# Plan 0: Architecture

## System Overview

Plan 0 introduces two structured communication channels between Wotch and Claude Code, replacing the current regex-based terminal output parsing. Each channel serves a distinct purpose and operates independently, allowing graceful degradation if either is unavailable.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Wotch Main Process                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │ Hook Receiver │  │  MCP IPC     │                             │
│  │ (HTTP :19520) │  │  Server      │                             │
│  │               │  │  (TCP :19523)│                             │
│  └──────┬───────┘  └──────┬───────┘                             │
│         │                 │                                      │
│         ▼                 ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Event Bus                             │    │
│  │  (ClaudeIntegrationManager)                              │    │
│  └──────┬──────────┬──────────┬──────────┬────────────┘    │
│         │          │          │          │                   │
│         ▼          ▼          ▼          ▼                   │
│  ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐      │
│  │ Enhanced │ │ PTY    │ │ Git    │ │ Existing     │      │
│  │ Status   │ │ Manager│ │ Ops    │ │ IPC Handlers │      │
│  │ Detector │ └────────┘ └────────┘ └──────────────┘      │
│  └──────────┘                                               │
│       ▲                                                     │
│       │ (fallback)                                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Regex Fallback Detector                  │   │
│  │  (existing ClaudeStatusDetector, used when hooks     │   │
│  │   are unavailable)                                    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         ▲                 ▲
         │                 │
    Hook Events        MCP Calls
    (HTTP POST)        (stdio JSON-RPC)
         │                 │
┌─────────────────────────────────────────────────────────────────┐
│              Claude Code (running in xterm.js tab)              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │ Hook System  │  │  MCP Client  │                             │
│  │ (type: http) │  │  (built-in)  │                             │
│  └──────────────┘  └──────────────┘                             │
│                                                                 │
│  Config sources:                                                │
│  - ~/.claude/settings.json (hooks)                              │
│  - ~/.claude.json (MCP servers)                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Channel 1: Hooks (Claude Code → Wotch)

### Direction
Unidirectional: Claude Code pushes events to Wotch.

### Purpose
Real-time notification of Claude Code lifecycle events. Replaces terminal output regex parsing for status detection.

### How It Works

Claude Code's hook system supports `type: http` hooks — when a lifecycle event fires, Claude Code sends the hook's stdin JSON directly as an HTTP POST body to a configured URL. Wotch registers these hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/PreToolUse",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

The hook payload arrives as JSON on the HTTP body with fields like `session_id`, `tool_name`, `tool_input`, `cwd`, and `hook_event_name`. This is the same data that `type: command` hooks receive on stdin.

### Data Flow

```
Claude Code lifecycle event (e.g., PreToolUse with tool Bash)
  → Hook system evaluates matchers
  → HTTP POST to http://localhost:19520/hook/PreToolUse
  → Body: {"session_id":"...","tool_name":"Bash","tool_input":{"command":"npm test"},"cwd":"/project",...}
  → Wotch HookReceiver parses JSON body
  → Event emitted on ClaudeIntegrationManager event bus
  → EnhancedClaudeStatusDetector updates state → "working" with description "Running command"
  → IPC event sent to renderer
  → Pill status updates
```

### Key Design Decisions

- **`type: http` over `type: command`**: Native HTTP hooks are simpler, more reliable, and don't depend on curl being installed. Claude Code POSTs the hook payload directly — no shell command intermediary.
- **Event type in URL path**: Using `/hook/PreToolUse` instead of a single `/hook` endpoint allows the receiver to route without parsing the body first, and makes log inspection easier.
- **12 subscribed events (of 24 available)**: Wotch subscribes to the events relevant for status detection and notification. Low-value events (UserPromptSubmit, PermissionRequest, etc.) are not subscribed.
- **Fire-and-forget**: Wotch's hooks return HTTP 200 with no structured output. They do not block tool execution or modify behavior. (Exception: optional safety hooks for dangerous operations — see `02-hooks-integration.md`.)

### Subscribed Events

| Event | Purpose for Wotch |
|-------|-------------------|
| `PreToolUse` | Status: detect tool usage with tool name + input |
| `PostToolUse` | Status: tool completed |
| `PostToolUseFailure` | Status: tool failed |
| `Stop` | Status: turn finished → "done" |
| `StopFailure` | Status: API error → "error" |
| `SubagentStart` | Status: sub-agent spawned |
| `SubagentStop` | Status: sub-agent finished |
| `SessionStart` | Status: session began → "idle" |
| `SessionEnd` | Status: session ended → cleanup |
| `PreCompact` | Status: compacting context |
| `PostCompact` | Status: compaction done |
| `Notification` | Forward to Wotch notification system |

---

## Channel 2: MCP Server (Wotch → Claude Code)

### Direction
Request-response: Claude Code calls Wotch tools as needed.

### Purpose
Expose Wotch capabilities as tools that Claude Code can invoke natively during its agent loop. Claude Code can create checkpoints, query git status, read project context, and send notifications without the user typing commands.

### How It Works

Wotch registers itself as an MCP server in `~/.claude.json` (NOT `~/.claude/settings.json` — MCP and hooks use different config files):

```json
{
  "mcpServers": {
    "wotch": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/wotch/resources/mcp-server.js"],
      "env": {
        "WOTCH_IPC_PORT": "19523"
      }
    }
  }
}
```

Claude Code launches the MCP server script as a subprocess. The script communicates with the Wotch main process via a localhost TCP connection (port 19523) for data access.

### Tool Inventory

| Tool | Description | Parameters |
|------|-------------|------------|
| `wotch_checkpoint` | Create a git checkpoint | `message?: string` |
| `wotch_git_status` | Get current git status | — |
| `wotch_git_diff` | Get diff against last checkpoint | `context_lines?: number` |
| `wotch_project_info` | Get active project details | — |
| `wotch_terminal_buffer` | Read terminal output | `tab_id?: string, lines?: number` |
| `wotch_notify` | Send a system notification | `title: string, body: string` |
| `wotch_list_tabs` | List open terminal tabs | — |
| `wotch_tab_status` | Get Claude status for a tab | `tab_id: string` |

### Data Flow

```
Claude Code agent loop decides to call wotch_checkpoint
  → MCP client sends tool call request via stdio (JSON-RPC 2.0)
  → Wotch MCP Server script receives request
  → Script calls Wotch main process via TCP (port 19523)
  → Main process calls gitCheckpoint()
  → Result returned through TCP → MCP script → stdio → Claude Code
  → Claude Code incorporates result into its reasoning
```

### Key Design Decisions

- **stdio transport preferred**: For Claude Code instances running inside Wotch terminals, stdio transport is simplest — no port management, no auth. Claude Code manages the MCP server process lifecycle.
- **Standalone MCP server script**: The MCP server runs as `src/mcp-server.js`, a separate Node.js script. It communicates with Wotch's Electron main process via TCP IPC. This keeps MCP protocol handling isolated from Electron concerns.
- **Read-heavy tool set**: Most tools are read-only queries. The only write operation is `wotch_checkpoint`, which is a safe, additive git operation.
- **HTTP transport as alternative**: For Claude Code running outside Wotch (e.g., in a separate terminal), an HTTP-based MCP endpoint can be offered. Configured with `"type": "http"` in `~/.claude.json`. (Note: SSE transport is deprecated.)

---

## Why Not Three Channels?

The original plan proposed a third channel — a "bridge adapter" implementing Claude Code's IDE integration protocol. After investigation, this was found to be **not feasible**:

- Claude Code's IDE integration is a proprietary built-in MCP server over TCP with ephemeral lock-file auth
- Discovery uses files in `~/.claude/ide/`, not environment variables
- The protocol is undocumented and not designed for third-party clients
- Only 2 user-visible tools are exposed (getDiagnostics, executeCode)

The two-channel model (hooks + MCP) covers ~90% of what the bridge would have provided. See `04-bridge-adapter.md` for the full analysis.

---

## ClaudeIntegrationManager

The central coordinator that manages both channels and provides a unified interface to the rest of Wotch.

```javascript
class ClaudeIntegrationManager extends EventEmitter {
  constructor() {
    this.hookReceiver = new HookReceiver(PORT_HOOKS);
    this.mcpIPCServer = new MCPIPCServer(PORT_MCP_IPC);
    this.statusDetector = new EnhancedClaudeStatusDetector();
    this.regexFallback = new ClaudeStatusDetector(); // existing
  }

  // Unified status query — prefers hooks, falls back to regex
  getStatus(tabId) { ... }

  // Channel health
  getChannelStatus() {
    return {
      hooks: this.hookReceiver.isActive(),
      mcp: this.mcpIPCServer.isActive(),
      fallback: this.regexFallback.isActive()
    };
  }
}
```

### Source Priority

When multiple sources report status simultaneously:

1. **Hooks** (highest priority) — structured events, ~100-200ms latency
2. **Regex fallback** (lowest priority) — heuristic, used only when hooks are unavailable

The manager uses a "last-write-wins with priority" strategy: the regex source cannot override the hooks source's state unless a timeout has elapsed (e.g., 15 seconds without a hook event triggers fallback to regex).

---

## Integration with Existing Architecture

### Files Modified

| File | Changes |
|------|---------|
| `src/main.js` | Add `ClaudeIntegrationManager` instantiation, replace direct `ClaudeStatusDetector` usage, add hook receiver and MCP IPC server startup/shutdown, new IPC channels for integration status |
| `src/preload.js` | Add `window.wotch.integration.*` bridge methods (channel status, hook config status) |
| `src/renderer.js` | Add integration status indicator in settings panel, channel health display |
| `src/index.html` | Add CSS for integration status badges |
| `package.json` | Add `@modelcontextprotocol/sdk` dependency |

### Files Created

| File | Purpose |
|------|---------|
| `src/hook-receiver.js` | HTTP server for receiving Claude Code hook events |
| `src/mcp-server.js` | Standalone MCP server script (launched by Claude Code) |
| `src/claude-integration-manager.js` | Central coordinator for both channels |
| `src/enhanced-status-detector.js` | Multi-source status detection with priority |

### Configuration Files (Different Locations!)

| Config | Location | Contents |
|--------|----------|----------|
| Hooks | `~/.claude/settings.json` | `hooks` object with `type: http` entries |
| MCP servers | `~/.claude.json` | `mcpServers` object with `type: stdio` entry |
| Wotch settings | `~/.wotch/settings.json` | `integration` object with enable/disable toggles |

### Settings Additions

```json
{
  "integration": {
    "hooksEnabled": true,
    "hooksPort": 19520,
    "mcpEnabled": true,
    "mcpTransport": "stdio",
    "mcpIpcPort": 19523,
    "autoConfigureHooks": true,
    "autoRegisterMCP": true
  }
}
```

---

## Graceful Degradation

Each channel operates independently:

| Hooks | MCP | Behavior |
|-------|-----|----------|
| yes | yes | Full structured integration |
| yes | no | Structured status, no MCP tools |
| no | yes | MCP tools available, regex status detection |
| no | no | Full regex fallback (current behavior) |

The UI displays channel status so users can diagnose connectivity:

```
Integration: ● Hooks  ● MCP  (○ = inactive, ● = active)
```

---

## Security Considerations

### Hook Receiver
- Binds to `127.0.0.1` only (never `0.0.0.0`)
- No authentication required (localhost-only, same-user)
- Validates JSON payload structure; rejects malformed payloads
- Rate-limited to 100 events/second (prevents runaway hooks)
- Body size capped at 64KB

### MCP IPC Server
- Binds to `127.0.0.1` only
- No authentication (same-user localhost)
- Tools are read-only except `wotch_checkpoint` (safe, additive operation)
- No file write, shell exec, or network access tools exposed
- Connection limit: 5 simultaneous clients
- Request timeout: 10 seconds

### MCP Server Script
- Launched by Claude Code as a subprocess (stdio transport)
- No network exposure (communicates via stdin/stdout to Claude Code, TCP to Wotch)
- Inherits Wotch's tool safety restrictions

### New Invariants

- **INV-SEC-006**: Hook receiver must bind to `127.0.0.1` only; never `0.0.0.0`
- **INV-SEC-007**: MCP tools must not expose destructive operations (no file delete, no force push, no shell exec)
