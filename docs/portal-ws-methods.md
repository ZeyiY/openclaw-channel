# Portal WebSocket Methods

## Overview

Portal bridge acts as a WebSocket **client**, connecting to the agent-portal **server**.
Agent-portal sends requests, portal processes them locally and returns responses.

### Connection

```
ws(s)://{portal_host}/ws/workspace/{botId}
```

### Protocol

All messages are JSON text frames, using a JSON-RPC style format.

**Request (agent-portal -> portal):**
```json
{
  "id": "unique-request-id",
  "method": "method.name",
  "params": {}
}
```

**Success response:**
```json
{
  "id": "same-request-id",
  "result": { ... }
}
```

**Error response:**
```json
{
  "id": "same-request-id",
  "error": {
    "code": 400,
    "message": "error description"
  }
}
```

### Error Codes

| code | meaning            |
|------|--------------------|
| 400  | invalid parameters |
| 403  | forbidden          |
| 404  | unknown method     |
| 500  | internal error     |

---

## Methods

### 1. `bot.agent.get`

Returns the agentId bound to the current bot's WebSocket connection.

The lookup order:
1. Config `bindings` where `channel=openim` and `accountId` matches
2. Fallback to the default agent

**Request:**
```json
{
  "id": "req-000",
  "method": "bot.agent.get",
  "params": {}
}
```

No parameters required — the agent is resolved from the connection's accountId.

**Response:**
```json
{
  "id": "req-000",
  "result": {
    "agentId": "coder",
    "name": "coder"
  }
}
```

| field | type | required | description |
|-------|------|----------|-------------|
| agentId | string | yes | the agent ID bound to this bot |
| name | string | no | agent display name |

---

### 2. `models.list`

Returns the list of models configured in the local openclaw instance, with the active model marked for the given agent.

**Request:**
```json
{
  "id": "req-001",
  "method": "models.list",
  "params": {
    "agentId": "coder"
  }
}
```

| param | type | required | description |
|-------|------|----------|-------------|
| agentId | string | no | agent identifier. Used to determine which model is active. If omitted, the first model is marked active. |

**Response:**
```json
{
  "id": "req-001",
  "result": {
    "models": [
      {
        "id": "deepminer/claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "provider": "deepminer",
        "active": true
      },
      {
        "id": "deepminer/gpt-5",
        "name": "GPT-5",
        "provider": "deepminer",
        "active": false
      }
    ]
  }
}
```

**Response fields:**

| field | type | required | description |
|-------|------|----------|-------------|
| models | ModelEntry[] | yes | list of available models |

**ModelEntry:**

| field | type | required | description |
|-------|------|----------|-------------|
| id | string | yes | model identifier (format: `{provider}/{modelId}`) |
| name | string | yes | display name |
| provider | string | yes | provider name (e.g. "deepminer") |
| contextWindow | integer | no | max context tokens |
| reasoning | boolean | no | whether model supports reasoning |
| active | boolean | no | `true` if this is the model currently used by the agent. If the agent has no model configured, the first model is marked active. |

---

### 3. `agents.list`

Returns all configured agents.

**Request:**
```json
{
  "id": "req-002",
  "method": "agents.list",
  "params": {}
}
```

**Response:**
```json
{
  "id": "req-002",
  "result": {
    "defaultId": "main",
    "agents": [
      {
        "id": "main",
        "name": "My Agent",
        "identity": {
          "name": "Assistant",
          "emoji": "robot",
          "theme": "blue",
          "avatar": "avatar.png"
        },
        "workspace": "/path/to/workspace",
        "model": {
          "primary": "gpt-4",
          "fallbacks": ["gpt-3.5-turbo"]
        }
      }
    ]
  }
}
```

**Response fields:**

| field | type | required | description |
|-------|------|----------|-------------|
| defaultId | string | yes | ID of the default agent |
| agents | AgentSummary[] | yes | list of agents |

**AgentSummary:**

| field | type | required | description |
|-------|------|----------|-------------|
| id | string | yes | agent identifier (normalized) |
| name | string | no | display name |
| identity | AgentIdentity | no | identity metadata |
| workspace | string | no | absolute path to workspace directory |
| model | object | no | model configuration |
| model.primary | string | no | primary model ID |
| model.fallbacks | string[] | no | fallback model IDs |

**AgentIdentity:**

| field | type | required | description |
|-------|------|----------|-------------|
| name | string | no | identity display name |
| theme | string | no | theme name |
| emoji | string | no | emoji identifier |
| avatar | string | no | avatar file or URL |

---

### 4. `agents.files.list`

Lists all well-known workspace files for an agent, **including file content**.

Well-known files: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `MEMORY.md`, `memory.md`.

**Request:**
```json
{
  "id": "req-003",
  "method": "agents.files.list",
  "params": {
    "agentId": "main"
  }
}
```

| param | type | required | description |
|-------|------|----------|-------------|
| agentId | string | yes | agent identifier |

**Response:**
```json
{
  "id": "req-003",
  "result": {
    "agentId": "main",
    "workspace": "/path/to/workspace",
    "files": [
      {
        "name": "IDENTITY.md",
        "path": "/path/to/workspace/IDENTITY.md",
        "missing": false,
        "size": 128,
        "updatedAtMs": 1712649600000,
        "content": "- Name: My Agent\n- Emoji: robot\n"
      },
      {
        "name": "SOUL.md",
        "path": "/path/to/workspace/SOUL.md",
        "missing": true
      }
    ]
  }
}
```

**Response fields:**

| field | type | required | description |
|-------|------|----------|-------------|
| agentId | string | yes | normalized agent ID |
| workspace | string | yes | absolute workspace path |
| files | AgentFileEntry[] | yes | list of workspace files |

**AgentFileEntry:**

| field | type | required | description |
|-------|------|----------|-------------|
| name | string | yes | file name (e.g. "IDENTITY.md") |
| path | string | yes | absolute file path |
| missing | boolean | yes | true if file does not exist |
| size | integer | no | file size in bytes (present when file exists) |
| updatedAtMs | integer | no | last modified timestamp ms (present when file exists) |
| content | string | no | full file content as UTF-8 text (present when file exists) |

---

### 5. `agents.files.get`

Get a single file's content from an agent's workspace.

**Request:**
```json
{
  "id": "req-004",
  "method": "agents.files.get",
  "params": {
    "agentId": "main",
    "name": "SOUL.md"
  }
}
```

| param | type | required | description |
|-------|------|----------|-------------|
| agentId | string | yes | agent identifier |
| name | string | yes | file name relative to workspace root |

**Response (file exists):**
```json
{
  "id": "req-004",
  "result": {
    "agentId": "main",
    "workspace": "/path/to/workspace",
    "file": {
      "name": "SOUL.md",
      "path": "/path/to/workspace/SOUL.md",
      "missing": false,
      "size": 128,
      "updatedAtMs": 1712649600000,
      "content": "You are a helpful assistant."
    }
  }
}
```

**Response (file missing):**
```json
{
  "id": "req-004",
  "result": {
    "agentId": "main",
    "workspace": "/path/to/workspace",
    "file": {
      "name": "SOUL.md",
      "path": "/path/to/workspace/SOUL.md",
      "missing": true
    }
  }
}
```

**Errors:**

| code | when |
|------|------|
| 400 | `agentId` or `name` is empty |
| 403 | path traversal detected |

---

### 6. `agents.files.set`

Write or overwrite a file in an agent's workspace. Creates parent directories if needed.

**Request:**
```json
{
  "id": "req-005",
  "method": "agents.files.set",
  "params": {
    "agentId": "main",
    "name": "SOUL.md",
    "content": "You are a helpful assistant."
  }
}
```

| param | type | required | description |
|-------|------|----------|-------------|
| agentId | string | yes | agent identifier |
| name | string | yes | file name relative to workspace root |
| content | string | yes | file content to write |

**Success response:**
```json
{
  "id": "req-005",
  "result": {
    "ok": true,
    "agentId": "main",
    "workspace": "/path/to/workspace",
    "file": {
      "name": "SOUL.md",
      "path": "/path/to/workspace/SOUL.md",
      "missing": false,
      "size": 29,
      "updatedAtMs": 1712649600000,
      "content": "You are a helpful assistant."
    }
  }
}
```

**Errors:**

| code | when |
|------|------|
| 400 | `agentId` or `name` is empty |
| 403 | path traversal detected (e.g. `../etc/passwd`) |

---

### 7. `agents.create`

Create a new agent with a workspace directory and IDENTITY.md file.

**Request:**
```json
{
  "id": "req-006",
  "method": "agents.create",
  "params": {
    "name": "My New Agent",
    "workspace": "/path/to/new-workspace",
    "emoji": "star",
    "avatar": "avatar.png"
  }
}
```

| param | type | required | description |
|-------|------|----------|-------------|
| name | string | yes | display name (also used to derive the agent ID) |
| workspace | string | yes | absolute path for the workspace directory |
| emoji | string | no | emoji identifier |
| avatar | string | no | avatar file or URL |

**Success response:**
```json
{
  "id": "req-006",
  "result": {
    "ok": true,
    "agentId": "my-new-agent",
    "name": "My New Agent",
    "workspace": "/path/to/new-workspace"
  }
}
```

**Errors:**

| code | when |
|------|------|
| 400 | `name` or `workspace` is empty |
| 400 | agent ID is "main" (reserved) |
| 400 | agent with the same ID already exists |

**Side effects:**
- Creates the workspace directory (recursively)
- Creates `IDENTITY.md` in the workspace with name, emoji, and avatar

---

### 8. `ping`

Heartbeat check. Portal sends a ping every 30 seconds automatically. Agent-portal can also send pings.

**Request:**
```json
{
  "id": "ping-1712649600000",
  "method": "ping",
  "params": {}
}
```

**Response:**
```json
{
  "id": "ping-1712649600000",
  "result": {
    "pong": true
  }
}
```
