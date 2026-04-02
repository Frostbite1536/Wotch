# Wotch Mobile — Desktop Feature Gap Analysis

_Authored: 2026-04-02. Based on desktop state after Gemini CLI integration._

This document compares every feature area of the desktop Wotch app against the
current mobile app. Each section identifies what exists on desktop, what exists
on mobile, and the practical consequence of the gap.

---

## 1. Status Detection

### Desktop
Two-source fusion: Claude Code posts 24 structured lifecycle events via HTTP hooks
(`HookReceiver` on port 19520), giving precise state with tool name, file path, and
line number. Regex fallback activates when hooks are silent. An `EnhancedClaudeStatusDetector`
fuses both sources with timeout-based priority (hooks win for 15 s; regex fallback active
for 5 s). Tool verbs are mapped to human descriptions ("Bash → Running command",
"Edit → Editing", "Grep → Searching", etc.).

As of the Gemini CLI update, the detector also tracks `aiType` per tab
(`"claude"` | `"gemini"` | `null`) and labels notifications accordingly.

### Mobile
Regex only. The `ClaudeStatusDetector.ts` service is a TypeScript port of the
original desktop regex patterns, but it:

- Has no hooks channel.
- Has no `aiType` tracking; Gemini CLI output is not recognized.
- Has none of the Gemini-related pattern fixes (the `◆` line-anchor, the
  removal of `/google.*ai/i`, the tighter `/Gemini CLI/i` activation pattern).
- Has no tool-verb mapping; descriptions are sparse compared to desktop.

### Consequence
Mobile status accuracy is lower than desktop. Gemini CLI sessions on a VPS will
show "idle" instead of the correct state. Rich descriptions ("Editing auth.ts")
are absent.

---

## 2. Connection Architecture

### Desktop
Runs entirely locally. The Electron main process spawns PTYs directly via
`node-pty`. The optional API server (port 19519) exposes a REST+WebSocket interface
for external consumers but is not the primary path.

### Mobile
Connects to a custom **bridge server** (`server/index.js`) that must be manually
installed on the VPS. The bridge proxies WebSocket frames to/from a `node-pty`
process. The mobile app never speaks to Wotch's own API server.

### Consequence
There is an entirely unused connection mode: mobile connecting directly to the
**Wotch desktop API** (port 19519) over LAN or VPN. This would give mobile access
to the desktop's rich data model (tab listing, checkpoint history, git status, hook
events, buffer reads) without running any extra software. See
[`DESKTOP_API_INTEGRATION.md`](./DESKTOP_API_INTEGRATION.md) for full analysis.

---

## 3. Notifications

### Desktop
Electron `Notification` API fires when Claude transitions from
thinking/working → done/error while the window is unfocused. Notification body
uses the `aiType`-aware label ("Gemini finished: …" vs "Claude finished: …").
Budget alerts fire at 80 % and 100 % of the monthly API spend cap.

### Mobile
No notifications implemented. The feature is acknowledged in the roadmap (Phase 2)
but nothing has been built. `expo-haptics` is imported but unused.

### Consequence
Users cannot background the app and be alerted when Claude finishes. This is the
most common mobile use-case (glancing at the phone while Claude runs).

---

## 4. Git & Checkpoint Features

### Desktop
- Create named git snapshots from the UI or via the `wotch_checkpoint` MCP tool.
- Visual git status bar showing branch, changed file count, checkpoint count.
- Full diff viewer (working tree vs last checkpoint).
- Checkpoint history list with configurable retention (default 20).
- REST API endpoints: `POST /v1/checkpoints`, `GET /v1/git/status`,
  `GET /v1/git/diff`.

### Mobile
None. No checkpoint creation, no git status display, no diff viewer.

### Consequence
A common workflow — "what has Claude changed since I last checked?" — has no
mobile equivalent.

---

## 5. Multiple Tabs

### Desktop
Any number of terminal tabs. Tabs are independently monitored; the pill shows the
aggregate (highest-priority) state across all tabs. Each tab has its own status dot.
Tabs can be drag-reordered and renamed.

### Mobile
Each saved profile corresponds to one connection. The terminal screen shows one
connection at a time. There is no multi-tab view, no aggregate status across
connections.

### Consequence
If Claude is running in tab 2 while tab 1 is idle, and the user had opened tab 1's
terminal view, they won't see the activity in tab 2.

---

## 6. Direct Claude API / Chat

### Desktop
Full in-app chat panel: streaming responses, per-project conversation history
persisted to `~/.wotch/conversations/`, multi-model selection, monthly budget cap
with alerts at 80 %/100 %, token/cost tracking.

### Mobile
None.

### Consequence
Users who want to ask Claude a question in context (e.g., "explain what you just
changed") must switch to a different app.

---

## 7. Agent System

### Desktop
YAML-defined autonomous agents (`code-reviewer`, `error-fixer`, `test-writer`,
`deploy-assistant`). Agents observe terminal output, trigger on events
(onCheckpoint, onErrorDetected, onTestFailure, onInterval), and execute tools
(bash, file read/write, git) with configurable approval modes (ask-first,
auto-approve). Sub-agent spawning with depth limits.

### Mobile
None.

### Consequence
Mobile users cannot trigger or monitor agent runs.

---

## 8. Plugin System

### Desktop
Plugin discovery from `~/.wotch/plugins/`, granular permissions (`fs.read`,
`process.exec`, `net.fetch`, etc.), UI panel registration, custom themes, per-plugin
settings.

### Mobile
None.

### Consequence
Any desktop plugin that adds status-bar information or new terminal commands is
invisible to mobile users.

---

## 9. Terminal Rendering

### Desktop
Full xterm.js: ANSI 256-color + truecolor, bold/italic/underline, search addon,
clipboard integration, multiple panes per tab, fit addon for responsive sizing.

### Mobile
Plain `ScrollView` + `Text` rendering with ANSI codes stripped. Fast and lightweight,
but all color and formatting information is lost.

### Consequence
Terminal output is harder to scan. Color-coded Claude Code output (tool names in
blue, filenames in yellow, errors in red) renders as plain monochrome text.

---

## 10. SSH Direct Connection

### Desktop
Direct SSH2 via the `ssh2` npm library. Features: password and key authentication,
TOFU host fingerprint verification with `~/.wotch/known_hosts.json`, credential
prompts in the renderer, exponential-backoff reconnect (up to 5 attempts, cap 30 s).

### Mobile
SSH info (host, port, username) is stored in profiles but is not used for actual
connections. All data travels through the bridge server WebSocket proxy. The
mobile app has no SSH client.

### Consequence
The bridge server is a required dependency. Users must install and maintain it on
every VPS they want to monitor.

---

## 11. Settings Surface

### Desktop
~30 configurable settings across 7 categories: window/display, appearance, terminal,
Claude Code integration (hooks, MCP, IDE bridge), Claude API, agent system, SSH
profiles.

### Mobile
One setting: theme (4 options). Everything else is hardcoded (reconnect delay,
ping interval, buffer sizes, etc.).

### Consequence
Power users have no way to tune mobile behaviour. The reconnect delay (fixed 3 s)
cannot be changed even though desktop SSH uses exponential backoff.

---

## 12. MCP Server

### Desktop
Standalone stdio MCP server (`src/mcp-server.js`) registered in `~/.claude.json`.
Exposes 8 tools to Claude: checkpoint creation, git status/diff, project info,
terminal buffer read, tab listing, tab status, desktop notifications.

### Mobile
None (architecture doesn't apply — Claude Code runs on the remote machine, not the
phone).

### Consequence
Not applicable to mobile in its current form, but relevant if mobile ever connects
to the desktop Wotch API: the desktop's MCP data (terminal buffers, tab status,
checkpoints) would then be available to drive a richer mobile UI.

---

## 13. Hook Integration

### Desktop
`HookReceiver` HTTP server (port 19520) auto-configured in `~/.claude/settings.json`.
Receives and maps 24 Claude Code lifecycle events, feeding the enhanced status
detector with sub-second latency and structured metadata.

### Mobile
Not implemented. The bridge server is stateless — it pipes bytes and does not
interpret Claude Code events. Status detection on mobile is entirely regex-based.

### Consequence
See Section 1 (Status Detection). Hook-quality status (tool name, file path,
agent depth) is not available on mobile.

---

## 14. Auto-reconnect Behaviour

### Desktop SSH
Exponential backoff: 3 s → 6 s → 12 s → 24 s → 30 s cap. Maximum 5 attempts
before giving up with a clear error state.

### Mobile Bridge
Fixed 3 s delay, indefinite retries. No attempt limit, no error state after
persistent failure.

### Consequence
On an unreliable connection, the mobile app retries silently forever. Users have no
way to tell if the VPS is down versus just slow to respond.

---

## 15. Gemini CLI Support

### Desktop
Added in recent session:
- Activation patterns: `/Gemini CLI/i`, `/gemini\.google\.com/i`
- `aiType` tracking per tab
- Notification labels ("Gemini finished/error" vs "Claude …")
- `◆` line-anchored done pattern

### Mobile
Not present. `ClaudeStatusDetector.ts` has not received any of these changes.

### Consequence
Gemini CLI sessions on a monitored VPS will not be detected by mobile. Status will
remain idle throughout.

---

## Summary Table

| Feature | Desktop | Mobile | Gap Severity |
|---|---|---|---|
| Status detection (regex) | ✓ | ✓ | — |
| Status detection (hooks) | ✓ | ✗ | High |
| Gemini CLI recognition | ✓ | ✗ | High |
| aiType tracking | ✓ | ✗ | Medium |
| Background notifications | ✓ | ✗ | High |
| Budget alerts | ✓ | ✗ | Medium |
| Git status display | ✓ | ✗ | Medium |
| Checkpoint creation | ✓ | ✗ | Medium |
| Diff viewer | ✓ | ✗ | Low |
| Multiple tabs / aggregate | ✓ | Partial | Medium |
| Direct Claude API chat | ✓ | ✗ | Low |
| Agent system | ✓ | ✗ | Low |
| Plugin system | ✓ | ✗ | Low |
| ANSI color rendering | ✓ | ✗ | Medium |
| Terminal search | ✓ | ✗ | Low |
| SSH direct (no bridge) | ✓ | ✗ | Medium |
| Desktop Wotch API connection | — | ✗ | High |
| Configurable settings | ✓ (30+) | ✗ (1) | Medium |
| Reconnect backoff | ✓ | ✗ | Low |
| Rich tool descriptions | ✓ | ✗ | Medium |
