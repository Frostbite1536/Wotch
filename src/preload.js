const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wotch", {
  // PTY
  createPty: (tabId, cwd) => ipcRenderer.invoke("pty-create", { tabId, cwd }),
  writePty: (tabId, data) => ipcRenderer.send("pty-write", { tabId, data }),
  resizePty: (tabId, cols, rows) => ipcRenderer.send("pty-resize", { tabId, cols, rows }),
  killPty: (tabId) => ipcRenderer.send("pty-kill", { tabId }),

  onPtyData: (callback) => {
    ipcRenderer.on("pty-data", (_e, payload) => callback(payload));
  },
  onPtyExit: (callback) => {
    ipcRenderer.on("pty-exit", (_e, payload) => callback(payload));
  },

  // Expansion state
  onExpansionState: (callback) => {
    ipcRenderer.on("expansion-state", (_e, expanded) => callback(expanded));
  },

  // Claude Code status
  onClaudeStatus: (callback) => {
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
    ipcRenderer.on("pin-state", (_e, pinned) => callback(pinned));
  },
});
