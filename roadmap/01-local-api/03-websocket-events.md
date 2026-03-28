# WebSocket Event Specification

## Connection Protocol

### Endpoint

```
ws://localhost:19519/v1/ws
```

### Connection Lifecycle

```
Client                                     Server
  │                                          │
  │  HTTP Upgrade Request                    │
  │  GET /v1/ws HTTP/1.1                     │
  │  Host: localhost:19519                   │
  │  Connection: Upgrade                     │
  │  Upgrade: websocket                      │
  │─────────────────────────────────────────>│
  │                                          │
  │               Host header validation     │
  │               (DNS rebinding check)      │
  │                                          │
  │  101 Switching Protocols                 │
  │<─────────────────────────────────────────│
  │                                          │
  │  Phase 1: Authentication (5s timeout)    │
  │                                          │
  │  >>> { "type": "auth",                   │
  │        "token": "wotch_abc123..." }      │
  │─────────────────────────────────────────>│
  │                                          │
  │  <<< { "type": "auth:ok",               │
  │        "sessionId": "ws-1234" }          │
  │<─────────────────────────────────────────│
  │                                          │
  │  Phase 2: Subscription (optional)        │
  │                                          │
  │  >>> { "type": "subscribe",              │
  │        "events": ["claude:status",       │
  │                    "terminal:output"] }   │
  │─────────────────────────────────────────>│
  │                                          │
  │  <<< { "type": "subscribe:ok",           │
  │        "events": ["claude:status",       │
  │                    "terminal:output"] }   │
  │<─────────────────────────────────────────│
  │                                          │
  │  Phase 3: Event streaming                │
  │                                          │
  │  <<< { "type": "claude:status", ... }    │
  │<─────────────────────────────────────────│
  │  <<< { "type": "terminal:output", ... }  │
  │<─────────────────────────────────────────│
  │                                          │
  │  Heartbeat (every 30s)                   │
  │  <<< ping                                │
  │<─────────────────────────────────────────│
  │  >>> pong                                │
  │─────────────────────────────────────────>│
```

### Authentication Handshake

After the WebSocket connection is established, the client **must** send an `auth` message within 5 seconds. The server does not accept any other message type before authentication succeeds.

**Client sends:**

```json
{
  "type": "auth",
  "token": "wotch_abc123def456..."
}
```

**Server responds (success):**

```json
{
  "type": "auth:ok",
  "sessionId": "ws-a1b2c3d4",
  "serverVersion": "1.0.0"
}
```

**Server responds (failure):**

```json
{
  "type": "auth:error",
  "message": "Invalid token"
}
```

Then the server closes the connection with WebSocket close code `4001`.

**Server responds (timeout):**

If no `auth` message is received within 5 seconds, the server closes the connection with code `4002` and reason `"Authentication timeout"`.

### Close Codes

| Code | Meaning |
|---|---|
| 1000 | Normal closure (client or server initiated) |
| 1001 | Server shutting down |
| 4001 | Authentication failed |
| 4002 | Authentication timeout |
| 4003 | Too many connections (max 10 per IP) |
| 4004 | Token revoked (regenerated while connected) |

---

## Subscription Model

### Default Subscriptions

Upon successful authentication, the client is subscribed to **no events** by default. The client must explicitly subscribe.

### Subscribe

**Client sends:**

```json
{
  "type": "subscribe",
  "events": ["claude:status", "tab:lifecycle"]
}
```

Valid event types:

| Event Type | Description |
|---|---|
| `claude:status` | Claude Code state changes across all tabs |
| `terminal:output` | Terminal output data (raw or clean) |
| `tab:lifecycle` | Tab created, closed events |
| `git:checkpoint` | Checkpoint created events |
| `settings:changed` | Settings update events |
| `*` | Subscribe to all event types |

**Server responds:**

```json
{
  "type": "subscribe:ok",
  "events": ["claude:status", "tab:lifecycle"]
}
```

### Unsubscribe

**Client sends:**

```json
{
  "type": "unsubscribe",
  "events": ["terminal:output"]
}
```

**Server responds:**

```json
{
  "type": "unsubscribe:ok",
  "events": ["claude:status"]
}
```

The response includes the **remaining** active subscriptions.

### Filtered Subscriptions

For high-volume events like `terminal:output`, clients can filter by tab:

```json
{
  "type": "subscribe",
  "events": ["terminal:output"],
  "filter": {
    "tabIds": ["tab-1", "tab-2"]
  }
}
```

If `filter.tabIds` is omitted or empty, events from all tabs are sent. The filter is stored per-event-type and can be updated by sending another `subscribe` message for the same event type (it replaces the previous filter).

---

## Event Schemas

Every server-pushed event follows this envelope:

```json
{
  "type": "<event_type>",
  "timestamp": "2026-03-28T10:30:00.123Z",
  "data": { ... }
}
```

### `claude:status`

Emitted when Claude Code status changes on any tab. Debounced to at most one event per 150ms (matches the existing `ClaudeStatusDetector.broadcast()` debounce).

```json
{
  "type": "claude:status",
  "timestamp": "2026-03-28T10:30:00.123Z",
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
      }
    }
  }
}
```

**Trigger:** `ClaudeStatusDetector.broadcast()` fires.

---

### `terminal:output`

Emitted when a terminal (PTY or SSH) produces output. This is a high-frequency event.

```json
{
  "type": "terminal:output",
  "timestamp": "2026-03-28T10:30:00.456Z",
  "data": {
    "tabId": "tab-1",
    "output": "$ ls -la\ntotal 32\ndrwxr-xr-x  5 user user 4096 Mar 28 10:30 .\n",
    "format": "raw"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `tabId` | string | Which tab produced the output |
| `output` | string | Terminal data, including ANSI escape codes |
| `format` | string | Always `"raw"` -- clients can strip ANSI locally |

**Trigger:** `ptyProc.onData(data)` or `sshStream.on('data', data)` in `main.js`.

**Volume control:** This event can produce hundreds of messages per second during active terminal use. Clients should be prepared for high throughput. The server does **not** buffer or batch these events -- they are sent as they arrive from the PTY/SSH stream.

---

### `tab:lifecycle`

Emitted when a tab is created or closed.

**Tab created:**

```json
{
  "type": "tab:lifecycle",
  "timestamp": "2026-03-28T10:30:01.000Z",
  "data": {
    "action": "created",
    "tabId": "tab-4",
    "tabType": "pty",
    "cwd": "/home/user/projects/myapp"
  }
}
```

**Tab closed:**

```json
{
  "type": "tab:lifecycle",
  "timestamp": "2026-03-28T10:30:05.000Z",
  "data": {
    "action": "closed",
    "tabId": "tab-4",
    "tabType": "pty",
    "exitCode": 0
  }
}
```

| Field | Type | Description |
|---|---|---|
| `action` | string | `"created"` or `"closed"` |
| `tabId` | string | Tab identifier |
| `tabType` | string | `"pty"` or `"ssh"` |
| `cwd` | string | Working directory (only on `created`, only for `pty`) |
| `exitCode` | number | Process exit code (only on `closed`) |
| `profileId` | string | SSH profile ID (only for `ssh` tabs, on `created`) |

**Trigger:** `createPty()` return, `createSshSession()` resolve, PTY exit, SSH stream close.

---

### `git:checkpoint`

Emitted when a git checkpoint is created (via UI or API).

```json
{
  "type": "git:checkpoint",
  "timestamp": "2026-03-28T10:31:00.000Z",
  "data": {
    "projectPath": "/home/user/projects/myapp",
    "success": true,
    "hash": "a1b2c3d",
    "branch": "main",
    "changedFiles": 5,
    "message": "wotch-checkpoint-2026-03-28T10-31-00"
  }
}
```

**Trigger:** After `gitCheckpoint()` completes successfully (in both the IPC handler and the API endpoint handler).

---

### `settings:changed`

Emitted when settings are updated (via UI or API).

```json
{
  "type": "settings:changed",
  "timestamp": "2026-03-28T10:32:00.000Z",
  "data": {
    "changed": {
      "theme": "purple",
      "expandedHeight": 500
    },
    "source": "api"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `changed` | object | Only the fields that changed, with their new values |
| `source` | string | `"ui"` (from renderer IPC) or `"api"` (from REST endpoint) |

**Redaction:** The `sshProfiles` field is never included in `changed`, even if profiles were modified through their dedicated handlers.

**Trigger:** `save-settings` IPC handler and `PATCH /v1/settings` endpoint.

---

## Client-to-Server Messages

Beyond `auth`, `subscribe`, and `unsubscribe`, the client can send:

### `ping` (application-level)

```json
{
  "type": "ping",
  "id": "p-12345"
}
```

**Server responds:**

```json
{
  "type": "pong",
  "id": "p-12345"
}
```

This is distinct from WebSocket-level ping/pong frames. The `id` field is echoed back so clients can measure round-trip latency.

---

## Heartbeat and Reconnection

### Server-Side Heartbeat

The server sends a WebSocket-level `ping` frame every 30 seconds to each authenticated client. If the client does not respond with a `pong` frame within 10 seconds, the server considers the connection dead and closes it.

### Client Reconnection Behavior (Recommended)

Clients should implement exponential backoff reconnection:

1. On unexpected disconnect, wait 1 second and reconnect.
2. If reconnection fails, double the wait (2s, 4s, 8s, ...) up to 60s max.
3. On successful reconnection, reset the backoff timer.
4. Re-authenticate and re-subscribe after reconnection.
5. There is no server-side "resume" mechanism -- events missed during disconnection are lost.

### Connection Limits

- Maximum 10 concurrent WebSocket connections per IP address (always 127.0.0.1, so 10 total).
- If a new connection would exceed the limit, the server rejects the upgrade with HTTP 429.

---

## Message Format Summary

### Client-to-Server Messages

| type | Fields | When |
|---|---|---|
| `auth` | `token` | Immediately after connection |
| `subscribe` | `events`, `filter?` | After auth |
| `unsubscribe` | `events` | Anytime after auth |
| `ping` | `id?` | Anytime after auth |

### Server-to-Client Messages

| type | Trigger | Subscription |
|---|---|---|
| `auth:ok` | Successful auth | Always |
| `auth:error` | Failed auth | Always |
| `subscribe:ok` | Subscription change | Always |
| `unsubscribe:ok` | Subscription change | Always |
| `pong` | Client ping | Always |
| `claude:status` | Status detector broadcast | `claude:status` |
| `terminal:output` | PTY/SSH data | `terminal:output` |
| `tab:lifecycle` | Tab created/closed | `tab:lifecycle` |
| `git:checkpoint` | Checkpoint created | `git:checkpoint` |
| `settings:changed` | Settings saved | `settings:changed` |

---

## Example: Complete Client Session (JavaScript)

```javascript
const WebSocket = require('ws');
const fs = require('fs');

// Read token and port
const token = fs.readFileSync(`${process.env.HOME}/.wotch/api-token`, 'utf-8').trim();
const port = fs.readFileSync(`${process.env.HOME}/.wotch/api-port`, 'utf-8').trim();

const ws = new WebSocket(`ws://localhost:${port}/v1/ws`);

ws.on('open', () => {
  // Step 1: Authenticate
  ws.send(JSON.stringify({ type: 'auth', token }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  switch (msg.type) {
    case 'auth:ok':
      console.log('Authenticated, session:', msg.sessionId);
      // Step 2: Subscribe to events
      ws.send(JSON.stringify({
        type: 'subscribe',
        events: ['claude:status', 'tab:lifecycle'],
      }));
      break;

    case 'subscribe:ok':
      console.log('Subscribed to:', msg.events);
      break;

    case 'claude:status':
      console.log(`Claude: ${msg.data.aggregate.state} - ${msg.data.aggregate.description}`);
      break;

    case 'tab:lifecycle':
      console.log(`Tab ${msg.data.tabId} ${msg.data.action}`);
      break;
  }
});

ws.on('close', (code, reason) => {
  console.log(`Disconnected: ${code} ${reason}`);
  // Implement reconnection here
});
```
