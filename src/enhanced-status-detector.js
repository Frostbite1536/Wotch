// src/enhanced-status-detector.js
// Two-source status fusion: hooks (priority 1) + regex fallback (priority 2)

const { EventEmitter } = require("events");

// Human-readable tool verbs — uses actual Claude Code tool names
const TOOL_VERBS = {
  Bash: "Running command",
  Edit: "Editing",
  Read: "Reading",
  Write: "Writing",
  Grep: "Searching",
  Glob: "Finding files",
  Agent: "Running agent",
  WebFetch: "Fetching",
  WebSearch: "Searching web",
  AskUserQuestion: "Waiting for input",
  NotebookEdit: "Editing notebook",
};

const STATE_DESCRIPTIONS = {
  idle: "",
  thinking: "Thinking...",
  working: "Working...",
  waiting: "Waiting for input",
  done: "Done",
  error: "Error",
};

// Maps tool names to Wotch status states
const TOOL_STATE_MAP = {
  Bash: "working",
  Edit: "working",
  Write: "working",
  Read: "thinking",
  Grep: "thinking",
  Glob: "thinking",
  Agent: "working",
  WebFetch: "working",
  WebSearch: "working",
  AskUserQuestion: "waiting",
  NotebookEdit: "working",
};

const SOURCES = [
  { name: "hooks", priority: 1, timeout: 15000 },
  { name: "regex", priority: 2, timeout: 5000 },
];

class EnhancedClaudeStatusDetector extends EventEmitter {
  constructor() {
    super();
    this.tabs = new Map(); // tabId -> TabState
  }

  addTab(tabId) {
    if (!this.tabs.has(tabId)) {
      this.tabs.set(tabId, this._createTabState(tabId));
    }
  }

  updateFromSource(tabId, source, data) {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = this._createTabState(tabId);
      this.tabs.set(tabId, tab);
    }

    tab.sources[source] = {
      state: data.state,
      description: data.description || "",
      tool: data.tool || null,
      file: data.file || null,
      line: data.line || null,
      agentDepth: data.agentDepth || 0,
      timestamp: Date.now(),
    };

    const resolved = this._resolve(tab);

    if (
      resolved.state !== tab.lastEmitted?.state ||
      resolved.description !== tab.lastEmitted?.description
    ) {
      tab.lastEmitted = resolved;
      this.emit("status-changed", tabId, resolved);
    }
  }

  removeTab(tabId) {
    this.tabs.delete(tabId);
  }

  getStatus(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return { state: "idle", description: "", source: "none" };
    return tab.lastEmitted || { state: "idle", description: "", source: "none" };
  }

  getAggregateStatus() {
    const priority = { error: 6, working: 5, thinking: 4, waiting: 2, done: 1, idle: 0 };
    let best = { state: "idle", description: "", source: "none", tabId: null };

    for (const [tabId, tab] of this.tabs) {
      const status = tab.lastEmitted || { state: "idle", description: "", source: "none" };
      const p = priority[status.state] || 0;
      const bestP = priority[best.state] || 0;
      if (p > bestP) {
        best = { ...status, tabId };
      }
    }

    return best;
  }

  getTabStatus(tabId) {
    return this.getStatus(tabId);
  }

  getChannelHealth() {
    const now = Date.now();
    let hooksActive = false;
    let regexActive = false;

    for (const [, tab] of this.tabs) {
      if (tab.sources.hooks && (now - tab.sources.hooks.timestamp) < 15000) {
        hooksActive = true;
      }
      if (tab.sources.regex && (now - tab.sources.regex.timestamp) < 5000) {
        regexActive = true;
      }
    }

    return { hooks: hooksActive, regex: regexActive };
  }

  _createTabState(tabId) {
    return {
      tabId,
      sources: { hooks: null, regex: null },
      lastEmitted: null,
    };
  }

  _resolve(tab) {
    const now = Date.now();

    for (const src of SOURCES) {
      const data = tab.sources[src.name];
      if (data && (now - data.timestamp) < src.timeout) {
        return {
          state: data.state,
          description: this._buildDescription(data, src.name),
          source: src.name,
          tool: data.tool,
          file: data.file,
          line: data.line,
          agentDepth: data.agentDepth,
        };
      }
    }

    return { state: "idle", description: "", source: "timeout" };
  }

  _buildDescription(data, source) {
    if (source === "hooks" && data.tool && data.file) {
      const shortFile = data.file.split("/").pop();
      const toolVerb = TOOL_VERBS[data.tool] || "Using " + data.tool;
      return `${toolVerb} ${shortFile}${data.line ? ":" + data.line : ""}`;
    }

    if (source === "hooks" && data.tool) {
      return TOOL_VERBS[data.tool] || "Using " + data.tool;
    }

    return data.description || STATE_DESCRIPTIONS[data.state] || "";
  }
}

/**
 * Maps a hook event to an internal status update.
 * Returns null if the event should not change status (maintain current state).
 */
function mapHookToStatus(event) {
  switch (event.eventType) {
    case "PreToolUse": {
      const tool = event.tool_name;
      const file = event.tool_input?.file_path || event.tool_input?.path || null;
      const line = event.tool_input?.line || null;
      const state = TOOL_STATE_MAP[tool] || "working";
      return { state, tool, file, line, description: "" };
    }

    case "PostToolUse":
    case "PostToolUseFailure":
      return null; // Maintain current state (tool just finished, still in turn)

    case "Stop":
      return { state: "done", description: "Done" };

    case "StopFailure":
      return { state: "error", description: `Error (${event.reason || "unknown"})` };

    case "SubagentStart":
      return { state: "working", tool: "Agent", description: "Running agent", agentDepth: 1 };

    case "SubagentStop":
      return null;

    case "SessionStart":
      return { state: "idle", description: "" };

    case "SessionEnd":
      return { state: "idle", description: "" };

    case "PreCompact":
      return { state: "thinking", description: "Compacting context..." };

    case "PostCompact":
      return null;

    case "Notification":
      return null; // Forward to notification system, don't change status

    default:
      return null;
  }
}

module.exports = { EnhancedClaudeStatusDetector, mapHookToStatus, TOOL_STATE_MAP };
