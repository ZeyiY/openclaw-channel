# Agent-Portal WebSocket Server 开发规范

## 概述

本地 openclaw 插件会作为 WebSocket **客户端**，主动连接到 agent-portal 的 WebSocket **服务端**。
通过这个连接，agent-portal 可以远程读取和修改本地 openclaw workspace 中的文件。

每个 openclaw 的 OpenIM 账号会用一个 `botId`（用户配置）作为唯一标识建立连接。

## 连接

### 端点

```
ws(s)://{portal_host}/ws/workspace/{botId}
```

- `botId`: 唯一标识符，由用户在 openclaw 配置中手动填写
- openclaw 端主动连接此端点，portal 端是被动接受连接

### 连接生命周期

- openclaw 启动 OpenIM 账号时自动连接，停止时断开
- openclaw 端有自动重连机制（指数退避，2s ~ 60s）
- openclaw 端每 30 秒发送一次心跳 ping

### 数据格式

所有消息均为 JSON 文本帧，遵循 JSON-RPC 风格。

---

## 协议

### 请求方向

**agent-portal（服务端）→ openclaw（客户端）** 发请求，openclaw 处理后返回响应。

### 请求格式

```json
{
  "id": "unique-request-id",
  "method": "state | writeFile | ping",
  "params": {}
}
```

- `id`: 字符串，请求的唯一标识，用于关联响应。建议使用 UUID。
- `method`: 方法名
- `params`: 方法参数对象

### 响应格式

**成功：**
```json
{
  "id": "same-request-id",
  "result": { ... }
}
```

**失败：**
```json
{
  "id": "same-request-id",
  "error": {
    "code": 400,
    "message": "error description"
  }
}
```

---

## 方法详情

### 1. `state` — 获取 workspace 完整快照

获取 openclaw 本地 workspace 的所有文本文件列表及内容。

**请求：**
```json
{
  "id": "req-001",
  "method": "state",
  "params": {}
}
```

**响应：**
```json
{
  "id": "req-001",
  "result": {
    "files": [
      {
        "path": "src/index.ts",
        "content": "import ...\nexport default ...",
        "size": 1234
      },
      {
        "path": "package.json",
        "content": "{\"name\": ...}",
        "size": 567
      }
    ]
  }
}
```

**注意事项：**
- 自动跳过二进制文件（图片、视频、压缩包等）
- 自动跳过 `node_modules`、`.git`、`dist`、`build` 等目录
- 自动跳过 `.lock` 文件
- 单文件最大 10MB，超过的会被跳过
- `path` 是相对于 workspace 根目录的相对路径
- `size` 单位为字节

### 2. `writeFile` — 写入文件

写入或修改 workspace 中的一个文件。如果文件不存在会自动创建（含父目录）。

**请求：**
```json
{
  "id": "req-002",
  "method": "writeFile",
  "params": {
    "path": "src/new-feature.ts",
    "content": "export function hello() { return 'world'; }"
  }
}
```

**成功响应：**
```json
{
  "id": "req-002",
  "result": {
    "ok": true
  }
}
```

**错误响应（路径穿越）：**
```json
{
  "id": "req-002",
  "error": {
    "code": 403,
    "message": "path traversal not allowed"
  }
}
```

**参数：**
| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| path | string | 是 | 相对于 workspace 根目录的文件路径 |
| content | string | 是 | 文件内容 |

### 3. `ping` — 心跳

**请求：**
```json
{
  "id": "ping-1712649600000",
  "method": "ping",
  "params": {}
}
```

**响应：**
```json
{
  "id": "ping-1712649600000",
  "result": {
    "pong": true
  }
}
```

**注意：** openclaw 端每 30 秒会主动发送一次 ping 请求。portal 端也可以主动发 ping 检测连接存活。

---

## 错误码

| code | 含义 |
|------|------|
| 400 | 参数错误（如 path 为空） |
| 403 | 路径穿越，拒绝访问 |
| 404 | 未知方法 |
| 500 | 服务端内部错误 |

---

## FastAPI 实现参考

```python
import json
import uuid
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from typing import Any

app = FastAPI()

# botId -> WebSocket connection
connections: dict[str, WebSocket] = {}
# request id -> asyncio.Future (for awaiting responses)
pending_requests: dict[str, asyncio.Future] = {}


@app.websocket("/ws/workspace/{bot_id}")
async def workspace_ws(websocket: WebSocket, bot_id: str):
    await websocket.accept()
    connections[bot_id] = websocket
    print(f"[portal] bot connected: {bot_id}")

    try:
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            msg_id = data.get("id")

            # Check if this is a response to one of our requests
            if msg_id and msg_id in pending_requests:
                pending_requests[msg_id].set_result(data)
                continue

            # It's a request from openclaw (e.g. heartbeat ping)
            # For ping from openclaw, just acknowledge
            if data.get("method") == "ping":
                await websocket.send_text(json.dumps({
                    "id": msg_id,
                    "result": {"pong": True}
                }))

    except WebSocketDisconnect:
        print(f"[portal] bot disconnected: {bot_id}")
    finally:
        connections.pop(bot_id, None)
        # Cancel any pending requests for this bot
        for req_id in list(pending_requests.keys()):
            if not pending_requests[req_id].done():
                pending_requests[req_id].set_exception(
                    Exception(f"bot {bot_id} disconnected")
                )


async def send_request(bot_id: str, method: str, params: dict = None, timeout: float = 30.0) -> Any:
    """
    Send a request to a connected openclaw bot and await the response.
    
    Usage:
        result = await send_request("bot-123", "state")
        files = result["files"]
        
        result = await send_request("bot-123", "writeFile", {
            "path": "src/hello.ts",
            "content": "export const x = 1;"
        })
    """
    ws = connections.get(bot_id)
    if not ws:
        raise Exception(f"bot {bot_id} not connected")

    req_id = str(uuid.uuid4())
    request = {
        "id": req_id,
        "method": method,
        "params": params or {}
    }

    future: asyncio.Future = asyncio.get_event_loop().create_future()
    pending_requests[req_id] = future

    try:
        await ws.send_text(json.dumps(request))
        result = await asyncio.wait_for(future, timeout=timeout)

        if "error" in result:
            raise Exception(f"Request failed: {result['error']['message']}")

        return result.get("result")
    finally:
        pending_requests.pop(req_id, None)


# ---- Example: HTTP API that uses the WS bridge ----

@app.get("/api/workspace/{bot_id}/files")
async def get_workspace_files(bot_id: str):
    """Get all files from a bot's workspace."""
    result = await send_request(bot_id, "state")
    return result


@app.post("/api/workspace/{bot_id}/write")
async def write_workspace_file(bot_id: str, path: str, content: str):
    """Write a file to a bot's workspace."""
    result = await send_request(bot_id, "writeFile", {
        "path": path,
        "content": content
    })
    return result


@app.get("/api/bots/online")
async def list_online_bots():
    """List all currently connected bot IDs."""
    return {"bots": list(connections.keys())}
```

---

## 连接示意图

```
openclaw (本地)                           agent-portal (云端)
┌──────────────┐                         ┌──────────────────────┐
│              │  WS connect             │                      │
│  portal.ts   │ ──────────────────────→ │ /ws/workspace/{botId}│
│              │                         │                      │
│              │  ← { state request }    │  send_request()      │
│              │  → { files: [...] }     │                      │
│              │                         │                      │
│              │  ← { writeFile req }    │  send_request()      │
│              │  → { ok: true }         │                      │
│              │                         │                      │
│              │  → { ping }             │  (heartbeat)         │
│              │  ← { pong }             │                      │
└──────────────┘                         └──────────────────────┘
```

## 配置示例（openclaw 侧）

```json
{
  "channels": {
    "openim": {
      "accounts": {
        "default": {
          "token": "eyJ...",
          "wsAddr": "ws://openim-server:10001",
          "apiAddr": "http://openim-server:10002",
          "botId": "bot-abc-123",
          "portalWsAddr": "wss://portal.example.com/ws/workspace"
        }
      }
    }
  }
}
```

openclaw 会连接到 `wss://portal.example.com/ws/workspace/bot-abc-123`。
