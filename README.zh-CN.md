# @zeyiy/openclaw-channel

OpenClaw Gateway 的 OpenIM 渠道插件。

> 从 [@openim/openclaw-channel](https://github.com/openimsdk/openclaw-channel) fork 而来，采用 AGPL-3.0-only 许可证。

English documentation: [README.md](https://github.com/ZeyiY/openclaw-channel/blob/main/README.md)

## 功能

- 支持私聊与群聊
- 支持文本/图片/文件消息的收发
- `openim_send_video` 按文件消息发送（不使用 OpenIM 视频消息）
- 支持引用消息解析（用于入站上下文）
- 支持多账号并发（`channels.openim.accounts.<id>`）
- 支持群聊仅 @ 触发
- 私聊消息自动标记已读（已读回执）
- 每用户独立会话（私聊）/ 同群共享会话（群聊）
- Agent Portal Bridge — 与 agent-portal 云服务保持 WebSocket 长连接，支持远程管理
- 提供交互式配置命令：`openclaw openim setup`

## 安装

从 npm 安装：

```bash
openclaw plugins install @zeyiy/openclaw-channel
```

本地路径安装：

```bash
openclaw plugins install /path/to/openclaw-channel
```

仓库地址：https://github.com/ZeyiY/openclaw-channel

## 标识说明

- npm 包名：`@zeyiy/openclaw-channel`
- 插件 id：`openclaw-channel`（用于 `plugins.entries` / `plugins.allow`）
- 渠道 id：`openim`（用于 `channels.openim`）
- 配置命令：`openclaw openim setup`

## 配置

### 方式一：交互式配置（推荐）

```bash
openclaw openim setup
```

### 方式二：手动编辑 `~/.openclaw/openclaw.json`

```json
{
  "channels": {
    "openim": {
      "accounts": {
        "default": {
          "enabled": true,
          "token": "your_token",
          "wsAddr": "ws://127.0.0.1:10001",
          "apiAddr": "http://127.0.0.1:10002",
          "botId": "my-bot-001",
          "portalWsAddr": "wss://portal.example.com/ws"
        }
      }
    }
  }
}
```

`userID` 和 `platformID` 为可选项，未填写时会自动从 JWT token 的 `UserID` / `PlatformID` 声明解析。

`requireMention` 为可选项，默认 `true`。

`inboundWhitelist` 为可选项，不填或为空时保持当前逻辑；填了后仅处理白名单用户触发的消息：
- 给账号发单聊消息
- 在群里 @ 账号的消息

`botId` 和 `portalWsAddr` 为可选项。同时配置后，插件会与 agent-portal 云服务建立 WebSocket 连接，支持远程管理 agent、文件和模型。

支持单账号兜底写法（不使用 `accounts`）。

`default` 账号支持环境变量兜底：

- `OPENIM_TOKEN`
- `OPENIM_WS_ADDR`
- `OPENIM_API_ADDR`

可选环境变量覆盖项：

- `OPENIM_USER_ID`
- `OPENIM_PLATFORM_ID`

## Agent 工具

- `openim_send_text`
  - `target`: `user:<id>` 或 `group:<id>`
  - `text`: 文本内容
  - `accountId`（可选）：指定发送账号

- `openim_send_image`
  - `target`: `user:<id>` 或 `group:<id>`
  - `image`: 本地路径（支持 `file://`）或 `http(s)` URL
  - `accountId`（可选）：指定发送账号

- `openim_send_video`
  - `target`: `user:<id>` 或 `group:<id>`
  - `video`: 本地路径（支持 `file://`）或 `http(s)` URL
  - 行为：按文件消息发送（不是视频消息）
  - `name`（可选）：URL 输入时覆盖文件名
  - `accountId`（可选）：指定发送账号

- `openim_send_file`
  - `target`: `user:<id>` 或 `group:<id>`
  - `file`: 本地路径（支持 `file://`）或 `http(s)` URL
  - `name`（可选）：URL 输入时覆盖文件名
  - `accountId`（可选）：指定发送账号

## Agent Portal Bridge

配置 `botId` 和 `portalWsAddr` 后，插件会通过 WebSocket 连接到 agent-portal 云服务。Portal 可远程调用以下方法：

| 方法 | 说明 |
|---|---|
| `bot.agent.get` | 获取当前 bot 绑定的 agentId |
| `models.list` | 列出配置中的可用模型 |
| `agents.list` | 列出所有已配置的 agent |
| `agents.create` | 创建新 agent 及工作空间 |
| `agents.files.list` | 列出 agent 工作空间文件 |
| `agents.files.get` | 读取单个工作空间文件 |
| `agents.files.set` | 写入文件到 agent 工作空间 |
| `tools.catalog` | 列出可用工具 |
| `skills.status` | 列出已安装技能/插件状态 |
| `skills.search` | 搜索 ClawHub 技能（占位） |
| `skills.detail` | 获取特定技能详情 |
| `cron.list` | 列出已配置的定时任务 |

连接支持指数退避自动重连和心跳保活。

## 开发

```bash
pnpm run build
pnpm run test:connect
```

运行 `test:connect` 前请先配置 `.env`（参考 `.env.example`）。

## 许可证

本项目采用 `AGPL-3.0-only` 许可证。详见 [LICENSE](https://github.com/ZeyiY/openclaw-channel/blob/main/LICENSE)。

原始项目由 [openimsdk](https://github.com/openimsdk/openclaw-channel) 开发。
