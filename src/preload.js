const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wotch", {
  // PTY
  createPty: (tabId, cwd) => ipcRenderer.invoke("pty-create", { tabId, cwd }),
  writePty: (tabId, data) => ipcRenderer.send("pty-write", { tabId, data }),
  resizePty: (tabId, cols, rows) => ipcRenderer.send("pty-resize", { tabId, cols, rows }),
  killPty: (tabId) => ipcRenderer.send("pty-kill", { tabId }),

  onPtyData: (callback) => {
    ipcRenderer.removeAllListeners("pty-data");
    ipcRenderer.on("pty-data", (_e, payload) => callback(payload));
  },
  onPtyExit: (callback) => {
    ipcRenderer.removeAllListeners("pty-exit");
    ipcRenderer.on("pty-exit", (_e, payload) => callback(payload));
  },

  // Expansion state
  onExpansionState: (callback) => {
    ipcRenderer.removeAllListeners("expansion-state");
    ipcRenderer.on("expansion-state", (_e, expanded) => callback(expanded));
  },

  // Claude Code status
  onClaudeStatus: (callback) => {
    ipcRenderer.removeAllListeners("claude-status");
    ipcRenderer.on("claude-status", (_e, status) => callback(status));
  },

  // Utils
  getCwd: () => ipcRenderer.invoke("get-cwd"),

  // Project detection
  detectProjects: () => ipcRenderer.invoke("detect-projects"),

  // Git checkpointing
  gitCheckpoint: (projectPath, message) =>
    ipcRenderer.invoke("git-checkpoint", { projectPath, message }),
  gitStatus: (projectPath) =>
    ipcRenderer.invoke("git-status", { projectPath }),

  // Platform info
  getPlatformInfo: () => ipcRenderer.invoke("get-platform-info"),

  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  resetSettings: () => ipcRenderer.invoke("reset-settings"),

  // Pin mode
  setPinned: (pinned) => ipcRenderer.invoke("set-pinned", pinned),
  getPinned: () => ipcRenderer.invoke("get-pinned"),
  onPinState: (callback) => {
    ipcRenderer.removeAllListeners("pin-state");
    ipcRenderer.on("pin-state", (_e, pinned) => callback(pinned));
  },

  // Auto-update
  onUpdateAvailable: (callback) => {
    ipcRenderer.removeAllListeners("update-available");
    ipcRenderer.on("update-available", (_e, version) => callback(version));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.removeAllListeners("update-downloaded");
    ipcRenderer.on("update-downloaded", (_e, version) => callback(version));
  },

  // Git diff
  gitDiff: (projectPath, mode) =>
    ipcRenderer.invoke("git-diff", { projectPath, mode }),

  // Display management
  getDisplays: () => ipcRenderer.invoke("get-displays"),

  // Window resize
  resizeWindow: (size) => ipcRenderer.send("resize-window", size),

  // Position changes
  onPositionChanged: (callback) => {
    ipcRenderer.removeAllListeners("position-changed");
    ipcRenderer.on("position-changed", (_e, position) => callback(position));
  },

  // ── SSH ──────────────────────────────────────────────
  sshConnect: (tabId, profileId, password) =>
    ipcRenderer.invoke("ssh-connect", { tabId, profileId, password }),
  sshCredentialResponse: (tabId, credential) =>
    ipcRenderer.send("ssh-credential-response", { tabId, credential }),
  sshHostVerifyResponse: (tabId, accepted) =>
    ipcRenderer.send("ssh-host-verify-response", { tabId, accepted }),
  sshSaveProfile: (profile) => ipcRenderer.invoke("ssh-save-profile", profile),
  sshDeleteProfile: (profileId) => ipcRenderer.invoke("ssh-delete-profile", profileId),
  sshListProfiles: () => ipcRenderer.invoke("ssh-list-profiles"),
  sshBrowseKey: () => ipcRenderer.invoke("ssh-browse-key"),

  onSshCredentialRequest: (callback) => {
    ipcRenderer.removeAllListeners("ssh-credential-request");
    ipcRenderer.on("ssh-credential-request", (_e, payload) => callback(payload));
  },
  onSshHostVerify: (callback) => {
    ipcRenderer.removeAllListeners("ssh-host-verify");
    ipcRenderer.on("ssh-host-verify", (_e, payload) => callback(payload));
  },

  // ── Claude Code Integration ────────────────────────────────
  getIntegrationStatus: () => ipcRenderer.invoke("integration-status"),
  configureHooks: () => ipcRenderer.invoke("integration-configure-hooks"),
  registerMCP: () => ipcRenderer.invoke("integration-register-mcp"),

  // ── Local API ──────────────────────────────────────────────────
  apiGetInfo: () => ipcRenderer.invoke("api-get-info"),
  apiCopyToken: () => ipcRenderer.invoke("api-copy-token"),
  apiRegenerateToken: () => ipcRenderer.invoke("api-regenerate-token"),

  // ── Claude API Chat ────────────────────────────────────────────
  claude: {
    setApiKey: (apiKey) => ipcRenderer.invoke("claude-set-api-key", { apiKey }),
    validateKey: () => ipcRenderer.invoke("claude-validate-key"),
    hasKey: () => ipcRenderer.invoke("claude-has-key"),
    deleteKey: () => ipcRenderer.invoke("claude-delete-key"),
    getModels: () => ipcRenderer.invoke("claude-get-models"),
    sendMessage: (tabId, projectPath, message, options) =>
      ipcRenderer.invoke("claude-send-message", { tabId, projectPath, message, options }),
    stopStream: () => ipcRenderer.send("claude-stop-stream"),
    onStreamChunk: (callback) => {
      ipcRenderer.removeAllListeners("claude-stream-chunk");
      ipcRenderer.on("claude-stream-chunk", (_e, data) => callback(data));
    },
    onStreamEnd: (callback) => {
      ipcRenderer.removeAllListeners("claude-stream-end");
      ipcRenderer.on("claude-stream-end", (_e, data) => callback(data));
    },
    onStreamError: (callback) => {
      ipcRenderer.removeAllListeners("claude-stream-error");
      ipcRenderer.on("claude-stream-error", (_e, data) => callback(data));
    },
    onBudgetAlert: (callback) => {
      ipcRenderer.removeAllListeners("claude-budget-alert");
      ipcRenderer.on("claude-budget-alert", (_e, data) => callback(data));
    },
    getContext: (tabId, projectPath) =>
      ipcRenderer.invoke("claude-get-context", { tabId, projectPath }),
    getConversations: (projectPath) =>
      ipcRenderer.invoke("claude-get-conversations", { projectPath }),
    loadConversation: (conversationId) =>
      ipcRenderer.invoke("claude-load-conversation", { conversationId }),
    deleteConversation: (conversationId) =>
      ipcRenderer.invoke("claude-delete-conversation", { conversationId }),
    newConversation: (projectPath) =>
      ipcRenderer.invoke("claude-new-conversation", { projectPath }),
    getUsage: () => ipcRenderer.invoke("claude-get-usage"),
    setBudget: (limit) => ipcRenderer.invoke("claude-set-budget", { limit }),
  },

  // ── Plugin System ──────────────────────────────────────────────
  pluginList: () => ipcRenderer.invoke("plugin-list"),
  pluginEnable: (pluginId) => ipcRenderer.invoke("plugin-enable", { pluginId }),
  pluginDisable: (pluginId) => ipcRenderer.invoke("plugin-disable", { pluginId }),
  pluginExecuteCommand: (commandId) => ipcRenderer.invoke("plugin-execute-command", { commandId }),
  pluginGetSettings: (pluginId) => ipcRenderer.invoke("plugin-get-settings", { pluginId }),
  pluginSaveSetting: (pluginId, settingId, value) =>
    ipcRenderer.invoke("plugin-save-setting", { pluginId, settingId, value }),
  pluginGetPermissions: (pluginId) => ipcRenderer.invoke("plugin-get-permissions", { pluginId }),
  pluginGrantPermission: (pluginId, permission) =>
    ipcRenderer.invoke("plugin-grant-permission", { pluginId, permission }),
  pluginRevokePermission: (pluginId, permission) =>
    ipcRenderer.invoke("plugin-revoke-permission", { pluginId, permission }),
  onPluginCommandRegistered: (callback) => {
    ipcRenderer.removeAllListeners("plugin-command-registered");
    ipcRenderer.on("plugin-command-registered", (_e, data) => callback(data));
  },
  onPluginStatusUpdate: (callback) => {
    ipcRenderer.removeAllListeners("plugin-status-update");
    ipcRenderer.on("plugin-status-update", (_e, data) => callback(data));
  },
  onPluginPanelRegistered: (callback) => {
    ipcRenderer.removeAllListeners("plugin-panel-registered");
    ipcRenderer.on("plugin-panel-registered", (_e, data) => callback(data));
  },
  onPluginSettingsRegistered: (callback) => {
    ipcRenderer.removeAllListeners("plugin-settings-registered");
    ipcRenderer.on("plugin-settings-registered", (_e, data) => callback(data));
  },
  onPluginNotification: (callback) => {
    ipcRenderer.removeAllListeners("plugin-notification");
    ipcRenderer.on("plugin-notification", (_e, data) => callback(data));
  },
  onPluginThemeRegistered: (callback) => {
    ipcRenderer.removeAllListeners("plugin-theme-registered");
    ipcRenderer.on("plugin-theme-registered", (_e, data) => callback(data));
  },
  onPluginPanelMessage: (callback) => {
    ipcRenderer.removeAllListeners("plugin-panel-message");
    ipcRenderer.on("plugin-panel-message", (_e, data) => callback(data));
  },
  onPluginPanelVisible: (callback) => {
    ipcRenderer.removeAllListeners("plugin-panel-visible");
    ipcRenderer.on("plugin-panel-visible", (_e, data) => callback(data));
  },

  // ── Agent SDK ──────────────────────────────────────────────────
  listAgents: () => ipcRenderer.invoke("agent-list"),
  startAgent: (agentId, context) => ipcRenderer.invoke("agent-start", { agentId, context }),
  stopAgent: (runId) => ipcRenderer.invoke("agent-stop", { runId }),
  approveAction: (runId, actionId, decision) =>
    ipcRenderer.invoke("agent-approve", { runId, actionId, decision }),
  rejectAction: (runId, actionId, reason) =>
    ipcRenderer.invoke("agent-reject", { runId, actionId, reason }),
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

  // Terminal buffer read (used by MCP server via main process)
  onTerminalBufferRead: (callback) => {
    ipcRenderer.removeAllListeners("terminal-buffer-read");
    ipcRenderer.on("terminal-buffer-read", (_e, payload) => callback(payload));
  },
  sendTerminalBuffer: (data) => ipcRenderer.send("terminal-buffer-response", data),
});
