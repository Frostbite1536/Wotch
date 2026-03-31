import { Terminal } from "../node_modules/@xterm/xterm/lib/xterm.js";
import { FitAddon } from "../node_modules/@xterm/addon-fit/lib/addon-fit.js";
import { SearchAddon } from "../node_modules/@xterm/addon-search/lib/addon-search.js";

// ── State ──────────────────────────────────────────────
let tabs = [];          // { id, name, term, fitAddon, searchAddon, el, cwd }
let activeTabId = null;
let tabCounter = 0;
let isExpanded = false;
let isPinned = false;
let settingsOpen = false;
let searchOpen = false;

let tabStatuses = {};   // tabId → { state, description }
let detectedProjects = [];
let currentProject = null;  // { name, path, source }
let gitInfo = null;
let dropdownOpen = false;
let gitPollInterval = null;

// ── Themes ──────────────────────────────────────────────
const THEMES = {
  dark: {
    '--bg': 'rgba(10, 10, 18, 0.97)',
    '--bg-solid': '#0a0a12',
    '--border': 'rgba(148, 163, 184, 0.12)',
    '--accent': '#a78bfa',
    '--accent-dim': 'rgba(168, 139, 250, 0.15)',
    '--text': '#e2e8f0',
    '--text-dim': '#64748b',
    '--text-muted': '#475569',
    '--green': '#34d399',
    termBg: '#0a0a12', termFg: '#e2e8f0', termCursor: '#a78bfa',
  },
  light: {
    '--bg': 'rgba(255, 255, 255, 0.97)',
    '--bg-solid': '#ffffff',
    '--border': 'rgba(100, 116, 139, 0.2)',
    '--accent': '#7c3aed',
    '--accent-dim': 'rgba(124, 58, 237, 0.1)',
    '--text': '#1e293b',
    '--text-dim': '#64748b',
    '--text-muted': '#94a3b8',
    '--green': '#059669',
    termBg: '#ffffff', termFg: '#1e293b', termCursor: '#7c3aed',
  },
  purple: {
    '--bg': 'rgba(20, 10, 30, 0.97)',
    '--bg-solid': '#140a1e',
    '--border': 'rgba(168, 139, 250, 0.15)',
    '--accent': '#c084fc',
    '--accent-dim': 'rgba(192, 132, 252, 0.15)',
    '--text': '#e2e8f0',
    '--text-dim': '#a78bfa',
    '--text-muted': '#6d28d9',
    '--green': '#34d399',
    termBg: '#140a1e', termFg: '#e2e8f0', termCursor: '#c084fc',
  },
  green: {
    '--bg': 'rgba(5, 15, 10, 0.97)',
    '--bg-solid': '#050f0a',
    '--border': 'rgba(52, 211, 153, 0.15)',
    '--accent': '#34d399',
    '--accent-dim': 'rgba(52, 211, 153, 0.15)',
    '--text': '#d1fae5',
    '--text-dim': '#6ee7b7',
    '--text-muted': '#065f46',
    '--green': '#34d399',
    termBg: '#050f0a', termFg: '#d1fae5', termCursor: '#34d399',
  },
};

let currentTheme = 'dark';

function applyTheme(themeName) {
  const theme = THEMES[themeName] || THEMES.dark;
  currentTheme = themeName;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) {
    if (key.startsWith('--')) {
      root.style.setProperty(key, value);
    }
  }
  // Update existing terminal themes
  tabs.forEach((t) => {
    t.term.options.theme = {
      ...t.term.options.theme,
      background: theme.termBg,
      foreground: theme.termFg,
      cursor: theme.termCursor,
    };
  });
}

function getTermTheme() {
  const theme = THEMES[currentTheme] || THEMES.dark;
  return {
    background: theme.termBg,
    foreground: theme.termFg,
    cursor: theme.termCursor,
    cursorAccent: theme.termBg,
    selectionBackground: 'rgba(168, 139, 250, 0.3)',
    black: '#1e293b', red: '#f87171', green: '#34d399', yellow: '#fbbf24',
    blue: '#60a5fa', magenta: '#a78bfa', cyan: '#22d3ee', white: '#e2e8f0',
    brightBlack: '#475569', brightRed: '#fca5a5', brightGreen: '#6ee7b7',
    brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#c4b5fd',
    brightCyan: '#67e8f9', brightWhite: '#f8fafc',
  };
}

const pillEl = document.getElementById("pill");
const panelEl = document.getElementById("panel");
const tabBar = document.getElementById("tab-bar");
const terminalsEl = document.getElementById("terminals");
const btnAddTab = document.getElementById("btn-add-tab");
const projectSelectBtn = document.getElementById("project-select-btn");
const projectDropdown = document.getElementById("project-dropdown");
const projNameText = document.getElementById("proj-name-text");
const gitBarEl = document.getElementById("git-bar");
const gitBranchName = document.getElementById("git-branch-name");
const gitChangesEl = document.getElementById("git-changes");
const gitCheckpointsEl = document.getElementById("git-checkpoints");
const btnCheckpoint = document.getElementById("btn-checkpoint");
const toastEl = document.getElementById("toast");

// ── Toast system ───────────────────────────────────────
let toastTimeout = null;
function showToast(message, type = "info") {
  if (toastTimeout) clearTimeout(toastTimeout);
  toastEl.textContent = message;
  toastEl.className = `${type} show`;
  toastTimeout = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 3000);
}

// ── Project detection ──────────────────────────────────
async function loadProjects() {
  projectDropdown.innerHTML = '<div class="proj-scanning"><div class="spinner"></div>Scanning for projects...</div>';
  projectDropdown.classList.add("open");
  dropdownOpen = true;

  try {
    detectedProjects = await window.wotch.detectProjects();
  } catch {
    detectedProjects = [];
  }

  renderProjectDropdown();
}

function renderProjectDropdown() {
  projectDropdown.innerHTML = "";

  if (detectedProjects.length === 0) {
    projectDropdown.innerHTML = '<div class="proj-empty">No projects found.<br>Open a project in VS Code or add folders to ~/Projects</div>';
    return;
  }

  // Group by source
  const vsRunning = detectedProjects.filter((p) => p.source === "vscode-running");
  const vsRecent = detectedProjects.filter((p) => p.source === "vscode-recent");
  const jetbrains = detectedProjects.filter((p) => p.source === "jetbrains");
  const xcode = detectedProjects.filter((p) => p.source === "xcode");
  const visualstudio = detectedProjects.filter((p) => p.source === "visualstudio");
  const scanned = detectedProjects.filter((p) => p.source === "scan");

  function addGroup(label, items) {
    if (items.length === 0) return;
    if (projectDropdown.children.length > 0) {
      const div = document.createElement("div");
      div.className = "proj-divider";
      projectDropdown.appendChild(div);
    }
    for (const proj of items) {
      const btn = document.createElement("button");
      btn.className = "proj-option";
      btn.innerHTML = `
        <span style="font-size:13px;">📂</span>
        <div style="min-width:0;flex:1;">
          <div class="proj-opt-name">${escapeHtml(proj.name)}</div>
          <div class="proj-opt-path">${escapeHtml(proj.path)}</div>
        </div>
        <span class="proj-opt-source">${escapeHtml(label)}</span>
      `;
      btn.addEventListener("click", () => selectProject(proj));
      projectDropdown.appendChild(btn);
    }
  }

  addGroup("active", vsRunning);
  addGroup("recent", vsRecent);
  addGroup("JetBrains", jetbrains);
  addGroup("Xcode", xcode);
  addGroup("VS", visualstudio);
  addGroup("found", scanned);
}

async function selectProject(project) {
  currentProject = project;
  projNameText.textContent = project.name;
  closeDropdown();

  // cd the active terminal into the project directory (local tabs only)
  if (activeTabId) {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab && activeTab.connectionType !== "ssh") {
      const escapedPath = project.path.replace(/'/g, "'\\''");
      window.wotch.writePty(activeTabId, `cd '${escapedPath}'\r`);
      activeTab.cwd = project.path;
      activeTab.name = project.name;
      renderTabBar();
    }
  }

  // Update git status
  await refreshGitStatus();

  // Start git polling
  if (gitPollInterval) clearInterval(gitPollInterval);
  gitPollInterval = setInterval(refreshGitStatus, 5000);

  showToast(`Project: ${project.name}`, "info");
}

function closeDropdown() {
  projectDropdown.classList.remove("open");
  dropdownOpen = false;
}

projectSelectBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (dropdownOpen) {
    closeDropdown();
  } else {
    loadProjects();
  }
});

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (dropdownOpen && !projectDropdown.contains(e.target) && e.target !== projectSelectBtn) {
    closeDropdown();
  }
});

// ── Git status ─────────────────────────────────────────
async function refreshGitStatus() {
  if (!currentProject) {
    gitBarEl.classList.remove("visible");
    return;
  }

  try {
    gitInfo = await window.wotch.gitStatus(currentProject.path);
  } catch {
    gitInfo = null;
  }

  if (!gitInfo) {
    gitBarEl.classList.remove("visible");
    return;
  }

  gitBarEl.classList.add("visible");
  gitBranchName.textContent = gitInfo.branch || "detached";

  if (gitInfo.changedFiles > 0) {
    gitChangesEl.textContent = `${gitInfo.changedFiles} change${gitInfo.changedFiles > 1 ? "s" : ""}`;
    gitChangesEl.classList.remove("clean");
  } else {
    gitChangesEl.textContent = "clean";
    gitChangesEl.classList.add("clean");
  }

  gitCheckpointsEl.textContent = `${gitInfo.checkpointCount || 0} checkpoint${gitInfo.checkpointCount !== 1 ? "s" : ""}`;
}

// ── Git checkpoint ─────────────────────────────────────
async function doCheckpoint() {
  if (!currentProject) {
    showToast("Select a project first", "error");
    return;
  }

  btnCheckpoint.classList.add("saving");
  btnCheckpoint.textContent = "⏳ Saving...";

  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const result = await window.wotch.gitCheckpoint(currentProject.path, `wotch-checkpoint-${timestamp}`);
    if (result.success) {
      showToast(`✓ ${result.message} (${result.details.changedFiles} files)`, "success");
    } else {
      showToast(result.message, result.message.includes("No changes") ? "info" : "error");
    }
  } catch (err) {
    showToast(`Checkpoint failed: ${err.message}`, "error");
  }

  btnCheckpoint.classList.remove("saving");
  btnCheckpoint.innerHTML = "📸 Checkpoint";

  // Refresh git status
  await refreshGitStatus();
}

btnCheckpoint.addEventListener("click", doCheckpoint);

// ── Tab management ─────────────────────────────────────
async function createTab(cwdOverride, sshProfile) {
  tabCounter++;
  const tabId = `tab-${tabCounter}`;
  const cwd = cwdOverride || (currentProject ? currentProject.path : await window.wotch.getCwd());
  const name = sshProfile
    ? `SSH: ${sshProfile.name}`
    : (currentProject ? currentProject.name : `Session ${tabCounter}`);

  // Terminal instance
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 12,
    lineHeight: 1.3,
    cursorBlink: true,
    cursorStyle: "bar",
    theme: getTermTheme(),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const searchAddon = new SearchAddon();
  term.loadAddon(searchAddon);

  // DOM
  const containerEl = document.createElement("div");
  containerEl.className = "terminal-container";
  containerEl.dataset.tabId = tabId;
  terminalsEl.appendChild(containerEl);

  term.open(containerEl);

  // Wire PTY/SSH ↔ xterm (same IPC for both — main process routes transparently)
  term.onData((data) => window.wotch.writePty(tabId, data));
  term.onResize(({ cols, rows }) => window.wotch.resizePty(tabId, cols, rows));

  const tab = {
    id: tabId, name, term, fitAddon, searchAddon, el: containerEl, cwd,
    connectionType: sshProfile ? "ssh" : "local",
    profileId: sshProfile ? sshProfile.id : null,
  };
  tabs.push(tab);

  renderTabBar();
  activateTab(tabId);

  if (sshProfile) {
    // Ensure panel is expanded so credential/host-key dialogs are visible
    if (!isExpanded) {
      pillEl.click();
      await new Promise((r) => setTimeout(r, 350));
    }

    term.writeln(`\x1b[36mConnecting to ${sshProfile.host}:${sshProfile.port}...\x1b[0m`);

    let password = null;
    if (sshProfile.authMethod === "password") {
      password = await promptSshCredential(tabId, "password",
        `Password for ${sshProfile.username}@${sshProfile.host}:`);
      if (password === null) {
        term.writeln("\x1b[31mConnection cancelled.\x1b[0m");
        return tab;
      }
    }

    try {
      await window.wotch.sshConnect(tabId, sshProfile.id, password);
      term.writeln("\x1b[32mConnected.\x1b[0m\r\n");
    } catch (err) {
      term.writeln(`\x1b[31mSSH connection failed: ${err.message}\x1b[0m`);
    } finally {
      password = null;
    }
  } else {
    // Local PTY
    await window.wotch.createPty(tabId, cwd);

    // Auto-launch Claude if enabled
    try {
      const s = await window.wotch.getSettings();
      if (s.autoLaunchClaude) {
        setTimeout(() => window.wotch.writePty(tabId, "claude\r"), 500);
      }
    } catch { /* ignore */ }
  }

  return tab;
}

function activateTab(tabId) {
  activeTabId = tabId;

  tabs.forEach((t) => {
    t.el.classList.toggle("active", t.id === tabId);
  });

  renderTabBar();

  // Fit after a frame so the container is visible
  requestAnimationFrame(() => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) {
      tab.fitAddon.fit();
      tab.term.focus();
    }
  });
}

function closeTab(tabId) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;

  // Dismiss any SSH dialogs for this tab
  const credResolve = credentialResolves.get(tabId);
  if (credResolve) { credResolve(null); credentialResolves.delete(tabId); sshCredentialOverlay.classList.remove("open"); }
  // Dismiss active host-key dialog if it belongs to this tab
  if (hostVerifyActiveTabId === tabId) {
    sshHostkeyOverlay.classList.remove("open");
    window.wotch.sshHostVerifyResponse(tabId, false);
    hostVerifyActiveTabId = null;
    processHostVerifyQueue();
  }
  // Remove any queued host-verify requests for this tab
  for (let i = hostVerifyQueue.length - 1; i >= 0; i--) {
    if (hostVerifyQueue[i].tabId === tabId) {
      hostVerifyQueue.splice(i, 1);
      window.wotch.sshHostVerifyResponse(tabId, false);
    }
  }

  window.wotch.killPty(tabId);
  tabs[idx].term.dispose();
  tabs[idx].el.remove();
  tabs.splice(idx, 1);

  if (tabs.length === 0) {
    createTab();
  } else if (activeTabId === tabId) {
    activateTab(tabs[Math.max(0, idx - 1)].id);
  }

  renderTabBar();
}

let dragTabId = null;

function renderTabBar() {
  // Skip re-render during an active drag to avoid destroying drag state
  if (dragTabId) return;

  // Remove old tab buttons (keep the + button)
  tabBar.querySelectorAll(".tab").forEach((el) => el.remove());

  tabs.forEach((tab) => {
    const btn = document.createElement("button");
    btn.className = "tab" + (tab.id === activeTabId ? " active" : "");
    btn.draggable = true;
    btn.dataset.tabId = tab.id;
    const VALID_STATES = new Set(["idle", "thinking", "working", "waiting", "done", "error"]);
    const tabState = VALID_STATES.has(tabStatuses[tab.id]?.state) ? tabStatuses[tab.id].state : "idle";
    const isSSH = tab.connectionType === "ssh";
    btn.innerHTML = `<span class="tab-dot status-${tabState}"></span>${isSSH ? '<span class="ssh-badge">SSH</span>' : ""}${escapeHtml(tab.name)}<span class="tab-close" data-close="${escapeHtmlAttr(tab.id)}">✕</span>`;
    btn.addEventListener("click", (e) => {
      if (e.target.dataset.close) {
        closeTab(e.target.dataset.close);
      } else {
        activateTab(tab.id);
      }
    });

    // Drag-and-drop reordering
    btn.addEventListener("dragstart", (e) => {
      dragTabId = tab.id;
      e.dataTransfer.effectAllowed = "move";
      btn.style.opacity = "0.4";
    });
    btn.addEventListener("dragend", () => {
      dragTabId = null;
      btn.style.opacity = "";
      tabBar.querySelectorAll(".tab.drag-over").forEach((el) => el.classList.remove("drag-over"));
      // Re-render to pick up any status updates that were skipped during drag
      renderTabBar();
    });
    btn.addEventListener("dragover", (e) => {
      if (dragTabId && dragTabId !== tab.id) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        btn.classList.add("drag-over");
      }
    });
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("drag-over");
    });
    btn.addEventListener("drop", (e) => {
      e.preventDefault();
      btn.classList.remove("drag-over");
      if (!dragTabId || dragTabId === tab.id) return;
      const fromIdx = tabs.findIndex((t) => t.id === dragTabId);
      const toIdx = tabs.findIndex((t) => t.id === tab.id);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = tabs.splice(fromIdx, 1);
      tabs.splice(toIdx, 0, moved);
      dragTabId = null; // Clear before re-render so the guard doesn't block
      renderTabBar();
    });

    tabBar.insertBefore(btn, btnAddTab);
  });
}

// ── PTY data from main process ─────────────────────────
window.wotch.onPtyData(({ tabId, data }) => {
  if (typeof tabId !== "string" || typeof data !== "string") return;
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) tab.term.write(data);
});

window.wotch.onPtyExit(({ tabId, exitCode }) => {
  if (typeof tabId !== "string" || typeof exitCode !== "number") return;
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.term.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`);
    tabStatuses[tabId] = { state: exitCode === 0 ? "idle" : "error", description: "Exited" };
    renderTabBar();
  }
});

// ── Expansion state from main process ──────────────────
window.wotch.onExpansionState((payload) => {
  // Handle both old boolean format and new object format
  const expanded = typeof payload === "object" ? payload.expanded : payload;
  if (typeof payload === "object" && payload.pinned !== undefined) {
    isPinned = payload.pinned;
    updatePinButton();
  }
  isExpanded = expanded;
  pillEl.style.display = expanded ? "none" : "flex";
  panelEl.style.display = expanded ? "flex" : "none";

  if (expanded) {
    requestAnimationFrame(() => {
      tabs.forEach((t) => t.fitAddon.fit());
      const active = tabs.find((t) => t.id === activeTabId);
      if (active) active.term.focus();
    });
    // Refresh git status when expanding
    if (currentProject) refreshGitStatus();
  } else {
    closeDropdown();
    closeSettings();
  }
});

// ── Claude Code live status ────────────────────────────
const pillDot = document.getElementById("pill-dot");
const pillLabel = document.querySelector("#pill .label");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
let defaultPillLabel = "claude";

const STATUS_DISPLAY = {
  idle:     { color: "var(--green)", label: null,             badge: "Ready" },
  thinking: { color: "var(--accent)", label: "Thinking...",   badge: "Thinking..." },
  working:  { color: "#60a5fa",      label: null,             badge: null }, // uses description
  waiting:  { color: "#fbbf24",      label: "Needs input",    badge: "Waiting for input" },
  done:     { color: "var(--green)", label: "Done",           badge: "Done" },
  error:    { color: "#f87171",      label: "Error",          badge: "Error" },
};

const VALID_STATUS_STATES = new Set(["idle", "thinking", "working", "waiting", "done", "error"]);

function updateClaudeStatus(aggregate) {
  const rawState = aggregate.state;
  const state = VALID_STATUS_STATES.has(rawState) ? rawState : "idle";
  const description = aggregate.description;
  const display = STATUS_DISPLAY[state] || STATUS_DISPLAY.idle;

  // ── Update pill dot ──
  pillDot.className = `dot status-${state}`;

  // ── Update pill label ──
  // Show description if working, otherwise use display label or default
  const showDesc = state !== "idle" && description;
  if (showDesc) {
    pillLabel.textContent = description.length > 22 ? description.slice(0, 20) + "…" : description;
    pillLabel.classList.add("active-status");
  } else if (display.label) {
    pillLabel.textContent = display.label;
    pillLabel.classList.add("active-status");
  } else {
    pillLabel.textContent = defaultPillLabel;
    pillLabel.classList.remove("active-status");
  }

  // ── Update panel status badge ──
  statusDot.className = `dot status-${state}`;
  statusText.textContent = description || display.badge || "Ready";
}

window.wotch.onClaudeStatus(({ aggregate, perTab }) => {
  if (!aggregate || typeof aggregate !== "object") return;
  updateClaudeStatus(aggregate);
  tabStatuses = (perTab && typeof perTab === "object") ? perTab : {};
  renderTabBar();
});

// ── Resize handling ────────────────────────────────────
const resizeObserver = new ResizeObserver(() => {
  if (isExpanded) {
    tabs.forEach((t) => {
      if (t.el.classList.contains("active")) {
        t.fitAddon.fit();
      }
    });
  }
});
resizeObserver.observe(terminalsEl);

// ── Event listeners ────────────────────────────────────
// ── New tab menu ──────────────────────────────────────
const newTabMenu = document.getElementById("new-tab-menu");
let newTabMenuOpen = false;

function closeNewTabMenu() {
  newTabMenu.classList.remove("open");
  newTabMenuOpen = false;
}

async function showNewTabMenu(e) {
  if (newTabMenuOpen) { closeNewTabMenu(); return; }

  const profiles = await window.wotch.sshListProfiles();
  newTabMenu.innerHTML = "";

  // Local terminal option
  const localOpt = document.createElement("div");
  localOpt.className = "new-tab-option";
  localOpt.textContent = "Local Terminal";
  localOpt.addEventListener("click", () => { closeNewTabMenu(); createTab(); });
  newTabMenu.appendChild(localOpt);

  if (profiles.length > 0) {
    const sep = document.createElement("div");
    sep.className = "new-tab-separator";
    newTabMenu.appendChild(sep);

    for (const p of profiles) {
      const opt = document.createElement("div");
      opt.className = "new-tab-option";
      opt.innerHTML = `<span class="ntm-badge">SSH</span>${escapeHtml(p.name)}`;
      opt.addEventListener("click", () => { closeNewTabMenu(); createTab(null, p); });
      newTabMenu.appendChild(opt);
    }
  }

  // "Connect via SSH..." option
  const sep2 = document.createElement("div");
  sep2.className = "new-tab-separator";
  newTabMenu.appendChild(sep2);
  const sshOpt = document.createElement("div");
  sshOpt.className = "new-tab-option";
  sshOpt.style.color = "var(--accent)";
  sshOpt.textContent = "Connect via SSH...";
  sshOpt.addEventListener("click", () => { closeNewTabMenu(); showSshConnectDialog(); });
  newTabMenu.appendChild(sshOpt);

  // Position the menu near the + button
  const rect = btnAddTab.getBoundingClientRect();
  newTabMenu.style.top = `${rect.bottom + 4}px`;
  newTabMenu.style.left = `${rect.left}px`;
  newTabMenu.classList.add("open");
  newTabMenuOpen = true;
}

let connectAfterSave = false;

function showSshConnectDialog() {
  connectAfterSave = true;
  openSshEditor(null);
}

// Close menu when clicking outside
document.addEventListener("click", (e) => {
  if (newTabMenuOpen && !newTabMenu.contains(e.target) && e.target !== btnAddTab) {
    closeNewTabMenu();
  }
});

btnAddTab.addEventListener("click", (e) => {
  e.stopPropagation();
  showNewTabMenu(e);
});

// Keyboard shortcuts within the renderer
document.addEventListener("keydown", (e) => {
  // Don't intercept if typing in a settings input or search/palette input
  if (e.target.classList.contains("setting-input") || e.target.classList.contains("setting-input-wide")) return;
  if (e.target.id === "search-input" || e.target.id === "palette-input") return;

  // Ctrl+Shift+P — command palette
  if (e.ctrlKey && e.shiftKey && e.key === "P") {
    e.preventDefault();
    paletteOpen ? closePalette() : openPalette();
    return;
  }
  if (e.ctrlKey && e.key === "t") {
    e.preventDefault();
    createTab();
  }
  if (e.ctrlKey && e.key === "w") {
    e.preventDefault();
    if (activeTabId) closeTab(activeTabId);
  }
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    doCheckpoint();
  }
  if (e.ctrlKey && e.key === "f") {
    e.preventDefault();
    searchOpen ? closeSearch() : openSearch();
  }
  if (e.key === "Escape") {
    if (sshCredentialOverlay.classList.contains("open")) document.getElementById("btn-ssh-cred-cancel").click();
    else if (sshHostkeyOverlay.classList.contains("open")) document.getElementById("btn-ssh-hostkey-reject").click();
    else if (sshEditorOverlay.classList.contains("open")) { connectAfterSave = false; sshEditorOverlay.classList.remove("open"); }
    else if (newTabMenuOpen) closeNewTabMenu();
    else if (paletteOpen) closePalette();
    else if (searchOpen) closeSearch();
    else if (diffOverlay.classList.contains("open")) closeDiff();
    else if (settingsOpen) closeSettings();
  }
  // Ctrl/Cmd+P to toggle pin (only when Shift not held, to avoid conflict with palette)
  if (e.ctrlKey && !e.shiftKey && e.key === "p") {
    e.preventDefault();
    togglePin();
  }
});

// ── Pin mode ───────────────────────────────────────────
const btnPin = document.getElementById("btn-pin");

function updatePinButton() {
  btnPin.classList.toggle("pinned", isPinned);
  btnPin.title = isPinned ? "Unpin (panel stays open)" : "Pin open";
}

async function togglePin() {
  isPinned = !isPinned;
  await window.wotch.setPinned(isPinned);
  updatePinButton();
  showToast(isPinned ? "📌 Pinned — panel stays open" : "Unpinned — panel auto-hides", "info");
}

btnPin.addEventListener("click", (e) => {
  e.stopPropagation();
  togglePin();
});

// Listen for pin state changes from main process
window.wotch.onPinState((pinned) => {
  isPinned = pinned;
  updatePinButton();
});

// ── Position handling ──────────────────────────────────
const pillArrow = document.querySelector("#pill .arrow");
const ARROW_CHARS = { top: "\u25BE", left: "\u25B8", right: "\u25C2" }; // ▾ ▸ ◂

function applyPosition(position) {
  const pos = position || "top";
  document.body.classList.remove("position-top", "position-left", "position-right");
  document.body.classList.add(`position-${pos}`);
  // Update arrow to point toward screen interior
  if (pillArrow) pillArrow.textContent = ARROW_CHARS[pos] || ARROW_CHARS.top;
}

window.wotch.onPositionChanged((position) => {
  applyPosition(position);
});

// ── Settings UI ────────────────────────────────────────
const settingsOverlay = document.getElementById("settings-overlay");
const btnSettings = document.getElementById("btn-settings");
const btnSettingsClose = document.getElementById("btn-settings-close");
const btnSettingsReset = document.getElementById("btn-settings-reset");

// Setting elements
const setExpandedWidth = document.getElementById("set-expanded-width");
const setExpandedHeight = document.getElementById("set-expanded-height");
const setPillWidth = document.getElementById("set-pill-width");
const setCollapseDelay = document.getElementById("set-collapse-delay");
const setHoverPadding = document.getElementById("set-hover-padding");
const setStartExpanded = document.getElementById("set-start-expanded");
const setRememberPin = document.getElementById("set-remember-pin");
const setDefaultShell = document.getElementById("set-default-shell");
const setTheme = document.getElementById("set-theme");
const setAutoLaunchClaude = document.getElementById("set-auto-claude");
const setDisplay = document.getElementById("set-display");
const setPosition = document.getElementById("set-position");
const setHooksEnabled = document.getElementById("set-hooks-enabled");
const setMcpEnabled = document.getElementById("set-mcp-enabled");
const hooksDot = document.getElementById("hooks-dot");
const mcpDot = document.getElementById("mcp-dot");
const btnReconfigureHooks = document.getElementById("btn-reconfigure-hooks");
const btnReregisterMcp = document.getElementById("btn-reregister-mcp");
// API settings elements
const setApiEnabled = document.getElementById("set-api-enabled");
const setApiPort = document.getElementById("set-api-port");
const apiDot = document.getElementById("api-dot");
const apiTokenDisplay = document.getElementById("api-token-display");
const btnApiShowToken = document.getElementById("btn-api-show-token");
const btnApiCopyToken = document.getElementById("btn-api-copy-token");
const btnApiRegenToken = document.getElementById("btn-api-regen-token");
const apiStatusInfo = document.getElementById("api-status-info");

let integrationPollTimer = null;

function openSettings() {
  settingsOpen = true;
  settingsOverlay.classList.add("open");
  loadSettingsUI();
  refreshIntegrationStatus();
  integrationPollTimer = setInterval(refreshIntegrationStatus, 5000);
}

function closeSettings() {
  settingsOpen = false;
  settingsOverlay.classList.remove("open");
  if (integrationPollTimer) {
    clearInterval(integrationPollTimer);
    integrationPollTimer = null;
  }
  // Re-focus terminal
  const active = tabs.find((t) => t.id === activeTabId);
  if (active) active.term.focus();
}

async function refreshIntegrationStatus() {
  try {
    const status = await window.wotch.getIntegrationStatus();
    if (hooksDot) {
      hooksDot.className = "channel-dot " + (status.hooks.active ? "active" : "inactive");
    }
    if (mcpDot) {
      mcpDot.className = "channel-dot " + (status.mcp.registered ? "active" : "inactive");
    }
  } catch { /* ignore */ }
  // Refresh API status
  try {
    const apiInfo = await window.wotch.apiGetInfo();
    if (apiDot) {
      apiDot.className = "channel-dot " + (apiInfo.running ? "active" : "inactive");
    }
    if (apiTokenDisplay && apiInfo.tokenMasked) {
      apiTokenDisplay.textContent = apiInfo.tokenMasked;
    }
    if (apiStatusInfo) {
      if (apiInfo.running) {
        apiStatusInfo.textContent = `Listening on 127.0.0.1:${apiInfo.port} \u2022 ${apiInfo.connections} WS connection${apiInfo.connections !== 1 ? "s" : ""}`;
      } else {
        apiStatusInfo.textContent = "Server not running";
      }
    }
  } catch { /* ignore */ }
}

async function loadSettingsUI() {
  try {
    const s = await window.wotch.getSettings();
    setExpandedWidth.value = s.expandedWidth;
    setExpandedHeight.value = s.expandedHeight;
    setPillWidth.value = s.pillWidth;
    setCollapseDelay.value = s.collapseDelay;
    setHoverPadding.value = s.hoverPadding;
    setStartExpanded.classList.toggle("on", s.startExpanded);
    setRememberPin.classList.toggle("on", s.pinned);
    setDefaultShell.value = s.defaultShell || "";
    if (setTheme) setTheme.value = s.theme || "dark";
    if (setAutoLaunchClaude) setAutoLaunchClaude.classList.toggle("on", s.autoLaunchClaude || false);
    if (setPosition) setPosition.value = s.position || "top";
    // Populate display selector
    if (setDisplay) {
      try {
        const displays = await window.wotch.getDisplays();
        setDisplay.innerHTML = displays.map((d) =>
          `<option value="${parseInt(d.index) || 0}">${escapeHtml(d.label)} (${parseInt(d.width) || 0}x${parseInt(d.height) || 0})${d.primary ? " — primary" : ""}</option>`
        ).join("");
        setDisplay.value = s.displayIndex || 0;
      } catch { /* ignore */ }
    }
    renderSshProfiles();
    // Integration settings
    if (setHooksEnabled) setHooksEnabled.classList.toggle("on", s.integrationHooksEnabled !== false);
    if (setMcpEnabled) setMcpEnabled.classList.toggle("on", s.integrationMcpEnabled !== false);
    // API settings
    if (setApiEnabled) setApiEnabled.classList.toggle("on", s.apiEnabled || false);
    if (setApiPort) setApiPort.value = s.apiPort || 19519;
    refreshIntegrationStatus();
  } catch { /* ignore */ }
}

// Auto-save on input change with debounce
let saveTimeout = null;
function debouncedSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    const newSettings = {
      expandedWidth: parseInt(setExpandedWidth.value) || 640,
      expandedHeight: parseInt(setExpandedHeight.value) || 440,
      pillWidth: parseInt(setPillWidth.value) || 200,
      collapseDelay: parseInt(setCollapseDelay.value) || 400,
      hoverPadding: parseInt(setHoverPadding.value) || 20,
      startExpanded: setStartExpanded.classList.contains("on"),
      pinned: setRememberPin.classList.contains("on") ? isPinned : false,
      defaultShell: setDefaultShell.value.trim(),
      theme: setTheme ? setTheme.value : "dark",
      autoLaunchClaude: setAutoLaunchClaude ? setAutoLaunchClaude.classList.contains("on") : false,
      displayIndex: setDisplay ? parseInt(setDisplay.value) || 0 : 0,
      position: setPosition ? setPosition.value : "top",
      integrationHooksEnabled: setHooksEnabled ? setHooksEnabled.classList.contains("on") : true,
      integrationMcpEnabled: setMcpEnabled ? setMcpEnabled.classList.contains("on") : true,
      apiEnabled: setApiEnabled ? setApiEnabled.classList.contains("on") : false,
      apiPort: setApiPort ? parseInt(setApiPort.value) || 19519 : 19519,
    };
    await window.wotch.saveSettings(newSettings);
  }, 500);
}

// Wire up number inputs
[setExpandedWidth, setExpandedHeight, setPillWidth, setCollapseDelay, setHoverPadding, setDefaultShell].forEach((el) => {
  el.addEventListener("input", debouncedSave);
});

// Wire up toggles
setStartExpanded.addEventListener("click", () => {
  setStartExpanded.classList.toggle("on");
  debouncedSave();
});
setRememberPin.addEventListener("click", () => {
  setRememberPin.classList.toggle("on");
  debouncedSave();
});
if (setTheme) {
  setTheme.addEventListener("change", () => {
    applyTheme(setTheme.value);
    debouncedSave();
  });
}
if (setAutoLaunchClaude) {
  setAutoLaunchClaude.addEventListener("click", () => {
    setAutoLaunchClaude.classList.toggle("on");
    debouncedSave();
  });
}
if (setDisplay) {
  setDisplay.addEventListener("change", debouncedSave);
}
if (setPosition) {
  setPosition.addEventListener("change", debouncedSave);
}
if (setHooksEnabled) {
  setHooksEnabled.addEventListener("click", () => {
    setHooksEnabled.classList.toggle("on");
    debouncedSave();
  });
}
if (setMcpEnabled) {
  setMcpEnabled.addEventListener("click", () => {
    setMcpEnabled.classList.toggle("on");
    debouncedSave();
  });
}
if (btnReconfigureHooks) {
  btnReconfigureHooks.addEventListener("click", async () => {
    const result = await window.wotch.configureHooks();
    if (result.success) {
      btnReconfigureHooks.textContent = result.added > 0 ? `Configured ${result.added} hooks` : "Already configured";
      setTimeout(() => { btnReconfigureHooks.textContent = "Reconfigure Hooks"; }, 2000);
    }
  });
}
if (btnReregisterMcp) {
  btnReregisterMcp.addEventListener("click", async () => {
    const result = await window.wotch.registerMCP();
    if (result.success) {
      btnReregisterMcp.textContent = result.registered ? "Registered" : "Already registered";
      setTimeout(() => { btnReregisterMcp.textContent = "Re-register MCP"; }, 2000);
    }
  });
}

// ── API Settings Wiring ──
if (setApiEnabled) {
  setApiEnabled.addEventListener("click", () => {
    setApiEnabled.classList.toggle("on");
    debouncedSave();
    // Refresh status after a brief delay for the server to start/stop
    setTimeout(refreshIntegrationStatus, 1000);
  });
}
if (setApiPort) {
  setApiPort.addEventListener("input", debouncedSave);
}
if (btnApiShowToken) {
  let tokenVisible = false;
  btnApiShowToken.addEventListener("click", async () => {
    if (tokenVisible) {
      // Hide it
      try {
        const info = await window.wotch.apiGetInfo();
        if (apiTokenDisplay) apiTokenDisplay.textContent = info.tokenMasked || "---";
      } catch { /* ignore */ }
      btnApiShowToken.textContent = "Show";
      tokenVisible = false;
    } else {
      // Show full token
      try {
        const token = await window.wotch.apiCopyToken();
        if (apiTokenDisplay && token) apiTokenDisplay.textContent = token;
      } catch { /* ignore */ }
      btnApiShowToken.textContent = "Hide";
      tokenVisible = true;
    }
  });
}
if (btnApiCopyToken) {
  btnApiCopyToken.addEventListener("click", async () => {
    try {
      const token = await window.wotch.apiCopyToken();
      if (token) {
        await navigator.clipboard.writeText(token);
        btnApiCopyToken.textContent = "Copied!";
        setTimeout(() => { btnApiCopyToken.textContent = "Copy"; }, 2000);
      }
    } catch {
      btnApiCopyToken.textContent = "Failed";
      setTimeout(() => { btnApiCopyToken.textContent = "Copy"; }, 2000);
    }
  });
}
if (btnApiRegenToken) {
  btnApiRegenToken.addEventListener("click", async () => {
    try {
      const masked = await window.wotch.apiRegenerateToken();
      if (apiTokenDisplay) apiTokenDisplay.textContent = masked || "---";
      btnApiRegenToken.textContent = "Done!";
      setTimeout(() => { btnApiRegenToken.textContent = "Regenerate"; }, 2000);
      refreshIntegrationStatus();
    } catch {
      btnApiRegenToken.textContent = "Failed";
      setTimeout(() => { btnApiRegenToken.textContent = "Regenerate"; }, 2000);
    }
  });
}

// ── Terminal buffer read (for MCP server) ──
window.wotch.onTerminalBufferRead(({ tabId, lines }) => {
  const tab = tabs.find((t) => t.id === (tabId || activeTabId));
  if (!tab) {
    window.wotch.sendTerminalBuffer("(tab not found)");
    return;
  }
  const buf = tab.term.buffer.active;
  const totalRows = buf.length;
  const startRow = Math.max(0, totalRows - (lines || 50));
  const output = [];
  for (let i = startRow; i < totalRows; i++) {
    const line = buf.getLine(i);
    if (line) output.push(line.translateToString(true));
  }
  window.wotch.sendTerminalBuffer(output.join("\n"));
});

btnSettings.addEventListener("click", (e) => {
  e.stopPropagation();
  if (settingsOpen) {
    closeSettings();
  } else {
    openSettings();
  }
});

btnSettingsClose.addEventListener("click", closeSettings);

btnSettingsReset.addEventListener("click", async () => {
  try {
    const defaults = await window.wotch.resetSettings();
    loadSettingsUI();
    showToast("Settings reset to defaults", "info");
  } catch (err) {
    showToast("Failed to reset settings", "error");
  }
});

// ── SSH Settings Management ──────────────────────────
const sshProfilesList = document.getElementById("ssh-profiles-list");
const btnSshAdd = document.getElementById("btn-ssh-add");
const sshEditorOverlay = document.getElementById("ssh-editor-overlay");
const sshCredentialOverlay = document.getElementById("ssh-credential-overlay");
const sshHostkeyOverlay = document.getElementById("ssh-hostkey-overlay");

let editingProfileId = null;

function escapeHtmlAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function renderSshProfiles() {
  const profiles = await window.wotch.sshListProfiles();
  sshProfilesList.innerHTML = "";
  if (profiles.length === 0) {
    sshProfilesList.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:6px 0;">No saved connections</div>';
    return;
  }
  for (const p of profiles) {
    const row = document.createElement("div");
    row.className = "setting-row";
    row.innerHTML = `
      <div style="min-width:0;flex:1;">
        <div class="setting-label">${escapeHtml(p.name)}</div>
        <div class="setting-hint">${escapeHtml(p.username)}@${escapeHtml(p.host)}:${p.port} (${p.authMethod})</div>
      </div>
      <div style="display:flex;gap:4px;">
        <button class="settings-reset-btn ssh-edit-btn" data-id="${escapeHtmlAttr(p.id)}" style="font-size:11px;">Edit</button>
        <button class="settings-reset-btn ssh-del-btn" data-id="${escapeHtmlAttr(p.id)}" style="font-size:11px;color:#f87171;">Delete</button>
      </div>
    `;
    sshProfilesList.appendChild(row);
  }
  sshProfilesList.querySelectorAll(".ssh-edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openSshEditor(btn.dataset.id));
  });
  sshProfilesList.querySelectorAll(".ssh-del-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await window.wotch.sshDeleteProfile(btn.dataset.id);
      renderSshProfiles();
      showToast("SSH connection deleted", "info");
    });
  });
}

async function openSshEditor(profileId) {
  editingProfileId = profileId || null;
  document.getElementById("ssh-editor-title").textContent = profileId ? "Edit SSH Connection" : "New SSH Connection";
  document.getElementById("ssh-name").value = "";
  document.getElementById("ssh-host").value = "";
  document.getElementById("ssh-port").value = "22";
  document.getElementById("ssh-username").value = "";
  document.getElementById("ssh-auth-method").value = "key";
  document.getElementById("ssh-key-path").value = "";
  document.getElementById("ssh-key-row").style.display = "";

  if (profileId) {
    const profiles = await window.wotch.sshListProfiles();
    const p = profiles.find((x) => x.id === profileId);
    if (p) {
      document.getElementById("ssh-name").value = p.name;
      document.getElementById("ssh-host").value = p.host;
      document.getElementById("ssh-port").value = p.port;
      document.getElementById("ssh-username").value = p.username;
      document.getElementById("ssh-auth-method").value = p.authMethod;
      document.getElementById("ssh-key-path").value = p.keyPath || "";
      document.getElementById("ssh-key-row").style.display = p.authMethod === "key" ? "" : "none";
    }
  }
  sshEditorOverlay.classList.add("open");
}

document.getElementById("ssh-auth-method").addEventListener("change", (e) => {
  document.getElementById("ssh-key-row").style.display = e.target.value === "key" ? "" : "none";
});

document.getElementById("btn-ssh-browse-key").addEventListener("click", async () => {
  const filePath = await window.wotch.sshBrowseKey();
  if (filePath) document.getElementById("ssh-key-path").value = filePath;
});

document.getElementById("btn-ssh-save").addEventListener("click", async () => {
  const profile = {
    id: editingProfileId || undefined,
    name: document.getElementById("ssh-name").value.trim() || "Unnamed",
    host: document.getElementById("ssh-host").value.trim(),
    port: parseInt(document.getElementById("ssh-port").value) || 22,
    username: document.getElementById("ssh-username").value.trim(),
    authMethod: document.getElementById("ssh-auth-method").value,
    keyPath: document.getElementById("ssh-key-path").value.trim(),
  };
  if (!profile.host || !profile.username) {
    showToast("Host and username are required", "error");
    return;
  }
  const saved = await window.wotch.sshSaveProfile(profile);
  sshEditorOverlay.classList.remove("open");
  renderSshProfiles();
  if (connectAfterSave) {
    connectAfterSave = false;
    createTab(null, saved);
  } else {
    showToast(`SSH connection "${profile.name}" saved`, "success");
  }
});

document.getElementById("btn-ssh-editor-close").addEventListener("click", () => { connectAfterSave = false; sshEditorOverlay.classList.remove("open"); });
document.getElementById("btn-ssh-cancel").addEventListener("click", () => { connectAfterSave = false; sshEditorOverlay.classList.remove("open"); });
btnSshAdd.addEventListener("click", () => openSshEditor(null));

// ── SSH Credential Prompt ────────────────────────────
const credentialResolves = new Map(); // tabId → resolve

function promptSshCredential(tabId, type, promptText) {
  return new Promise((resolve) => {
    credentialResolves.set(tabId, resolve);
    document.getElementById("ssh-credential-title").textContent =
      type === "passphrase" ? "Key Passphrase" : "SSH Password";
    document.getElementById("ssh-credential-prompt").textContent = promptText;
    document.getElementById("ssh-credential-input").value = "";
    document.getElementById("ssh-credential-input").dataset.tabId = tabId;
    sshCredentialOverlay.classList.add("open");
    setTimeout(() => document.getElementById("ssh-credential-input").focus(), 100);
  });
}

document.getElementById("btn-ssh-cred-ok").addEventListener("click", () => {
  const input = document.getElementById("ssh-credential-input");
  const val = input.value;
  const tabId = input.dataset.tabId;
  input.value = ""; // Clear password from DOM immediately
  sshCredentialOverlay.classList.remove("open");
  const resolve = credentialResolves.get(tabId);
  if (resolve) { resolve(val); credentialResolves.delete(tabId); }
});

document.getElementById("btn-ssh-cred-cancel").addEventListener("click", () => {
  const input = document.getElementById("ssh-credential-input");
  const tabId = input.dataset.tabId;
  input.value = ""; // Clear password from DOM immediately
  sshCredentialOverlay.classList.remove("open");
  const resolve = credentialResolves.get(tabId);
  if (resolve) { resolve(null); credentialResolves.delete(tabId); }
});

document.getElementById("ssh-credential-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("btn-ssh-cred-ok").click(); }
});

window.wotch.onSshCredentialRequest(async ({ tabId, type, prompt }) => {
  const credential = await promptSshCredential(tabId, type, prompt);
  window.wotch.sshCredentialResponse(tabId, credential);
});

// ── SSH Host Key Verification (queued) ──────────────
const hostVerifyQueue = []; // { tabId, host, port, fingerprint, isChanged }
let hostVerifyActiveTabId = null; // tabId of the currently shown dialog, or null

function processHostVerifyQueue() {
  if (hostVerifyActiveTabId !== null || hostVerifyQueue.length === 0) return;
  const { tabId, host, port, fingerprint, isChanged } = hostVerifyQueue.shift();
  hostVerifyActiveTabId = tabId;

  const msg = isChanged
    ? `WARNING: Host key for ${host}:${port} has CHANGED! This could indicate a man-in-the-middle attack. Do you still want to connect?`
    : `The authenticity of host '${host}:${port}' can't be established. Do you want to continue connecting?`;
  document.getElementById("ssh-hostkey-message").textContent = msg;
  document.getElementById("ssh-hostkey-fingerprint").textContent = fingerprint;
  sshHostkeyOverlay.classList.add("open");

  document.getElementById("btn-ssh-hostkey-accept").onclick = () => {
    sshHostkeyOverlay.classList.remove("open");
    window.wotch.sshHostVerifyResponse(tabId, true);
    hostVerifyActiveTabId = null;
    processHostVerifyQueue();
  };
  document.getElementById("btn-ssh-hostkey-reject").onclick = () => {
    sshHostkeyOverlay.classList.remove("open");
    window.wotch.sshHostVerifyResponse(tabId, false);
    hostVerifyActiveTabId = null;
    processHostVerifyQueue();
  };
}

window.wotch.onSshHostVerify(({ tabId, host, port, fingerprint, isChanged }) => {
  hostVerifyQueue.push({ tabId, host, port, fingerprint, isChanged });
  processHostVerifyQueue();
});

// ── Terminal search (Ctrl+F) ──────────────────────────
const searchBar = document.getElementById("search-bar");
const searchInput = document.getElementById("search-input");

function openSearch() {
  searchOpen = true;
  searchBar.classList.add("open");
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchOpen = false;
  searchBar.classList.remove("open");
  const active = tabs.find((t) => t.id === activeTabId);
  if (active) {
    active.searchAddon.clearDecorations();
    active.term.focus();
  }
}

function doSearch(direction) {
  const active = tabs.find((t) => t.id === activeTabId);
  if (!active || !searchInput.value) return;
  if (direction === "prev") {
    active.searchAddon.findPrevious(searchInput.value);
  } else {
    active.searchAddon.findNext(searchInput.value);
  }
}

searchInput.addEventListener("input", () => doSearch("next"));
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { doSearch(e.shiftKey ? "prev" : "next"); e.preventDefault(); }
  if (e.key === "Escape") { closeSearch(); e.preventDefault(); }
});
document.getElementById("search-prev").addEventListener("click", () => doSearch("prev"));
document.getElementById("search-next").addEventListener("click", () => doSearch("next"));
document.getElementById("search-close").addEventListener("click", closeSearch);

// ── Diff viewer ──────────────────────────────────────
const diffOverlay = document.getElementById("diff-overlay");
const diffContent = document.getElementById("diff-content");

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function showDiff(mode) {
  if (!currentProject) { showToast("Select a project first", "error"); return; }
  const result = await window.wotch.gitDiff(currentProject.path, mode);

  if (result.success) {
    diffContent.innerHTML = result.diff.split("\n").map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="diff-add">${escapeHtml(line)}</span>`;
      if (line.startsWith("-") && !line.startsWith("---")) return `<span class="diff-del">${escapeHtml(line)}</span>`;
      if (line.startsWith("@@")) return `<span class="diff-hunk">${escapeHtml(line)}</span>`;
      if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++"))
        return `<span class="diff-meta">${escapeHtml(line)}</span>`;
      return escapeHtml(line);
    }).join("\n");
  } else {
    diffContent.textContent = result.diff;
  }
  diffOverlay.classList.add("open");
}

function closeDiff() {
  diffOverlay.classList.remove("open");
}

document.getElementById("btn-diff-close").addEventListener("click", closeDiff);
document.getElementById("btn-diff")?.addEventListener("click", () => showDiff("last-checkpoint"));

// ── Drag to resize ───────────────────────────────────
const resizeHandle = document.getElementById("resize-handle");
let resizing = false;
let resizeStartY = 0;
let resizeStartX = 0;
let resizeStartHeight = 0;
let resizeStartWidth = 0;

resizeHandle.addEventListener("mousedown", (e) => {
  resizing = true;
  resizeStartY = e.screenY;
  resizeStartX = e.screenX;
  resizeStartHeight = document.body.offsetHeight;
  resizeStartWidth = document.body.offsetWidth;
  e.preventDefault();
});

let resizeRafPending = false;
document.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  if (resizeRafPending) return;
  const sx = e.screenX, sy = e.screenY;
  resizeRafPending = true;
  requestAnimationFrame(() => {
    resizeRafPending = false;
    const pos = document.body.classList.contains("position-left") ? "left"
      : document.body.classList.contains("position-right") ? "right" : "top";
    if (pos === "left") {
      window.wotch.resizeWindow(resizeStartWidth + (sx - resizeStartX));
    } else if (pos === "right") {
      window.wotch.resizeWindow(resizeStartWidth + (resizeStartX - sx));
    } else {
      window.wotch.resizeWindow(resizeStartHeight + (sy - resizeStartY));
    }
  });
});

document.addEventListener("mouseup", () => {
  if (resizing) {
    resizing = false;
    const pos = document.body.classList.contains("position-left") ? "left"
      : document.body.classList.contains("position-right") ? "right" : "top";
    if (pos === "left" || pos === "right") {
      window.wotch.saveSettings({ expandedWidth: document.body.offsetWidth });
    } else {
      window.wotch.saveSettings({ expandedHeight: document.body.offsetHeight });
    }
    tabs.forEach((t) => t.fitAddon.fit());
  }
});

// ── Command palette (Ctrl+Shift+P) ──────────────────
const paletteOverlay = document.getElementById("palette-overlay");
const paletteInput = document.getElementById("palette-input");
const paletteList = document.getElementById("palette-list");
let paletteOpen = false;
let paletteIndex = 0;

const COMMANDS = [
  { name: "New Tab", shortcut: "Ctrl+T", action: () => createTab() },
  { name: "Close Tab", shortcut: "Ctrl+W", action: () => activeTabId && closeTab(activeTabId) },
  { name: "Toggle Pin", shortcut: "Ctrl+P", action: () => togglePin() },
  { name: "Create Checkpoint", shortcut: "Ctrl+S", action: () => doCheckpoint() },
  { name: "Search Terminal", shortcut: "Ctrl+F", action: () => openSearch() },
  { name: "View Diff", shortcut: "", action: () => showDiff("last-checkpoint") },
  { name: "Open Settings", shortcut: "", action: () => openSettings() },
  { name: "Scan Projects", shortcut: "", action: () => loadProjects() },
  { name: "SSH: Connect to Remote", shortcut: "", action: () => showSshConnectDialog() },
  { name: "SSH: Manage Connections", shortcut: "", action: () => openSettings() },
  { name: "API: Copy Token", shortcut: "", action: async () => {
    try {
      const token = await window.wotch.apiCopyToken();
      if (token) { await navigator.clipboard.writeText(token); showToast("API token copied", "info"); }
      else showToast("API server not running", "error");
    } catch { showToast("Failed to copy token", "error"); }
  }},
  { name: "API: Toggle Server", shortcut: "", action: async () => {
    const s = await window.wotch.getSettings();
    await window.wotch.saveSettings({ apiEnabled: !s.apiEnabled });
    showToast(s.apiEnabled ? "API server disabled" : "API server enabled", "info");
    if (setApiEnabled) setApiEnabled.classList.toggle("on", !s.apiEnabled);
    setTimeout(refreshIntegrationStatus, 1000);
  }},
];

function openPalette() {
  paletteOpen = true;
  paletteIndex = 0;
  paletteInput.value = "";
  paletteOverlay.classList.add("open");
  paletteInput.focus();
  renderPalette();
}

function closePalette() {
  paletteOpen = false;
  paletteOverlay.classList.remove("open");
  const active = tabs.find((t) => t.id === activeTabId);
  if (active) active.term.focus();
}

function getFilteredCommands() {
  const q = paletteInput.value.toLowerCase();
  return q ? COMMANDS.filter((c) => c.name.toLowerCase().includes(q)) : COMMANDS;
}

function renderPalette() {
  const filtered = getFilteredCommands();
  paletteIndex = Math.max(0, Math.min(paletteIndex, filtered.length - 1));
  paletteList.innerHTML = filtered.map((cmd, i) =>
    `<div class="palette-item${i === paletteIndex ? " active" : ""}" data-idx="${i}">
      <span>${cmd.name}</span>
      ${cmd.shortcut ? `<span class="palette-shortcut">${cmd.shortcut}</span>` : ""}
    </div>`
  ).join("");
}

paletteInput.addEventListener("input", () => { paletteIndex = 0; renderPalette(); });
paletteInput.addEventListener("keydown", (e) => {
  const filtered = getFilteredCommands();
  if (e.key === "ArrowDown") { paletteIndex = Math.min(paletteIndex + 1, filtered.length - 1); renderPalette(); e.preventDefault(); }
  if (e.key === "ArrowUp") { paletteIndex = Math.max(paletteIndex - 1, 0); renderPalette(); e.preventDefault(); }
  if (e.key === "Enter" && filtered[paletteIndex]) { closePalette(); filtered[paletteIndex].action(); e.preventDefault(); }
  if (e.key === "Escape") { closePalette(); e.preventDefault(); }
});
paletteList.addEventListener("click", (e) => {
  const item = e.target.closest(".palette-item");
  if (item) {
    const filtered = getFilteredCommands();
    const cmd = filtered[parseInt(item.dataset.idx)];
    if (cmd) { closePalette(); cmd.action(); }
  }
});

// ── Init ───────────────────────────────────────────────
// Auto-detect projects on startup and pre-select first VS Code one
(async () => {
  await createTab();

  // Load initial pin state and theme
  try {
    isPinned = await window.wotch.getPinned();
    updatePinButton();
  } catch { /* ignore */ }
  try {
    const initSettings = await window.wotch.getSettings();
    if (initSettings.theme) applyTheme(initSettings.theme);
    applyPosition(initSettings.position);
  } catch { /* ignore */ }

  // Check platform and adapt UI accordingly
  try {
    const platformInfo = await window.wotch.getPlatformInfo();

    // Update shortcut labels: Ctrl → ⌘ on macOS
    if (platformInfo.isMac) {
      document.querySelectorAll(".shortcut-mod").forEach((el) => {
        el.textContent = "⌘";
      });
      // Update checkpoint button title
      btnCheckpoint.title = "Create checkpoint (⌘S)";
    }

    // Wayland notice
    if (platformInfo.isWayland) {
      const mod = platformInfo.isMac ? "⌘" : "Ctrl";
      defaultPillLabel = `claude · ${mod}+\``;
      pillLabel.textContent = defaultPillLabel;
      setTimeout(() => {
        if (!isExpanded) {
          showToast(`Wayland: use ${mod}+\` to toggle (hover may be limited)`, "info");
        }
      }, 2000);
    }

    // macOS non-notch notice
    if (platformInfo.isMac && !platformInfo.hasNotch) {
      setTimeout(() => {
        if (!isExpanded) {
          showToast("Positioned below menu bar (no notch detected)", "info");
        }
      }, 1500);
    }
  } catch { /* ignore */ }

  // Auto-update notifications
  window.wotch.onUpdateAvailable?.((version) => {
    showToast(`Update v${version} available, downloading...`, "info");
  });
  window.wotch.onUpdateDownloaded?.((version) => {
    showToast(`Update v${version} ready — restart to install`, "success");
  });

  try {
    detectedProjects = await window.wotch.detectProjects();
    // Auto-select first active VS Code project, or first recent one
    const autoProject =
      detectedProjects.find((p) => p.source === "vscode-running") ||
      detectedProjects.find((p) => p.source === "vscode-recent");
    if (autoProject) {
      await selectProject(autoProject);
    }
  } catch { /* no projects found, that's fine */ }
})();
