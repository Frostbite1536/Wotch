// src/claude-integration-manager.js
// Central coordinator for Claude Code deep integration channels:
// - Hooks (Claude Code → Wotch via HTTP POST)
// - MCP (Wotch → Claude Code via stdio MCP server)
// - Regex fallback (existing ClaudeStatusDetector)

const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const { EventEmitter } = require("events");
const { EnhancedClaudeStatusDetector, mapHookToStatus } = require("./enhanced-status-detector");
const { HookReceiver } = require("./hook-receiver");

const WOTCH_HOOK_EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "Stop", "StopFailure",
  "SubagentStart", "SubagentStop",
  "SessionStart", "SessionEnd",
  "PreCompact", "PostCompact",
  "Notification",
];

class ClaudeIntegrationManager extends EventEmitter {
  constructor(settings = {}) {
    super();

    this.settings = {
      hooksEnabled: true,
      hooksPort: 19520,
      mcpEnabled: true,
      mcpIpcPort: 19523,
      autoConfigureHooks: true,
      autoRegisterMCP: true,
      ...settings,
    };

    // Session-to-tab mapping: session_id → tabId
    this.sessionTabMap = new Map();
    // Tab-to-cwd mapping for session association
    this.tabCwdMap = new Map();

    // Components
    this.statusDetector = new EnhancedClaudeStatusDetector();
    this.hookReceiver = null;
    this.mcpIpcServer = null;

    // Forward status-changed events
    this.statusDetector.on("status-changed", (tabId, status) => {
      this.emit("status-changed", tabId, status);
    });
  }

  async start(mcpHandlers) {
    // Start hook receiver
    if (this.settings.hooksEnabled) {
      await this._startHookReceiver();
    }

    // Start MCP IPC server
    if (this.settings.mcpEnabled && mcpHandlers) {
      this._startMCPIpcServer(mcpHandlers);
    }

    console.log("[wotch] Integration manager started");
  }

  async stop() {
    if (this.hookReceiver) {
      await this.hookReceiver.stop();
    }
    if (this.mcpIpcServer) {
      this.mcpIpcServer.close();
      this.mcpIpcServer = null;
    }
    console.log("[wotch] Integration manager stopped");
  }

  // ── Tab management ─────────────────────────────────────────────────

  addTab(tabId, cwd) {
    this.statusDetector.addTab(tabId);
    if (cwd) {
      this.tabCwdMap.set(tabId, cwd);
    }
  }

  removeTab(tabId) {
    this.statusDetector.removeTab(tabId);
    this.tabCwdMap.delete(tabId);
    // Clean up session mappings for this tab
    for (const [sessionId, tid] of this.sessionTabMap) {
      if (tid === tabId) this.sessionTabMap.delete(sessionId);
    }
  }

  // Feed regex detector data (from existing ClaudeStatusDetector)
  feedRegex(tabId, state, description) {
    this.statusDetector.updateFromSource(tabId, "regex", { state, description });
  }

  // ── Status queries ─────────────────────────────────────────────────

  getStatus(tabId) {
    return this.statusDetector.getStatus(tabId);
  }

  getAggregateStatus() {
    return this.statusDetector.getAggregateStatus();
  }

  getTabStatus(tabId) {
    return this.statusDetector.getTabStatus(tabId);
  }

  getIntegrationStatus() {
    return {
      hooks: {
        active: this.hookReceiver?.isActive() || false,
        port: this.hookReceiver?.getPort() || null,
        eventCount: this.hookReceiver?.getEventCount() || 0,
      },
      mcp: {
        registered: this.mcpIpcServer !== null,
        ipcPort: this.settings.mcpIpcPort,
      },
      regex: { active: true },
      channelHealth: this.statusDetector.getChannelHealth(),
    };
  }

  // ── Hook Receiver ──────────────────────────────────────────────────

  async _startHookReceiver() {
    this.hookReceiver = new HookReceiver(this.settings.hooksPort);

    this.hookReceiver.on("hook-event", (event) => {
      this._handleHookEvent(event);
    });

    this.hookReceiver.on("error", (err) => {
      console.error("[wotch] Hook receiver error:", err.message);
    });

    try {
      const port = await this.hookReceiver.start();
      this.settings.hooksPort = port; // Update if port changed due to conflict
    } catch (err) {
      console.error("[wotch] Failed to start hook receiver:", err.message);
    }
  }

  _handleHookEvent(event) {
    // Map session_id to tabId
    let tabId = this.sessionTabMap.get(event.session_id);

    // On SessionStart, establish the mapping via cwd
    if (event.eventType === "SessionStart" && !tabId) {
      tabId = this._findTabByCwd(event.cwd);
      if (tabId) {
        this.sessionTabMap.set(event.session_id, tabId);
      }
    }

    if (!tabId) {
      // Fallback: attribute to most recently active tab matching cwd
      tabId = this._findTabByCwd(event.cwd);
      if (tabId) {
        this.sessionTabMap.set(event.session_id, tabId);
      }
    }

    if (!tabId) {
      // Last resort: attribute to any tab that has a status detector entry
      const tabs = [...this.statusDetector.tabs.keys()];
      if (tabs.length === 1) {
        tabId = tabs[0];
        this.sessionTabMap.set(event.session_id, tabId);
      }
    }

    if (!tabId) return; // Cannot map this event to a tab

    // Forward Notification events to the UI
    if (event.eventType === "Notification") {
      this.emit("notification", event);
      return;
    }

    // Map hook event to status update
    const mapped = mapHookToStatus(event);
    if (mapped) {
      this.statusDetector.updateFromSource(tabId, "hooks", mapped);
    }
  }

  _findTabByCwd(cwd) {
    if (!cwd) return null;
    for (const [tabId, tabCwd] of this.tabCwdMap) {
      if (tabCwd === cwd || cwd.startsWith(tabCwd + "/") || cwd.startsWith(tabCwd + path.sep)) {
        return tabId;
      }
    }
    return null;
  }

  // ── MCP IPC Server ─────────────────────────────────────────────────
  // TCP server that the standalone mcp-server.js connects to for data access

  _startMCPIpcServer(handlers) {
    this.mcpIpcServer = net.createServer((socket) => {
      let buffer = "";

      socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          this._handleMCPIpcRequest(socket, line, handlers);
        }
      });

      socket.on("error", (err) => {
        console.error("[wotch] MCP IPC socket error:", err.message);
      });
    });

    this.mcpIpcServer.on("error", (err) => {
      console.error("[wotch] MCP IPC server error:", err.message);
    });

    this.mcpIpcServer.listen(this.settings.mcpIpcPort, "127.0.0.1", () => {
      console.log(`[wotch] MCP IPC server listening on 127.0.0.1:${this.settings.mcpIpcPort}`);
    });
  }

  async _handleMCPIpcRequest(socket, line, handlers) {
    try {
      const { id, method, params } = JSON.parse(line);
      if (handlers[method]) {
        try {
          const result = await handlers[method](params);
          socket.write(JSON.stringify({ id, result }) + "\n");
        } catch (err) {
          socket.write(JSON.stringify({ id, error: err.message }) + "\n");
        }
      } else {
        socket.write(JSON.stringify({ id, error: `Unknown method: ${method}` }) + "\n");
      }
    } catch (e) {
      // Malformed JSON — ignore
    }
  }

  // ── Auto-Configuration ─────────────────────────────────────────────

  /**
   * Configure Claude Code hooks in ~/.claude/settings.json.
   * Uses type:http hooks pointing at the hook receiver.
   * Idempotent — won't duplicate existing Wotch hooks.
   */
  configureClaudeHooks() {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    let claudeSettings = {};

    try {
      claudeSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (e) {
      // File doesn't exist or is malformed
    }

    if (!claudeSettings.hooks) claudeSettings.hooks = {};

    const wotchPort = this.hookReceiver?.getPort() || this.settings.hooksPort;
    let added = 0;

    for (const event of WOTCH_HOOK_EVENTS) {
      if (!claudeSettings.hooks[event]) claudeSettings.hooks[event] = [];

      const wotchUrl = `http://localhost:${wotchPort}/hook/${event}`;
      const existing = claudeSettings.hooks[event].find((h) =>
        h.hooks?.some((hook) => hook.type === "http" && hook.url?.includes("/hook/"))
      );

      if (!existing) {
        claudeSettings.hooks[event].push({
          matcher: "",
          hooks: [{
            type: "http",
            url: wotchUrl,
            timeout: 5,
          }],
        });
        added++;
      }
    }

    if (added > 0) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(claudeSettings, null, 2));
      console.log(`[wotch] Configured ${added} hooks in ${settingsPath}`);
    } else {
      console.log("[wotch] Claude hooks already configured");
    }

    return added;
  }

  /**
   * Register Wotch MCP server in ~/.claude.json.
   * Uses type:stdio transport. Idempotent.
   */
  registerMCPServer(mcpServerPath) {
    const configPath = path.join(os.homedir(), ".claude.json");
    let config = {};

    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      // Start fresh
    }

    if (!config.mcpServers) config.mcpServers = {};

    if (config.mcpServers.wotch) {
      console.log("[wotch] MCP server already registered in ~/.claude.json");
      return false;
    }

    config.mcpServers.wotch = {
      type: "stdio",
      command: "node",
      args: [mcpServerPath],
      env: {
        WOTCH_IPC_PORT: String(this.settings.mcpIpcPort),
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[wotch] Registered MCP server in ${configPath}`);
    return true;
  }

  /**
   * Remove Wotch hooks from ~/.claude/settings.json.
   */
  removeClaudeHooks() {
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    let claudeSettings;

    try {
      claudeSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (e) {
      return;
    }

    if (!claudeSettings.hooks) return;

    for (const event of WOTCH_HOOK_EVENTS) {
      if (!claudeSettings.hooks[event]) continue;
      claudeSettings.hooks[event] = claudeSettings.hooks[event].filter((h) =>
        !h.hooks?.some((hook) => hook.type === "http" && hook.url?.includes("/hook/"))
      );
      if (claudeSettings.hooks[event].length === 0) {
        delete claudeSettings.hooks[event];
      }
    }

    if (Object.keys(claudeSettings.hooks).length === 0) {
      delete claudeSettings.hooks;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(claudeSettings, null, 2));
    console.log("[wotch] Removed Wotch hooks from Claude settings");
  }

  /**
   * Remove Wotch MCP server from ~/.claude.json.
   */
  removeMCPServer() {
    const configPath = path.join(os.homedir(), ".claude.json");
    let config;

    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (e) {
      return;
    }

    if (config.mcpServers?.wotch) {
      delete config.mcpServers.wotch;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log("[wotch] Removed MCP server from ~/.claude.json");
    }
  }
}

module.exports = { ClaudeIntegrationManager };
