# Plan 0: IDE Bridge Adapter

## Overview

Claude Code integrates with IDEs (VS Code, JetBrains) via an **MCP-over-WebSocket** protocol. Each IDE writes a lockfile to `~/.claude/ide/[PORT].lock` containing workspace folders, PID, transport type, and an optional auth token. Claude Code discovers these lockfiles, connects via WebSocket, and communicates using **JSON-RPC 2.0** per the Model Context Protocol (MCP) specification.

Wotch implements a compatible **BridgeServer** that positions itself as another "IDE" in Claude Code's discovery system. This gives Claude Code native, bidirectional access to Wotch's tools — making Wotch a first-class integration target alongside VS Code and JetBrains.

---

## Protocol Details

### Discovery: Lockfile

Wotch writes a lockfile to `~/.claude/ide/[PORT].lock` on startup:

```json
{
  "workspaceFolders": ["/path/to/project1", "/path/to/project2"],
  "pid": 12345,
  "ideName": "Wotch",
  "transport": "ws",
  "runningInWindows": true,
  "authToken": "<random-24-byte-base64url>"
}
```

- **Port**: Default `19521`, configurable in settings. Falls back through +9 range if busy.
- **Auth token**: Generated fresh each startup using `crypto.randomBytes(24).toString("base64url")`.
- **File permissions**: `0o600` (owner read/write only).
- **Workspace folders**: Populated from `knownProjectPaths` and updated when projects change.
- **Cleanup**: Lockfile is deleted on app quit.

### Transport: WebSocket

- **URL**: `ws://127.0.0.1:[PORT]`
- **Subprotocol**: `mcp` (negotiated via WebSocket subprotocol header)
- **Binding**: `127.0.0.1` only (INV-SEC-019)
- **Auth header**: Claude Code sends `X-Claude-Code-Ide-Authorization: [token]`
- **DNS rebinding protection**: Host header validated against localhost aliases

### Protocol: MCP JSON-RPC 2.0

All messages are JSON-RPC 2.0:

```json
// Request (Claude Code → Wotch)
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "wotch_checkpoint", "arguments": {} } }

// Response (Wotch → Claude Code)
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"success\":true}" }] } }

// Notification (Claude Code → Wotch, no response expected)
{ "jsonrpc": "2.0", "method": "ide_connected", "params": { "pid": 5678 } }
```

### MCP Methods Implemented

| Method | Description |
|--------|-------------|
| `initialize` | Returns server info, capabilities (tools) |
| `tools/list` | Returns 8 Wotch tool definitions |
| `tools/call` | Executes a tool and returns result |
| `resources/list` | Returns empty list (no resources) |
| `prompts/list` | Returns empty list (no prompts) |

### Tools Exposed

Same 8 tools as the existing MCP server (shared `mcpHandlers` object):

| Tool | Description |
|------|-------------|
| `wotch_checkpoint` | Create git checkpoint (safe, additive commit) |
| `wotch_git_status` | Get branch, changed files, checkpoint count |
| `wotch_git_diff` | Get unified diff with configurable context lines |
| `wotch_project_info` | Get active project path and name |
| `wotch_terminal_buffer` | Read terminal output (ANSI-stripped, up to 500 lines) |
| `wotch_notify` | Show desktop notification |
| `wotch_list_tabs` | List terminal tabs with status |
| `wotch_tab_status` | Get Claude Code status for specific tab |

---

## Connection Flow

```
1. Wotch starts BridgeServer
   └─ Binds WebSocket server to 127.0.0.1:19521
   └─ Writes lockfile: ~/.claude/ide/19521.lock

2. Claude Code starts in a Wotch terminal
   └─ Scans ~/.claude/ide/*.lock
   └─ Finds 19521.lock, validates workspace match
   └─ Connects: ws://127.0.0.1:19521 (subprotocol: mcp)
   └─ Sends header: X-Claude-Code-Ide-Authorization: <token>

3. Handshake
   └─ Claude Code sends: initialize { protocolVersion, clientInfo }
   └─ Wotch responds: { serverInfo: { name: "wotch" }, capabilities: { tools: {} } }
   └─ Claude Code sends notification: ide_connected { pid }
   └─ Wotch logs connection, notifies renderer

4. Tool discovery
   └─ Claude Code sends: tools/list {}
   └─ Wotch responds with 8 tool definitions

5. Normal operation
   └─ Claude Code calls tools via: tools/call { name, arguments }
   └─ Wotch executes via shared mcpHandlers and returns results

6. Shutdown
   └─ Wotch closes all WebSocket connections
   └─ Deletes lockfile
```

---

## Three-Channel Architecture (Updated)

With the bridge now implemented, Wotch operates a complete three-channel model:

```
Claude Code (running in Wotch terminal)
    |
    |--- Hooks (12 events) ──► Wotch Hook Receiver (HTTP POST localhost:19520)
    |    (type: http)              |
    |                              +--> EnhancedClaudeStatusDetector
    |                              +--> Event bus (Plans 1, 3, 4)
    |                              +--> Notification forwarding
    |
    |--- MCP ──────────────► Wotch MCP Server (stdio transport, port 19523)
    |    (configured in              |
    |     ~/.claude.json)            +--> 8 tools (checkpoint, git, terminal, etc.)
    |
    |--- Bridge ───────────► Wotch Bridge Server (WebSocket, port 19521)
    |    (discovered via             |
    |     ~/.claude/ide/)            +--> Same 8 tools via MCP-over-WebSocket
    |                                +--> Bidirectional: Wotch can broadcast to Claude Code
    |
    |--- Regex Fallback ──► Existing ClaudeStatusDetector
         (PTY output)           (used when hooks unavailable)
```

### Channel Comparison

| Channel | Direction | Transport | Discovery | Auth |
|---------|-----------|-----------|-----------|------|
| Hooks | Claude Code → Wotch | HTTP POST | `~/.claude/settings.json` | None (localhost) |
| MCP | Claude Code → Wotch | stdio + TCP IPC | `~/.claude.json` | None (localhost) |
| Bridge | Bidirectional | WebSocket | `~/.claude/ide/*.lock` | Token in header |
| Regex | Claude Code → Wotch | PTY output | Always on | N/A |

### Why Three Channels?

- **Hooks**: Best for real-time status events (PreToolUse, SubagentStart, etc.). Fire-and-forget, low latency.
- **MCP**: Best for tool calls initiated by Claude Code. Works via stdio, no port conflicts.
- **Bridge**: Best for bidirectional communication. Wotch can broadcast to Claude Code. Uses the standard IDE integration path that Claude Code already supports.

The bridge and MCP channels expose the same tools. The bridge adds:
- **Bidirectional broadcasting**: Wotch can push notifications/events to Claude Code
- **Standard IDE integration**: Claude Code discovers Wotch like any IDE, no manual config needed
- **WebSocket persistence**: Long-lived connection vs. MCP's per-request model

---

## Settings

```json
{
  "integrationBridgeEnabled": true,
  "integrationBridgePort": 19521
}
```

---

## Security

- **INV-SEC-019**: Bridge WebSocket binds to `127.0.0.1` only
- Auth token validated via `X-Claude-Code-Ide-Authorization` header
- DNS rebinding protection via Host header validation
- Lockfile written with `0o600` permissions
- Token generated with `crypto.randomBytes(24)` per startup
- Lockfile cleaned up on shutdown

---

## Implementation

All bridge code lives in `src/main.js` as the `BridgeServer` class, following the codebase convention. Key components:

- **BridgeServer class**: WebSocket server, lockfile management, JSON-RPC handler
- **Shared mcpHandlers**: Same tool implementations used by the MCP stdio server
- **Settings**: `integrationBridgeEnabled`, `integrationBridgePort` in DEFAULT_SETTINGS
- **IPC**: `bridge-status`, `bridge-restart` handlers
- **Preload**: `bridgeGetStatus()`, `bridgeRestart()`, `onBridgeStatus()`
- **UI**: Bridge toggle, port input, status indicator, restart button in Settings
