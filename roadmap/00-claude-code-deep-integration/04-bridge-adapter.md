# Plan 0: IDE Integration & Bridge Adapter

## Overview

Claude Code integrates with IDEs (VS Code, JetBrains) via a **built-in IDE MCP server** — a proprietary TCP-based server with ephemeral lock-file authentication. This is NOT a public protocol that third-party tools can implement directly.

This document describes what the IDE integration actually is, what Wotch can and cannot do with it, and the alternative strategy Wotch uses instead.

---

## What the IDE Integration Actually Is

### Architecture

Claude Code's IDE integration consists of:

1. **A built-in MCP server** running over **TCP** on `127.0.0.1` using a **random high port**
2. **Ephemeral authentication**: Each IDE extension activation generates a fresh random auth token, written to a lock file in `~/.claude/ide/` with `0600` permissions in a `0700` directory
3. **Platform-specific discovery**:
   - VS Code: The extension launches a local MCP server; the CLI finds it automatically
   - JetBrains: The plugin runs `claude` from the IDE's integrated terminal, which detects the IDE context

### What It Exposes

The IDE MCP server exposes only **2 user-visible tools**:

| Tool | Description |
|------|-------------|
| `mcp__ide__getDiagnostics` | Read-only language-server diagnostics |
| `mcp__ide__executeCode` | Run Python code in Jupyter notebooks (with user confirmation) |

Internal RPC methods (opening diffs, reading selections, saving files) exist but are **filtered out** before the tool list reaches Claude.

### Why Wotch Cannot Implement This

| Constraint | Impact |
|-----------|--------|
| Random port with lock-file discovery | No stable endpoint to connect to |
| Ephemeral per-activation auth tokens | No way to authenticate without file access to `~/.claude/ide/` |
| No public protocol specification | Wire protocol is undocumented and proprietary |
| Internal tools are hidden | Rich state data (tool use, files, context) is in hidden internal RPC, not exposed tools |
| Not designed for third parties | The extension integration is tightly coupled to VS Code/JetBrains |

---

## Wotch's Alternative: Hooks as the "Bridge"

The original Plan 0 proposed a three-channel model (hooks + MCP + bridge). With the bridge channel not feasible, Wotch operates on a **two-channel model**:

1. **Hooks** (Claude Code → Wotch): Structured lifecycle events via HTTP hooks
2. **MCP** (Wotch → Claude Code): Tool access via MCP server

The good news is that Claude Code's **24 hook events** provide most of what the bridge was supposed to deliver:

### What Hooks Cover (That Bridge Would Have)

| Bridge Capability | Hook Equivalent | Coverage |
|------------------|-----------------|----------|
| Real-time status | `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure` | Full |
| Tool call tracking | `PreToolUse` (with `tool_name` + `tool_input`) | Full |
| Sub-agent awareness | `SubagentStart`, `SubagentStop` | Full |
| Context compression | `PreCompact`, `PostCompact` | Full |
| Session lifecycle | `SessionStart`, `SessionEnd` | Full |
| File change tracking | `FileChanged` | Partial (watched files only) |
| Notifications | `Notification` | Full |
| Error detection | `StopFailure` (with error type) | Full |

### What Hooks Cannot Do (Bridge Could Have)

| Capability | Status | Workaround |
|-----------|--------|------------|
| Bidirectional context injection | Not possible with hooks | Use MCP tools — Claude Code calls `wotch_project_info`, `wotch_git_status` |
| Real-time token usage tracking | Not available in hook payloads | Monitor via API usage tracking (Plan 2) |
| File path + line number for edits | `tool_input` includes `file_path` for Edit/Write/Read | Partial — available in `PreToolUse` |
| Command routing (Wotch → Claude) | Not possible with hooks | Not needed — MCP tools serve this purpose |

The two-channel model covers ~90% of what the three-channel model proposed, with significantly lower implementation complexity and zero reliance on undocumented protocols.

---

## Future: IDE MCP Server Integration

If Claude Code's IDE integration protocol is ever documented or opened to third parties, Wotch could implement it as a third channel. Signs to watch for:

- **Public bridge protocol spec** published by Anthropic
- **Stable port or discovery mechanism** for third-party clients
- **Token-based auth** that external tools can obtain
- **Third-party IDE extension API** for registering as a bridge client

Until then, the hooks + MCP architecture is the correct approach. It uses only public, documented configuration surfaces (`~/.claude/settings.json` for hooks, `~/.claude.json` for MCP) and is resilient to Claude Code version changes.

---

## Comparison: Original Bridge Plan vs. Reality

| Aspect | Original Plan (04-bridge-adapter.md v1) | Reality |
|--------|----------------------------------------|---------|
| Protocol | Custom WebSocket with handshake, state_update, tool_start, context_request messages | Proprietary TCP MCP server with hidden internal RPC |
| Discovery | `CLAUDE_BRIDGE_PORT` environment variable | Lock file in `~/.claude/ide/` with ephemeral token |
| Authentication | None (localhost assumption) | Random per-activation token with file-based exchange |
| Capabilities | Rich state sync, context injection, command routing, file tracking | 2 user-visible tools (getDiagnostics, executeCode) |
| Third-party support | Assumed implementable | Not designed for external clients |
| Implementation effort | ~200 lines bridge-adapter.js | Not feasible without reverse engineering |

---

## Impact on Architecture

### Revised Channel Model

```
Claude Code (running in Wotch terminal)
    |
    |--- Hooks (24 events) ──► Wotch Hook Receiver (HTTP POST localhost:19520)
    |    (type: http)              |
    |                              +--> EnhancedClaudeStatusDetector
    |                              +--> Event bus (Plans 1, 3, 4)
    |                              +--> Notification forwarding
    |
    |--- MCP ──────────────► Wotch MCP Server (stdio transport)
    |    (configured in              |
    |     ~/.claude.json)            +--> gitCheckpoint()
    |                                +--> gitGetStatus()
    |                                +--> detectProjects()
    |                                +--> terminalBuffer()
    |                                +--> sendNotification()
    |
    |--- Regex Fallback ──► Existing ClaudeStatusDetector
         (PTY output)           (used when hooks unavailable)
```

### Files Removed

The standalone `src/bridge-adapter.js` file is **not created**. The `ClaudeIntegrationManager` manages only two channels (hooks + MCP) plus the regex fallback.

### Settings Simplified

```json
{
  "integration": {
    "hooksEnabled": true,
    "hooksPort": 19520,
    "mcpEnabled": true,
    "mcpTransport": "stdio",
    "autoConfigureHooks": true,
    "autoRegisterMCP": true
  }
}
```

No `bridgeEnabled`, `bridgePort`, or bridge-related settings.

### Status Detection: Two Sources + Fallback

The `EnhancedClaudeStatusDetector` operates with two priority sources instead of three:

1. **Hooks** (Priority 1) — structured events, ~100-200ms latency
2. **Regex fallback** (Priority 2) — heuristic, always available

See `05-enhanced-status-detection.md` for the updated fusion logic.
