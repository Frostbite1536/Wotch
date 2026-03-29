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
  my-agent/
    agent.yaml       # Agent definition
    system-prompt.md  # System prompt template
    tools/            # Custom tool definitions (optional)
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

- `src/agents/error-fixer/agent.yaml` + `system-prompt.md`
- `src/agents/code-reviewer/agent.yaml` + `system-prompt.md`
- `src/agents/test-writer/agent.yaml` + `system-prompt.md`
- `src/agents/deploy-assistant/agent.yaml` + `system-prompt.md`

Each includes: system prompt, model selection, tool permissions, trigger conditions, and max iterations.

**Testing:** All 4 agents load. System prompts render correctly with variable substitution.

---

## Step 4: Tool Registry

**Files:** `src/main.js`

Implement the tool registry that maps tool names to implementations, as specified in `03-tool-definitions.md`.

**Built-in tools:**
- `read_file` / `write_file` / `list_directory` — filesystem operations
- `execute_command` — shell command execution with timeout and cwd
- `search_code` — ripgrep-based code search
- `git_status` / `git_diff` / `git_commit` — git operations
- `terminal_read` / `terminal_write` — interact with Wotch terminal tabs
- `web_fetch` — HTTP requests (with URL allowlist)

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
- Tool execution results (collapsible)
- Streaming text output

### IPC
- `agent-run` — start agent with task and context
- `agent-cancel` — cancel running agent
- `agent-list` — list available agents
- `agent-progress` (main→renderer) — progress updates

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

IPC: `agent-approval-request` (main→renderer), `agent-approval-response` (renderer→main)

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

- **INV-SEC-014:** Agent Tool Gating — agents can only use tools declared in their definition
- **INV-SEC-015:** Agent Iteration Limits — all agents must have `max_iterations` (default 10, max 50)
- **INV-SEC-016:** Agent Approval — write operations require user approval unless agent is in full-auto mode and is a built-in agent with only read tools
- **INV-DATA-008:** Agent Definition Immutability — built-in agent definitions in `src/agents/` must not be modified at runtime; user overrides go in `~/.wotch/agents/`

---

## Summary of Changes by File

| File | Changes |
|------|---------|
| `package.json` | Add `claude_agent_sdk` (if separate from `@anthropic-ai/sdk`) |
| `src/main.js` | Agent definition loader, tool registry, AgentRuntime class, trigger system, approval system, IPC handlers |
| `src/agents/` | 4 built-in agent definitions (YAML + system prompts) |
| `src/preload.js` | ~6 new IPC bridge methods for agents |
| `src/index.html` | Agent panel HTML/CSS, approval dialog, suggestion toast |
| `src/renderer.js` | Agent panel logic, progress display, approval UI, trigger suggestions, definition editor |
| `docs/INVARIANTS.md` | INV-SEC-014, INV-SEC-015, INV-SEC-016, INV-DATA-008 |

## New IPC Channels (8)

`agent-run`, `agent-cancel`, `agent-list`, `agent-progress` (m→r), `agent-suggestion` (m→r), `agent-approval-request` (m→r), `agent-approval-response` (r→m), `agent-save-definition`
