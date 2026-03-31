# Architecture: Wotch Local API

## High-Level Design

The Local API is an HTTP + WebSocket server that runs inside the Electron main process. It shares the same Node.js runtime as the PTY manager, SSH manager, Claude Status Detector, and Settings Manager, so it can access all in-memory state directly -- no IPC round-trips needed for data that already lives in main.

```
  ┌──────────────────────────────────────────────────────────────┐
  │                     Electron Main Process                     │
  │                                                               │
  │  ┌─────────┐  ┌──────────┐  ┌───────────────┐  ┌──────────┐ │
  │  │ PTY Mgr │  │ SSH Mgr  │  │ ClaudeStatus  │  │ Settings │ │
  │  │ (Map)   │  │ (Map)    │  │  Detector     │  │ Manager  │ │
  │  └────┬────┘  └────┬─────┘  └───────┬───────┘  └────┬─────┘ │
  │       │            │                │                │       │
  │       ▼            ▼                ▼                ▼       │
  │  ┌───────────────────────────────────────────────────────┐   │
  │  │                    ApiServer                           │   │
  │  │  ┌──────────┐  ┌──────────────┐  ┌────────────────┐   │   │
  │  │  │ HTTP     │  │ WS Server    │  │ Auth + Security│   │   │
  │  │  │ Router   │  │ (ws library) │  │ Middleware     │   │   │
  │  │  └──────────┘  └──────────────┘  └────────────────┘   │   │
  │  └──────────────────────┬────────────────────────────────┘   │
  │                         │                                     │
  │                   127.0.0.1:19519                             │
  │                                                               │
  │  ┌─────────────────────────────────────────────────────────┐ │
  │  │  BrowserWindow (Renderer)                                │ │
  │  │  Communicates via IPC only (unchanged)                   │ │
  │  └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
          ▲                    ▲
          │ IPC                │ HTTP/WS
          ▼                    ▼
     Renderer UI         External Tools
                         (curl, VS Code ext,
                          scripts, dashboards)
```

## Why Not Express/Fastify?

The API surface is small: ~15 endpoints and one WebSocket path. A framework would:

1. Add 500KB+ to the bundle (Express) or 200KB+ (Fastify)
2. Increase the attack surface (middleware chains, prototype pollution vectors in body parsers)
3. Provide features we do not need (template rendering, cookie parsing, session management)

Instead, the server uses Node.js `http.createServer()` with a simple hand-rolled router. The router is a flat array of `{ method, pattern, handler }` entries with RegExp path matching. This is easy to audit, easy to test, and adds zero dependencies.

For WebSocket, we use the `ws` library (the de facto standard, used by Electron itself internally). It attaches to the same HTTP server via the `upgrade` event.

## Server Lifecycle

### Startup

```
app.whenReady()
  ├── createWindow()           (existing)
  ├── globalShortcut.register() (existing)
  ├── createTray()             (existing)
  └── apiServer.start()        (NEW)
        ├── loadOrGenerateToken()
        ├── http.createServer(requestHandler)
        ├── new WebSocketServer({ noServer: true })
        ├── server.listen(port, '127.0.0.1')
        └── hookIntoExistingEmitters()
```

### Shutdown

```
app.on('will-quit')
  ├── kill all PTYs            (existing)
  ├── close all SSH sessions   (existing)
  └── apiServer.stop()         (NEW)
        ├── wss.close()        (close all WS connections)
        └── server.close()     (stop accepting new connections)
```

### Restart (settings change)

If `apiPort` changes in settings, the server restarts:

```
apiServer.restart()
  ├── apiServer.stop()
  └── apiServer.start()  (with new port)
```

## Port Selection Strategy

1. **Default port:** `19519` (mnemonic: "19" for Wotch's release year concept + "519" which is unique enough to avoid conflicts)
2. **Configurable:** `settings.apiPort` overrides the default
3. **Fallback:** If the configured port is busy, try ports 19520-19529. If all fail, log an error and disable the API (do not crash the app).
4. **Port file:** Write the actual listening port to `~/.wotch/api-port` so external tools can discover it without knowing the configured port. This file is deleted on shutdown.

```
Port resolution:
  settings.apiPort (default 19519)
       │
       ▼
  Try listen on 127.0.0.1:<port>
       │
       ├── Success → write ~/.wotch/api-port → ready
       │
       └── EADDRINUSE → try port+1 (up to +10)
              │
              ├── Success → write ~/.wotch/api-port → ready
              │
              └── All failed → log error, apiServer.running = false
```

## Module Structure

All API code lives in a single new file: `src/api-server.js`. This keeps the change surface minimal and avoids scattering API logic across existing files.

```
src/
├── main.js           (modified: import and start ApiServer)
├── preload.js        (modified: add 3 new IPC methods)
├── api-server.js     (NEW: entire API server)
├── renderer.js       (modified: show API status in settings panel)
└── index.html        (modified: API status UI in settings)
```

### `src/api-server.js` — Module Exports

```javascript
class ApiServer {
  constructor(options)  // { ptyProcesses, sshSessions, claudeStatus, getSettings, saveSettings, ... }
  start()              // Returns Promise<void>
  stop()               // Returns Promise<void>
  restart()            // Calls stop() then start()
  getInfo()            // Returns { running, port, token (masked), connections }

  // Called by main.js to push events into WebSocket
  broadcastEvent(type, payload)
}

module.exports = { ApiServer };
```

## Integration with Existing Main Process

The ApiServer receives references to existing objects. It does **not** import them or create its own; `main.js` passes them in during construction.

```javascript
// In main.js, after all managers are initialized:
const { ApiServer } = require('./api-server');

const apiServer = new ApiServer({
  // State references (read-only for most)
  ptyProcesses,          // Map<tabId, ptyProcess>
  sshSessions,           // Map<tabId, sshSession>
  integrationManager,    // ClaudeIntegrationManager (wraps EnhancedClaudeStatusDetector + HookReceiver)
  mainWindow: () => mainWindow,  // Getter (window may be recreated)

  // Functions the API can call
  createPty,             // (tabId, cwd) => tabId
  detectProjects,        // () => Project[]
  gitCheckpoint,         // (projectPath, message) => result
  gitGetStatus,          // (projectPath) => status
  loadSettings: () => ({ ...settings }),
  saveSettingsFn: (newSettings) => { /* same logic as IPC handler */ },
  resetSettingsFn: () => { /* same logic as IPC handler */ },
  setPinned,             // (pinned) => void

  // For WebSocket event broadcasting
  getExpansionState: () => ({ expanded: isExpanded, pinned: isPinned }),
});
```

### Event Hookups

The API needs to broadcast real-time events. Rather than modifying every emitter, we hook into a small number of strategic points:

| Event Source | Hook Point | WebSocket Event |
|---|---|---|
| Claude status changes | `integrationManager.on('status-changed')` — already emits per-tab events | `claude:status` |
| Terminal output | `ptyProc.onData` / `sshStream.on('data')` — add callback | `terminal:output` |
| PTY exit | `ptyProc.onExit` / `sshStream.on('close')` — add callback | `tab:closed` |
| Settings change | `save-settings` IPC handler — add callback | `settings:changed` |
| Git checkpoint | After `gitCheckpoint()` returns — explicit call | `git:checkpoint` |

The cleanest way to hook these is to add an **event emitter** to the ApiServer and have `main.js` call `apiServer.broadcastEvent(type, payload)` at each hook point. This avoids modifying the internal logic of `createPty`.

For Claude status, the `integrationManager` already emits `'status-changed'` events (added in Plan 0), so the API server can listen directly:

```javascript
// Example: Claude status → API WebSocket (uses existing integrationManager event)
integrationManager.on('status-changed', (tabId, status) => {
  if (apiServer) apiServer.broadcastEvent('claude:status', { tabId, ...status });
});

// Example: Terminal output → API WebSocket (inside createPty())
ptyProc.onData((data) => {
  // Existing: send to renderer
  mainWindow.webContents.send("pty-data", { tabId, data });
  // Existing: feed to status detector
  claudeStatus.feed(tabId, data);
  // NEW: broadcast to API WebSocket clients
  if (apiServer) apiServer.broadcastEvent('terminal:output', { tabId, data });
});
```

## HTTP Router Design

The router is a simple pattern matcher:

```javascript
class Router {
  constructor() {
    this.routes = [];  // { method, pattern: RegExp, paramNames: string[], handler }
  }

  add(method, path, handler) {
    // Convert '/v1/tabs/:tabId' → /^\/v1\/tabs\/([^/]+)$/
    // with paramNames = ['tabId']
    const paramNames = [];
    const regexStr = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    this.routes.push({
      method,
      pattern: new RegExp(`^${regexStr}$`),
      paramNames,
      handler,
    });
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method && route.method !== '*') continue;
      const m = pathname.match(route.pattern);
      if (m) {
        const params = {};
        route.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
        return { handler: route.handler, params };
      }
    }
    return null;
  }
}
```

## Request Processing Pipeline

```
Incoming HTTP Request
        │
        ▼
  ┌─────────────────┐
  │ Parse URL        │
  │ (url.parse)      │
  └────────┬─────────┘
           │
           ▼
  ┌─────────────────┐     403 Forbidden
  │ DNS Rebinding   │────────────────────►
  │ Check (Host hdr)│
  └────────┬────────┘
           │ OK
           ▼
  ┌─────────────────┐     405 Method Not Allowed
  │ CORS Preflight  │────────────────────►
  │ (if OPTIONS)    │     (with CORS deny headers)
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐     429 Too Many Requests
  │ Rate Limiter    │────────────────────►
  │ (token bucket)  │
  └────────┬────────┘
           │ OK
           ▼
  ┌─────────────────┐     (skip auth for /v1/health)
  │ Route Match     │
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐     401 Unauthorized
  │ Auth Check      │────────────────────►
  │ (Bearer token)  │
  └────────┬────────┘
           │ OK
           ▼
  ┌─────────────────┐
  │ Parse Body      │
  │ (if POST/PUT/   │
  │  PATCH + JSON)  │
  └────────┬────────┘
           │
           ▼
  ┌─────────────────┐     4xx/5xx
  │ Route Handler   │────────────────────►
  │ (business logic)│
  └────────┬────────┘
           │
           ▼
     200 JSON Response
```

## WebSocket Design

### Connection Flow

```
Client                                  Server
  │                                       │
  │  GET /v1/ws                           │
  │  Connection: Upgrade                  │
  │  Upgrade: websocket                   │
  │  Host: localhost:19519                │
  │──────────────────────────────────────>│
  │                                       │
  │                        DNS rebinding  │
  │                        check on Host  │
  │                                       │
  │  101 Switching Protocols              │
  │<──────────────────────────────────────│
  │                                       │
  │  { "type": "auth", "token": "..." }  │
  │──────────────────────────────────────>│
  │                                       │
  │         Validate token                │
  │                                       │
  │  { "type": "auth:ok" }               │
  │<──────────────────────────────────────│
  │                                       │
  │  { "type": "subscribe",              │
  │    "events": ["claude:status"] }      │
  │──────────────────────────────────────>│
  │                                       │
  │  { "type": "subscribe:ok",           │
  │    "events": ["claude:status"] }      │
  │<──────────────────────────────────────│
  │                                       │
  │  (server pushes events as they occur) │
  │                                       │
  │  { "type": "claude:status",          │
  │    "data": { ... } }                  │
  │<──────────────────────────────────────│
  │                                       │
```

### Authentication

WebSocket connections authenticate via a message after the upgrade (not via query parameters or headers, to avoid token leakage in server logs and proxy caches). The client has 5 seconds after connection to send a valid `auth` message. If not authenticated within 5 seconds, the server closes the connection with code 4001.

### Subscription Model

Clients can subscribe to specific event types or `["*"]` for all events. The subscription is stored per-connection. Events not in the subscription list are not sent (reduces bandwidth for clients that only care about status).

### Heartbeat

The server sends a `ping` frame every 30 seconds. Clients that don't respond with `pong` within 10 seconds are disconnected. This prevents half-open connections from accumulating.

## New IPC Channels

Three new IPC channels are added for the renderer to interact with the API server:

| Channel | Direction | Purpose |
|---|---|---|
| `api-get-info` | renderer → main (invoke) | Returns `{ running, port, tokenMasked, connections }` |
| `api-copy-token` | renderer → main (invoke) | Returns the full token string (for clipboard copy) |
| `api-regenerate-token` | renderer → main (invoke) | Generates a new token, disconnects all WS clients, returns masked token |

These are added to `preload.js` as named methods on `window.wotch`:

```javascript
// In preload.js
apiGetInfo: () => ipcRenderer.invoke('api-get-info'),
apiCopyToken: () => ipcRenderer.invoke('api-copy-token'),
apiRegenerateToken: () => ipcRenderer.invoke('api-regenerate-token'),
```

## Settings Additions

Two new fields in `DEFAULT_SETTINGS`:

```javascript
const DEFAULT_SETTINGS = {
  // ... existing fields ...
  apiEnabled: true,    // Whether the API server starts with the app
  apiPort: 19519,      // Port to listen on (will try +1 through +10 on conflict)
};
```

## Terminal Buffer Access

Plan 0 implemented a terminal buffer read mechanism via IPC round-trip: the main process sends a `terminal-buffer-read` event to the renderer, which reads from the xterm.js `Terminal.buffer.active` and responds via `terminal-buffer-response`. This is already used by the MCP server's `wotch_terminal_buffer` tool.

The API server can reuse this same mechanism for `GET /v1/tabs/:tabId/buffer`. For higher-throughput API use, a second rolling buffer can be added to each PTY/SSH session, capped at 50KB (roughly 1000 lines of 50 chars). This buffer would be stored on the ApiServer itself:

```javascript
// Inside ApiServer
this.terminalBuffers = new Map();  // tabId → { data: string, maxSize: 50000 }

// Called from main.js hooks
addTerminalData(tabId, data) {
  let buf = this.terminalBuffers.get(tabId);
  if (!buf) {
    buf = { data: '' };
    this.terminalBuffers.set(tabId, buf);
  }
  buf.data += data;
  if (buf.data.length > 50000) {
    buf.data = buf.data.slice(-50000);
  }
}
```

## Error Handling

All route handlers are wrapped in try/catch. Unhandled errors return:

```json
{
  "error": "Internal server error",
  "code": "INTERNAL_ERROR"
}
```

with status 500. The actual error is logged to console but never sent to the client (to avoid leaking stack traces or internal paths).

## Graceful Degradation

If the API server fails to start (port conflict, permission error), the rest of Wotch continues to function normally. The API is an additive feature -- its failure must never affect the core terminal experience. This is enforced by wrapping `apiServer.start()` in try/catch in `main.js`.
