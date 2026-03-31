# 01 — System Architecture

## High-Level Overview

The Agent SDK integration adds three new modules to Wotch:

1. **AgentRuntime** (main process) — Manages agent lifecycle, runs the Claude API conversation loop, dispatches tool calls, enforces trust/approval.
2. **AgentLoader** (main process) — Discovers, parses, validates, and hot-reloads agent definitions from disk.
3. **AgentPanel** (renderer) — UI panel for agent selection, activity streaming, and action approval.

These modules communicate via IPC channels through the existing preload bridge pattern (`contextBridge.exposeInMainWorld`).

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        RENDERER PROCESS                             │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Agent Panel UI                          │   │
│  │  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐  │   │
│  │  │Agent Selector│ │Activity Log  │ │Approval Dialog       │  │   │
│  │  │(dropdown)    │ │(streaming)   │ │(approve/reject/stop) │  │   │
│  │  └──────┬──────┘ └──────┬───────┘ └──────────┬───────────┘  │   │
│  └─────────┼───────────────┼────────────────────┼──────────────┘   │
│            │               │                    │                   │
│  ┌─────────┴───────────────┴────────────────────┴──────────────┐   │
│  │                  window.wotch (preload bridge)               │   │
│  │                                                              │   │
│  │  Agent IPC Methods:                                          │   │
│  │    listAgents()          → invoke "agent-list"               │   │
│  │    startAgent(id, ctx)   → invoke "agent-start"              │   │
│  │    stopAgent(runId)      → invoke "agent-stop"               │   │
│  │    approveAction(id, d)  → invoke "agent-approve"            │   │
│  │    rejectAction(id, r)   → invoke "agent-reject"             │   │
│  │    getAgentRuns()        → invoke "agent-runs"               │   │
│  │    getAgentTrust(id)     → invoke "agent-get-trust"          │   │
│  │    setAgentTrust(id, t)  → invoke "agent-set-trust"          │   │
│  │                                                              │   │
│  │  Agent IPC Events (main → renderer):                         │   │
│  │    onAgentEvent(cb)      ← on "agent-event"                  │   │
│  │    onAgentApproval(cb)   ← on "agent-approval-request"       │   │
│  │    onAgentListChanged(cb)← on "agent-list-changed"           │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ IPC (contextBridge)
┌───────────────────────────────┴─────────────────────────────────────┐
│                         MAIN PROCESS                                │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      AgentManager                            │   │
│  │                                                              │   │
│  │  ┌────────────┐  ┌────────────────┐  ┌───────────────────┐  │   │
│  │  │AgentLoader  │  │AgentRuntime(s)  │  │TrustManager      │  │   │
│  │  │             │  │                 │  │                   │  │   │
│  │  │• scan dirs  │  │• conversation   │  │• approval modes  │  │   │
│  │  │• parse YAML │  │  loop per agent │  │• dangerous action│  │   │
│  │  │• validate   │  │• tool dispatch  │  │  detection       │  │   │
│  │  │• watch for  │  │• token counting │  │• audit logging   │  │   │
│  │  │  changes    │  │• max turns      │  │• trust storage   │  │   │
│  │  └──────┬─────┘  └───────┬─────────┘  └────────┬──────────┘  │   │
│  │         │                │                      │             │   │
│  │  ┌──────┴────────────────┴──────────────────────┴──────────┐  │   │
│  │  │                   ToolRegistry                          │  │   │
│  │  │                                                         │  │   │
│  │  │  Shell.*       FileSystem.*    Git.*        Agent.*       │  │   │
│  │  │  Terminal.*    Project.*       Wotch.*                   │  │   │
│  │  └─────────┬───────────┬──────────┬────────────────────────┘  │   │
│  └────────────┼───────────┼──────────┼──────────────────────────┘   │
│               │           │          │                              │
│  ┌────────────┴───┐ ┌─────┴────┐ ┌──┴──────────────────────────┐   │
│  │ PTY Manager    │ │ fs (Node)│ │ ClaudeStatusDetector         │   │
│  │ (node-pty)     │ │          │ │ Git Operations               │   │
│  │ ptyProcesses   │ │          │ │ Project Detection            │   │
│  └────────────────┘ └──────────┘ └─────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Breakdown

### AgentManager (`src/main.js`)

The top-level coordinator. Instantiated once in `src/main.js` after `app.whenReady()`.

```
class AgentManager {
  constructor(mainWindow, settings, claudeStatus, ptyProcesses)

  // Lifecycle
  async initialize()          // Load agents, set up watchers, register IPC
  async shutdown()             // Stop all running agents, flush logs

  // Agent discovery
  getAvailableAgents()         // Returns AgentDefinition[]
  getRunningAgents()           // Returns AgentRun[]

  // Agent control
  async startAgent(agentId, context)   // Start an agent run
  async stopAgent(runId)               // Emergency stop
  async approveAction(runId, actionId, decision)  // User approval response

  // Internal
  _registerIpcHandlers()
  _setupTriggers()
  _onStatusChange(tabId, oldState, newState)
  _onCheckpoint(projectPath, result)
}
```

### AgentLoader (integrated into AgentManager in `src/main.js`)

Discovers and parses agent definition files. Implemented as `_discoverAgents()`, `_scanDir()`, `parseAgentYaml()`, and `validateAgentDef()` functions.

```
class AgentLoader {
  constructor(settingsDir)

  // Discovery
  scanAgents()                     // Scan global + per-project dirs
  watchForChanges(callback)        // fs.watch on agent directories

  // Parsing
  parseAgentFile(filePath)         // YAML/JSON → AgentDefinition
  validateDefinition(def)          // Schema validation, returns errors[]

  // Paths
  getGlobalAgentsDir()             // ~/.wotch/agents/
  getProjectAgentsDir(projectPath) // <project>/.wotch/agents/
}
```

### AgentRuntime (`src/main.js`)

Runs a single agent's conversation loop. One instance per active agent run.

```
class AgentRuntime {
  constructor(definition, context, toolRegistry, trustManager, eventEmitter)

  // Lifecycle
  async run()          // Main conversation loop
  async stop()         // Abort immediately (also stops child agents)
  pause()              // Pause at next tool call boundary
  resume()             // Resume after pause

  // State
  getState()           // 'idle' | 'running' | 'paused' | 'waiting-approval' | 'completed' | 'failed' | 'stopped'
  getTurnCount()       // Current turn number
  getTokensUsed()      // Total tokens consumed
  getMessages()        // Conversation history

  // Sub-agent tracking
  parentRunId          // null for root agents, runId of parent for sub-agents
  depth                // 0 for root, increments for each nesting level (max MAX_AGENT_DEPTH=3)
  childRunIds[]        // List of spawned sub-agent runIds

  // Internal
  _buildSystemPrompt(context)
  _executeToolCall(toolName, toolInput)
  _checkApproval(toolName, toolInput)
  _enforceGuardrails()
  _emitEvent(type, data)
}
```

### ToolRegistry (implemented as `createAgentTools()` and `getToolSchemas()` in `src/main.js`)

Manages the set of tools available to agents.

```
class ToolRegistry {
  constructor(ptyProcesses, claudeStatus, settings)

  registerTool(category, name, handler, schema, permissions)
  getTool(fullName)              // e.g., "Shell.execute"
  getToolsForAgent(definition)   // Filter by agent's declared tools
  getToolSchema(fullName)        // Returns JSON Schema for API
  getAllToolSchemas()             // All tools as Anthropic API format

  // Built-in registration
  _registerShellTools()
  _registerFileSystemTools()
  _registerGitTools()
  _registerTerminalTools()
  _registerProjectTools()
  _registerWotchTools()
}
```

### TrustManager (implemented as `loadAgentTrust()`, `saveAgentTrust()`, `TOOL_DANGER_LEVELS`, and `_needsApproval()` in `src/main.js`)

Enforces the graduated trust model.

```
class TrustManager {
  constructor(settingsDir)

  getApprovalMode(agentId)       // 'suggest-only' | 'ask-first' | 'auto-execute'
  setApprovalMode(agentId, mode)

  isDangerousAction(toolName, toolInput)   // Check against danger rules
  shouldRequireApproval(agentId, toolName, toolInput)  // Combines mode + danger check

  requestApproval(runId, actionId, toolName, toolInput, reasoning)  // → Promise<decision>

  logAction(runId, agentId, toolName, toolInput, result, approved)  // Audit log

  loadTrustSettings()
  saveTrustSettings()
}
```

## Agent Runtime Lifecycle

```
                    ┌─────────┐
                    │  IDLE   │
                    └────┬────┘
                         │ startAgent(id, ctx)
                         ▼
                    ┌─────────┐
              ┌────>│ RUNNING │<────────────────────┐
              │     └────┬────┘                     │
              │          │                          │
              │          │ tool_use in response      │
              │          ▼                          │
              │     ┌─────────────────┐             │
              │     │ CHECK APPROVAL  │             │
              │     └────┬───────┬────┘             │
              │          │       │                  │
              │    needs approval│  auto-approved    │
              │          │       │                  │
              │          ▼       └──────────────────┤
              │     ┌──────────────────┐            │
              │     │ WAITING-APPROVAL │            │
              │     └────┬────────┬────┘            │
              │          │        │                 │
              │     approved   rejected             │
              │          │        │                 │
              │          │        ▼                 │
              │          │   ┌─────────┐            │
              │          │   │ tool skipped,        │
              │          │   │ tell model  ─────────┘
              │          │   └─────────┘
              │          │
              │          ▼
              │     ┌─────────────┐
              │     │EXECUTE TOOL │
              │     └──────┬──────┘
              │            │
              │            ▼
              │     ┌─────────────┐
              │     │ SEND RESULT │──── more turns? ──── yes ───┘
              │     └──────┬──────┘
              │            │ no (end_turn / max turns / max tokens)
              │            ▼
              │     ┌───────────┐
              │     │ COMPLETED │
              │     └───────────┘
              │
              │     ┌───────────┐
     stop()───┴────>│  STOPPED  │
                    └───────────┘
```

### Conversation Loop Detail

Each `AgentRuntime.run()` call performs the following loop:

```
1. Build initial messages:
   - System prompt (from agent definition + injected context)
   - User message (trigger context: error text, diff content, etc.)

2. LOOP (until done or stopped):
   a. Call Anthropic API: client.messages.create({
        model: definition.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: conversationHistory,
        tools: toolSchemas
      })

   b. Stream response tokens → emit "agent-event" { type: "reasoning", text }

   c. If response has stop_reason "end_turn":
      → emit "agent-event" { type: "completed", summary }
      → break

   d. If response has stop_reason "tool_use":
      For each tool_use block:
        i.   Emit "agent-event" { type: "tool-call", tool, input }
        ii.  Check approval: trustManager.shouldRequireApproval(...)
        iii. If approval needed:
             - Emit "agent-approval-request" { runId, actionId, tool, input, reasoning }
             - Wait for user response (Promise)
             - If rejected: add tool_result with error "User rejected this action"
        iv.  If approved/auto:
             - Execute tool via toolRegistry
             - Emit "agent-event" { type: "tool-result", tool, output }
             - Add tool_result to conversation

   e. Increment turn counter
      If turnCount >= definition.maxTurns → emit warning, break
      If tokensUsed >= definition.maxTokenBudget → emit warning, break

3. Flush audit log
4. Set state to "completed" or "stopped"
```

## Data Flow: Agent Trigger to UI Update

### Example: Error Fixer trigger flow

```
Terminal output (PTY)
        │
        ▼
ClaudeStatusDetector.feed(tabId, rawData)
        │
        │  state transitions to "error"
        ▼
AgentManager._onStatusChange(tabId, "working", "error")
        │
        │  finds agents with trigger: { type: "onStatusChange", state: "error" }
        ▼
AgentManager.startAgent("error-fixer", {
  tabId,
  terminalBuffer: last 500 lines,
  projectPath: currentProject.path,
  errorState: statusDetector.getTabStatus(tabId)
})
        │
        ▼
new AgentRuntime(definition, context, tools, trust, emitter)
        │
        │  runtime.run()
        ▼
Anthropic API call (streaming)
        │
        │  tokens stream in
        ▼
emitter.emit("agent-event", { runId, type: "reasoning", text: "I see a TypeError..." })
        │
        ▼
mainWindow.webContents.send("agent-event", { runId, type: "reasoning", text })
        │
        │  IPC to renderer
        ▼
Agent Panel UI updates activity log (streaming text append)
        │
        │  tool_use: FileSystem.readFile
        ▼
emitter.emit("agent-event", { runId, type: "tool-call", tool: "FileSystem.readFile", input: {...} })
        │
        ▼
TrustManager.shouldRequireApproval("error-fixer", "FileSystem.readFile", input)
        │
        │  mode=suggest-only → approval required
        ▼
mainWindow.webContents.send("agent-approval-request", { runId, actionId, tool, input, reasoning })
        │
        ▼
Renderer shows approval dialog
        │
        │  User clicks "Approve"
        ▼
ipcRenderer.invoke("agent-approve", { runId, actionId, decision: "approved" })
        │
        ▼
AgentRuntime receives approval, executes tool, continues loop
```

## Agent Isolation

Each agent run gets its own `AgentRuntime` instance with:

1. **Separate conversation state** — its own `messages[]` array, turn counter, token counter.
2. **Scoped tool access** — only tools declared in the agent definition are available. The `ToolRegistry.getToolsForAgent(definition)` method filters.
3. **Independent cancellation** — `stopAgent(runId)` aborts only that run's API call and clears its pending approvals.
4. **Separate audit log** — each run writes to its own log file under `~/.wotch/agent-logs/<agentId>/<runId>.jsonl`.

Agents do NOT share:
- Conversation history (each run starts fresh)
- Tool execution state (no shared mutable state between agents)
- Approval queues (each run has its own pending approvals)

Agents DO share (read-only or via Wotch APIs):
- The terminal buffer (read-only observation via `Terminal.readBuffer`)
- Git status (via `Git.status`, which calls the existing `gitGetStatus()`)
- Project information (via `Project.getInfo`)
- File system (via `FileSystem.*` tools, which use Node.js `fs` module)

## Sub-Agent Spawning

Agents can spawn child agents via the `Agent.spawn` tool, enabling tree-structured task delegation:

1. **Depth limit:** Maximum nesting depth is `MAX_AGENT_DEPTH = 3`. Deeper spawning is rejected with an error.
2. **Parent-child tracking:** `AgentRuntime` tracks `parentRunId`, `depth`, and `childRunIds[]`. `AgentManager.getRunningAgents()` includes this hierarchy data.
3. **Cascading stop:** Stopping a parent agent also stops all its child agents recursively. Emergency stop halts the entire tree.
4. **Concurrent limit applies globally:** Sub-agents count toward the `maxConcurrentAgents` limit (default 3), preventing runaway spawning.
5. **Context inheritance:** Child agents inherit the project context (path, branch) from their parent but get their own conversation loop and tool instances.
6. **Agent tree IPC:** The `agent-tree` IPC channel returns a nested tree structure for UI visualization.

## Agent Tree Visualization

The agent panel includes a real-time tree view that:
- Shows all running agents in a hierarchical tree (parent → child)
- Displays per-node status (running/waiting/completed/failed/stopped) with color-coded icons
- Shows iteration progress for running agents
- Provides per-node "Stop" buttons to halt individual agents or entire subtrees
- Auto-refreshes on agent start/complete/stop events

## Concurrency Model

- **Max concurrent agents:** 3 (configurable in settings). Additional start requests are queued.
- **API calls:** Each `AgentRuntime` makes its own `messages.create()` calls. They are independent HTTP requests to the Anthropic API.
- **Tool execution:** Tools run sequentially within a single agent (one tool at a time). Different agents' tools can run concurrently.
- **Approval queue:** Each agent has its own approval queue. Multiple approval dialogs can be shown (stacked in the UI).
- **PTY sharing:** Agents use a dedicated "agent PTY" per project — not the user's visible terminal tabs. This prevents agents from interfering with user input. The Shell.execute tool creates a temporary PTY, runs the command, captures output, and destroys the PTY.

## File Layout

Following Wotch's convention of keeping logic in `src/main.js` (same pattern as PluginHost, ClaudeStatusDetector, etc.):

```
src/
  main.js                    # AgentManager, AgentRuntime, ToolRegistry, TrustManager,
                             # agent loader, IPC handlers, trigger system
  preload.js                 # Add agent IPC bridge methods (~11 methods)
  renderer.js                # Agent panel logic, progress display, approval UI
  index.html                 # Agent panel HTML structure + CSS

~/.wotch/
  settings.json              # Modified: add agentSettings key
  agents/                    # NEW: global agent definitions directory
    error-fixer.yaml
    code-reviewer.yaml
    test-writer.yaml
    deploy-assistant.yaml
  agent-logs/                # NEW: audit logs directory
    <agentId>/
      <runId>.jsonl
  agent-trust.json           # NEW: per-agent trust settings

<project>/
  .wotch/
    agents/                  # NEW: per-project agent definitions
      custom-agent.yaml
```

## IPC Channel Summary

### Renderer → Main (invoke)

| Channel | Payload | Returns |
|---------|---------|---------|
| `agent-list` | `{}` | `AgentDefinition[]` |
| `agent-start` | `{ agentId, context? }` | `{ runId }` |
| `agent-stop` | `{ runId }` | `{ success }` |
| `agent-approve` | `{ runId, actionId, decision }` | `{ success }` |
| `agent-reject` | `{ runId, actionId, reason? }` | `{ success }` |
| `agent-runs` | `{}` | `AgentRun[]` |
| `agent-get-trust` | `{ agentId }` | `{ mode, overrides }` |
| `agent-set-trust` | `{ agentId, mode }` | `{ success }` |
| `agent-tree` | `{}` | `AgentTreeNode[]` (nested with `children`) |

### Main → Renderer (send)

| Channel | Payload |
|---------|---------|
| `agent-event` | `{ runId, type, data, timestamp }` |
| `agent-approval-request` | `{ runId, actionId, agentName, tool, input, reasoning }` |
| `agent-list-changed` | `{ agents: AgentDefinition[] }` |
| `agent-suggestion` | `{ agentId, agentName, trigger, tabId }` |

### Event Types in `agent-event`

| Type | Data |
|------|------|
| `started` | `{ agentId, agentName, context }` |
| `reasoning` | `{ text }` (streaming tokens) |
| `tool-call` | `{ tool, input }` |
| `tool-result` | `{ tool, input, output, durationMs }` |
| `approval-waiting` | `{ actionId, tool, input }` |
| `approval-resolved` | `{ actionId, decision }` |
| `warning` | `{ message }` (turn limit, token limit) |
| `error` | `{ message, stack? }` |
| `completed` | `{ summary, turnsUsed, tokensUsed }` |
| `stopped` | `{ reason }` |

## Integration with Existing Code

### Changes to `src/main.js`

1. Import `AgentManager` at the top.
2. After `createWindow()` and `app.whenReady()`, instantiate:
   ```javascript
   const agentManager = new AgentManager(mainWindow, settings, claudeStatus, ptyProcesses);
   await agentManager.initialize();
   ```
3. Modify `ClaudeStatusDetector.broadcast()` to also notify the `AgentManager` of state changes (add a callback hook).
4. Modify `gitCheckpoint()` to notify `AgentManager` after a successful checkpoint.
5. Add IPC handler registrations (delegated to `agentManager._registerIpcHandlers()`).

### Changes to `src/preload.js`

Add agent methods to `contextBridge.exposeInMainWorld("wotch", { ... })`:
```javascript
// Agent SDK
listAgents: () => ipcRenderer.invoke("agent-list"),
startAgent: (agentId, context) => ipcRenderer.invoke("agent-start", { agentId, context }),
stopAgent: (runId) => ipcRenderer.invoke("agent-stop", { runId }),
approveAction: (runId, actionId, decision) => ipcRenderer.invoke("agent-approve", { runId, actionId, decision }),
rejectAction: (runId, actionId, reason) => ipcRenderer.invoke("agent-reject", { runId, actionId, reason }),
getAgentRuns: () => ipcRenderer.invoke("agent-runs"),
getAgentTree: () => ipcRenderer.invoke("agent-tree"),
getAgentTrust: (agentId) => ipcRenderer.invoke("agent-get-trust", { agentId }),
setAgentTrust: (agentId, mode) => ipcRenderer.invoke("agent-set-trust", { agentId, mode }),

onAgentEvent: (callback) => {
  ipcRenderer.removeAllListeners("agent-event");
  ipcRenderer.on("agent-event", (_e, payload) => callback(payload));
},
onAgentApproval: (callback) => {
  ipcRenderer.removeAllListeners("agent-approval-request");
  ipcRenderer.on("agent-approval-request", (_e, payload) => callback(payload));
},
onAgentListChanged: (callback) => {
  ipcRenderer.removeAllListeners("agent-list-changed");
  ipcRenderer.on("agent-list-changed", (_e, payload) => callback(payload));
},
onAgentSuggestion: (callback) => {
  ipcRenderer.removeAllListeners("agent-suggestion");
  ipcRenderer.on("agent-suggestion", (_e, payload) => callback(payload));
},
```

### Changes to `src/renderer.js`

Add the agent panel module (inline or as a separate section at the bottom of the file) that:
- Manages agent panel open/close state
- Renders agent selector dropdown
- Handles streaming `agent-event` messages to build the activity log
- Shows approval dialogs
- Provides keyboard shortcut handling (Ctrl+Shift+A to toggle panel, Ctrl+Shift+K to emergency stop)

### Changes to `src/index.html`

Add the agent panel HTML structure inside the `#panel` container, as a sibling to the terminal area. See `05-agent-ui.md` for the exact HTML.

## API Key Management

Agents require an Anthropic API key to call the Claude API. The key is managed by the existing `CredentialManager` from Plan 2, which stores the encrypted key in `~/.wotch/credentials` (file mode 0o600, encrypted at rest via `safeStorage` or AES-256-GCM fallback per INV-SEC-014).

The AgentManager calls `credentialManager.getKey()` on initialization. If no key is found, agent features are disabled and the agent panel shows a "Configure API Key" prompt that links to the existing Claude API settings section.

The key is never sent to the renderer process. All API calls happen in the main process.

## Error Handling

1. **API errors** (rate limit, auth failure, network) — AgentRuntime catches, emits `error` event, retries once after 2s for rate limits, fails for auth errors.
2. **Tool execution errors** — caught per-tool, returned as tool_result with `is_error: true` so the model can recover.
3. **Agent definition errors** — AgentLoader.validateDefinition() returns structured errors, invalid agents are skipped with a console warning.
4. **Approval timeout** — if a user doesn't respond to an approval request within 5 minutes, the action is auto-rejected and the agent is notified.
5. **Runaway agents** — maxTurns (default 10) and maxTokenBudget (default 50000) prevent infinite loops. Emergency stop (Ctrl+Shift+K) aborts the API call via AbortController.
