# 05 — Agent UI Panel

## Overview

The agent UI is a collapsible side panel that appears inside the expanded Wotch window, to the right of the terminal area. It provides agent selection, a streaming activity log, action approval dialogs, and agent status indicators.

The panel is toggled with `Ctrl+Shift+A` (or via a button in the tab bar). It does not affect the pill/collapsed state — it only appears when the window is expanded.

## Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Tab Bar  [+]  [project ▾]  [branch]  [changes]  [⚡ checkpoint]  [🤖]│
├───────────────────────────────────┬──────────────────────────────────┤
│                                   │ Agent Panel (collapsible)        │
│                                   │                                  │
│         Terminal Area             │ ┌──────────────────────────────┐ │
│         (xterm.js)                │ │ Agent: [Error Fixer ▾] [⏹]  │ │
│                                   │ ├──────────────────────────────┤ │
│                                   │ │                              │ │
│                                   │ │  Activity Log (streaming)    │ │
│                                   │ │                              │ │
│                                   │ │  🔵 Analyzing terminal       │ │
│                                   │ │     output...                │ │
│                                   │ │                              │ │
│                                   │ │  📖 Read src/utils.js        │ │
│                                   │ │     [5 lines, 12ms]          │ │
│                                   │ │                              │ │
│                                   │ │  ┌──────────────────────┐   │ │
│                                   │ │  │ ⚠ APPROVAL NEEDED    │   │ │
│                                   │ │  │                      │   │ │
│                                   │ │  │ Write src/utils.js   │   │ │
│                                   │ │  │                      │   │ │
│                                   │ │  │ [Approve] [Reject]   │   │ │
│                                   │ │  └──────────────────────┘   │ │
│                                   │ │                              │ │
│                                   │ ├──────────────────────────────┤ │
│                                   │ │ Turns: 2/10  Tokens: 4.2k   │ │
│                                   │ └──────────────────────────────┘ │
│                                   │                                  │
├───────────────────────────────────┴──────────────────────────────────┤
│ Status bar / search bar                                              │
└──────────────────────────────────────────────────────────────────────┘
```

## Panel States

1. **Hidden** — Panel is not visible. Terminal takes full width. The `[🤖]` button in the tab bar shows a dot indicator if any agent is running.
2. **Open, No Agent Running** — Panel shows agent selector and "Start" button. Activity log is empty or shows last run summary.
3. **Open, Agent Running** — Panel shows streaming activity log, tool calls, and any pending approval dialogs.
4. **Open, Approval Pending** — An approval dialog is prominently displayed within the activity log.

## HTML Structure

Add the following inside `#panel` in `src/index.html`, after the terminal area (`#terminals`):

```html
<!-- Agent Panel (inside #panel, after #terminals) -->
<div id="agent-panel" class="agent-panel hidden">
  <!-- Header -->
  <div class="agent-panel-header">
    <div class="agent-selector">
      <select id="agent-select">
        <option value="">Select agent...</option>
      </select>
    </div>
    <div class="agent-controls">
      <button id="btn-agent-start" class="agent-btn agent-btn-start" disabled title="Start agent">▶</button>
      <button id="btn-agent-stop" class="agent-btn agent-btn-stop hidden" title="Stop agent (Ctrl+Shift+K)">⏹</button>
    </div>
    <button id="btn-agent-close" class="agent-btn agent-btn-close" title="Close panel">✕</button>
  </div>

  <!-- Trust indicator -->
  <div id="agent-trust-bar" class="agent-trust-bar hidden">
    <span class="trust-label">Trust:</span>
    <select id="agent-trust-select">
      <option value="suggest-only">Suggest Only</option>
      <option value="ask-first">Ask First</option>
      <option value="auto-execute">Auto Execute</option>
    </select>
  </div>

  <!-- Activity Log -->
  <div id="agent-activity" class="agent-activity">
    <div class="agent-empty-state">
      <div class="agent-empty-icon">🤖</div>
      <div class="agent-empty-text">Select an agent to get started</div>
      <div class="agent-empty-hint">Agents can analyze errors, review code, write tests, and more.</div>
    </div>
  </div>

  <!-- Status Footer -->
  <div id="agent-footer" class="agent-footer hidden">
    <span id="agent-status-text" class="agent-status-text">Idle</span>
    <span id="agent-turns" class="agent-stat">Turns: 0/10</span>
    <span id="agent-tokens" class="agent-stat">Tokens: 0</span>
  </div>
</div>

<!-- Agent toggle button in tab bar (add to existing tab bar controls) -->
<!-- Insert this button after the checkpoint button in the tab-bar-right area -->
<button id="btn-agent-toggle" class="tab-btn" title="Agent panel (Ctrl+Shift+A)">
  <span class="agent-toggle-icon">🤖</span>
  <span id="agent-indicator" class="agent-indicator hidden"></span>
</button>
```

## CSS

Add the following CSS to the `<style>` block in `src/index.html`:

```css
/* ── Agent Panel ──────────────────────────────────── */
.agent-panel {
  width: 280px;
  min-width: 280px;
  max-width: 280px;
  height: 100%;
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--bg-solid);
  transition: width 0.2s ease, min-width 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}

.agent-panel.hidden {
  width: 0;
  min-width: 0;
  max-width: 0;
  opacity: 0;
  border-left: none;
  pointer-events: none;
}

/* Header */
.agent-panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.agent-selector {
  flex: 1;
  min-width: 0;
}

.agent-selector select {
  width: 100%;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-family: var(--font);
  font-size: 11px;
  cursor: pointer;
  outline: none;
}

.agent-selector select:focus {
  border-color: var(--accent);
}

.agent-controls {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.agent-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.agent-btn:hover {
  background: var(--accent-dim);
  border-color: var(--accent);
}

.agent-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.agent-btn-start {
  color: var(--green);
}

.agent-btn-stop {
  color: #f87171;
}

.agent-btn-close {
  color: var(--text-dim);
  border: none;
  width: 24px;
  height: 24px;
  font-size: 14px;
}

/* Trust bar */
.agent-trust-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 10px;
  flex-shrink: 0;
}

.agent-trust-bar.hidden {
  display: none;
}

.trust-label {
  color: var(--text-dim);
  font-weight: 500;
}

.agent-trust-bar select {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: var(--font);
  font-size: 10px;
  cursor: pointer;
  outline: none;
}

/* Activity log */
.agent-activity {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.agent-activity::-webkit-scrollbar {
  width: 4px;
}

.agent-activity::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 2px;
}

/* Empty state */
.agent-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  gap: 8px;
}

.agent-empty-icon {
  font-size: 28px;
  opacity: 0.5;
}

.agent-empty-text {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 500;
}

.agent-empty-hint {
  color: var(--text-muted);
  font-size: 10px;
  max-width: 200px;
}

/* Activity entries */
.agent-entry {
  font-size: 11px;
  line-height: 1.5;
  padding: 4px 0;
}

.agent-entry-reasoning {
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-entry-tool {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  background: var(--accent-dim);
  border-radius: 6px;
  border-left: 2px solid var(--accent);
}

.agent-entry-tool .tool-icon {
  flex-shrink: 0;
  font-size: 12px;
}

.agent-entry-tool .tool-info {
  flex: 1;
  min-width: 0;
}

.agent-entry-tool .tool-name {
  font-weight: 600;
  color: var(--accent);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.agent-entry-tool .tool-detail {
  color: var(--text-dim);
  font-size: 10px;
  margin-top: 2px;
  word-break: break-all;
}

.agent-entry-tool .tool-result {
  color: var(--text-dim);
  font-size: 10px;
  margin-top: 4px;
  font-style: italic;
}

.agent-entry-tool.error {
  border-left-color: #f87171;
  background: rgba(248, 113, 113, 0.08);
}

.agent-entry-tool.error .tool-name {
  color: #f87171;
}

/* Approval dialog */
.agent-approval {
  border: 1px solid #fbbf24;
  border-radius: 8px;
  padding: 10px;
  background: rgba(251, 191, 36, 0.08);
  margin: 4px 0;
}

.agent-approval-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #fbbf24;
  margin-bottom: 8px;
}

.agent-approval-tool {
  font-size: 11px;
  color: var(--text);
  margin-bottom: 4px;
}

.agent-approval-input {
  font-size: 10px;
  color: var(--text-dim);
  background: var(--bg);
  padding: 6px 8px;
  border-radius: 4px;
  margin: 6px 0;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--font);
}

.agent-approval-reasoning {
  font-size: 10px;
  color: var(--text-dim);
  font-style: italic;
  margin-bottom: 8px;
}

.agent-approval-actions {
  display: flex;
  gap: 6px;
}

.agent-approval-btn {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: none;
  font-family: var(--font);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.agent-approval-btn.approve {
  background: var(--green);
  color: #0a0a12;
}

.agent-approval-btn.approve:hover {
  opacity: 0.85;
}

.agent-approval-btn.reject {
  background: var(--border);
  color: var(--text);
}

.agent-approval-btn.reject:hover {
  background: rgba(248, 113, 113, 0.2);
  color: #f87171;
}

/* Agent status text */
.agent-entry-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 4px 8px;
  border-radius: 6px;
}

.agent-entry-status.started {
  color: var(--green);
  background: rgba(52, 211, 153, 0.08);
}

.agent-entry-status.completed {
  color: var(--green);
  background: rgba(52, 211, 153, 0.08);
}

.agent-entry-status.error {
  color: #f87171;
  background: rgba(248, 113, 113, 0.08);
}

.agent-entry-status.stopped {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.08);
}

.agent-entry-status.warning {
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.08);
}

/* Footer */
.agent-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  flex-shrink: 0;
}

.agent-footer.hidden {
  display: none;
}

.agent-status-text {
  color: var(--text-dim);
  flex: 1;
}

.agent-stat {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

/* Agent indicator dot in tab bar */
.agent-indicator {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 4px var(--green);
}

.agent-indicator.hidden {
  display: none;
}

.agent-indicator.running {
  background: #60a5fa;
  box-shadow: 0 0 4px #60a5fa;
  animation: pulse 2s ease-in-out infinite;
}

.agent-indicator.waiting {
  background: #fbbf24;
  box-shadow: 0 0 4px #fbbf24;
}

.agent-indicator.error {
  background: #f87171;
  box-shadow: 0 0 4px #f87171;
}

/* Tab bar button positioning */
#btn-agent-toggle {
  position: relative;
}

/* ── Promotion banner ──────────────────────────────── */
.agent-promotion-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(52, 211, 153, 0.08);
  border-bottom: 1px solid var(--border);
  font-size: 10px;
  color: var(--green);
}

.agent-promotion-banner button {
  background: var(--green);
  color: var(--bg-solid);
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 10px;
  font-family: var(--font);
  cursor: pointer;
  font-weight: 600;
}

.agent-promotion-banner .dismiss {
  background: none;
  color: var(--text-dim);
  font-weight: normal;
}
```

## Theme Compatibility

The CSS uses CSS custom properties (`var(--bg)`, `var(--accent)`, etc.) exclusively, so all four themes (dark, light, purple, green) work automatically. No theme-specific overrides are needed.

Theme-specific visual appearance:

| Element | Dark | Light | Purple | Green |
|---------|------|-------|--------|-------|
| Panel background | `#0a0a12` | `#ffffff` | `#140a1e` | `#050f0a` |
| Tool call card | Purple tint | Purple tint | Purple tint | Green tint |
| Approval border | `#fbbf24` | `#fbbf24` | `#fbbf24` | `#fbbf24` |
| Approve button | `#34d399` | `#059669` | `#34d399` | `#34d399` |
| Accent color | `#a78bfa` | `#7c3aed` | `#c084fc` | `#34d399` |

## Panel Width and Terminal Resizing

When the agent panel opens:
1. The terminal area width reduces by 280px.
2. `fitAddon.fit()` is called on the active terminal to recalculate columns.
3. The PTY is resized via `window.wotch.resizePty(tabId, newCols, newRows)`.

When the agent panel closes:
1. The terminal area expands back to full width.
2. Same resize sequence.

Implementation in renderer:

```javascript
function toggleAgentPanel() {
  const panel = document.getElementById('agent-panel');
  const isHidden = panel.classList.contains('hidden');

  if (isHidden) {
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }

  // Re-fit terminal after transition
  setTimeout(() => {
    const activeTab = tabs.find(t => t.id === activeTabId);
    if (activeTab) {
      activeTab.fitAddon.fit();
      const dims = activeTab.fitAddon.proposeDimensions();
      if (dims) {
        window.wotch.resizePty(activeTabId, dims.cols, dims.rows);
      }
    }
  }, 250); // Wait for CSS transition
}
```

## Terminal Area Layout Change

The `#terminals` container and agent panel must be siblings in a flex row. Modify the existing panel layout:

```css
/* Modify existing #panel content area to use flex row */
.panel-content {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
```

The terminal containers and agent panel sit inside this flex row. The terminal area gets `flex: 1` and the agent panel has a fixed 280px width.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+A` | Toggle agent panel |
| `Ctrl+Shift+K` | Emergency stop (all agents) |
| `Enter` (when approval focused) | Approve action |
| `Escape` (when approval focused) | Reject action |

Register in renderer:

```javascript
document.addEventListener('keydown', (e) => {
  // Toggle agent panel
  if (e.ctrlKey && e.shiftKey && e.key === 'A') {
    e.preventDefault();
    toggleAgentPanel();
  }

  // Emergency stop
  if (e.ctrlKey && e.shiftKey && e.key === 'K') {
    e.preventDefault();
    emergencyStopAllAgents();
  }
});
```

## Activity Log Rendering

Each event from `agent-event` IPC is rendered as an entry in the activity log:

```javascript
function renderAgentEvent(event) {
  const activity = document.getElementById('agent-activity');

  switch (event.type) {
    case 'started': {
      const el = createStatusEntry('started', `Agent started: ${event.data.agentName}`);
      activity.appendChild(el);
      break;
    }

    case 'reasoning': {
      // Append to current reasoning block or create new one
      let current = activity.querySelector('.agent-entry-reasoning:last-child');
      if (!current) {
        current = document.createElement('div');
        current.className = 'agent-entry agent-entry-reasoning';
        activity.appendChild(current);
      }
      current.textContent += event.data.text;
      break;
    }

    case 'tool-call': {
      const el = createToolEntry(event.data.tool, event.data.input);
      activity.appendChild(el);
      break;
    }

    case 'tool-result': {
      // Find the last tool entry and add result
      const lastTool = activity.querySelector('.agent-entry-tool:last-of-type');
      if (lastTool) {
        const resultEl = document.createElement('div');
        resultEl.className = 'tool-result';
        resultEl.textContent = summarizeToolResult(event.data.tool, event.data.output);
        lastTool.appendChild(resultEl);
      }
      break;
    }

    case 'completed': {
      const el = createStatusEntry('completed',
        `Completed in ${event.data.turnsUsed} turns (${formatTokens(event.data.tokensUsed)} tokens)`);
      activity.appendChild(el);
      break;
    }

    case 'error': {
      const el = createStatusEntry('error', event.data.message);
      activity.appendChild(el);
      break;
    }

    case 'stopped': {
      const el = createStatusEntry('stopped', `Stopped: ${event.data.reason}`);
      activity.appendChild(el);
      break;
    }

    case 'warning': {
      const el = createStatusEntry('warning', event.data.message);
      activity.appendChild(el);
      break;
    }
  }

  // Auto-scroll to bottom
  activity.scrollTop = activity.scrollHeight;
}
```

## Approval Dialog Rendering

When an `agent-approval-request` event arrives:

```javascript
function renderApprovalRequest(request) {
  const activity = document.getElementById('agent-activity');

  const el = document.createElement('div');
  el.className = 'agent-approval';
  el.dataset.actionId = request.actionId;

  const dangerLabel = request.dangerLevel === 'dangerous' ? '🔴 DANGEROUS ACTION' : '⚠ APPROVAL NEEDED';

  el.innerHTML = `
    <div class="agent-approval-header">
      <span>${dangerLabel}</span>
    </div>
    <div class="agent-approval-tool">
      <strong>${escapeHtml(request.tool)}</strong>
    </div>
    <div class="agent-approval-input">${escapeHtml(summarizeInput(request.tool, request.input))}</div>
    <div class="agent-approval-reasoning">${escapeHtml(request.reasoning || '')}</div>
    <div class="agent-approval-actions">
      <button class="agent-approval-btn approve" data-action-id="${request.actionId}" data-run-id="${request.runId}">Approve</button>
      <button class="agent-approval-btn reject" data-action-id="${request.actionId}" data-run-id="${request.runId}">Reject</button>
    </div>
  `;

  // Event listeners
  el.querySelector('.approve').addEventListener('click', () => {
    window.wotch.approveAction(request.runId, request.actionId, 'approved');
    el.remove();
  });

  el.querySelector('.reject').addEventListener('click', () => {
    window.wotch.rejectAction(request.runId, request.actionId, 'User rejected');
    el.remove();
  });

  activity.appendChild(el);
  activity.scrollTop = activity.scrollHeight;
}
```

## Agent Selector Population

On panel open and when `agent-list-changed` fires:

```javascript
async function refreshAgentList() {
  const agents = await window.wotch.listAgents();
  const select = document.getElementById('agent-select');
  const currentValue = select.value;

  select.innerHTML = '<option value="">Select agent...</option>';
  for (const agent of agents) {
    const opt = document.createElement('option');
    opt.value = agent.name;
    opt.textContent = agent.displayName || agent.name;
    if (agent._errors && agent._errors.length > 0) {
      opt.textContent += ' ⚠';
    }
    opt.title = agent.description;
    select.appendChild(opt);
  }

  if (currentValue) select.value = currentValue;
}
```

## Agent Status in Pill (Collapsed State)

When the window is collapsed (pill mode) and an agent is running, the pill's status dot can reflect agent activity. This is handled by extending the existing `onClaudeStatus` handler:

- If an agent is in `waiting-approval` state, the pill dot shows amber/yellow with a pulse animation (same as `status-waiting`).
- If an agent is actively running, no change to the pill (Claude's own status takes priority).
- If an agent completes with results, a desktop notification is shown (already handled by the existing notification system in `ClaudeStatusDetector.broadcast()`).

## Helper Functions

```javascript
function createStatusEntry(type, message) {
  const el = document.createElement('div');
  el.className = `agent-entry agent-entry-status ${type}`;
  el.textContent = message;
  return el;
}

function createToolEntry(toolName, input) {
  const el = document.createElement('div');
  el.className = 'agent-entry agent-entry-tool';

  const icons = {
    'Shell': '⚡', 'FileSystem': '📄', 'Git': '🔀',
    'Terminal': '🖥', 'Project': '📁', 'Wotch': '👁',
  };
  const category = toolName.split('.')[0];
  const icon = icons[category] || '🔧';

  el.innerHTML = `
    <span class="tool-icon">${icon}</span>
    <div class="tool-info">
      <div class="tool-name">${escapeHtml(toolName)}</div>
      <div class="tool-detail">${escapeHtml(summarizeInput(toolName, input))}</div>
    </div>
  `;
  return el;
}

function summarizeInput(toolName, input) {
  if (!input) return '';
  if (toolName.includes('readFile') || toolName.includes('writeFile')) return input.path || '';
  if (toolName.includes('execute')) return input.command || '';
  if (toolName.includes('searchFiles')) return `"${input.pattern}" in ${input.path || '.'}`;
  if (toolName.includes('diff')) return input.mode || 'all';
  return JSON.stringify(input).slice(0, 100);
}

function summarizeToolResult(toolName, output) {
  if (!output) return 'No output';
  try {
    const parsed = typeof output === 'string' ? JSON.parse(output) : output;
    if (parsed.exitCode !== undefined) return `Exit code: ${parsed.exitCode} (${parsed.durationMs}ms)`;
    if (parsed.lineCount !== undefined) return `${parsed.lineCount} lines read`;
    if (parsed.bytesWritten !== undefined) return `${parsed.bytesWritten} bytes written`;
    if (parsed.matches) return `${parsed.matches.length} matches found`;
    if (parsed.diff) return `${parsed.filesChanged} files changed`;
    return 'Done';
  } catch {
    return 'Done';
  }
}

function formatTokens(n) {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1) + 'k';
}
```

## Responsive Behavior

- If the expanded window width is less than 500px, the agent panel is automatically hidden (not enough room for both terminal and panel).
- The panel width stays fixed at 280px. The terminal area absorbs all remaining width.
- On window resize, `fitAddon.fit()` is called to adjust terminal columns.
