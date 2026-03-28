# REST API Specification

All endpoints are prefixed with `/v1/`. All request and response bodies use `Content-Type: application/json`. All authenticated endpoints require `Authorization: Bearer <token>` header.

## Common Response Envelope

Success responses:

```json
{
  "ok": true,
  "data": { ... }
}
```

Error responses:

```json
{
  "ok": false,
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE"
}
```

## Common Error Codes

| HTTP Status | Code | Description |
|---|---|---|
| 401 | `UNAUTHORIZED` | Missing or invalid bearer token |
| 403 | `FORBIDDEN` | DNS rebinding detected (bad Host header) |
| 404 | `NOT_FOUND` | Route or resource not found |
| 405 | `METHOD_NOT_ALLOWED` | HTTP method not supported for this route |
| 422 | `VALIDATION_ERROR` | Request body failed validation |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## 1. Health & Info

### `GET /v1/health`

Health check endpoint. **No authentication required.**

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "status": "healthy",
    "version": "1.0.0",
    "uptime": 3600,
    "apiVersion": "v1"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `status` | string | Always `"healthy"` if the server is responding |
| `version` | string | Wotch app version from `package.json` |
| `uptime` | number | Seconds since the API server started |
| `apiVersion` | string | API version (`"v1"`) |

**Example:**

```bash
curl http://localhost:19519/v1/health
```

---

### `GET /v1/info`

Detailed information about the running Wotch instance. **Requires authentication.**

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "version": "1.0.0",
    "platform": "linux",
    "electron": "33.0.0",
    "node": "20.0.0",
    "uptime": 3600,
    "tabs": {
      "total": 3,
      "pty": 2,
      "ssh": 1
    },
    "api": {
      "port": 19519,
      "wsConnections": 2,
      "startedAt": "2026-03-28T10:00:00.000Z"
    },
    "window": {
      "expanded": true,
      "pinned": false,
      "position": "top",
      "display": 0
    }
  }
}
```

**Example:**

```bash
curl -H "Authorization: Bearer wotch_abc123..." http://localhost:19519/v1/info
```

---

## 2. Claude Status

### `GET /v1/status`

Get the current Claude Code status for all tabs and the aggregate status.

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "aggregate": {
      "state": "working",
      "description": "Editing 3 files (renderer.js)",
      "tabId": "tab-2"
    },
    "tabs": {
      "tab-1": {
        "state": "idle",
        "description": "Ready"
      },
      "tab-2": {
        "state": "working",
        "description": "Editing 3 files (renderer.js)"
      },
      "tab-3": {
        "state": "thinking",
        "description": "Thinking..."
      }
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `aggregate.state` | string | One of: `idle`, `thinking`, `working`, `waiting`, `done`, `error` |
| `aggregate.description` | string | Human-readable description of the most important activity |
| `aggregate.tabId` | string\|null | Tab driving the aggregate status |
| `tabs.<tabId>.state` | string | Same enum as aggregate |
| `tabs.<tabId>.description` | string | Per-tab description |

**Example:**

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:19519/v1/status
```

---

### `GET /v1/status/:tabId`

Get Claude status for a specific tab.

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "tabId": "tab-2",
    "state": "working",
    "description": "Editing 3 files (renderer.js)"
  }
}
```

**Response 404:**

```json
{
  "ok": false,
  "error": "Tab not found",
  "code": "NOT_FOUND"
}
```

---

## 3. Tabs

### `GET /v1/tabs`

List all open tabs.

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "tabs": [
      {
        "id": "tab-1",
        "type": "pty",
        "status": {
          "state": "idle",
          "description": "Ready"
        }
      },
      {
        "id": "tab-3",
        "type": "ssh",
        "profileId": "profile-abc",
        "status": {
          "state": "thinking",
          "description": "Thinking..."
        }
      }
    ]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string | Tab identifier |
| `type` | string | `"pty"` for local terminals, `"ssh"` for SSH sessions |
| `profileId` | string | Only present for SSH tabs; the SSH profile ID |
| `status.state` | string | Current Claude status for this tab |
| `status.description` | string | Human-readable status description |

---

### `POST /v1/tabs`

Create a new terminal tab.

**Request body:**

```json
{
  "cwd": "/home/user/projects/myapp"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `cwd` | string | No | `$HOME` | Working directory for the new shell |

**Response 201:**

```json
{
  "ok": true,
  "data": {
    "tabId": "tab-4",
    "type": "pty",
    "cwd": "/home/user/projects/myapp"
  }
}
```

**Implementation note:** This creates a PTY in the main process and notifies the renderer via an IPC event to create the corresponding xterm.js terminal and tab UI element. A new IPC channel `api-tab-created` is sent from main to renderer for this purpose.

---

### `DELETE /v1/tabs/:tabId`

Close a tab (kills the PTY or SSH session).

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "tabId": "tab-4",
    "closed": true
  }
}
```

**Response 404:**

```json
{
  "ok": false,
  "error": "Tab not found",
  "code": "NOT_FOUND"
}
```

---

### `GET /v1/tabs/:tabId/buffer`

Read the terminal output buffer for a tab.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `lines` | number | 100 | Number of lines to return (max 1000) |
| `format` | string | `"raw"` | `"raw"` (with ANSI codes) or `"clean"` (stripped) |

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "tabId": "tab-1",
    "lines": 100,
    "format": "raw",
    "content": "$ claude\n╭─ Claude Code ─╮\n│ ...",
    "totalBytes": 12345
  }
}
```

| Field | Type | Description |
|---|---|---|
| `content` | string | Terminal buffer content (last N lines) |
| `totalBytes` | number | Total size of the stored buffer |

**Example:**

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:19519/v1/tabs/tab-1/buffer?lines=50&format=clean"
```

---

### `POST /v1/tabs/:tabId/input`

Write input to a tab's terminal (simulates typing).

**Request body:**

```json
{
  "data": "ls -la\n"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `data` | string | Yes | Data to write to the terminal. Use `\n` for Enter, `\x03` for Ctrl+C, etc. |

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "tabId": "tab-1",
    "bytesWritten": 7
  }
}
```

**Response 404:**

```json
{
  "ok": false,
  "error": "Tab not found",
  "code": "NOT_FOUND"
}
```

**Security note:** This endpoint allows writing arbitrary data to a terminal. The bearer token is the authorization gate. Rate limiting applies (see `04-security.md`).

---

## 4. Checkpoints

### `POST /v1/checkpoints`

Create a git checkpoint in a project directory.

**Request body:**

```json
{
  "projectPath": "/home/user/projects/myapp",
  "message": "Before refactoring auth module"
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `projectPath` | string | Yes | -- | Absolute path to a git repository |
| `message` | string | No | Auto-generated timestamp | Commit message for the checkpoint |

**Response 201:**

```json
{
  "ok": true,
  "data": {
    "success": true,
    "message": "Checkpoint created: a1b2c3d",
    "details": {
      "branch": "main",
      "hash": "a1b2c3d",
      "changedFiles": 5,
      "commitMessage": "Before refactoring auth module"
    }
  }
}
```

**Response 200 (no changes):**

```json
{
  "ok": true,
  "data": {
    "success": false,
    "message": "No changes to checkpoint",
    "details": {
      "branch": "main",
      "changedFiles": 0
    }
  }
}
```

**Response 422 (not a git repo):**

```json
{
  "ok": false,
  "error": "Not a git repository",
  "code": "VALIDATION_ERROR"
}
```

---

### `GET /v1/checkpoints`

List recent checkpoints for a project.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `projectPath` | string | Required | Absolute path to a git repository |
| `limit` | number | 20 | Maximum number of checkpoints to return (max 100) |

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "projectPath": "/home/user/projects/myapp",
    "checkpoints": [
      {
        "hash": "a1b2c3d",
        "message": "wotch-checkpoint-2026-03-28T10-30-00",
        "date": "2026-03-28T10:30:00.000Z",
        "filesChanged": 3
      },
      {
        "hash": "e4f5g6h",
        "message": "Before refactoring auth module",
        "date": "2026-03-28T09:15:00.000Z",
        "filesChanged": 7
      }
    ],
    "totalCount": 12
  }
}
```

**Implementation:** Runs `git log --oneline --grep="wotch-checkpoint" --format="%H %ai %s"` plus custom-message checkpoints. Parses the output into structured data.

---

## 5. Git Status

### `GET /v1/git/status`

Get git status for a project.

**Query parameters:**

| Param | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | Yes | Absolute path to a git repository |

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "projectPath": "/home/user/projects/myapp",
    "branch": "main",
    "changedFiles": 3,
    "lastCommit": "a1b2c3d Implement user authentication",
    "checkpointCount": 5
  }
}
```

**Response 200 (not a git repo):**

```json
{
  "ok": true,
  "data": {
    "projectPath": "/home/user/projects/myapp",
    "isGitRepo": false
  }
}
```

---

### `GET /v1/git/diff`

Get the git diff for a project.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `projectPath` | string | Required | Absolute path to a git repository |
| `mode` | string | `"working"` | `"working"` (uncommitted changes) or `"last-checkpoint"` (diff from HEAD~1) |

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "projectPath": "/home/user/projects/myapp",
    "mode": "working",
    "diff": "diff --git a/src/auth.js b/src/auth.js\n..."
  }
}
```

---

## 6. Projects

### `GET /v1/projects`

Detect and list all discoverable projects (from VS Code, JetBrains, common directories, etc.).

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "projects": [
      {
        "name": "myapp",
        "path": "/home/user/projects/myapp",
        "source": "vscode-recent"
      },
      {
        "name": "dotfiles",
        "path": "/home/user/dotfiles",
        "source": "scan"
      }
    ]
  }
}
```

| Field | Type | Description |
|---|---|---|
| `name` | string | Directory name |
| `path` | string | Absolute path |
| `source` | string | How it was discovered: `vscode-recent`, `vscode-running`, `jetbrains`, `xcode`, `visualstudio`, `scan` |

**Note:** This endpoint may take 1-3 seconds due to filesystem scanning. Consider caching results for 60 seconds.

---

## 7. Settings

### `GET /v1/settings`

Get current settings. SSH profiles are excluded (see security design).

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "pillWidth": 200,
    "pillHeight": 36,
    "expandedWidth": 640,
    "expandedHeight": 440,
    "hoverPadding": 20,
    "collapseDelay": 400,
    "mousePollingMs": 100,
    "defaultShell": "",
    "startExpanded": false,
    "pinned": false,
    "theme": "dark",
    "autoLaunchClaude": false,
    "displayIndex": 0,
    "position": "top",
    "apiEnabled": true,
    "apiPort": 19519
  }
}
```

**Redaction:** The `sshProfiles` field is always excluded from the response. See `04-security.md`.

---

### `PATCH /v1/settings`

Update one or more settings. Partial update -- only the provided fields are changed.

**Request body:**

```json
{
  "theme": "purple",
  "expandedHeight": 500
}
```

**Validation rules:**

| Field | Type | Constraints |
|---|---|---|
| `pillWidth` | number | 100-400 |
| `pillHeight` | number | 24-60 |
| `expandedWidth` | number | 400-1200 |
| `expandedHeight` | number | 200-900 |
| `hoverPadding` | number | 0-100 |
| `collapseDelay` | number | 100-5000 |
| `mousePollingMs` | number | 50-1000 |
| `defaultShell` | string | Max 256 chars |
| `startExpanded` | boolean | -- |
| `pinned` | boolean | -- |
| `theme` | string | One of: `dark`, `light`, `purple`, `green` |
| `autoLaunchClaude` | boolean | -- |
| `displayIndex` | number | 0-9 |
| `position` | string | One of: `top`, `left`, `right` |
| `apiEnabled` | boolean | -- |
| `apiPort` | number | 1024-65535 |

**Rejected fields (422):** `sshProfiles` -- cannot be modified via API.

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "theme": "purple",
    "expandedHeight": 500
  }
}
```

**Side effects:**
- If `theme` changes, the renderer UI updates immediately (via existing IPC).
- If `position` changes, the window repositions immediately.
- If `apiPort` changes, the API server restarts on the new port (the current request completes first).
- If `apiEnabled` is set to `false`, the API server shuts down after responding to this request.

---

### `POST /v1/settings/reset`

Reset all settings to defaults (except SSH profiles, which are preserved).

**Request body:** None.

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "pillWidth": 200,
    "pillHeight": 36,
    "expandedWidth": 640,
    "expandedHeight": 440,
    "...": "..."
  }
}
```

---

## 8. Platform

### `GET /v1/platform`

Get platform information.

**Response 200:**

```json
{
  "ok": true,
  "data": {
    "platform": "linux",
    "isMac": false,
    "isWayland": true,
    "waylandCursorBroken": true,
    "hasNotch": false
  }
}
```

---

## Endpoint Summary Table

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/health` | No | Health check |
| `GET` | `/v1/info` | Yes | Detailed instance info |
| `GET` | `/v1/status` | Yes | All tab Claude statuses |
| `GET` | `/v1/status/:tabId` | Yes | Single tab Claude status |
| `GET` | `/v1/tabs` | Yes | List open tabs |
| `POST` | `/v1/tabs` | Yes | Create new tab |
| `DELETE` | `/v1/tabs/:tabId` | Yes | Close a tab |
| `GET` | `/v1/tabs/:tabId/buffer` | Yes | Read terminal buffer |
| `POST` | `/v1/tabs/:tabId/input` | Yes | Write to terminal |
| `POST` | `/v1/checkpoints` | Yes | Create git checkpoint |
| `GET` | `/v1/checkpoints` | Yes | List checkpoints |
| `GET` | `/v1/git/status` | Yes | Git repo status |
| `GET` | `/v1/git/diff` | Yes | Git diff |
| `GET` | `/v1/projects` | Yes | Detect projects |
| `GET` | `/v1/settings` | Yes | Get settings |
| `PATCH` | `/v1/settings` | Yes | Update settings |
| `POST` | `/v1/settings/reset` | Yes | Reset to defaults |
| `GET` | `/v1/platform` | Yes | Platform info |
