# Plan 0: Claude Code Deep Integration

## Overview

Replace Wotch's heuristic-based Claude Code integration (regex terminal output parsing) with structured, first-party integration channels exposed by Claude Code itself. This plan leverages three integration surfaces discovered in Claude Code's architecture:

1. **Hooks System** — Shell commands triggered by Claude Code lifecycle events (`PreToolUse`, `PostToolUse`, `Notification`, `Stop`). Wotch registers as a hook consumer to receive structured status updates without terminal scraping.
2. **MCP Server** — Wotch exposes itself as a Model Context Protocol server, giving Claude Code native tool access to Wotch capabilities (checkpoints, project context, notifications, tab management).
3. **Bridge Adapter** — Claude Code's bidirectional IDE bridge protocol (used by VS Code and JetBrains extensions) is implemented by Wotch, enabling real-time state synchronization, command execution, and context sharing.

These three channels replace the fragile regex-based status detection with reliable, structured data flows — and unlock capabilities that were previously impossible (Claude Code calling Wotch tools, Wotch injecting context into Claude sessions, bidirectional command routing).

---

## Goals

1. **Structured Status Detection** — Receive Claude Code state transitions via hooks rather than parsing terminal output. Eliminate false positives, reduce latency, and capture states invisible to regex (context compression, agent spawning, MCP tool calls).
2. **Wotch as a Claude Code Tool** — Via MCP, let Claude Code natively create checkpoints, read project context, switch tabs, send notifications, and query git status — without the user typing commands.
3. **Bidirectional Communication** — Via the bridge adapter, synchronize state between Wotch and Claude Code: Wotch knows what Claude is doing, and Claude knows what Wotch is showing.
4. **Foundation for Plans 1–4** — Every subsequent plan benefits from structured Claude Code communication. The Local API (Plan 1) exposes hook-sourced data instead of regex guesses. The Claude API integration (Plan 2) can share context via MCP. The Plugin SDK (Plan 3) can expose hook events to plugins. The Agent SDK (Plan 4) can coordinate with Claude Code's own agent system.

---

## Scope

### In scope

- Claude Code hooks configuration generator (`~/.claude/settings.json` or project-level `.claude/settings.json`)
- Hook event receiver (localhost HTTP endpoint in Wotch main process)
- MCP server implementation exposing Wotch tools via stdio or SSE transport
- MCP tool definitions for checkpoints, git status, project info, notifications, terminal buffer
- Bridge adapter implementing Claude Code's IDE bridge protocol
- Enhanced `ClaudeStatusDetector` that consumes hook events with regex fallback
- Settings UI for enabling/disabling each integration channel
- Auto-detection of Claude Code installation and version

### Out of scope

- Modifying Claude Code's source code (we only use its public configuration surfaces)
- Running Claude Code as a subprocess (Wotch observes Claude Code running in its terminals)
- Replacing the terminal — Claude Code still runs in xterm.js tabs
- Multi-user or remote Claude Code instances

---

## Success Criteria

1. When Claude Code transitions between states (idle → thinking → tool use → done), Wotch receives a structured hook event within 100ms and updates the pill status without any regex parsing.
2. Claude Code can call `wotch_checkpoint` as an MCP tool and a git checkpoint is created identically to clicking the UI button.
3. Claude Code can call `wotch_git_status` and receive the same structured data that the git status bar displays.
4. The bridge adapter maintains a persistent connection with Claude Code, and Wotch's status display matches Claude Code's internal state with zero false positives.
5. All three channels degrade gracefully: if Claude Code is older (pre-hooks), Wotch falls back to regex detection with no user-visible error.
6. Hook registration is automatic — launching Claude Code in a Wotch terminal tab auto-configures hooks via `~/.claude/settings.json`.

---

## Why This Comes First

The existing Plans 1–4 were designed around Wotch's current limitation: no structured communication with Claude Code. Every plan independently reinvents ways to get Claude Code data:

| Plan | Current approach | With Plan 0 |
|------|-----------------|-------------|
| Plan 1 (Local API) | Exposes regex-detected status | Exposes hook-sourced structured status |
| Plan 2 (Claude API) | Separate API connection, no Claude Code awareness | MCP enables context sharing with running Claude Code sessions |
| Plan 3 (Plugin SDK) | Plugins parse terminal output for Claude events | Plugins subscribe to structured hook events |
| Plan 4 (Agent SDK) | Agents observe terminal via PTY | Agents coordinate with Claude Code via bridge |

By building the structured integration layer first, all subsequent plans get reliable data from day one instead of building on regex heuristics.

---

## Architecture Summary

See `01-architecture.md` for the full design. In brief:

```
Claude Code (running in Wotch terminal)
    |
    |--- Hooks -----> Wotch Hook Receiver (HTTP POST localhost:19520)
    |                      |
    |                      +--> ClaudeStatusDetector (structured events)
    |                      +--> Event bus (for Plans 1, 3, 4)
    |
    |--- MCP -------> Wotch MCP Server (stdio transport)
    |                      |
    |                      +--> gitCheckpoint()
    |                      +--> gitGetStatus()
    |                      +--> detectProjects()
    |                      +--> terminalBuffer()
    |                      +--> sendNotification()
    |
    |--- Bridge ----> Wotch Bridge Adapter (WebSocket localhost:19521)
                           |
                           +--> State sync (bidirectional)
                           +--> Command routing
                           +--> Context injection
```

---

## Dependencies

New npm dependencies:

| Package | Purpose | Size |
|---------|---------|------|
| `@anthropic-ai/sdk` | MCP server protocol types (if using SDK's MCP utilities) | ~200KB |
| `@modelcontextprotocol/sdk` | MCP server implementation | ~150KB |

No other dependencies. The hook receiver uses Node.js built-in `http` module. The bridge adapter uses the `ws` package (already planned for Plan 1).

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Claude Code hooks API changes in future versions | Version detection at startup; hook schema validation; regex fallback always available |
| MCP protocol evolution | Pin to MCP SDK version; implement only stable tool types |
| Bridge protocol is undocumented | Reverse-engineer from VS Code extension behavior; implement minimal viable subset |
| User has older Claude Code without hooks | Graceful degradation to regex detection; settings UI shows which channels are active |
| Hook receiver port conflicts | Configurable port with auto-detection fallback; same pattern as Plan 1's API server |
| Performance overhead of three integration channels | Channels are event-driven (no polling); hook events are small JSON payloads; MCP calls are infrequent |

---

## Document Index

| Document | Description |
|----------|-------------|
| [01-architecture.md](./01-architecture.md) | System architecture, data flow, integration channel design |
| [02-hooks-integration.md](./02-hooks-integration.md) | Claude Code hooks system: configuration, events, receiver |
| [03-mcp-server.md](./03-mcp-server.md) | Wotch MCP server: tool definitions, transport, registration |
| [04-bridge-adapter.md](./04-bridge-adapter.md) | Bridge protocol: connection, state sync, command routing |
| [05-enhanced-status-detection.md](./05-enhanced-status-detection.md) | Upgraded status detection with multi-source fusion |
| [06-implementation-steps.md](./06-implementation-steps.md) | Step-by-step build guide with exact file changes |
