# Security Design: Wotch Local API

## Threat Model

The Wotch Local API binds to `127.0.0.1` only. The primary threats are:

1. **DNS rebinding attacks:** A malicious website in the user's browser makes requests to `http://localhost:19519` using a DNS rebinding trick, bypassing same-origin policy.
2. **Malicious local processes:** Another process on the machine reads the API token from `~/.wotch/api-token` and uses the API.
3. **Token leakage:** The token appears in logs, process arguments, browser history, or error messages.
4. **Data exposure:** The API exposes sensitive information (SSH credentials, private keys, API keys found in terminal output).

Threats 1 and 3 are fully mitigated. Threat 2 is accepted as inherent to local APIs (any process with the user's UID can already read their files, inject keystrokes, etc.). Threat 4 is mitigated by explicit redaction policies.

---

## Token Generation and Storage

### Token Format

```
wotch_<64 hex characters>
```

Example: `wotch_a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1`

The `wotch_` prefix makes it easy to identify in logs and to write `.gitignore` rules. The 64 hex characters provide 256 bits of entropy (generated via `crypto.randomBytes(32).toString('hex')`).

### Generation

The token is generated once on first run and stored at `~/.wotch/api-token`. If the file does not exist when the API server starts, a new token is generated.

```javascript
function loadOrGenerateToken() {
  const tokenPath = path.join(os.homedir(), '.wotch', 'api-token');
  try {
    const existing = fs.readFileSync(tokenPath, 'utf-8').trim();
    if (existing.startsWith('wotch_') && existing.length === 71) {
      return existing;
    }
    // Invalid format -- regenerate
  } catch {
    // File doesn't exist -- generate
  }

  const token = 'wotch_' + crypto.randomBytes(32).toString('hex');
  const dir = path.join(os.homedir(), '.wotch');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(tokenPath, token + '\n', { encoding: 'utf-8', mode: 0o600 });
  return token;
}
```

### File Permissions

The token file is written with mode `0o600` (owner read/write only). On creation, the `~/.wotch` directory should already exist (created by the settings manager) with default permissions.

### Token Regeneration

The `api-regenerate-token` IPC handler (exposed as `window.wotch.apiRegenerateToken()` in the renderer):

1. Generates a new token using the same logic as above.
2. Writes it to `~/.wotch/api-token` (mode 0o600).
3. Disconnects all active WebSocket clients with close code `4004` ("Token revoked").
4. Returns the masked token to the renderer.

### Token Masking

When displaying the token in the UI or in the `GET /v1/info` response, it is masked:

```
wotch_a3f8...f0a1
```

Show the prefix plus first 4 and last 4 hex characters. The full token is only returned by the `api-copy-token` IPC handler (for clipboard copy).

---

## Authentication Flow

### HTTP Requests

All endpoints except `GET /v1/health` require the `Authorization` header:

```
Authorization: Bearer wotch_a3f8b2c1d4e5...
```

**Validation logic:**

```javascript
function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(parts[1]),
    Buffer.from(apiToken)
  );
}
```

**Important:** Use `crypto.timingSafeEqual` for token comparison. A naive `===` comparison leaks information about the token through timing differences.

**Failed auth response (401):**

```json
{
  "ok": false,
  "error": "Invalid or missing authentication token",
  "code": "UNAUTHORIZED"
}
```

The response must not indicate whether the token was missing, malformed, or incorrect (to avoid enumeration).

### WebSocket Connections

WebSocket connections use message-based auth after the upgrade (see `03-websocket-events.md`). The token is **not** sent in query parameters or HTTP headers during the upgrade to avoid it appearing in server access logs or proxy caches.

The 5-second auth timeout prevents unauthenticated connections from consuming resources.

---

## DNS Rebinding Protection

### The Attack

1. Attacker registers `evil.com` with a short DNS TTL.
2. User visits `evil.com` in their browser.
3. JavaScript on `evil.com` makes a fetch to `evil.com:19519/v1/status`.
4. DNS for `evil.com` now resolves to `127.0.0.1`.
5. The browser sends the request to `localhost:19519` with `Host: evil.com`.
6. Without protection, the API server would respond -- the attacker now has the data.

### Mitigation

Validate the `Host` header on **every** request (HTTP and WebSocket upgrade). Only allow:

- `localhost`
- `localhost:<port>`
- `127.0.0.1`
- `127.0.0.1:<port>`
- `[::1]`
- `[::1]:<port>`

**Implementation:**

```javascript
const ALLOWED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

function validateHost(req) {
  const host = req.headers['host'];
  if (!host) return false;
  // Strip port if present
  const hostWithoutPort = host.replace(/:\d+$/, '');
  return ALLOWED_HOSTS.has(hostWithoutPort);
}
```

**Failed validation response (403):**

```json
{
  "ok": false,
  "error": "Forbidden",
  "code": "FORBIDDEN"
}
```

This check runs **before** authentication, before routing, before everything. It is the first line of defense.

### WebSocket Upgrade

The `ws` library's `verifyClient` callback is used to validate the Host header before the upgrade completes:

```javascript
const wss = new WebSocketServer({
  noServer: true,  // We handle the upgrade manually
});

httpServer.on('upgrade', (req, socket, head) => {
  if (!validateHost(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  // Check path
  if (req.url !== '/v1/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
```

---

## CORS Policy

The API server sets restrictive CORS headers on all responses:

```javascript
function setCorsHeaders(res) {
  // Deny all cross-origin requests
  // Do NOT set Access-Control-Allow-Origin at all
  // This means browsers will block cross-origin responses
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}
```

For `OPTIONS` preflight requests:

```javascript
if (req.method === 'OPTIONS') {
  res.writeHead(204, {
    'Content-Length': '0',
    // Explicitly deny cross-origin
    // No Access-Control-Allow-Origin header
  });
  res.end();
  return;
}
```

By **not** setting `Access-Control-Allow-Origin`, browsers will block all cross-origin responses. The API is only intended for same-origin use by local processes (curl, Node.js scripts, VS Code extensions) that are not subject to CORS.

---

## Rate Limiting

### Strategy

Simple in-memory token bucket per IP address. Since all traffic comes from `127.0.0.1`, this effectively limits total request rate.

### Configuration

| Parameter | Value | Rationale |
|---|---|---|
| Bucket capacity | 100 requests | Enough for burst activity |
| Refill rate | 20 requests/second | Comfortable for normal use |
| Applies to | All authenticated endpoints | Health check is exempt |

### Implementation

```javascript
class RateLimiter {
  constructor(capacity = 100, refillRate = 20) {
    this.capacity = capacity;
    this.refillRate = refillRate;  // tokens per second
    this.buckets = new Map();     // ip → { tokens, lastRefill }
  }

  allow(ip) {
    const now = Date.now();
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(ip, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }
}
```

**Rate-limited response (429):**

```json
{
  "ok": false,
  "error": "Too many requests",
  "code": "RATE_LIMITED"
}
```

Headers on 429 response:

```
Retry-After: 1
```

### WebSocket Rate Limiting

WebSocket messages are rate-limited separately: max 50 messages per second per connection. If exceeded, the server sends:

```json
{
  "type": "error",
  "message": "Rate limited",
  "code": "RATE_LIMITED"
}
```

Messages that exceed the limit are silently dropped (not queued).

---

## Data Exposure and Redaction

### What the API Exposes

| Data | Exposed Via | Risk Level | Mitigation |
|---|---|---|---|
| Claude status (state, description) | `GET /v1/status`, WebSocket | Low | None needed |
| Terminal output | `GET /v1/tabs/:id/buffer`, WebSocket | **Medium** | See below |
| File paths | Status descriptions | Low | None needed |
| Settings (dimensions, theme) | `GET /v1/settings` | Low | None needed |
| SSH profile metadata | Never | -- | Excluded entirely |
| SSH passwords/keys | Never | -- | Never stored; never exposed |
| Git diff content | `GET /v1/git/diff` | Low-Medium | Read-only |
| Project paths | `GET /v1/projects` | Low | None needed |

### Terminal Output Exposure

Terminal output may contain sensitive data typed or displayed by the user (passwords, API keys, secrets). The API makes a deliberate choice:

**Terminal buffer and WebSocket output are exposed as-is (no server-side redaction).**

Rationale:
1. The user already sees this data in their terminal. The API does not expose data the user cannot already see.
2. Server-side regex-based redaction is unreliable and creates a false sense of security.
3. The bearer token is the access control gate. If an attacker has the token, they can also read `~/.wotch/api-token` directly (same privilege level).

### Fields Always Redacted

The following are **never** included in any API response or WebSocket event:

| Field | Where It Exists | Why Redacted |
|---|---|---|
| `settings.sshProfiles` | In-memory `settings` object | Contains SSH hostnames, usernames, key paths -- profile metadata |
| SSH passwords | Transient in `createSshSession()` | INV-SEC-005: never stored or transmitted |
| SSH private key contents | Read from disk in `createSshSession()` | INV-SEC-005: never stored |
| API token (full) | `~/.wotch/api-token` file | Only accessible via `api-copy-token` IPC, never via REST |

### `GET /v1/settings` Redaction

The settings endpoint returns all settings **except** `sshProfiles`:

```javascript
function getRedactedSettings() {
  const s = { ...settings };
  delete s.sshProfiles;
  return s;
}
```

### `PATCH /v1/settings` Rejection

If the request body contains `sshProfiles`, the server returns 422:

```json
{
  "ok": false,
  "error": "sshProfiles cannot be modified via the API",
  "code": "VALIDATION_ERROR"
}
```

---

## New Security Invariants

Add these to `docs/INVARIANTS.md`:

> **Note:** INV-SEC-006 through INV-SEC-008 are already assigned to Plan 0 (Hook Receiver Localhost Binding, MCP Tools Non-Destructive, MCP IPC Localhost Binding). Plan 1 invariants start at INV-SEC-009.

### INV-SEC-009: API Localhost Binding

The API server must bind exclusively to `127.0.0.1`. It must never listen on `0.0.0.0`, `::`, or any network interface. The `server.listen()` call must always specify `'127.0.0.1'` as the hostname.

**Rationale:** Network-accessible API with bearer token auth (no TLS) would expose the token and all terminal data to network sniffers.

**Enforcement:** Code review. The listen call must include the hostname parameter.

### INV-SEC-010: API Token Storage Permissions

The `~/.wotch/api-token` file must be written with mode `0o600` (owner read/write only). The token must never be logged, sent to the renderer (except via explicit `api-copy-token` IPC), or included in error messages.

**Rationale:** The token is the sole authorization mechanism for the API. Exposure compromises all API-accessible data.

**Enforcement:** Code review. Check `fs.writeFileSync` calls for the token file.

### INV-SEC-011: DNS Rebinding Protection

Every HTTP request and WebSocket upgrade must validate the `Host` header against a whitelist of localhost aliases (`localhost`, `127.0.0.1`, `[::1]`, with optional port). Requests with any other Host value must be rejected with 403 before any processing occurs.

**Rationale:** DNS rebinding attacks can bypass the localhost binding by making the browser send requests to `127.0.0.1` with a malicious Host header.

**Enforcement:** Code review. The validation function must run before routing, auth, and body parsing.

### INV-SEC-012: API Token Comparison

API token comparison must use `crypto.timingSafeEqual()`, not `===` or `.includes()`. This applies to both HTTP bearer token validation and WebSocket auth message validation.

**Rationale:** Timing side-channels in string comparison can leak token bytes one at a time.

**Enforcement:** Code review.

### INV-SEC-013: No SSH Profile Exposure via API

The API must never include `settings.sshProfiles` in any response or WebSocket event. The `GET /v1/settings` endpoint must strip it. The `PATCH /v1/settings` endpoint must reject it. The `settings:changed` WebSocket event must exclude it.

**Rationale:** SSH profiles contain hostnames, usernames, and key file paths. Combined with terminal access, this could facilitate lateral movement by a compromised local process.

**Enforcement:** Code review. Grep for `sshProfiles` in `api-server.js`.

---

## Security Checklist

Before merging the Local API implementation, verify:

- [ ] `server.listen()` specifies `'127.0.0.1'` as the hostname
- [ ] Host header validation runs on every HTTP request and WebSocket upgrade
- [ ] Token comparison uses `crypto.timingSafeEqual()`
- [ ] Token file is written with mode `0o600`
- [ ] Token is never logged (search for `console.log` containing token variable)
- [ ] `sshProfiles` is never present in any JSON response
- [ ] Rate limiter is applied to all authenticated endpoints
- [ ] WebSocket auth timeout is enforced (5 seconds)
- [ ] WebSocket connections are limited (max 10)
- [ ] No `Access-Control-Allow-Origin` header is set on any response
- [ ] All error responses use generic messages (no stack traces, no internal paths)
- [ ] The `api-port` file is cleaned up on shutdown
- [ ] `preload.js` additions follow INV-SEC-003 (named channels only)
