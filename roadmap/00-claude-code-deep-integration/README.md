# Plan 0: Claude Code Deep Integration

## Overview

Replace Wotch's heuristic-based Claude Code integration (regex terminal output parsing) with structured, first-party integration using two channels exposed by Claude Code's public configuration surfaces:

1. **Hooks System** — Claude Code's 24 lifecycle events delivered to Wotch via `type: http` hooks configured in `~/.claude/settings.json`. Wotch receives structured JSON payloads (tool name, session ID, working directory) on every state transition — no terminal scraping needed.
2. **MCP Server** — Wotch exposes itself as a Model Context Protocol server configured in `~/.claude.json`, giving Claude Code native tool access to Wotch capabilities (checkpoints, project context, notifications, tab management).

These two channels replace the fragile regex-based status detection with reliable, structured data flows — and unlock capabilities that were previously impossible (Claude Code calling Wotch tools, Wotch receiving granular lifecycle events including sub-agent activity and context compaction).

> **Note on IDE bridge**: Claude Code's IDE integration (VS Code, JetBrains) uses a proprietary built-in MCP server over TCP with ephemeral lock-file auth. This protocol is not documented, not designed for third-party clients, and cannot be implemented by Wotch. See `04-bridge-adapter.md` for the full analysis and why the two-channel model is sufficient.

---

## Goals

1. **Structured Status Detection** — Receive Claude Code state transitions via hooks rather than parsing terminal output. Eliminate false positives, reduce latency, and capture states invisible to regex (context compression, agent spawning, MCP tool calls, API errors).
2. **Wotch as a Claude Code Tool** — Via MCP, let Claude Code natively create checkpoints, read project context, send notifications, and query git status — without the user typing commands.
3. **Rich Event Stream** — Leverage all 24 hook events for granular awareness: tool use, sub-agent lifecycle, session start/end, context compaction, file changes, and errors.
4. **Foundation for Plans 1–4** — Every subsequent plan benefits from structured Claude Code communication. The Local API (Plan 1) exposes hook-sourced data instead of regex guesses. The Claude API integration (Plan 2) can share context via MCP. The Plugin SDK (Plan 3) can expose hook events to plugins. The Agent SDK (Plan 4) can trigger agents from hook events.

---

## Scope

### In scope

- Claude Code hooks configuration generator (writes `type: http` hooks to `~/.claude/settings.json`)
- Hook event receiver (localhost HTTP server in Wotch main process, receives hook stdin JSON as POST body)
- MCP server implementation exposing Wotch tools via stdio transport (configured in `~/.claude.json`)
- MCP tool definitions for checkpoints, git status, project info, notifications, terminal buffer
- Enhanced `ClaudeStatusDetector` that consumes hook events with regex fallback
- Settings UI for enabling/disabling each integration channel
- Auto-detection of Claude Code installation and version

### Out of scope

- Modifying Claude Code's source code (we only use public configuration surfaces)
- Implementing Claude Code's IDE bridge protocol (proprietary, undocumented — see `04-bridge-adapter.md`)
- Running Claude Code as a subprocess (Wotch observes Claude Code running in its terminals)
- Replacing the terminal — Claude Code still runs in xterm.js tabs
- Multi-user or remote Claude Code instances

---

## Success Criteria

1. When Claude Code transitions between states (idle → thinking → tool use → done), Wotch receives a structured hook event within 200ms and updates the pill status without any regex parsing.
2. Claude Code can call `wotch_checkpoint` as an MCP tool and a git checkpoint is created identically to clicking the UI button.
3. Claude Code can call `wotch_git_status` and receive the same structured data that the git status bar displays.
4. Both channels degrade gracefully: if Claude Code is older (pre-hooks), Wotch falls back to regex detection with no user-visible error.
5. Hook registration is automatic — Wotch auto-configures `type: http` hooks in `~/.claude/settings.json` (with user consent).
6. MCP registration is automatic — Wotch auto-registers in `~/.claude.json` (with user consent).

---

## Why This Comes First

The existing Plans 1–4 were designed around Wotch's current limitation: no structured communication with Claude Code. Every plan independently reinvents ways to get Claude Code data:

| Plan | Current approach | With Plan 0 |
|------|-----------------|-------------|
| Plan 1 (Local API) | Exposes regex-detected status | Exposes hook-sourced structured status |
| Plan 2 (Claude API) | Separate API connection, no Claude Code awareness | MCP enables context sharing with running Claude Code sessions |
| Plan 3 (Plugin SDK) | Plugins parse terminal output for Claude events | Plugins subscribe to structured hook events |
| Plan 4 (Agent SDK) | Agents observe terminal via PTY | Agents triggered by hook events (Stop, StopFailure, SubagentStop) |

By building the structured integration layer first, all subsequent plans get reliable data from day one instead of building on regex heuristics.

---

## Architecture Summary

See `01-architecture.md` for the full design. In brief:

```
Claude Code (running in Wotch terminal)
    |
    |--- Hooks (24 events) ──► Wotch Hook Receiver (HTTP POST localhost:19520)
    |    (type: http,               |
    |     ~/.claude/settings.json)  +--> EnhancedClaudeStatusDetector
    |                               +--> Event bus (for Plans 1, 3, 4)
    |                               +--> Notification forwarding
    |
    |--- MCP ────────────────► Wotch MCP Server (stdio transport)
    |    (configured in              |
    |     ~/.claude.json)            +--> gitCheckpoint()
    |                                +--> gitGetStatus()
    |                                +--> detectProjects()
    |                                +--> terminalBuffer()
    |                                +--> sendNotification()
    |
    |--- Regex Fallback ────► Existing ClaudeStatusDetector
         (PTY output parsing)       (used when hooks unavailable)
```

---

## Dependencies

New npm dependencies:

| Package | Purpose | Size |
|---------|---------|------|
| `@modelcontextprotocol/sdk` | MCP server implementation | ~150KB |

No other dependencies. The hook receiver uses Node.js built-in `http` module. The `@anthropic-ai/sdk` is not needed for this plan (it's used in Plan 2 for the Claude API client).

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Claude Code hooks API changes in future versions | Hook payload validation; regex fallback always available; version detection at startup |
| MCP protocol evolution | Pin to MCP SDK version; implement only stable tool types |
| User has older Claude Code without hooks support | Graceful degradation to regex detection; settings UI shows which channels are active |
| Hook receiver port conflicts | Configurable port with auto-detection fallback (try 19520–19529) |
| `type: http` hooks not supported in user's Claude Code version | Fall back to `type: command` with curl; or use regex fallback |
| Performance overhead of hook HTTP requests | Hooks are event-driven (no polling); payloads are small JSON; timeout set to 5s |

---

## Document Index

| Document | Description |
|----------|-------------|
| [01-architecture.md](./01-architecture.md) | System architecture, data flow, integration channel design |
| [02-hooks-integration.md](./02-hooks-integration.md) | Claude Code hooks: 24 events, stdin JSON format, HTTP receiver, auto-configuration |
| [03-mcp-server.md](./03-mcp-server.md) | Wotch MCP server: tool definitions, stdio/HTTP transport, registration in ~/.claude.json |
| [04-bridge-adapter.md](./04-bridge-adapter.md) | IDE integration analysis: why the bridge isn't feasible, two-channel alternative |
| [05-enhanced-status-detection.md](./05-enhanced-status-detection.md) | Multi-source status detection with hook priority and regex fallback |
| [06-implementation-steps.md](./06-implementation-steps.md) | Step-by-step build guide with exact file changes |
