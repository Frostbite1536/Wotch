# 04 — Trust Model and Approval System

## Overview

The trust model governs how much autonomy each agent has. It provides three approval modes with graduated levels of human oversight, dangerous action detection, emergency stop, and audit logging. The goal is to let experienced users run agents autonomously while ensuring new or untrusted agents require explicit approval for every action.

## Three Approval Modes

### 1. `suggest-only`

The most restrictive mode. The agent can reason and propose actions, but EVERY tool call requires explicit user approval before execution.

**Behavior:**
- Agent runs its conversation loop normally (API calls proceed).
- When the model returns a `tool_use` block, the runtime pauses.
- An approval request is sent to the renderer and displayed in the agent panel.
- The approval dialog shows: tool name, input parameters, and the agent's reasoning (text preceding the tool call).
- User can: **Approve** (execute the tool), **Reject** (skip the tool, tell the model it was rejected), or **Stop** (terminate the agent).
- If approved, the tool executes and the result is sent back to the model.
- If rejected, a `tool_result` with content "User rejected this action" and `is_error: true` is sent back to the model so it can adapt.

**Use cases:**
- First time using a new agent
- Agents that modify files or run commands
- Agents from untrusted sources

**Default for:** All agents on first use (before trust is promoted).

### 2. `ask-first`

The agent explains its intent before taking each action, but only actions classified as `write` or `dangerous` require approval. Read-only actions proceed automatically.

**Behavior:**
- `safe` and `read` danger-level tools execute automatically.
- `write` tools: the agent panel shows the pending action with a 3-second countdown. If the user doesn't intervene, the action executes. User can click "Pause" to require explicit approval.
- `dangerous` tools: always pause and require explicit approval (same as `suggest-only` for these tools).
- The agent panel streams all tool calls and results in real-time, so the user can monitor.

**Use cases:**
- Agents you've used a few times and trust for read operations
- Code reviewer (reads code, runs git diff — all read-only)
- Test writer (needs to write files — those writes require approval)

**Default for:** Built-in agents after user has run them 3 times in `suggest-only` mode.

### 3. `auto-execute`

The agent runs fully autonomously. All tools execute without approval, EXCEPT actions classified as `dangerous`.

**Behavior:**
- `safe`, `read`, and `write` tools execute immediately.
- `dangerous` tools still require approval (file deletion, force commands).
- The agent panel shows a real-time activity log but no approval dialogs for non-dangerous actions.
- A summary is shown when the agent completes.

**Use cases:**
- Highly trusted agents that you run frequently
- Error Fixer that you trust to read and fix code
- CI/CD agents that run in the background

**User must explicitly opt in:** Cannot be set via agent definition file — only via the trust settings UI.

## Trust Promotion and Demotion

### Promotion Rules

Trust starts at the mode specified in the agent definition (default: `ask-first`). Users can promote or demote at any time via the agent panel's trust dropdown.

```
suggest-only  ──→  ask-first  ──→  auto-execute
     ↑                                    │
     └────────────────────────────────────┘
              (user can always demote)
```

**Automatic promotion suggestions:** After an agent has been run N times without any rejected actions, the agent panel shows a subtle "Promote to [next level]?" prompt:
- `suggest-only` → `ask-first`: after 3 runs with 0 rejections
- `ask-first` → `auto-execute`: after 5 runs with 0 rejections

The user must click to confirm. Promotion never happens automatically.

**Automatic demotion (safety):** If an agent encounters a critical error or the user uses emergency stop, the trust level is automatically demoted one level:
- `auto-execute` → `ask-first`
- `ask-first` → `suggest-only`
- `suggest-only` stays at `suggest-only`

The user is notified of the demotion with a toast: "Agent [name] trust demoted to [level] after emergency stop."

### Per-Agent Trust Persistence

Trust settings are stored in `~/.wotch/agent-trust.json`:

```json
{
  "error-fixer": {
    "mode": "ask-first",
    "runCount": 7,
    "rejectionCount": 0,
    "lastRun": "2026-03-28T10:30:00Z",
    "emergencyStopCount": 0,
    "promotionDismissed": false
  },
  "code-reviewer": {
    "mode": "auto-execute",
    "runCount": 15,
    "rejectionCount": 1,
    "lastRun": "2026-03-28T09:15:00Z",
    "emergencyStopCount": 0,
    "promotionDismissed": false
  }
}
```

The `TrustManager` loads this file on startup and saves after each agent run completes. File permissions are set to `0o600`.

## Dangerous Action Detection

The `TrustManager.isDangerousAction(toolName, toolInput)` method checks tool calls against a set of danger rules. Dangerous actions require approval even in `auto-execute` mode.

### Danger Rules

```javascript
const DANGER_RULES = [
  // File deletion
  {
    tool: 'FileSystem.deleteFile',
    always: true,  // Always dangerous regardless of input
  },

  // Shell commands — pattern matching
  {
    tool: 'Shell.execute',
    patterns: [
      /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s|.*-rf\s)/,   // rm -r, rm -rf
      /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s)/,             // rm -f
      /\bgit\s+push\s+.*--force/,                      // git push --force
      /\bgit\s+push\s+-f\b/,                           // git push -f
      /\bgit\s+reset\s+--hard/,                        // git reset --hard
      /\bgit\s+clean\s+-[a-zA-Z]*f/,                  // git clean -f
      /\bgit\s+checkout\s+\./,                         // git checkout .
      /\bsudo\b/,                                      // sudo anything
      /\bchmod\s+777\b/,                               // chmod 777
      /\bcurl\s.*\|\s*(ba)?sh/,                        // curl | sh
      /\bwget\s.*\|\s*(ba)?sh/,                        // wget | sh
      /\bdd\s+if=/,                                    // dd (disk write)
      /\bmkfs\b/,                                      // mkfs (format)
      />\s*\/dev\//,                                   // write to device
      /\bnpm\s+publish\b/,                             // npm publish
      /\bdocker\s+rm\b/,                               // docker rm
      /\bdocker\s+system\s+prune/,                     // docker prune
      /\bkubectl\s+delete\b/,                          // kubectl delete
      /\bdropdb\b/,                                    // dropdb
      /\bDROP\s+(TABLE|DATABASE)\b/i,                  // SQL DROP
    ],
  },

  // Git checkpoint — not inherently dangerous but is a write
  // (classified as 'write', not 'dangerous')

  // File write to sensitive paths
  {
    tool: 'FileSystem.writeFile',
    pathPatterns: [
      /\.env/,           // Environment files
      /credentials/i,    // Credential files
      /\.pem$/,          // TLS certificates
      /\.key$/,          // Private keys
      /\.ssh\//,         // SSH directory
      /package\.json$/,  // Package manifest (could add malicious deps)
      /Makefile$/,       // Build config
      /Dockerfile$/,     // Container config
      /\.github\//,      // CI/CD config
      /\.gitlab-ci/,     // CI/CD config
    ],
  },
];
```

### Detection Implementation

```javascript
isDangerousAction(toolName, toolInput) {
  for (const rule of DANGER_RULES) {
    if (rule.tool !== toolName) continue;

    if (rule.always) return true;

    if (rule.patterns && toolInput.command) {
      for (const pattern of rule.patterns) {
        if (pattern.test(toolInput.command)) return true;
      }
    }

    if (rule.pathPatterns && toolInput.path) {
      for (const pattern of rule.pathPatterns) {
        if (pattern.test(toolInput.path)) return true;
      }
    }
  }

  return false;
}
```

## Approval Flow

### shouldRequireApproval Decision Tree

```
shouldRequireApproval(agentId, toolName, toolInput):
  │
  ├── Is action dangerous? (isDangerousAction)
  │     └── YES → return true (always require approval)
  │
  ├── Get agent mode (getApprovalMode(agentId))
  │
  ├── mode = "suggest-only"
  │     └── return true (all actions require approval)
  │
  ├── mode = "ask-first"
  │     ├── tool danger level = "safe" or "read" → return false
  │     └── tool danger level = "write" → return true
  │
  └── mode = "auto-execute"
        └── return false (only dangerous actions, handled above)
```

### Approval Request Flow

```
AgentRuntime                TrustManager              MainWindow (IPC)           Renderer
    │                           │                          │                       │
    │  shouldRequireApproval()  │                          │                       │
    │ ─────────────────────────>│                          │                       │
    │                           │                          │                       │
    │  true                     │                          │                       │
    │ <─────────────────────────│                          │                       │
    │                           │                          │                       │
    │  requestApproval(runId, actionId, tool, input, reasoning)                    │
    │ ─────────────────────────>│                          │                       │
    │                           │                          │                       │
    │                           │  send("agent-approval-   │                       │
    │                           │    request", payload)     │                       │
    │                           │ ────────────────────────>│                       │
    │                           │                          │  show approval dialog  │
    │                           │                          │ ─────────────────────>│
    │                           │                          │                       │
    │                           │                          │  user clicks Approve   │
    │                           │                          │ <─────────────────────│
    │                           │                          │                       │
    │                           │  invoke("agent-approve", │                       │
    │                           │    { runId, actionId,    │                       │
    │                           │      decision })          │                       │
    │                           │ <────────────────────────│                       │
    │                           │                          │                       │
    │  resolve("approved")      │                          │                       │
    │ <─────────────────────────│                          │                       │
    │                           │                          │                       │
    │  execute tool             │                          │                       │
    │ ─────>                    │                          │                       │
```

### Approval Request Object

Sent to renderer via `agent-approval-request` IPC channel:

```json
{
  "runId": "run-abc123",
  "actionId": "action-001",
  "agentName": "Error Fixer",
  "agentId": "error-fixer",
  "tool": "FileSystem.writeFile",
  "input": {
    "path": "src/utils.js",
    "content": "function add(a, b) {\n  return a + b;\n}\n"
  },
  "reasoning": "The error is caused by Math.abs() wrapping the addition. The fix is to remove it so negative results are returned correctly.",
  "dangerLevel": "write",
  "timestamp": "2026-03-28T10:30:15Z"
}
```

### Approval Timeout

If a user doesn't respond to an approval request within 5 minutes (300,000ms), the action is auto-rejected:

```javascript
requestApproval(runId, actionId, toolName, toolInput, reasoning) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      this.pendingApprovals.delete(actionId);
      resolve('rejected');
      this._emitEvent(runId, 'approval-resolved', { actionId, decision: 'timeout' });
    }, 300000);

    this.pendingApprovals.set(actionId, { resolve, timer, runId });

    // Send to renderer
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('agent-approval-request', {
        runId, actionId, agentName: this.getAgentName(runId),
        tool: toolName, input: toolInput, reasoning,
        dangerLevel: this.getToolDangerLevel(toolName, toolInput),
        timestamp: new Date().toISOString(),
      });
    }
  });
}

resolveApproval(actionId, decision) {
  const pending = this.pendingApprovals.get(actionId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  this.pendingApprovals.delete(actionId);
  pending.resolve(decision);
  return true;
}
```

## Emergency Stop

**Trigger:** Keyboard shortcut `Ctrl+Shift+K` (configurable), or the red stop button in the agent panel.

**Behavior:**
1. Immediately aborts all running agent API calls (via `AbortController.abort()`).
2. Sets all running agents to `stopped` state.
3. Clears all pending approval requests.
4. Demotes each stopped agent's trust level by one tier.
5. Emits `agent-event` with type `stopped` and reason `emergency-stop`.
6. Shows a toast notification: "All agents stopped."
7. Logs the emergency stop to the audit log.

**Implementation in AgentManager:**

```javascript
emergencyStopAll() {
  for (const [runId, runtime] of this.runningAgents) {
    runtime.stop();
    const agentId = runtime.definition.name;
    this.trustManager.demote(agentId, 'emergency-stop');
    this.trustManager.logAction(runId, agentId, 'EMERGENCY_STOP', {}, null, false);
  }
  this.runningAgents.clear();

  if (this.mainWindow && !this.mainWindow.isDestroyed()) {
    this.mainWindow.webContents.send('agent-event', {
      type: 'all-stopped',
      data: { reason: 'emergency-stop' },
      timestamp: new Date().toISOString(),
    });
  }
}
```

**Per-agent stop:** `stopAgent(runId)` stops only that agent. Does NOT auto-demote (only emergency stop demotes).

## Audit Logging

Every tool execution is logged to `~/.wotch/agent-logs/<agentId>/<runId>.jsonl`. Each line is a JSON object.

### Log Entry Format

```json
{
  "timestamp": "2026-03-28T10:30:15.123Z",
  "runId": "run-abc123",
  "agentId": "error-fixer",
  "type": "tool-call",
  "tool": "FileSystem.readFile",
  "input": { "path": "src/utils.js" },
  "output": { "content": "...", "lineCount": 5 },
  "approved": true,
  "approvalMode": "ask-first",
  "durationMs": 12,
  "isError": false
}
```

### Log Entry Types

| Type | Description |
|------|-------------|
| `agent-start` | Agent run started, includes context and trigger info |
| `tool-call` | Tool execution (input, output, approval status, duration) |
| `approval-request` | Approval was requested from user |
| `approval-response` | User responded (approved/rejected/timeout) |
| `agent-complete` | Agent finished normally (includes summary, turns, tokens) |
| `agent-stop` | Agent was stopped by user |
| `emergency-stop` | Emergency stop was triggered |
| `error` | Agent encountered an error |

### Log Retention

- Logs are retained for 30 days by default (configurable in settings: `agentSettings.logRetentionDays`).
- On startup, `AgentManager.initialize()` prunes logs older than the retention period.
- Log files are plain JSONL — no encryption (they contain tool inputs/outputs which may include file contents, but this is local-only).
- Total log directory size capped at 100MB. Oldest logs are deleted first when cap is reached.

### Log Viewing

Logs are not viewable in the UI in this plan (future enhancement). Users can read the JSONL files directly. The agent panel shows the current run's activity in real-time, which serves as the primary monitoring interface.

## Settings Integration

New settings key in `~/.wotch/settings.json`:

```json
{
  "agentSettings": {
    "enabled": true,
    "maxConcurrentAgents": 3,
    "defaultApprovalMode": "ask-first",
    "emergencyStopShortcut": "Ctrl+Shift+K",
    "approvalTimeoutMs": 300000,
    "logRetentionDays": 30,
    "autoTriggerEnabled": true,
    "apiKeyConfigured": false
  }
}
```

These are added to `DEFAULT_SETTINGS` in `src/main.js` and exposed via the existing `getSettings`/`saveSettings` IPC handlers.

## Security Invariants

This plan introduces the following security invariants to complement the existing ones in `docs/INVARIANTS.md`:

- **INV-AGENT-001:** Agents run in the main process but have no direct access to Electron APIs (BrowserWindow, ipcMain, etc.). They interact only through the ToolRegistry.
- **INV-AGENT-002:** All file operations are sandboxed to the project directory. Path traversal outside the project is blocked.
- **INV-AGENT-003:** The API key is stored in the main process only and never sent to the renderer.
- **INV-AGENT-004:** Shell commands executed by agents use `execFile`/`pty.spawn` with explicit arguments — no shell interpretation of user-controlled strings in command construction.
- **INV-AGENT-005:** Dangerous actions require approval even in `auto-execute` mode. There is no mode that skips all approvals.
- **INV-AGENT-006:** Emergency stop aborts all agent activity within 500ms. No agent can block or prevent emergency stop.
