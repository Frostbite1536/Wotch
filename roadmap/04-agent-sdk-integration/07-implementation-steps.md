# Implementation Steps — Agent SDK Integration

## Step 1: Install Agent SDK

**Files:** `package.json`

```bash
npm install claude_agent_sdk
```

The Agent SDK provides the framework for defining, running, and managing autonomous agents within Wotch.

**Testing:** `npm install` succeeds; SDK can be required without errors.

---

## Step 2: Agent Definition Loader

**Files:** `src/main.js`

Create a loader that reads agent definitions from `~/.wotch/agents/` and built-in agents from `src/agents/`.

```
~/.wotch/agents/
  my-agent.yaml       # Agent definition (system_prompt inline or file reference)
```

- Parse YAML definitions against the schema in `02-agent-definition-format.md`
- Validate required fields (name, version, model, system_prompt)
- Validate tool references against available tools
- Merge built-in agents with user agents (user overrides built-in by name)

**Testing:** Valid agent discovered. Invalid YAML skipped with warning. Built-in agents always available.

---

## Step 3: Built-in Agent Definitions

**Files:** `src/agents/` (new directory)

Create the 4 built-in agents from `06-built-in-agents.md`:

- `src/agents/error-fixer.yaml`
- `src/agents/code-reviewer.yaml`
- `src/agents/test-writer.yaml`
- `src/agents/deploy-assistant.yaml`

Each includes: system prompt, model selection, tool permissions, trigger conditions, and max iterations.

**Testing:** All 4 agents load. System prompts render correctly with variable substitution.

---

## Step 4: Tool Registry

**Files:** `src/main.js`

Implement the tool registry that maps tool names to implementations, as specified in `03-tool-definitions.md`.

**Built-in tools (19 across 7 categories):**
- `Shell.execute` / `Shell.readVisibleTerminal` — shell command execution with timeout
- `FileSystem.readFile` / `FileSystem.writeFile` / `FileSystem.listFiles` / `FileSystem.searchFiles` / `FileSystem.deleteFile` — filesystem operations (sandboxed to project)
- `Git.status` / `Git.diff` / `Git.log` / `Git.checkpoint` / `Git.branchInfo` — git operations
- `Terminal.readBuffer` / `Terminal.detectPattern` — terminal observation
- `Project.list` / `Project.getInfo` — project discovery
- `Wotch.getStatus` / `Wotch.showNotification` — Wotch integration
- `Agent.spawn` — sub-agent spawning with depth limits

Each tool has:
- Input schema (JSON Schema)
- Permission requirements
- Execution function
- Output formatting

**Trust model:** Tools are gated by the agent's `tools` list in its definition. An agent can only use tools it declares. The trust model from `04-trust-model.md` applies: built-in agents get default permissions, user agents require explicit grants.

**Testing:** Each tool executes correctly. Tool not in agent's list → rejected. Permission denied → error returned to agent.

---

## Step 5: Agent Runtime

**Files:** `src/main.js`

`AgentRuntime` class that executes an agent's agentic loop:

1. Load agent definition and system prompt
2. Initialize conversation with system prompt + user's task
3. Call Claude API with tool definitions
4. If response contains tool_use → execute tool, append result, loop
5. If response is text-only → agent is done
6. Respect `max_iterations` limit
7. Stream progress to renderer via IPC

```js
class AgentRuntime {
  constructor(agentDef, apiKey) {
    this.agent = agentDef;
    this.client = new Anthropic({ apiKey });
    this.messages = [];
    this.iteration = 0;
    this.cancelled = false;
  }

  async run(task, context) {
    const systemPrompt = this.renderSystemPrompt(context);
    this.messages = [{ role: 'user', content: task }];

    while (this.iteration < this.agent.max_iterations && !this.cancelled) {
      this.iteration++;
      broadcastAgentProgress({ iteration: this.iteration, status: 'thinking' });

      const response = await this.client.messages.create({
        model: this.agent.model,
        system: systemPrompt,
        messages: this.messages,
        tools: this.getToolDefinitions(),
        max_tokens: 4096,
      });

      this.messages.push({ role: 'assistant', content: response.content });

      // Check for tool use
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // Agent is done — extract text response
        const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        broadcastAgentProgress({ iteration: this.iteration, status: 'done', result: text });
        return text;
      }

      // Execute tools
      const toolResults = [];
      for (const toolUse of toolUses) {
        broadcastAgentProgress({ iteration: this.iteration, status: 'tool', tool: toolUse.name });
        const result = await this.executeTool(toolUse.name, toolUse.input);
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result });
      }
      this.messages.push({ role: 'user', content: toolResults });
    }

    return 'Agent reached maximum iterations';
  }

  cancel() { this.cancelled = true; }
}
```

**Testing:**
1. Run error-fixer agent with a failing test → agent reads file, identifies fix, writes fix
2. Cancel during execution → stops cleanly
3. Max iterations reached → returns gracefully
4. Tool not in agent's list → rejected

---

## Step 6: Agent UI

**Files:** `src/index.html`, `src/renderer.js`

As specified in `05-agent-ui.md`:

### Agent Panel
Add an "Agents" view alongside Terminal and Chat in the view toggle. The agent panel shows:
- Agent selector dropdown (built-in + user agents)
- Task input area
- Run/Cancel buttons
- Progress display (iteration count, current tool, status)
- Result display with markdown rendering

### Agent Progress
During execution, show:
- Current iteration number / max
- What the agent is doing (thinking, executing tool X, done)
- Tool execution results with **tool-specific rich rendering**:
  - File reads: line count + content preview (first 8 lines)
  - File writes/edits: success confirmation, diff rendering with syntax highlighting
  - Search results: matched file count + file list
  - Shell commands: exit code, stdout preview with color coding
  - Git diffs: +/- line counts with colored diff display
  - Git log: commit hash + message list
  - Agent.spawn: sub-agent started notification
- Streaming text output

### Agent Tree Visualization
When agents are running (especially with sub-agent spawning):
- Real-time hierarchical tree showing parent → child relationships
- Per-node status icons with color coding (running/waiting/completed/failed/stopped)
- Per-node iteration progress display
- Per-node "Stop" buttons to halt individual agents or entire subtrees
- Auto-refreshes on start/complete/stop events

### IPC
- `agent-start` — start agent with task and context
- `agent-stop` — stop/cancel running agent
- `agent-list` — list available agents
- `agent-event` (main→renderer) — progress updates (streaming events)

**Testing:** Select agent → enter task → run → progress displayed → result shown.

---

## Step 7: Trigger System

**Files:** `src/main.js`

Auto-trigger agents based on terminal output patterns:

```js
function checkAgentTriggers(tabId, terminalOutput) {
  for (const agent of discoveredAgents) {
    if (!agent.triggers) continue;
    for (const trigger of agent.triggers) {
      if (trigger.type === 'pattern' && new RegExp(trigger.pattern).test(terminalOutput)) {
        // Suggest agent to user (don't auto-run)
        mainWindow.webContents.send('agent-suggestion', {
          agentId: agent.name,
          agentName: agent.display_name,
          trigger: trigger.description,
          tabId,
        });
      }
    }
  }
}
```

In PTY onData handler, after status detection:
```js
checkAgentTriggers(tabId, strippedData);
```

Renderer shows a non-intrusive suggestion toast: "Error Fixer can help with this test failure. [Run] [Dismiss]"

**Testing:**
1. Run failing test → "Error Fixer" suggestion appears
2. Click "Run" → agent starts with error context
3. Click "Dismiss" → suggestion disappears
4. Same trigger doesn't re-suggest within 60 seconds

---

## Step 8: Agent Approval System

**Files:** `src/main.js`, `src/renderer.js`

Implement the approval modes from `04-trust-model.md`:

- **Full auto:** Agent executes all tools without asking (built-in agents, read-only tools)
- **Approve writes:** Agent auto-executes reads, pauses for write approval
- **Approve all:** Agent pauses before every tool execution

Show approval dialog in renderer:
```
Agent wants to: write_file src/auth.ts
[Allow] [Allow All] [Deny] [Stop Agent]
```

IPC: `agent-approval-request` (main→renderer), `agent-approve` / `agent-reject` (renderer→main)

**Testing:**
1. Agent in "approve writes" mode → reads execute, writes pause for approval
2. "Allow" → single tool executes
3. "Allow All" → remaining tools auto-approved
4. "Deny" → tool skipped, agent continues
5. "Stop Agent" → agent cancelled

---

## Step 9: Agent Definition Editor

**Files:** `src/renderer.js`, `src/index.html`

Simple YAML editor for creating/editing agent definitions:
- Accessible from Settings > Agents > "Create Agent" button
- Pre-populated template with comments
- Validate on save
- Save to `~/.wotch/agents/<name>/agent.yaml`

---

## Step 10: New Invariants

**Files:** `docs/INVARIANTS.md`

- **INV-AGENT-001:** Agents run in the main process but have no direct access to Electron APIs. They interact only through the ToolRegistry.
- **INV-AGENT-002:** All file operations are sandboxed to the project directory. Path traversal outside the project is blocked. Symlinks pointing outside the project are rejected.
- **INV-AGENT-003:** The API key is stored in the main process only and never sent to the renderer.
- **INV-AGENT-004:** Shell commands executed by agents use `execFile`/`pty.spawn` with explicit arguments — no shell interpretation.
- **INV-AGENT-005:** Dangerous actions require approval even in `auto-execute` mode. There is no mode that skips all approvals.
- **INV-AGENT-006:** Emergency stop aborts all agent activity within 500ms. No agent can block or prevent emergency stop.
- **INV-AGENT-007:** Sub-agent spawning is limited to `MAX_AGENT_DEPTH = 3`. Each spawned sub-agent counts toward the global `maxConcurrentAgents` limit. Stopping a parent agent cascades to all its descendants. Sub-agents inherit project context but get their own conversation loop, tool instances, and approval queue.

---

## Summary of Changes by File

| File | Changes |
|------|---------|
| `package.json` | Add `claude_agent_sdk` (if separate from `@anthropic-ai/sdk`) |
| `src/main.js` | Agent definition loader, tool registry, AgentRuntime class, trigger system, approval system, IPC handlers |
| `src/agents/` | 4 built-in agent definitions (YAML + system prompts) |
| `src/preload.js` | ~13 new IPC bridge methods for agents (including `getAgentTree`) |
| `src/index.html` | Agent panel HTML/CSS, approval dialog, suggestion toast |
| `src/renderer.js` | Agent panel logic, progress display, approval UI, trigger suggestions, definition editor |
| `docs/INVARIANTS.md` | INV-AGENT-001 through INV-AGENT-006 |

## New IPC Channels (9 invoke + 4 events = 13)

**Renderer → Main (invoke):** `agent-list`, `agent-start`, `agent-stop`, `agent-approve`, `agent-reject`, `agent-runs`, `agent-get-trust`, `agent-set-trust`, `agent-tree`

**Main → Renderer (send):** `agent-event`, `agent-approval-request`, `agent-list-changed`, `agent-suggestion`
