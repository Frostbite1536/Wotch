# Plan 0: Enhanced Status Detection

## Overview

Replace the existing `ClaudeStatusDetector` (regex-based terminal output parsing) with a multi-source `EnhancedClaudeStatusDetector` that fuses data from three structured channels (bridge, hooks, regex fallback) into a single, reliable status stream.

---

## Current State: Regex Detection

The existing detector in `src/main.js` works by:

1. Receiving raw terminal output bytes from node-pty
2. Stripping ANSI escape codes
3. Matching against regex patterns for Claude Code's output signatures
4. Transitioning between states based on matches

### Known Limitations

| Issue | Impact |
|-------|--------|
| False positives on non-Claude output | User sees "thinking" when running a script that happens to match a pattern |
| Missed transitions | Some state changes produce no distinctive output (e.g., context compression) |
| Latency | Regex match runs on every PTY data chunk; some transitions only visible after buffering |
| Fragility | Claude Code output format changes break detection without warning |
| Invisible states | Agent spawning, MCP tool calls, and token limit warnings have no terminal output patterns |

---

## New Architecture: Multi-Source Fusion

```
┌─────────────────────────────────────────────────────────────┐
│              EnhancedClaudeStatusDetector                    │
│                                                             │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐    │
│  │  Bridge     │  │  Hook      │  │  Regex Fallback    │    │
│  │  Source     │  │  Source    │  │  Source             │    │
│  │  (pri: 1)  │  │  (pri: 2) │  │  (pri: 3)          │    │
│  └─────┬──────┘  └─────┬──────┘  └─────────┬──────────┘    │
│        │               │                    │               │
│        ▼               ▼                    ▼               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                  State Resolver                      │    │
│  │  (priority-based, timeout-aware, per-tab)           │    │
│  └──────────────────────┬──────────────────────────────┘    │
│                         │                                   │
│                         ▼                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Unified Status Output                   │    │
│  │  { state, description, source, tool?, file? }       │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Source Definitions

### Source 1: Bridge (Priority 1 — Highest)

- **Data**: Real-time `state_update` messages via WebSocket
- **Granularity**: Includes tool name, file path, line number, token usage, agent depth
- **Latency**: <50ms (WebSocket push)
- **Reliability**: Depends on bridge connection; may disconnect
- **Timeout**: If no update in 10 seconds, deprioritize to allow lower sources

### Source 2: Hooks (Priority 2)

- **Data**: `PreToolUse`, `PostToolUse`, `Notification`, `Stop` events via HTTP POST
- **Granularity**: Tool name, input/output, session ID
- **Latency**: ~100-200ms (shell command execution + HTTP round trip)
- **Reliability**: Depends on curl availability and hook configuration
- **Timeout**: If no event in 15 seconds during active session, deprioritize

### Source 3: Regex Fallback (Priority 3 — Lowest)

- **Data**: Pattern matches on ANSI-stripped terminal output
- **Granularity**: State only (no tool details, no file info)
- **Latency**: Variable (depends on output buffering)
- **Reliability**: Always available (reads PTY output directly)
- **Timeout**: N/A (always active as fallback)

---

## State Resolver

The state resolver maintains per-tab state and decides which source's data to use at any moment.

```javascript
// src/enhanced-status-detector.js
const { EventEmitter } = require('events');

class EnhancedClaudeStatusDetector extends EventEmitter {
  constructor() {
    super();
    this.tabs = new Map(); // tabId -> TabState
  }

  // Called by ClaudeIntegrationManager when any source reports
  updateFromSource(tabId, source, data) {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = this._createTabState(tabId);
      this.tabs.set(tabId, tab);
    }

    // Update source-specific state
    tab.sources[source] = {
      state: data.state,
      description: data.description || '',
      tool: data.tool || null,
      file: data.file || null,
      line: data.line || null,
      tokenUsage: data.tokenUsage || null,
      agentDepth: data.agentDepth || 0,
      timestamp: Date.now()
    };

    // Resolve effective state
    const resolved = this._resolve(tab);

    // Only emit if state actually changed
    if (resolved.state !== tab.lastEmitted?.state ||
        resolved.description !== tab.lastEmitted?.description) {
      tab.lastEmitted = resolved;
      this.emit('status-changed', tabId, resolved);
    }
  }

  removeTab(tabId) {
    this.tabs.delete(tabId);
  }

  getStatus(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return { state: 'idle', description: '', source: 'none' };
    return tab.lastEmitted || { state: 'idle', description: '', source: 'none' };
  }

  getChannelHealth(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return { bridge: false, hooks: false, regex: false };

    const now = Date.now();
    return {
      bridge: tab.sources.bridge && (now - tab.sources.bridge.timestamp) < 10000,
      hooks: tab.sources.hooks && (now - tab.sources.hooks.timestamp) < 15000,
      regex: tab.sources.regex && (now - tab.sources.regex.timestamp) < 5000
    };
  }

  _createTabState(tabId) {
    return {
      tabId,
      sources: {
        bridge: null,
        hooks: null,
        regex: null
      },
      lastEmitted: null
    };
  }

  _resolve(tab) {
    const now = Date.now();
    const sources = [
      { name: 'bridge', priority: 1, timeout: 10000 },
      { name: 'hooks',  priority: 2, timeout: 15000 },
      { name: 'regex',  priority: 3, timeout: 5000  }
    ];

    // Find highest-priority source with fresh data
    for (const src of sources) {
      const data = tab.sources[src.name];
      if (data && (now - data.timestamp) < src.timeout) {
        return {
          state: data.state,
          description: this._buildDescription(data, src.name),
          source: src.name,
          tool: data.tool,
          file: data.file,
          line: data.line,
          tokenUsage: data.tokenUsage,
          agentDepth: data.agentDepth
        };
      }
    }

    // No fresh data from any source
    return { state: 'idle', description: '', source: 'timeout' };
  }

  _buildDescription(data, source) {
    // Bridge provides the richest descriptions
    if (source === 'bridge' && data.tool && data.file) {
      const shortFile = data.file.split('/').pop();
      const toolVerb = TOOL_VERBS[data.tool] || 'Using ' + data.tool;
      return `${toolVerb} ${shortFile}${data.line ? ':' + data.line : ''}`;
    }

    // Hooks provide tool-level descriptions
    if (source === 'hooks' && data.tool) {
      const toolVerb = TOOL_VERBS[data.tool] || 'Using ' + data.tool;
      return toolVerb;
    }

    // Regex provides generic descriptions
    return data.description || STATE_DESCRIPTIONS[data.state] || '';
  }
}

// Human-readable tool descriptions for pill display
const TOOL_VERBS = {
  'BashTool':     'Running command',
  'FileEditTool': 'Editing',
  'FileReadTool': 'Reading',
  'FileWriteTool':'Writing',
  'GrepTool':     'Searching',
  'GlobTool':     'Finding files',
  'AgentTool':    'Running agent',
  'WebFetchTool': 'Fetching',
  'WebSearchTool':'Searching web',
  'AskUserQuestion': 'Waiting for input',
};

const STATE_DESCRIPTIONS = {
  'idle':     '',
  'thinking': 'Thinking...',
  'working':  'Working...',
  'waiting':  'Waiting for input',
  'done':     'Done',
  'error':    'Error',
};

module.exports = { EnhancedClaudeStatusDetector };
```

---

## Rich Status Display

With structured data from bridge and hooks, the pill can show more informative status text:

### Current (Regex-only)

```
● Thinking...
● Working...
● Waiting for input
● Done
```

### Enhanced (Bridge/Hooks)

```
● Editing main.js:142
● Running npm test
● Searching for "handleClick"
● Reading package.json
● Running sub-agent
● Waiting for input
● Done (1.2K tokens)
```

### Implementation in Renderer

The renderer receives enhanced status objects via IPC:

```javascript
// In renderer.js — update pill status display
window.wotch.onClaudeStatus((tabId, status) => {
  // status = { state, description, source, tool?, file?, line?, tokenUsage?, agentDepth? }

  updateStatusDot(tabId, status.state);
  updateStatusLabel(tabId, status.description);

  // Optional: show source indicator in debug mode
  if (settings.showIntegrationStatus) {
    updateSourceBadge(tabId, status.source);
  }
});
```

### Pill Description Rules

| Priority | Condition | Display |
|----------|-----------|---------|
| 1 | Bridge with file + tool | `"Editing main.js:142"` |
| 2 | Bridge with tool only | `"Running command"` |
| 3 | Hook with tool | `"Editing"` / `"Searching"` |
| 4 | Regex state | `"Thinking..."` / `"Working..."` |
| 5 | No data | `""` (empty, state dot only) |

---

## Migration Path

### Phase A: Add EnhancedClaudeStatusDetector alongside existing detector

The enhanced detector is instantiated alongside the existing `ClaudeStatusDetector`. Both run simultaneously. The enhanced detector wraps the existing one as its regex source:

```javascript
// In main.js
const enhancedDetector = new EnhancedClaudeStatusDetector();
const regexDetector = new ClaudeStatusDetector(); // existing

// Wire regex detector as a source
regexDetector.on('status-changed', (tabId, state, description) => {
  enhancedDetector.updateFromSource(tabId, 'regex', { state, description });
});

// Wire hook events as a source
integrationManager.hookReceiver.on('hook-event', (event) => {
  const tabId = event.tabId || sessionTabMap.get(event.session);
  if (tabId) {
    const mapped = mapHookToStatus(event);
    enhancedDetector.updateFromSource(tabId, 'hooks', mapped);
  }
});

// Wire bridge events as a source
integrationManager.bridgeAdapter.on('state-update', ({ tabId, state }) => {
  const mapped = mapBridgeToStatus(state);
  enhancedDetector.updateFromSource(tabId, 'bridge', mapped);
});

// Use enhanced detector for all status queries
enhancedDetector.on('status-changed', (tabId, status) => {
  mainWindow.webContents.send('claude-status', tabId, status);
});
```

### Phase B: Remove direct regex detector usage

Once the enhanced detector is proven stable, all direct references to the old `ClaudeStatusDetector` in IPC handlers and renderer are updated to use the enhanced detector. The regex detector continues to exist but only as a source feeding into the enhanced detector.

### Phase C: Enriched UI (optional, future)

The renderer is updated to use the richer status fields (tool, file, line, token usage) for an enhanced pill display. This is additive and can be done incrementally.

---

## IPC Changes

### Modified IPC Channel: `claude-status`

The existing `claude-status` IPC event payload changes from:

```javascript
// Before
{ state: 'working', description: 'Working...' }

// After (backward compatible — new fields are additive)
{
  state: 'working',
  description: 'Editing main.js:142',
  source: 'bridge',        // NEW: which channel provided this
  tool: 'FileEditTool',    // NEW: active tool
  file: 'src/main.js',     // NEW: file being acted on
  line: 142,               // NEW: line number
  tokenUsage: null,        // NEW: token counts (bridge only)
  agentDepth: 0            // NEW: sub-agent depth (bridge only)
}
```

The renderer gracefully handles both old and new formats — new fields are optional and only used if present.

### New IPC Channel: `integration-status`

Reports which integration channels are active:

```javascript
// Sent periodically (every 5 seconds) or on channel state change
{
  hooks: { active: true, port: 19520, eventCount: 142 },
  mcp: { registered: true, transport: 'stdio' },
  bridge: { connected: true, port: 19521, tabs: ['tab-1', 'tab-3'] },
  regex: { active: true }
}
```

---

## Testing

### Unit Tests

1. State resolver picks bridge over hooks over regex
2. Stale bridge data (>10s old) falls through to hooks
3. Stale hooks data (>15s old) falls through to regex
4. All sources stale → returns idle
5. Description builder produces correct text for each source type
6. Tab removal cleans up all source state
7. Status change deduplication (same state doesn't re-emit)
8. Rich descriptions include file and line when available

### Integration Tests

1. Bridge + hooks + regex all reporting → verify bridge wins
2. Disconnect bridge → verify hooks take over within 10 seconds
3. Disable hooks → verify regex fallback activates
4. Reconnect bridge → verify bridge resumes priority
5. Multiple tabs with different sources → verify per-tab isolation

### Manual Verification

1. Launch Claude Code in Wotch → observe pill shows tool-specific descriptions
2. Disconnect bridge (kill WebSocket) → observe pill falls back to hook-based descriptions
3. Disable hooks in settings → observe pill falls back to regex descriptions
4. All channels active → check settings panel shows green indicators for all three
