# Plan 0: Architecture

## System Overview

Plan 0 introduces three structured communication channels between Wotch and Claude Code, replacing the current regex-based terminal output parsing. Each channel serves a distinct purpose and operates independently, allowing graceful degradation if any channel is unavailable.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Wotch Main Process                       │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ Hook Receiver │  │  MCP Server  │  │  Bridge Adapter    │    │
│  │ (HTTP :19520) │  │  (stdio)     │  │  (WS :19521)       │    │
│  └──────┬───────┘  └──────┬───────┘  └────────┬───────────┘    │
│         │                 │                    │                 │
│         ▼                 ▼                    ▼                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Event Bus                             │    │
│  │  (ClaudeIntegrationManager)                              │    │
│  └──────┬──────────┬──────────┬──────────┬────────────┘    │
│         │          │          │          │                   │
│         ▼          ▼          ▼          ▼                   │
│  ┌──────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐      │
│  │ Status   │ │ PTY    │ │ Git    │ │ Existing     │      │
│  │ Detector │ │ Manager│ │ Ops    │ │ IPC Handlers │      │
│  └──────────┘ └────────┘ └────────┘ └──────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Regex Fallback Detector                  │   │
│  │  (existing ClaudeStatusDetector, used when hooks     │   │
│  │   are unavailable)                                    │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         ▲                 ▲                    ▲
         │                 │                    │
    Hook Events        MCP Calls          Bridge Messages
         │                 │                    │
┌─────────────────────────────────────────────────────────────────┐
│              Claude Code (running in xterm.js tab)              │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ Hook System  │  │  MCP Client  │  │  Bridge Client     │    │
│  │ (settings)   │  │  (built-in)  │  │  (IDE protocol)    │    │
│  └──────────────┘  └──────────────┘  └────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Channel 1: Hooks (Claude Code → Wotch)

### Direction
Unidirectional: Claude Code pushes events to Wotch.

### Purpose
Real-time notification of Claude Code lifecycle events. Replaces terminal output regex parsing for status detection.

### How It Works

Claude Code's hook system allows users to register shell commands that execute at specific lifecycle points. These are configured in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:19520/hook -H 'Content-Type: application/json' -d '{\"event\":\"PreToolUse\",\"tool\":\"$TOOL_NAME\",\"session\":\"$SESSION_ID\"}'"
          }
        ]
      }
    ],
    "PostToolUse": [...],
    "Notification": [...],
    "Stop": [...]
  }
}
```

When Claude Code reaches a lifecycle point, it executes the registered command. Wotch runs a lightweight HTTP server on `localhost:19520` that receives these POST requests and translates them into internal events.

### Data Flow

```
Claude Code lifecycle event
  → Hook system evaluates matchers
  → Shell command executes (curl POST to localhost:19520)
  → Wotch HookReceiver parses JSON body
  → Event emitted on ClaudeIntegrationManager event bus
  → ClaudeStatusDetector updates state
  → IPC event sent to renderer
  → Pill status updates
```

### Key Design Decisions

- **HTTP POST over stdout/file**: Hooks execute as shell commands. HTTP POST is the lowest-latency, most reliable way to communicate between processes. File-based approaches introduce polling; stdout approaches require pipe management.
- **Separate port from Plan 1 API**: The hook receiver (19520) is distinct from the Local API server (19519, Plan 1). Hook events are internal; the API is for external consumers. Merging them would complicate auth (hooks don't carry tokens) and routing.
- **Matcher field empty string**: An empty matcher matches all tool invocations. Wotch filters events internally rather than relying on Claude Code's matcher syntax.

---

## Channel 2: MCP Server (Wotch → Claude Code)

### Direction
Request-response: Claude Code calls Wotch tools as needed.

### Purpose
Expose Wotch capabilities as tools that Claude Code can invoke natively during its agent loop. Claude Code can create checkpoints, query git status, read project context, and send notifications without the user typing commands.

### How It Works

Wotch registers itself as an MCP server in Claude Code's configuration (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "wotch": {
      "command": "node",
      "args": ["/path/to/wotch/mcp-server.js"],
      "env": {}
    }
  }
}
```

Alternatively, for an already-running Wotch instance, SSE transport can be used:

```json
{
  "mcpServers": {
    "wotch": {
      "url": "http://localhost:19522/mcp"
    }
  }
}
```

The MCP server exposes tools following the Model Context Protocol specification. Claude Code discovers available tools at session start and can call them during its reasoning loop.

### Tool Inventory

| Tool | Description | Parameters |
|------|-------------|------------|
| `wotch_checkpoint` | Create a git checkpoint | `message?: string` |
| `wotch_git_status` | Get current git status | `tabId?: string` |
| `wotch_git_diff` | Get diff against last checkpoint | `tabId?: string` |
| `wotch_project_info` | Get active project details | — |
| `wotch_terminal_buffer` | Read terminal output | `tabId?: string, lines?: number` |
| `wotch_notify` | Send a system notification | `title: string, body: string` |
| `wotch_list_tabs` | List open terminal tabs | — |
| `wotch_tab_status` | Get Claude status for a tab | `tabId: string` |

### Data Flow

```
Claude Code agent loop decides to call wotch_checkpoint
  → MCP client sends tool call request via stdio/SSE
  → Wotch MCP Server receives request
  → Server calls gitCheckpoint() in main process
  → Result returned to Claude Code
  → Claude Code incorporates result into its reasoning
```

### Key Design Decisions

- **stdio transport preferred**: For Claude Code instances running inside Wotch terminals, stdio transport is simplest — no port management, no auth needed. SSE is offered as a fallback for external Claude Code instances.
- **Standalone MCP server script**: The MCP server runs as a separate Node.js script (`src/mcp-server.js`) that communicates with the Wotch main process via IPC. This keeps the MCP protocol handling isolated from Electron concerns.
- **Read-heavy tool set**: Most tools are read-only queries. The only write operation is `wotch_checkpoint`, which is a safe, additive git operation (creates a new commit, never destructive).

---

## Channel 3: Bridge Adapter (Wotch ↔ Claude Code)

### Direction
Bidirectional: persistent WebSocket connection for real-time state synchronization.

### Purpose
Claude Code's bridge system was designed for IDE integration (VS Code, JetBrains). Wotch implements the same protocol, positioning itself as another "IDE" that Claude Code communicates with. This enables the richest integration: real-time state sync, context injection, and command routing.

### How It Works

Claude Code's bridge operates over a local WebSocket connection. When Claude Code detects a bridge-compatible client, it establishes a persistent connection and exchanges JSON messages for:

- **State updates**: Claude Code pushes its internal state (current tool, files being edited, conversation context) to the bridge client.
- **Context requests**: Claude Code can request context from the bridge client (open files, workspace info, diagnostics).
- **Command execution**: The bridge client can send commands to Claude Code (focus file, run command, provide input).

Wotch's Bridge Adapter connects to Claude Code's bridge endpoint and implements the client-side protocol:

```json
{
  "type": "state_update",
  "data": {
    "status": "tool_use",
    "tool": "FileEditTool",
    "file": "/src/main.js",
    "line": 142
  }
}
```

### Data Flow

```
Claude Code state changes
  → Bridge server emits state_update message
  → Wotch Bridge Adapter receives via WebSocket
  → Adapter translates to internal event
  → ClaudeIntegrationManager updates state
  → Renderer reflects new state

Wotch wants to provide context
  → Bridge Adapter sends context_response message
  → Claude Code receives workspace/project context
  → Claude uses context in its reasoning
```

### Key Design Decisions

- **Implement as bridge client, not server**: Claude Code runs the bridge server. Wotch connects as a client, just like VS Code does. This means no protocol design — we implement an existing spec.
- **WebSocket on port 19521**: Wotch listens for Claude Code's bridge announcements (via environment variables or discovery file) and connects. If Claude Code doesn't announce a bridge, this channel is simply inactive.
- **Minimal viable protocol subset**: The full bridge protocol may be extensive. Wotch implements only: state updates (receive), context requests (respond), and basic commands (send). Advanced features (diagnostics, decorations, inline diffs) are deferred.

---

## ClaudeIntegrationManager

The central coordinator that manages all three channels and provides a unified interface to the rest of Wotch.

```javascript
class ClaudeIntegrationManager extends EventEmitter {
  constructor() {
    this.hookReceiver = new HookReceiver(PORT_HOOKS);
    this.mcpServer = new WotchMCPServer();
    this.bridgeAdapter = new BridgeAdapter(PORT_BRIDGE);
    this.statusDetector = new EnhancedClaudeStatusDetector();
    this.regexFallback = new ClaudeStatusDetector(); // existing
  }

  // Unified status query — prefers structured sources, falls back to regex
  getStatus(tabId) { ... }

  // Channel health
  getChannelStatus() {
    return {
      hooks: this.hookReceiver.isActive(),
      mcp: this.mcpServer.isRegistered(),
      bridge: this.bridgeAdapter.isConnected(),
      fallback: this.regexFallback.isActive()
    };
  }
}
```

### Source Priority

When multiple channels report status simultaneously:

1. **Bridge** (highest priority) — most granular, real-time state
2. **Hooks** — structured events, slight delay (shell command execution)
3. **Regex fallback** (lowest priority) — heuristic, used only when no structured source is available

The manager uses a "last-write-wins with priority" strategy: a lower-priority source cannot override a higher-priority source's state unless a timeout has elapsed (e.g., 5 seconds without a bridge update triggers fallback to hooks or regex).

---

## Integration with Existing Architecture

### Files Modified

| File | Changes |
|------|---------|
| `src/main.js` | Add `ClaudeIntegrationManager` instantiation, replace direct `ClaudeStatusDetector` usage, add hook receiver startup/shutdown, add bridge adapter lifecycle, new IPC channels for integration status |
| `src/preload.js` | Add `window.wotch.integration.*` bridge methods (channel status, hook config status) |
| `src/renderer.js` | Add integration status indicator in settings panel, channel health display |
| `src/index.html` | Add CSS for integration status badges |
| `package.json` | Add `@modelcontextprotocol/sdk` dependency |

### Files Created

| File | Purpose |
|------|---------|
| `src/hook-receiver.js` | HTTP server for receiving Claude Code hook events |
| `src/mcp-server.js` | MCP server implementation (standalone script) |
| `src/bridge-adapter.js` | Bridge protocol client implementation |
| `src/claude-integration-manager.js` | Central coordinator for all channels |
| `src/enhanced-status-detector.js` | Multi-source status detection with priority |

### Settings Additions

```json
{
  "integration": {
    "hooksEnabled": true,
    "hooksPort": 19520,
    "mcpEnabled": true,
    "mcpTransport": "stdio",
    "bridgeEnabled": true,
    "bridgePort": 19521,
    "autoConfigureHooks": true,
    "autoRegisterMCP": true
  }
}
```

---

## Graceful Degradation

Each channel operates independently. The system must work in every combination:

| Hooks | MCP | Bridge | Behavior |
|-------|-----|--------|----------|
| yes | yes | yes | Full structured integration |
| yes | yes | no | Structured status + MCP tools, no live state sync |
| yes | no | no | Structured status only |
| no | yes | no | MCP tools available, regex status detection |
| no | no | yes | Bridge state sync, no hooks or MCP |
| no | no | no | Full regex fallback (current behavior) |

The UI displays channel status so users can diagnose connectivity:

```
Integration: ● Hooks  ● MCP  ○ Bridge  (○ = inactive, ● = active)
```

---

## Security Considerations

### Hook Receiver
- Binds to `127.0.0.1` only (same as Plan 1)
- No authentication required (localhost-only, same-user)
- Validates JSON schema of incoming events; rejects malformed payloads
- Rate-limited to 100 events/second per source (prevents runaway hooks)

### MCP Server
- stdio transport has no network exposure
- SSE transport binds to `127.0.0.1` only
- Tools are read-only except `wotch_checkpoint` (safe, additive operation)
- No file write, shell exec, or network access tools exposed

### Bridge Adapter
- Connects only to `localhost` bridge endpoints
- Validates message schema before processing
- Does not execute arbitrary commands from bridge messages
- Connection authenticated via Claude Code's bridge handshake

### New Invariants

- **INV-SEC-006**: Hook receiver must bind to `127.0.0.1` only; never `0.0.0.0`
- **INV-SEC-007**: MCP tools must not expose destructive operations (no file delete, no force push, no shell exec)
- **INV-SEC-008**: Bridge adapter must validate all incoming messages against a known schema before processing
