# Plan 0: Bridge Adapter

## Overview

Claude Code includes a bidirectional IDE bridge system designed for VS Code and JetBrains integration. Wotch implements the client side of this protocol, positioning itself as another "IDE" that Claude Code communicates with. The bridge enables the richest integration channel: real-time state synchronization, context provision, and command routing.

---

## Bridge Protocol Background

Claude Code's bridge system (`src/bridge/` in the source) operates as follows:

1. **Discovery**: When Claude Code starts, it checks for a bridge configuration file or environment variable indicating a bridge client is available.
2. **Connection**: Claude Code connects to the bridge client's WebSocket endpoint (or the client connects to Claude Code's endpoint, depending on the transport).
3. **Handshake**: Both sides exchange capabilities and version information.
4. **Message exchange**: JSON messages flow bidirectionally for state updates, context requests, and commands.

### Discovery Mechanism

Claude Code discovers bridge clients through:

- **Environment variable**: `CLAUDE_BRIDGE_PORT` — set in the PTY environment when launching Claude Code in a Wotch tab
- **Configuration file**: `~/.claude/bridge.json` — persistent configuration for bridge endpoints

Wotch uses the environment variable approach since it controls the PTY environment:

```javascript
// In main.js, when creating a PTY for Claude Code:
const pty = nodePty.spawn(shell, args, {
  env: {
    ...process.env,
    CLAUDE_BRIDGE_PORT: String(bridgePort),
    WOTCH_TAB_ID: tabId
  }
});
```

---

## Bridge Message Protocol

### Message Format

All bridge messages are JSON objects with a `type` field and optional `data` payload:

```typescript
interface BridgeMessage {
  type: string;
  id?: string;          // For request-response pairs
  data?: any;           // Type-specific payload
  timestamp?: number;   // Unix ms
}
```

### Message Types: Claude Code → Wotch

| Type | Description | Data |
|------|-------------|------|
| `handshake` | Initial connection setup | `{ version, capabilities }` |
| `state_update` | Claude Code's current state | `{ status, tool?, file?, line? }` |
| `tool_start` | Tool execution beginning | `{ tool, input }` |
| `tool_end` | Tool execution complete | `{ tool, output, duration }` |
| `conversation_update` | Conversation context changed | `{ messageCount, tokenUsage }` |
| `file_changed` | Claude Code modified a file | `{ path, changeType }` |
| `context_request` | Claude Code wants context | `{ requestId, contextType }` |
| `error` | Error notification | `{ message, code }` |

### Message Types: Wotch → Claude Code

| Type | Description | Data |
|------|-------------|------|
| `handshake_response` | Acknowledge connection | `{ clientName: "wotch", version, capabilities }` |
| `context_response` | Provide requested context | `{ requestId, context }` |
| `command` | Execute a command | `{ command, args }` |
| `focus_file` | Request Claude Code to focus a file | `{ path, line? }` |

---

## Wotch Bridge Adapter Implementation

### Architecture

```
┌─────────────────────────────────────┐
│         Bridge Adapter              │
│                                     │
│  ┌─────────────┐  ┌─────────────┐  │
│  │  WS Server  │  │  Protocol   │  │
│  │  (:19521)   │──│  Handler    │  │
│  └─────────────┘  └──────┬──────┘  │
│                          │          │
│  ┌─────────────┐  ┌──────┴──────┐  │
│  │  Context    │  │  State      │  │
│  │  Provider   │  │  Tracker    │  │
│  └─────────────┘  └─────────────┘  │
└─────────────────────────────────────┘
```

### Implementation

```javascript
// src/bridge-adapter.js
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class BridgeAdapter extends EventEmitter {
  constructor(port = 19521) {
    super();
    this.port = port;
    this.wss = null;
    this.connections = new Map(); // tabId -> ws
    this.states = new Map();     // tabId -> latest state
    this.connected = false;
  }

  start() {
    this.wss = new WebSocket.Server({
      port: this.port,
      host: '127.0.0.1'
    });

    this.wss.on('connection', (ws, req) => {
      this._handleConnection(ws, req);
    });

    this.wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        this.port++;
        if (this.port < 19530) {
          this.wss = new WebSocket.Server({ port: this.port, host: '127.0.0.1' });
        }
      }
    });
  }

  stop() {
    for (const [, ws] of this.connections) {
      ws.close();
    }
    if (this.wss) this.wss.close();
  }

  isConnected() {
    return this.connections.size > 0;
  }

  getState(tabId) {
    return this.states.get(tabId) || null;
  }

  // Send a context response to Claude Code
  sendContext(tabId, requestId, context) {
    const ws = this.connections.get(tabId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'context_response',
        id: requestId,
        data: { requestId, context }
      }));
    }
  }

  // Send a command to Claude Code
  sendCommand(tabId, command, args) {
    const ws = this.connections.get(tabId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'command',
        data: { command, args }
      }));
    }
  }

  _handleConnection(ws, req) {
    let tabId = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'handshake':
            tabId = this._resolveTabId(msg);
            this.connections.set(tabId, ws);
            ws.send(JSON.stringify({
              type: 'handshake_response',
              data: {
                clientName: 'wotch',
                version: '1.0.0',
                capabilities: ['state_tracking', 'context_provision', 'notifications']
              }
            }));
            this.connected = true;
            this.emit('connected', tabId);
            break;

          case 'state_update':
            if (tabId) {
              this.states.set(tabId, msg.data);
              this.emit('state-update', { tabId, state: msg.data });
            }
            break;

          case 'tool_start':
            if (tabId) {
              this.emit('tool-start', { tabId, ...msg.data });
            }
            break;

          case 'tool_end':
            if (tabId) {
              this.emit('tool-end', { tabId, ...msg.data });
            }
            break;

          case 'context_request':
            if (tabId) {
              this.emit('context-request', {
                tabId,
                requestId: msg.data.requestId,
                contextType: msg.data.contextType
              });
            }
            break;

          case 'file_changed':
            if (tabId) {
              this.emit('file-changed', { tabId, ...msg.data });
            }
            break;

          default:
            // Unknown message type — log and ignore
            break;
        }
      } catch (e) {
        // Malformed message — ignore
      }
    });

    ws.on('close', () => {
      if (tabId) {
        this.connections.delete(tabId);
        this.states.delete(tabId);
        this.emit('disconnected', tabId);
        if (this.connections.size === 0) {
          this.connected = false;
        }
      }
    });
  }

  _resolveTabId(handshake) {
    // Try to extract tab ID from handshake data or connection metadata
    return handshake.data?.tabId || `bridge-${Date.now()}`;
  }
}

module.exports = { BridgeAdapter };
```

---

## Context Provision

When Claude Code sends a `context_request`, Wotch responds with relevant context from its existing data sources.

### Supported Context Types

| Context Type | Data Provided | Source |
|-------------|---------------|--------|
| `workspace` | Project path, name, type, detected IDE | `detectProjects()` |
| `git` | Branch, changed files, checkpoint count, recent diff | `gitGetStatus()`, `gitGetDiff()` |
| `terminal` | Last N lines of terminal output | xterm.js buffer |
| `tabs` | Open tabs, their status, connection types | `ptyProcesses` map |
| `settings` | Relevant Wotch settings (non-sensitive) | `settings` object |

### Context Request Flow

```
Claude Code needs workspace context
  → Sends: { type: "context_request", data: { requestId: "req-1", contextType: "workspace" } }
  → BridgeAdapter emits "context-request" event
  → ClaudeIntegrationManager gathers workspace data from detectProjects()
  → Sends: { type: "context_response", data: { requestId: "req-1", context: { path: "/project", ... } } }
  → Claude Code receives context and uses it in reasoning
```

---

## State Tracking

Bridge state updates provide the most granular view of Claude Code's internal state.

### State Update Fields

```typescript
interface StateUpdate {
  status: 'idle' | 'thinking' | 'tool_use' | 'streaming' | 'waiting' | 'error';
  tool?: string;           // Active tool name (when status === 'tool_use')
  file?: string;           // File being read/edited
  line?: number;           // Line number in file
  tokenUsage?: {
    input: number;
    output: number;
  };
  agentDepth?: number;     // 0 = main, 1+ = sub-agent
  contextWindow?: {
    used: number;
    total: number;
  };
}
```

### Mapping to Wotch Status

| Bridge Status | Wotch Status | Notes |
|--------------|--------------|-------|
| `idle` | `idle` | Direct map |
| `thinking` | `thinking` | Claude is reasoning |
| `tool_use` | `working` | Tool is executing |
| `streaming` | `thinking` | Generating response text |
| `waiting` | `waiting` | Waiting for user input |
| `error` | `error` | Error occurred |

The bridge provides richer state than hooks or regex — it includes the specific tool, file, line number, and resource usage. The enhanced status detector can use these for richer pill displays (e.g., "Editing main.js:142" instead of just "Working").

---

## Connection Lifecycle

### Startup

1. Wotch starts the Bridge Adapter WebSocket server on port 19521
2. When a new terminal tab is created and Claude Code is launched, Wotch sets `CLAUDE_BRIDGE_PORT=19521` in the PTY environment
3. Claude Code detects the environment variable and connects to `ws://localhost:19521`
4. Handshake exchange establishes capabilities

### During Session

5. Claude Code sends state updates as it works
6. Claude Code sends context requests when it needs workspace info
7. Wotch responds to context requests with gathered data
8. Wotch can send commands to Claude Code (optional, used by Plan 4 agents)

### Shutdown

9. When Claude Code exits, WebSocket disconnects
10. BridgeAdapter cleans up connection and state maps
11. Status detector falls back to hooks or regex for that tab

### Reconnection

If the WebSocket drops unexpectedly:
- Claude Code will attempt to reconnect (built-in retry logic)
- Wotch's BridgeAdapter accepts new connections at any time
- State is re-established via a fresh handshake
- No data is lost — hooks and regex provide continuity during the gap

---

## Integration with Other Channels

The bridge adapter complements rather than replaces hooks and MCP:

| Capability | Hooks | MCP | Bridge |
|-----------|-------|-----|--------|
| Status detection | yes | no | **yes (best)** |
| Tool call tracking | yes | no | **yes (with details)** |
| Wotch tool access | no | **yes** | no |
| Context injection | no | no | **yes** |
| Bidirectional comms | no | request-response | **yes (streaming)** |
| Works without config | no (needs hooks setup) | no (needs MCP config) | **yes (env var only)** |

The bridge is the most capable channel but also the least stable (depends on Claude Code's bridge implementation, which may change). Hooks and MCP provide fallback reliability.

---

## Security

- WebSocket server binds to `127.0.0.1` only
- No authentication beyond localhost isolation (same pattern as Claude Code's own bridge)
- Message validation: all incoming messages are parsed and validated against known types; unknown types are ignored
- No arbitrary command execution from bridge messages — Wotch only processes recognized message types
- Context responses never include sensitive data (SSH credentials, API keys, encrypted settings)
- Connection limit: 10 simultaneous bridge connections (one per tab, with margin)

### New Invariant: INV-SEC-008

Bridge adapter must validate all incoming messages against a known schema before processing. Unknown message types are logged and discarded, never executed.

---

## Limitations & Future Work

### Current Limitations

- Bridge protocol is reverse-engineered from Claude Code's VS Code extension behavior — it is not a published, stable API
- Some message types may change between Claude Code versions
- The bridge may not be available in all Claude Code editions (e.g., older versions, web-only)

### Future Enhancements (Not in this plan)

- **Rich status display**: Show file paths and line numbers in the pill ("Editing src/main.js:142")
- **Token usage display**: Show context window usage in the UI (bridge provides this data)
- **Agent depth indicator**: Show when Claude Code is running sub-agents
- **Command palette integration**: Send commands to Claude Code from Wotch's command palette

---

## Testing

### Unit Tests

1. Bridge adapter starts WebSocket server on configured port
2. Handshake exchange completes correctly
3. State updates are parsed and emitted as events
4. Context requests trigger event emission
5. Context responses are sent in correct format
6. Connection cleanup on WebSocket close
7. Unknown message types are ignored (not crash)
8. Multiple simultaneous connections are handled

### Integration Tests

1. Set `CLAUDE_BRIDGE_PORT` → launch Claude Code in test PTY → verify handshake
2. Trigger tool use in Claude Code → verify `tool_start`/`tool_end` events received
3. Kill Claude Code → verify clean disconnection → verify fallback to hooks/regex
4. Reconnect after disconnect → verify state re-established
