# Wotch Mobile — Desktop API Integration Opportunity

_Authored: 2026-04-02._

## Overview

The mobile app currently speaks to a hand-rolled **bridge server** (`server/index.js`)
that must be installed manually on each VPS. The bridge is a dumb byte-pipe: it
opens a PTY and forwards raw terminal bytes over WebSocket. It knows nothing about
Claude Code's state, git history, tab count, or checkpoints.

Meanwhile, the desktop Wotch app runs its own **HTTP + WebSocket API server** on
port 19519 (configurable). This API is authenticated, rate-limited, and already
exposes a rich data model specifically designed for external consumers.

**Mobile never connects to it.** This is the largest single missed opportunity in
the current mobile architecture.

---

## What the Desktop API Provides

### REST Endpoints (port 19519, Bearer token auth)

| Endpoint | Data Available |
|---|---|
| `GET /v1/status` | Aggregate + per-tab Claude status, with state, description, source |
| `GET /v1/status/:tabId` | Single tab status |
| `GET /v1/tabs` | All open tabs (name, cwd, aiType, state) |
| `POST /v1/tabs` | Open a new tab |
| `DELETE /v1/tabs/:tabId` | Close a tab |
| `GET /v1/tabs/:tabId/buffer` | Last N lines of terminal output (raw or ANSI-stripped) |
| `POST /v1/tabs/:tabId/input` | Send input to a tab |
| `POST /v1/checkpoints` | Create a git checkpoint |
| `GET /v1/checkpoints` | List checkpoints for a project |
| `GET /v1/git/status` | Branch, changed files, last commit |
| `GET /v1/git/diff` | Diff since last checkpoint |
| `GET /v1/projects` | Auto-detected projects (VS Code, JetBrains, Xcode, ~/Projects) |
| `GET /v1/settings` | Current settings (SSH profiles redacted) |
| `PATCH /v1/settings` | Update settings |
| `GET /v1/health` | Uptime, version |
| `GET /v1/info` | Platform, tab count, API status |

### WebSocket Events (`/v1/ws`)

| Event | Payload |
|---|---|
| `claude:status` | Real-time aggregate + per-tab status updates (debounced 150 ms) |
| `terminal:output` | Streaming terminal bytes as they arrive |
| `tab:lifecycle` | Tab opened/closed |
| `git:checkpoint` | Checkpoint creation confirmation |
| `settings:changed` | Settings updated |

### Authentication

The desktop API token is stored at `~/.wotch/api-token` (0600 permissions).
The user needs to share this token with the mobile app once — the same pattern
already used by the bridge server. Timing-safe comparison is already implemented
on the desktop side.

---

## What a Desktop API Connection Would Unlock

### Immediate benefits (no new desktop code required)

1. **Accurate hook-quality status** — `GET /v1/status` returns the fused
   hooks + regex state, including tool names, file paths, and `aiType`. Mobile
   gets this for free the moment it reads from the API instead of parsing raw bytes.

2. **Tab listing** — `GET /v1/tabs` shows all open terminal tabs with their
   individual states. Mobile could display a tab switcher showing which tab Claude
   is working in without being connected to that tab's byte stream.

3. **Git status and checkpoints** — `GET /v1/git/status` and
   `GET /v1/checkpoints` are already implemented. Mobile could show a "last
   checkpoint" line and a changed-file count without any new desktop code.

4. **Terminal buffer** — `GET /v1/tabs/:tabId/buffer` returns up to 500 lines
   of recent output. Mobile could populate its terminal view immediately on connect
   rather than seeing a blank screen until new output arrives.

5. **Multi-tab aggregate** — The `/v1/status` aggregate is already computed and
   broadcast. Mobile's connection-list screen would show correct states for all tabs
   without needing a separate WebSocket per tab.

6. **aiType in notifications** — The API status payload includes `aiType`
   ("claude" / "gemini"). Mobile notification text would be correct automatically.

---

## Proposed Architecture

```
┌─────────────────────────────┐        LAN / VPN / Tailscale
│  Wotch Desktop (macOS/Win)  │ ◄────────────────────────────── iPhone
│                             │        port 19519
│  ┌──────────────────────┐  │        Bearer token
│  │  API Server          │  │
│  │  REST + WebSocket     │  │
│  └──────────────────────┘  │
│  ┌──────────────────────┐  │
│  │  HookReceiver (19520) │  │ ◄── Claude Code hooks
│  └──────────────────────┘  │
│  ┌──────────────────────┐  │
│  │  EnhancedDetector     │  │
│  └──────────────────────┘  │
└─────────────────────────────┘
```

The phone connects to the desktop machine's API server directly. No bridge server
software required. The desktop is already listening; the mobile just needs a new
connection type.

---

## Implementation Plan

### Phase A — Read-only status monitoring (highest value, lowest effort)

Add a second connection type to the mobile app: **"Wotch Desktop"** alongside the
existing **"VPS Bridge"**.

**New profile fields:**
```typescript
type WotchDesktopProfile = {
  id: string;
  name: string;
  host: string;        // desktop machine IP or hostname
  port: number;        // default 19519
  token: string;       // from ~/.wotch/api-token
  useTLS: boolean;
};
```

**New service: `WotchApiClient.ts`**
- `GET /v1/status` on connect, then subscribe to `claude:status` WebSocket events.
- `GET /v1/tabs` to populate a tab-switcher view.
- `GET /v1/git/status` for the git bar.
- `GET /v1/tabs/:tabId/buffer` on tab open to pre-fill terminal.
- Subscribe to `terminal:output` for live streaming.

The existing `ClaudeStatusDetector.ts` regex engine is **not needed** for this
connection type — the desktop already provides parsed, fused state. Status data
from `/v1/status` can be consumed directly.

**UI additions needed:**
- Profile editor: add a "Connection type" toggle (VPS Bridge / Wotch Desktop).
- Connections list: show a different icon for Desktop connections.
- Terminal view: show tab switcher when connected to Desktop (uses `GET /v1/tabs`).
- Git bar: show branch + changed files (uses `GET /v1/git/status`).

### Phase B — Actions (send input, checkpoints)

- `POST /v1/tabs/:tabId/input` — already implemented on desktop. Mobile terminal
  input can route through this instead of the bridge's raw byte pipe.
- `POST /v1/checkpoints` — add a "checkpoint" button to the terminal toolbar.

### Phase C — Notifications via the API stream

Subscribe to `claude:status` WebSocket events in a background task. When state
transitions to `done` or `error`, fire a local iOS notification. The `aiType`
field in the event payload ensures correct labeling with no extra work.

---

## Backward Compatibility

The bridge server connection type should be **kept**. It serves a different use
case: monitoring a Claude Code session on a remote VPS where the desktop Wotch app
is not running. Both connection types should coexist in the profile list.

The bridge server itself could eventually be upgraded to proxy the desktop API
format (instead of raw bytes), but that is lower priority than implementing the
direct Desktop connection mode.

---

## Risks

| Risk | Mitigation |
|---|---|
| Desktop API server not running | Check `GET /v1/health` on connect; show clear "Wotch API is not running" error state |
| LAN access unavailable (away from home) | Document Tailscale as the recommended remote-access solution; it works with the existing token auth |
| Port 19519 firewalled | User configures `apiPort` in desktop settings and enters matching port in mobile profile |
| Token distribution | User copies token from `~/.wotch/api-token` once; same friction as bridge server token |
