# Plan 1: Wotch Local API

## Overview

Expose Wotch's internal capabilities through a localhost-only HTTP + WebSocket API. External tools -- VS Code extensions, shell scripts, monitoring dashboards, custom automation -- can query Claude Code status, manage tabs, trigger checkpoints, and subscribe to real-time events without interacting with the UI.

## Goals

1. **Programmatic access to all Wotch capabilities.** Anything the renderer can do via `window.wotch`, the API should expose (with the exception of UI-only operations like window resize and expansion state).
2. **Real-time event streaming.** WebSocket connections receive Claude status changes, terminal output, git updates, and tab lifecycle events as they happen.
3. **Secure by default.** Bearer token authentication, DNS rebinding protection, and localhost-only binding ensure that only authorized local processes can access the API.
4. **Zero-configuration startup.** The API server starts automatically with Wotch. The token is auto-generated on first run and stored at `~/.wotch/api-token`.
5. **Stable versioned contract.** All endpoints live under `/v1/` so future breaking changes can coexist via `/v2/`.

## Scope

### In scope

- Localhost HTTP server (Node.js `http` module) running in the Electron main process
- REST endpoints for: health/info, Claude status, tabs, terminal I/O, checkpoints, projects, settings
- WebSocket server for real-time events (status changes, terminal output, git updates, tab lifecycle, settings changes)
- Bearer token authentication for both HTTP and WebSocket
- DNS rebinding protection via Host header validation
- CORS policy (deny all cross-origin by default)
- Rate limiting (simple in-memory token bucket)
- API token generation, storage (`~/.wotch/api-token`), and regeneration
- Port selection (configurable in settings with fallback auto-detection)
- New IPC channels so the renderer can display API status and copy the token
- Settings additions: `apiEnabled`, `apiPort`

### Out of scope (non-goals for this plan)

- **Remote/network access.** The server binds to `127.0.0.1` only. Never `0.0.0.0`.
- **TLS/HTTPS.** Localhost traffic does not need encryption. If network access is added later (Plan 3+), TLS becomes a requirement.
- **User accounts or multi-user auth.** Single-user desktop app; one token per machine.
- **GraphQL or gRPC.** REST + WebSocket is sufficient for this use case.
- **Renderer-side API client.** The renderer continues to use IPC. The API is for external consumers only.
- **OpenAPI spec auto-generation.** The spec in `02-endpoints.md` is the source of truth.
- **Plugin system hooks.** Those come in Plan 3.

## Success Criteria

1. `curl http://localhost:<port>/v1/health` returns 200 with version info (no auth required for health).
2. `curl -H "Authorization: Bearer <token>" http://localhost:<port>/v1/status` returns per-tab Claude status matching what the pill displays.
3. A WebSocket client connected to `ws://localhost:<port>/v1/ws` receives real-time `claude:status` events within 200ms of the status changing in the detector.
4. `curl -X POST .../v1/tabs` creates a new terminal tab; the tab appears in the Wotch UI.
5. `curl -X POST .../v1/checkpoints` creates a git checkpoint identical to clicking "Checkpoint" in the UI.
6. All endpoints return 401 without a valid bearer token (except `/v1/health`).
7. Requests with a `Host` header other than `localhost`, `127.0.0.1`, or `[::1]` (plus port) are rejected with 403.
8. The API server starts and stops cleanly with the app lifecycle. No orphaned listeners or port conflicts on restart.
9. Terminal buffer read returns the last N lines of xterm content for a given tab.
10. Settings can be read and updated via the API, and changes are reflected in the UI immediately.

## Dependency: Plan 0 (Claude Code Deep Integration)

Plan 1 benefits significantly from Plan 0's structured integration channels. With Plan 0 in place:

- **`/v1/status` endpoint** returns hook-sourced or bridge-sourced structured status instead of regex-guessed state. The response includes tool name, file path, and line number when available.
- **WebSocket `claude:status` events** carry the enhanced status object (state + source + tool + file) rather than just a state string.
- **`/v1/terminal/buffer` endpoint** can leverage the MCP server's terminal buffer reading infrastructure instead of implementing it from scratch.
- **Real-time events** from hooks and bridge can be forwarded directly to API WebSocket subscribers with minimal transformation.

If Plan 0 is not yet implemented, Plan 1 falls back to the existing regex-based status detection. All API contracts work either way — the response payloads simply have fewer fields.

---

## Architecture Summary

See `01-architecture.md` for the full design. In brief:

```
External Tool                  Wotch Main Process
  |                                |
  |  HTTP/WS (localhost:19519)     |
  |------------------------------->|  ApiServer (http + ws)
  |                                |     |
  |                                |     +--> reads ptyProcesses Map
  |                                |     +--> reads claudeStatus detector
  |                                |     +--> calls gitCheckpoint/gitGetStatus
  |                                |     +--> calls detectProjects()
  |                                |     +--> reads/writes settings
  |                                |     +--> emits events via WebSocket
  |                                |
  |  IPC (existing)                |
  |  Renderer <------------------->|
```

The API server runs **in the main process** (same as the PTY manager, SSH manager, etc.) and directly accesses the existing in-memory state. No IPC indirection is needed for data that already lives in the main process.

## Dependencies

New npm dependencies:

| Package | Purpose | Size |
|---------|---------|------|
| `ws` | WebSocket server (lightweight, no native deps) | ~50KB |

No other dependencies. The HTTP server uses Node.js built-in `http` module. Routing is hand-rolled (the API surface is small enough that a framework adds no value and increases attack surface).

## File Map

| Document | Contents |
|----------|----------|
| `01-architecture.md` | Server design, integration points, ASCII diagrams |
| `02-endpoints.md` | Complete REST API specification |
| `03-websocket-events.md` | WebSocket event types and schemas |
| `04-security.md` | Auth, DNS rebinding, CORS, rate limiting, redaction |
| `05-implementation-steps.md` | Step-by-step build guide with exact file changes |
