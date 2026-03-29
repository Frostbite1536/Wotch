# Implementation Steps — Wotch Local API

## Step 1: Install Dependencies

**Files:** `package.json`

```bash
npm install ws
```

Add `ws` (lightweight WebSocket library) as the only new dependency. The HTTP server uses Node's built-in `http` module.

**Testing:** `npm install` completes without errors.

---

## Step 2: Token Generation and Management

**Files:** `src/main.js`

Create a token manager that generates and stores a bearer token at `~/.wotch/api-token`.

```js
const API_TOKEN_PATH = path.join(os.homedir(), '.wotch', 'api-token');

function ensureApiToken() {
  try {
    const existing = fs.readFileSync(API_TOKEN_PATH, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(API_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(API_TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

function regenerateApiToken() {
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(API_TOKEN_PATH, token, { mode: 0o600 });
  return token;
}
```

**Imports needed:** `crypto` (add to existing imports at top of main.js).

**Testing:**
1. Call `ensureApiToken()` — verify file created at `~/.wotch/api-token`
2. File permissions should be `0600` (owner read/write only)
3. Token should be 64-character hex string
4. Calling again returns the same token
5. `regenerateApiToken()` creates a new, different token

---

## Step 3: HTTP Server Core

**Files:** `src/main.js`

Create the HTTP server that starts when the app launches (configurable via settings).

- Bind to `127.0.0.1` only (INV-SEC-006)
- DNS rebinding protection via Host header validation
- Bearer token auth on all requests
- CORS headers for local development tools
- WebSocket server on same port via `ws`

**Settings additions** (add to `DEFAULT_SETTINGS`):
```js
apiEnabled: false,
apiPort: 9222,
```

**Lifecycle:** Call `startApiServer()` after `app.whenReady()`. Call `stopApiServer()` in `app.on('will-quit')`.

**Testing:**
1. Set `apiEnabled: true` in settings
2. Launch app — server starts on port 9222
3. `curl http://127.0.0.1:9222/v1/health` without auth → 401
4. `curl -H "Authorization: Bearer $(cat ~/.wotch/api-token)" http://127.0.0.1:9222/v1/health` → 200
5. Request with `Host: evil.com` header → 403

---

## Step 4: REST API Router and Endpoint Handlers

**Files:** `src/main.js`

Implement the URL router and all endpoint handlers. Endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/health` | Server status, version, uptime |
| GET | `/v1/status` | Claude status for all tabs |
| GET | `/v1/tabs` | List active tabs |
| POST | `/v1/tabs` | Create new tab |
| DELETE | `/v1/tabs/:id` | Kill tab |
| GET | `/v1/tabs/:id/buffer` | Get terminal buffer (last N lines) |
| POST | `/v1/tabs/:id/write` | Write to terminal |
| POST | `/v1/checkpoints` | Create git checkpoint |
| GET | `/v1/checkpoints` | List checkpoints |
| GET | `/v1/projects` | Detect projects |
| GET | `/v1/git/status` | Git status for project |
| GET | `/v1/git/diff` | Git diff for project |
| GET | `/v1/settings` | Get settings (redacted) |
| PUT | `/v1/settings` | Update settings |

Bridge functions reuse existing main.js logic (PTY management, git operations, project detection). Settings endpoint strips `sshProfiles` before returning (INV-SEC-009).

**Testing:** Each endpoint responds correctly with proper HTTP status codes and JSON bodies. 404 for unknown routes.

---

## Step 5: WebSocket Event Streaming

**Files:** `src/main.js`

Implement WebSocket connection handling with auth and event broadcasting.

- Auth via query param (`?token=...`) or first message (`{ type: "auth", token: "..." }`)
- Subscription-based: clients subscribe to event types
- Default subscriptions: `status`, `tabs`
- Opt-in high-volume: `terminal`, `git`, `settings`

**Integration points** — Add `broadcastApiEvent()` calls to:
- Claude Status Detector `broadcast()` → `status` events
- PTY onData handler → `terminal` events
- Tab create/close → `tabs` events
- Git checkpoint → `git` events
- Settings save → `settings` events

**Testing:**
1. Connect with `wscat -c "ws://127.0.0.1:9222?token=<token>"`
2. Receive `status` events when Claude state changes
3. Subscribe/unsubscribe to event types
4. Invalid token → connection closed with 4001

---

## Step 6: Rate Limiting

**Files:** `src/main.js`

Simple in-memory rate limiting: 120 requests per 60-second window per IP.

**Testing:** 121 rapid requests → 121st returns 429. Wait 60 seconds → works again.

---

## Step 7: Settings UI for API Toggle

**Files:** `src/index.html`, `src/renderer.js`, `src/preload.js`

Add "Local API" section to settings panel with:
- Enable/disable toggle
- Port number input
- API token display (show/hide/copy/regenerate)

**New IPC channels:** `get-api-token`, `regenerate-api-token`

**Testing:** Toggle enable → server starts. Show/copy/regenerate token works.

---

## Step 8: API Server Restart on Settings Change

**Files:** `src/main.js`

When API settings change (enabled/disabled, port), restart the server.

**Testing:** Enable → server starts. Disable → stops. Change port → restarts on new port.

---

## Step 9: Command Palette Integration

**Files:** `src/renderer.js`

Add "Copy API Token" and "Toggle API Server" to the command palette.

---

## Step 10: New Invariants

**Files:** `docs/INVARIANTS.md`

- **INV-SEC-006:** API Server Localhost Only — bind to `127.0.0.1` only
- **INV-SEC-007:** API Token File Permissions — mode `0600`, 32+ random bytes
- **INV-SEC-008:** API DNS Rebinding Protection — validate Host header
- **INV-SEC-009:** API Data Redaction — never expose SSH credentials or API token via endpoints

---

## Summary of Changes by File

| File | Changes |
|------|---------|
| `package.json` | Add `ws` dependency |
| `src/main.js` | Token manager, HTTP server, REST router, WebSocket handler, rate limiter, API IPC handlers, broadcast integration |
| `src/preload.js` | Add `getApiToken`, `regenerateApiToken` IPC methods |
| `src/index.html` | Add API settings section to settings panel |
| `src/renderer.js` | API settings wiring, command palette commands |
| `docs/INVARIANTS.md` | Add INV-SEC-006 through INV-SEC-009 |
