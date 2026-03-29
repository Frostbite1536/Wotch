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
});
