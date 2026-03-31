# Plan 0: Enhanced Status Detection

## Overview

Replace the existing `ClaudeStatusDetector` (regex-based terminal output parsing) with a multi-source `EnhancedClaudeStatusDetector` that fuses data from hooks (structured events) and the existing regex fallback into a single, reliable status stream.

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
| False positives on non-Claude output | User sees "thinking" when running a script that matches a pattern |
| Missed transitions | Some state changes produce no distinctive output (context compression, API errors) |
| Latency | Regex match runs on every PTY data chunk; some transitions only visible after buffering |
| Fragility | Claude Code output format changes break detection without warning |
| Invisible states | Agent spawning, MCP tool calls, token limit warnings, and context compaction have no terminal output patterns |

---

## New Architecture: Two-Source Fusion

```
┌─────────────────────────────────────────────────────────────┐
│              EnhancedClaudeStatusDetector                    │
│                                                             │
│  ┌────────────┐  ┌────────────────────┐                     │
│  │  Hook       │  │  Regex Fallback    │                     │
│  │  Source     │  │  Source             │                     │
│  │  (pri: 1)  │  │  (pri: 2)          │                     │
│  └─────┬──────┘  └─────────┬──────────┘                     │
│        │                    │                                │
│        ▼                    ▼                                │
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

### Source 1: Hooks (Priority 1 — Highest)

- **Data**: Structured JSON from 12 subscribed hook events via HTTP POST
- **Granularity**: Tool name, tool input (including file paths, commands), session ID, working directory, agent type
- **Latency**: ~100-200ms (HTTP round trip from Claude Code's hook system)
- **Reliability**: Depends on hook configuration being present in `~/.claude/settings.json`
- **Timeout**: If no event in 15 seconds during an active session, deprioritize to allow regex fallback

### Source 2: Regex Fallback (Priority 2 — Lowest)

- **Data**: Pattern matches on ANSI-stripped terminal output
- **Granularity**: State only (no tool details, no file info)
- **Latency**: Variable (depends on output buffering)
- **Reliability**: Always available (reads PTY output directly)
- **Timeout**: N/A (always active as fallback)

---

## State Resolver

The state resolver maintains per-tab state and decides which source's data to use.

```javascript
// src/enhanced-status-detector.js
const { EventEmitter } = require('events');

class EnhancedClaudeStatusDetector extends EventEmitter {
  constructor() {
    super();
    this.tabs = new Map(); // tabId -> TabState
  }

  updateFromSource(tabId, source, data) {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = this._createTabState(tabId);
      this.tabs.set(tabId, tab);
    }

    tab.sources[source] = {
      state: data.state,
      description: data.description || '',
      tool: data.tool || null,
      file: data.file || null,
      line: data.line || null,
      agentDepth: data.agentDepth || 0,
      timestamp: Date.now()
    };

    const resolved = this._resolve(tab);

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
    if (!tab) return { hooks: false, regex: false };

    const now = Date.now();
    return {
      hooks: tab.sources.hooks && (now - tab.sources.hooks.timestamp) < 15000,
      regex: tab.sources.regex && (now - tab.sources.regex.timestamp) < 5000
    };
  }

  _createTabState(tabId) {
    return {
      tabId,
      sources: { hooks: null, regex: null },
      lastEmitted: null
    };
  }

  _resolve(tab) {
    const now = Date.now();
    const sources = [
      { name: 'hooks', priority: 1, timeout: 15000 },
      { name: 'regex', priority: 2, timeout: 5000  }
    ];

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
          agentDepth: data.agentDepth
        };
      }
    }

    return { state: 'idle', description: '', source: 'timeout' };
  }

  _buildDescription(data, source) {
    if (source === 'hooks' && data.tool && data.file) {
      const shortFile = data.file.split('/').pop();
      const toolVerb = TOOL_VERBS[data.tool] || 'Using ' + data.tool;
      return `${toolVerb} ${shortFile}${data.line ? ':' + data.line : ''}`;
    }

    if (source === 'hooks' && data.tool) {
      return TOOL_VERBS[data.tool] || 'Using ' + data.tool;
    }

    return data.description || STATE_DESCRIPTIONS[data.state] || '';
  }
}

// Human-readable tool verbs — uses actual Claude Code tool names
// (Bash, Edit, Read, Write, Grep, Glob, Agent, etc.)
const TOOL_VERBS = {
  'Bash':            'Running command',
  'Edit':            'Editing',
  'Read':            'Reading',
  'Write':           'Writing',
  'Grep':            'Searching',
  'Glob':            'Finding files',
  'Agent':           'Running agent',
  'WebFetch':        'Fetching',
  'WebSearch':       'Searching web',
  'AskUserQuestion': 'Waiting for input',
  'NotebookEdit':    'Editing notebook',
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

With structured data from hooks, the pill shows more informative status text:

### Current (Regex-only)

```
● Thinking...
● Working...
● Waiting for input
● Done
```

### Enhanced (Hooks)

```
● Editing main.js
● Running npm test
● Searching for "handleClick"
● Reading package.json
● Running agent
● Compacting context...
● Waiting for input
● Done
● Error (rate limit)
```

### Pill Description Rules

| Priority | Condition | Display |
|----------|-----------|---------|
| 1 | Hook with file + tool | `"Editing main.js"` |
| 2 | Hook with tool only | `"Running command"` |
| 3 | Hook with state only | `"Compacting context..."` |
| 4 | Regex state | `"Thinking..."` / `"Working..."` |
| 5 | No data | `""` (empty, state dot only) |

---

## Hook Event → Status Mapping

When a hook event arrives, it's translated to an internal status update:

```javascript
function mapHookToStatus(event) {
  switch (event.eventType) {
    case 'PreToolUse':
      const tool = event.tool_name;
      const file = event.tool_input?.file_path || event.tool_input?.path || null;
      const state = TOOL_STATE_MAP[tool] || 'working';
      return { state, tool, file, description: '' };

    case 'PostToolUse':
    case 'PostToolUseFailure':
      return null; // Maintain current state (tool just finished, still in turn)

    case 'Stop':
      return { state: 'done', description: 'Done' };

    case 'StopFailure':
      return { state: 'error', description: `Error (${event.reason || 'unknown'})` };

    case 'SubagentStart':
      return { state: 'working', tool: 'Agent', description: 'Running agent', agentDepth: 1 };

    case 'SubagentStop':
      return null; // Maintain current state

    case 'SessionStart':
      return { state: 'idle', description: '' };

    case 'SessionEnd':
      return { state: 'idle', description: '' };

    case 'PreCompact':
      return { state: 'thinking', description: 'Compacting context...' };

    case 'PostCompact':
      return null; // Maintain current state

    case 'Notification':
      return null; // Forward to notification system, don't change status
  }
}

const TOOL_STATE_MAP = {
  'Bash':            'working',
  'Edit':            'working',
  'Write':           'working',
  'Read':            'thinking',
  'Grep':            'thinking',
  'Glob':            'thinking',
  'Agent':           'working',
  'WebFetch':        'working',
  'WebSearch':       'working',
  'AskUserQuestion': 'waiting',
  'NotebookEdit':    'working',
};
```

---

## Migration Path

### Phase A: Add EnhancedClaudeStatusDetector alongside existing detector

Both detectors run simultaneously. The enhanced detector wraps the existing one as its regex source:

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
  const tabId = sessionTabMap.get(event.session_id);
  if (tabId) {
    const mapped = mapHookToStatus(event);
    if (mapped) {
      enhancedDetector.updateFromSource(tabId, 'hooks', mapped);
    }
  }
});

// Use enhanced detector for all status queries
enhancedDetector.on('status-changed', (tabId, status) => {
  mainWindow.webContents.send('claude-status', tabId, status);
});
```

### Phase B: Remove direct regex detector usage

All direct references to the old `ClaudeStatusDetector` are updated to use the enhanced detector. The regex detector continues as a source.

### Phase C: Enriched UI (optional, future)

The renderer uses richer status fields (tool, file) for enhanced pill display. This is additive.

---

## IPC Changes

### Modified IPC Channel: `claude-status`

Payload changes (backward compatible — new fields are additive):

```javascript
// Before
{ state: 'working', description: 'Working...' }

// After
{
  state: 'working',
  description: 'Editing main.js',
  source: 'hooks',           // NEW: which channel provided this
  tool: 'Edit',              // NEW: active tool (hook events only)
  file: 'src/main.js',       // NEW: file being acted on (hook events only)
  line: null,                 // NEW: line number (from tool_input if available)
  agentDepth: 0               // NEW: sub-agent depth
}
```

### New IPC Channel: `integration-status`

Reports which integration channels are active:

```javascript
{
  hooks: { active: true, port: 19520, eventCount: 142 },
  mcp: { registered: true, transport: 'stdio', ipcPort: 19523 },
  regex: { active: true }
}
```

---

## Testing

### Unit Tests

1. State resolver picks hooks over regex
2. Stale hooks data (>15s old) falls through to regex
3. All sources stale → returns idle
4. Description builder produces correct text for hook source with file
5. Description builder produces correct text for hook source without file
6. Description builder falls back to state descriptions for regex source
7. Tab removal cleans up all source state
8. Status change deduplication (same state doesn't re-emit)
9. Tool name mapping uses correct names (Bash, Edit, Read — not BashTool, FileEditTool)

### Integration Tests

1. Hooks active → verify hook source wins over regex
2. Kill hook receiver → verify regex fallback activates within 15 seconds
3. Restart hook receiver → verify hooks resume priority
4. Multiple tabs with different sources → verify per-tab isolation
5. SubagentStart event → verify agentDepth=1 in status output
6. PreCompact event → verify "Compacting context..." description

### Manual Verification

1. Launch Claude Code in Wotch → observe pill shows tool-specific descriptions
2. Disable hooks in settings → observe pill falls back to regex descriptions
3. Check settings panel shows integration channel health indicators
