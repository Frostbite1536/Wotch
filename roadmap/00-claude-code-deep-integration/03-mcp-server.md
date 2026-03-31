# Plan 0: MCP Server

## Overview

Wotch exposes itself as a Model Context Protocol (MCP) server, giving Claude Code native tool access to Wotch's capabilities. When Claude Code is configured to use the Wotch MCP server, it can create checkpoints, query git status, read terminal buffers, and send notifications — all as first-class tool calls within its agent loop.

---

## MCP Protocol Background

The Model Context Protocol is an open standard for connecting AI assistants to external tools and data sources. Claude Code has built-in support for MCP servers configured in `~/.claude.json` (user-level) or `.mcp.json` (project-level). An MCP server exposes:

- **Tools**: Functions the AI can call (with JSON Schema input/output)
- **Resources**: Data the AI can read (files, database records, etc.)
- **Prompts**: Templated prompts the AI can use

Wotch implements **tools only** for this plan. Resources and prompts may be added in future iterations.

---

## Transport Selection

### Option A: stdio (Recommended for Wotch-hosted Claude Code)

Claude Code launches the MCP server as a subprocess and communicates via stdin/stdout using JSON-RPC 2.0 messages.

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

The MCP server script (`mcp-server.js`) connects back to Wotch's main process via a localhost IPC socket to access Wotch state (git operations, terminal buffers, etc.).

**Pros**: No port management, no auth needed, Claude Code manages the lifecycle.
**Cons**: Each Claude Code session spawns a new process; MCP server must connect to Wotch main process for data.

### Option B: HTTP (For external Claude Code instances)

Wotch runs an HTTP-based MCP endpoint that Claude Code connects to over HTTP (streamable HTTP transport, replacing the deprecated SSE transport).

```json
{
  "mcpServers": {
    "wotch": {
      "type": "http",
      "url": "http://localhost:19522/mcp"
    }
  }
}
```

**Pros**: Single server instance, direct access to Wotch state.
**Cons**: Requires port management and localhost binding.

**Note**: SSE transport (`"type": "sse"`) is deprecated by the MCP specification. Use `"type": "http"` for remote/network transports.

### Recommendation

Support both transports. Use stdio as the default for Claude Code running inside Wotch terminals. Offer HTTP as a configurable option for advanced users running Claude Code externally.

---

## Tool Definitions

### `wotch_checkpoint`

Create a git checkpoint (safe, additive commit) in the active project.

```json
{
  "name": "wotch_checkpoint",
  "description": "Create a git checkpoint (snapshot commit) in the current project. This is a safe operation that creates a new commit on a checkpoint branch without modifying the working tree or current branch.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "description": "Optional checkpoint message. Defaults to timestamp-based message."
      }
    }
  }
}
```

**Implementation**: Calls the existing `gitCheckpoint()` function in `main.js`.

**Response**:
```json
{
  "content": [{
    "type": "text",
    "text": "Checkpoint created: abc1234 (2026-03-31 14:30:00)"
  }]
}
```

---

### `wotch_git_status`

Query the git status of the active project.

```json
{
  "name": "wotch_git_status",
  "description": "Get the current git status including branch name, changed files count, and checkpoint count for the active Wotch project.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

**Implementation**: Calls the existing `gitGetStatus()` function.

**Response**:
```json
{
  "content": [{
    "type": "text",
    "text": "Branch: main\nChanged files: 3\nCheckpoints: 5\nClean: false"
  }]
}
```

---

### `wotch_git_diff`

Get the diff between the current state and the last checkpoint.

```json
{
  "name": "wotch_git_diff",
  "description": "Get the git diff showing changes since the last checkpoint. Useful for reviewing what has changed before creating a new checkpoint.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "context_lines": {
        "type": "number",
        "description": "Number of context lines around changes. Default: 3."
      }
    }
  }
}
```

**Implementation**: Calls `gitGetDiff()` with the specified context.

---

### `wotch_project_info`

Get information about the active Wotch project.

```json
{
  "name": "wotch_project_info",
  "description": "Get information about the currently active project in Wotch, including path, name, source (VS Code, JetBrains, etc.), and detected project type.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

**Implementation**: Returns the current `currentProject` state from the main process.

---

### `wotch_terminal_buffer`

Read recent terminal output from a Wotch tab.

```json
{
  "name": "wotch_terminal_buffer",
  "description": "Read the recent terminal output from a Wotch terminal tab. Returns the last N lines of visible terminal content.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "lines": {
        "type": "number",
        "description": "Number of lines to read from the end of the buffer. Default: 50. Max: 500."
      },
      "tab_id": {
        "type": "string",
        "description": "ID of the tab to read. Defaults to the active tab."
      }
    }
  }
}
```

**Implementation**: Reads from the xterm.js buffer via IPC to the renderer. Requires a new IPC channel `terminal-buffer-read` that extracts text from the terminal's buffer.

**Security note**: Terminal output may contain sensitive data (passwords, tokens). The tool description warns Claude Code of this, and the output is only available within the same user's Claude Code session.

---

### `wotch_notify`

Send a system notification via Wotch.

```json
{
  "name": "wotch_notify",
  "description": "Send a desktop notification to the user via Wotch. Use this to alert the user about completed tasks, errors, or important events.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "Notification title"
      },
      "body": {
        "type": "string",
        "description": "Notification body text"
      }
    },
    "required": ["title", "body"]
  }
}
```

**Implementation**: Creates an Electron `Notification` in the main process.

---

### `wotch_list_tabs`

List all open terminal tabs.

```json
{
  "name": "wotch_list_tabs",
  "description": "List all open terminal tabs in Wotch, including their IDs, names, connection types (local/SSH), and current Claude Code status.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

**Implementation**: Iterates the `ptyProcesses` map and returns tab metadata.

---

### `wotch_tab_status`

Get the Claude Code status for a specific tab.

```json
{
  "name": "wotch_tab_status",
  "description": "Get the current Claude Code status (idle/thinking/working/waiting/done/error) for a specific terminal tab.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tab_id": {
        "type": "string",
        "description": "The tab ID to query"
      }
    },
    "required": ["tab_id"]
  }
}
```

---

## MCP Server Implementation

### Standalone Script (`src/mcp-server.js`)

The MCP server runs as a standalone Node.js script that Claude Code launches via the `command` field. It communicates with the Wotch main process over a localhost TCP connection for data access.

```javascript
// src/mcp-server.js
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const net = require('net');

const IPC_PORT = parseInt(process.env.WOTCH_IPC_PORT || '19523');

class WotchMCPServer {
  constructor() {
    this.server = new McpServer({
      name: 'wotch',
      version: '1.0.0'
    });
    this.ipcClient = null;
    this._registerTools();
  }

  async start() {
    // Connect to Wotch main process
    this.ipcClient = await this._connectToWotch();

    // Start MCP server with stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  _registerTools() {
    this.server.tool('wotch_checkpoint', { message: { type: 'string' } },
      async ({ message }) => {
        const result = await this._callWotch('gitCheckpoint', { message });
        return { content: [{ type: 'text', text: result }] };
      }
    );

    this.server.tool('wotch_git_status', {},
      async () => {
        const result = await this._callWotch('gitGetStatus', {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    );

    this.server.tool('wotch_git_diff', { context_lines: { type: 'number' } },
      async ({ context_lines }) => {
        const result = await this._callWotch('gitGetDiff', { contextLines: context_lines || 3 });
        return { content: [{ type: 'text', text: result }] };
      }
    );

    this.server.tool('wotch_project_info', {},
      async () => {
        const result = await this._callWotch('getProjectInfo', {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    );

    this.server.tool('wotch_terminal_buffer',
      { lines: { type: 'number' }, tab_id: { type: 'string' } },
      async ({ lines, tab_id }) => {
        const result = await this._callWotch('terminalBuffer', {
          lines: Math.min(lines || 50, 500),
          tabId: tab_id
        });
        return { content: [{ type: 'text', text: result }] };
      }
    );

    this.server.tool('wotch_notify',
      { title: { type: 'string' }, body: { type: 'string' } },
      async ({ title, body }) => {
        await this._callWotch('notify', { title, body });
        return { content: [{ type: 'text', text: 'Notification sent' }] };
      }
    );

    this.server.tool('wotch_list_tabs', {},
      async () => {
        const result = await this._callWotch('listTabs', {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    );

    this.server.tool('wotch_tab_status',
      { tab_id: { type: 'string' } },
      async ({ tab_id }) => {
        const result = await this._callWotch('tabStatus', { tabId: tab_id });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    );
  }

  async _connectToWotch() {
    return new Promise((resolve, reject) => {
      const client = net.createConnection({ port: IPC_PORT, host: '127.0.0.1' }, () => {
        resolve(client);
      });
      client.on('error', reject);
    });
  }

  async _callWotch(method, params) {
    return new Promise((resolve, reject) => {
      const id = Date.now().toString();
      const request = JSON.stringify({ id, method, params }) + '\n';
      this.ipcClient.write(request);

      const handler = (data) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.id === id) {
            this.ipcClient.removeListener('data', handler);
            if (response.error) reject(new Error(response.error));
            else resolve(response.result);
          }
        } catch (e) { /* partial data, wait for more */ }
      };
      this.ipcClient.on('data', handler);

      // Timeout after 10 seconds
      setTimeout(() => {
        this.ipcClient.removeListener('data', handler);
        reject(new Error('Wotch IPC timeout'));
      }, 10000);
    });
  }
}

const server = new WotchMCPServer();
server.start().catch(err => {
  process.stderr.write(`Wotch MCP server error: ${err.message}\n`);
  process.exit(1);
});
```

### Main Process IPC Server

The Wotch main process runs a simple TCP server that the MCP script connects to:

```javascript
// Added to main.js
class MCPIPCServer {
  constructor(port = 19523) {
    this.port = port;
    this.server = null;
  }

  start(handlers) {
    this.server = net.createServer((socket) => {
      socket.on('data', async (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const { id, method, params } = JSON.parse(line);
            if (handlers[method]) {
              const result = await handlers[method](params);
              socket.write(JSON.stringify({ id, result }) + '\n');
            } else {
              socket.write(JSON.stringify({ id, error: `Unknown method: ${method}` }) + '\n');
            }
          } catch (e) {
            // Handle parse errors
          }
        }
      });
    });

    this.server.listen(this.port, '127.0.0.1');
  }

  stop() {
    if (this.server) this.server.close();
  }
}
```

---

## Auto-Registration

When `integration.autoRegisterMCP` is enabled, Wotch adds itself to Claude Code's MCP server configuration:

```javascript
function registerMCPServer(wotchPath, ipcPort) {
  // MCP servers are configured in ~/.claude.json (NOT ~/.claude/settings.json)
  const configPath = path.join(os.homedir(), '.claude.json');
  let config = {};

  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) { /* start fresh */ }

  if (!config.mcpServers) config.mcpServers = {};

  // Only add if not already present
  if (!config.mcpServers.wotch) {
    config.mcpServers.wotch = {
      type: 'stdio',
      command: 'node',
      args: [path.join(wotchPath, 'resources', 'mcp-server.js')],
      env: {
        WOTCH_IPC_PORT: String(ipcPort)
      }
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
}
```

Alternatively, for project-level registration, write to `.mcp.json` in the project root.

### Safety Rules

- Never overwrite existing MCP server configs
- Idempotent: repeated calls produce the same result
- The MCP server script path must resolve to Wotch's installed location
- First-run prompts the user before modifying `~/.claude.json`

---

## Security

### Tool Safety Classification

| Tool | Read/Write | Risk | Notes |
|------|-----------|------|-------|
| `wotch_checkpoint` | Write | Low | Additive only; creates a new commit, never destructive |
| `wotch_git_status` | Read | None | Returns metadata only |
| `wotch_git_diff` | Read | None | Returns diff text |
| `wotch_project_info` | Read | None | Returns project metadata |
| `wotch_terminal_buffer` | Read | Low | May contain sensitive output |
| `wotch_notify` | Write | None | Creates a notification; no side effects |
| `wotch_list_tabs` | Read | None | Returns tab metadata |
| `wotch_tab_status` | Read | None | Returns status enum |

### Invariant: INV-SEC-007

MCP tools must not expose destructive operations. The following are explicitly **never** exposed as MCP tools:

- File write/delete operations
- Shell command execution
- Git push, reset, rebase, or force operations
- Settings modification
- SSH credential access
- PTY write (typing into terminals)

### IPC Server Security

- Binds to `127.0.0.1` only
- No authentication (same-user localhost)
- Request size capped at 64KB
- Connection limit: 5 simultaneous clients
- Timeout: 10 seconds per request

---

## Testing

### Unit Tests

1. Each MCP tool returns correct data format
2. Tool input validation rejects invalid parameters
3. `wotch_terminal_buffer` caps lines at 500
4. `wotch_checkpoint` creates a commit and returns the hash
5. IPC server handles concurrent requests correctly

### Integration Tests

1. Configure MCP server in test settings → launch Claude Code → verify tools appear in tool list
2. Call `wotch_checkpoint` via MCP → verify checkpoint created in git log
3. Call `wotch_git_status` → verify response matches actual git status
4. Call `wotch_terminal_buffer` → verify output matches visible terminal content
5. Kill Wotch main process → verify MCP server exits cleanly
