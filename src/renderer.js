// xterm.js UMD modules loaded via <script> tags in index.html
// UMD wraps as: window.Terminal.Terminal, window.FitAddon.FitAddon, etc.
const Terminal = (window.Terminal && window.Terminal.Terminal) || window.Terminal;
const FitAddon = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
const SearchAddon = (window.SearchAddon && window.SearchAddon.SearchAddon) || window.SearchAddon;

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

  // Prevent xterm from swallowing tab-navigation and split-pane shortcuts
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.key === "Tab") return false;
    if (e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "9") return false;
    if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "E")) return false;
    if (e.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return false;
    return true;
  });

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
  // Ctrl+Shift+A — toggle agent panel
  if (e.ctrlKey && e.shiftKey && e.key === "A") {
    e.preventDefault();
    agentPanelOpen ? closeAgentPanel() : openAgentPanel();
    return;
  }
  // Ctrl+Shift+K — emergency stop all agents
  if (e.ctrlKey && e.shiftKey && e.key === "K") {
    e.preventDefault();
    window.wotch.getAgentRuns().then(runs => {
      for (const run of runs) window.wotch.stopAgent(run.runId);
      if (runs.length) showToast("All agents stopped", "info");
    }).catch(() => {});
    return;
  }
  // Ctrl+Shift+L — toggle chat (avoids Ctrl+Shift+C which is terminal copy on Linux)
  if (e.ctrlKey && e.shiftKey && e.key === "L") {
    e.preventDefault();
    if (chatView) switchToTerminal(); else switchToChat();
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
  // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    if (tabs.length > 1) {
      const idx = tabs.findIndex(t => t.id === activeTabId);
      const next = e.shiftKey ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
      activateTab(tabs[next].id);
    }
    return;
  }
  // Ctrl+1-9 — jump to tab by index
  if (e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    const n = parseInt(e.key) - 1;
    if (n < tabs.length) activateTab(tabs[n].id);
    return;
  }
  if (e.key === "Escape") {
    if (sshCredentialOverlay.classList.contains("open")) document.getElementById("btn-ssh-cred-cancel").click();
    else if (sshHostkeyOverlay.classList.contains("open")) document.getElementById("btn-ssh-hostkey-reject").click();
    else if (sshEditorOverlay.classList.contains("open")) { connectAfterSave = false; sshEditorOverlay.classList.remove("open"); }
    else if (newTabMenuOpen) closeNewTabMenu();
    else if (paletteOpen) closePalette();
    else if (searchOpen) closeSearch();
    else if (diffOverlay.classList.contains("open")) closeDiff();
    else if (chatView && e.target.id !== "chat-input") switchToTerminal();
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
// Bridge settings elements
const setBridgeEnabled = document.getElementById("set-bridge-enabled");
const setBridgePort = document.getElementById("set-bridge-port");
const bridgeDot = document.getElementById("bridge-dot");
const bridgeStatusInfo = document.getElementById("bridge-status-info");
const btnRestartBridge = document.getElementById("btn-restart-bridge");
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
  renderPluginList();
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
  // Refresh bridge status
  try {
    const bridge = await window.wotch.bridgeGetStatus();
    if (bridgeDot) bridgeDot.className = "channel-dot " + (bridge.running && bridge.clients > 0 ? "active" : bridge.running ? "inactive" : "inactive");
    if (bridgeStatusInfo) {
      if (bridge.running) {
        bridgeStatusInfo.textContent = `ws://127.0.0.1:${bridge.port} \u2022 ${bridge.clients} client${bridge.clients !== 1 ? "s" : ""}`;
      } else {
        bridgeStatusInfo.textContent = bridge.enabled ? "Not running" : "Disabled";
      }
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
    // Bridge settings
    if (setBridgeEnabled) setBridgeEnabled.classList.toggle("on", s.integrationBridgeEnabled !== false);
    if (setBridgePort) setBridgePort.value = s.integrationBridgePort || 19521;
    // API settings
    if (setApiEnabled) setApiEnabled.classList.toggle("on", s.apiEnabled || false);
    if (setApiPort) setApiPort.value = s.apiPort || 19519;
    // Claude API settings
    if (setChatDefaultModel) setChatDefaultModel.value = s.chatDefaultModel || "claude-sonnet-4-6-20250514";
    if (setMonthlyBudget) setMonthlyBudget.value = s.apiBudgetMonthly || "";
    checkApiKeyStatus();
    refreshUsageDisplay();
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
      integrationBridgeEnabled: setBridgeEnabled ? setBridgeEnabled.classList.contains("on") : true,
      integrationBridgePort: setBridgePort ? parseInt(setBridgePort.value) || 19521 : 19521,
      apiEnabled: setApiEnabled ? setApiEnabled.classList.contains("on") : false,
      apiPort: setApiPort ? parseInt(setApiPort.value) || 19519 : 19519,
      chatDefaultModel: setChatDefaultModel ? setChatDefaultModel.value : "claude-sonnet-4-6-20250514",
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

// ── Bridge Settings Wiring ──
if (setBridgeEnabled) {
  setBridgeEnabled.addEventListener("click", () => {
    setBridgeEnabled.classList.toggle("on");
    debouncedSave();
    setTimeout(refreshIntegrationStatus, 1000);
  });
}
if (setBridgePort) {
  setBridgePort.addEventListener("input", debouncedSave);
}
if (btnRestartBridge) {
  btnRestartBridge.addEventListener("click", async () => {
    btnRestartBridge.textContent = "Restarting...";
    try {
      await window.wotch.bridgeRestart();
      btnRestartBridge.textContent = "Restarted";
    } catch { btnRestartBridge.textContent = "Failed"; }
    setTimeout(() => { btnRestartBridge.textContent = "Restart Bridge"; }, 2000);
    refreshIntegrationStatus();
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

// ── Claude API Settings Wiring ──
const setApiKeyInput = document.getElementById("set-api-key");
const btnSaveApiKey = document.getElementById("btn-save-api-key");
const btnDeleteApiKey = document.getElementById("btn-delete-api-key");
const apiKeyHint = document.getElementById("api-key-hint");
const apiKeyStatus = document.getElementById("api-key-status");
const apiKeyStatusRow = document.getElementById("api-key-status-row");
const setMonthlyBudget = document.getElementById("set-monthly-budget");
const setChatDefaultModel = document.getElementById("set-chat-default-model");
const apiUsageDisplay = document.getElementById("api-usage-display");

async function checkApiKeyStatus() {
  try {
    const hasKey = await window.wotch.claude.hasKey();
    if (hasKey) {
      apiKeyHint.textContent = "API key is configured";
      apiKeyHint.style.color = "var(--green)";
      if (setApiKeyInput) { setApiKeyInput.placeholder = "••••••••••••"; setApiKeyInput.value = ""; }
      if (btnDeleteApiKey) btnDeleteApiKey.style.display = "inline-block";
    } else {
      apiKeyHint.textContent = "Not configured";
      apiKeyHint.style.color = "var(--text-muted)";
      if (setApiKeyInput) setApiKeyInput.placeholder = "sk-ant-...";
      if (btnDeleteApiKey) btnDeleteApiKey.style.display = "none";
    }
  } catch { /* ignore */ }
}

if (btnSaveApiKey) {
  btnSaveApiKey.addEventListener("click", async () => {
    const key = setApiKeyInput?.value?.trim();
    if (!key) return;
    btnSaveApiKey.textContent = "Validating...";
    btnSaveApiKey.disabled = true;
    try {
      const result = await window.wotch.claude.setApiKey(key);
      if (apiKeyStatusRow) apiKeyStatusRow.style.display = "flex";
      if (result.valid) {
        if (apiKeyStatus) { apiKeyStatus.textContent = "Valid — key saved"; apiKeyStatus.style.color = "var(--green)"; }
        if (setApiKeyInput) setApiKeyInput.value = "";
        showToast("API key saved and validated", "success");
      } else {
        if (apiKeyStatus) { apiKeyStatus.textContent = result.error; apiKeyStatus.style.color = "#f87171"; }
      }
    } catch (err) {
      if (apiKeyStatus) { apiKeyStatus.textContent = err.message; apiKeyStatus.style.color = "#f87171"; }
    }
    btnSaveApiKey.textContent = "Save";
    btnSaveApiKey.disabled = false;
    checkApiKeyStatus();
  });
}

if (btnDeleteApiKey) {
  btnDeleteApiKey.addEventListener("click", async () => {
    await window.wotch.claude.deleteKey();
    checkApiKeyStatus();
    if (apiKeyStatusRow) apiKeyStatusRow.style.display = "none";
    showToast("API key deleted", "info");
  });
}

if (setMonthlyBudget) {
  setMonthlyBudget.addEventListener("change", async () => {
    const limit = parseFloat(setMonthlyBudget.value) || 0;
    await window.wotch.claude.setBudget(limit);
  });
}

if (setChatDefaultModel) {
  setChatDefaultModel.addEventListener("change", debouncedSave);
}

async function refreshUsageDisplay() {
  try {
    const usage = await window.wotch.claude.getUsage();
    if (apiUsageDisplay) {
      apiUsageDisplay.textContent = `$${usage.monthly.cost.toFixed(2)} (${usage.monthly.inputTokens.toLocaleString()} in / ${usage.monthly.outputTokens.toLocaleString()} out)`;
    }
  } catch { /* ignore */ }
}

// ── Chat Panel ──────────────────────────────────────────
const chatPanel = document.getElementById("chat-panel");
const terminalsContainer = document.getElementById("terminals");
const viewToggleBar = document.getElementById("view-toggle-bar");
const btnViewTerminal = document.getElementById("btn-view-terminal");
const btnViewChat = document.getElementById("btn-view-chat");
const chatMessages = document.getElementById("chat-messages");
const chatWelcome = document.getElementById("chat-welcome");
const chatInput = document.getElementById("chat-input");
const btnChatSend = document.getElementById("btn-chat-send");
const btnChatStop = document.getElementById("btn-chat-stop");
const chatModelSelect = document.getElementById("chat-model-select");
const chatCost = document.getElementById("chat-cost");
const chatTokens = document.getElementById("chat-tokens");
const ctxTerminal = document.getElementById("ctx-terminal");
const ctxGit = document.getElementById("ctx-git");
const ctxDiff = document.getElementById("ctx-diff");
const ctxFiles = document.getElementById("ctx-files");
const btnChatNew = document.getElementById("btn-chat-new");
const btnChatHistory = document.getElementById("btn-chat-history");
const chatHistoryOverlay = document.getElementById("chat-history-overlay");
const chatHistoryList = document.getElementById("chat-history-list");
const btnChatHistoryClose = document.getElementById("btn-chat-history-close");

let chatView = false; // false = terminal, true = chat
let chatStreaming = false;
let chatContextEnabled = { terminal: true, git: true, diff: true, files: true };
let chatSessionCost = 0;
let chatPendingChunks = "";
let chatRafScheduled = false;
let chatAutoScroll = true;
let chatCurrentBubble = null;

// Populate model selector
async function initChatModelSelector() {
  try {
    const models = await window.wotch.claude.getModels();
    if (chatModelSelect) {
      chatModelSelect.innerHTML = models.map((m) =>
        `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${escapeHtml(m.inputPrice)} in / ${escapeHtml(m.outputPrice)} out)</option>`
      ).join("");
      // Set default from settings
      try {
        const s = await window.wotch.getSettings();
        if (s.chatDefaultModel) chatModelSelect.value = s.chatDefaultModel;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function switchToChat() {
  chatView = true;
  if (terminalsContainer) terminalsContainer.style.display = "none";
  if (chatPanel) chatPanel.style.display = "flex";
  if (btnViewTerminal) btnViewTerminal.classList.remove("active");
  if (btnViewChat) btnViewChat.classList.add("active");
  if (chatInput) chatInput.focus();
  refreshContextBadges();
}

function switchToTerminal() {
  chatView = false;
  if (terminalsContainer) terminalsContainer.style.display = "";
  if (chatPanel) chatPanel.style.display = "none";
  if (btnViewTerminal) btnViewTerminal.classList.add("active");
  if (btnViewChat) btnViewChat.classList.remove("active");
  const active = tabs.find((t) => t.id === activeTabId);
  if (active) { active.fitAddon.fit(); active.term.focus(); }
}

if (btnViewTerminal) btnViewTerminal.addEventListener("click", switchToTerminal);
if (btnViewChat) btnViewChat.addEventListener("click", switchToChat);

async function refreshContextBadges() {
  try {
    const meta = await window.wotch.claude.getContext(activeTabId, currentProject?.path);
    if (ctxTerminal) {
      ctxTerminal.textContent = meta.terminal ? `Term: ${meta.terminal.lineCount} lines` : "Term: --";
      ctxTerminal.style.opacity = chatContextEnabled.terminal ? "1" : "0.4";
      ctxTerminal.style.textDecoration = chatContextEnabled.terminal ? "none" : "line-through";
    }
    if (ctxGit) {
      ctxGit.textContent = meta.git ? `Git: ${meta.git.changedFiles} files` : "Git: --";
      ctxGit.style.opacity = chatContextEnabled.git ? "1" : "0.4";
      ctxGit.style.textDecoration = chatContextEnabled.git ? "none" : "line-through";
    }
    if (ctxDiff) {
      ctxDiff.textContent = meta.diff ? `Diff: ${meta.diff.diffLines} lines` : "Diff: --";
      ctxDiff.style.opacity = chatContextEnabled.diff ? "1" : "0.4";
      ctxDiff.style.textDecoration = chatContextEnabled.diff ? "none" : "line-through";
    }
    if (ctxFiles) {
      ctxFiles.textContent = meta.files ? `Files: ${meta.files.fileCount}` : "Files: --";
      ctxFiles.style.opacity = chatContextEnabled.files ? "1" : "0.4";
      ctxFiles.style.textDecoration = chatContextEnabled.files ? "none" : "line-through";
    }
  } catch { /* ignore */ }
}

// Context badge toggles
if (ctxTerminal) ctxTerminal.addEventListener("click", () => { chatContextEnabled.terminal = !chatContextEnabled.terminal; refreshContextBadges(); });
if (ctxGit) ctxGit.addEventListener("click", () => { chatContextEnabled.git = !chatContextEnabled.git; refreshContextBadges(); });
if (ctxDiff) ctxDiff.addEventListener("click", () => { chatContextEnabled.diff = !chatContextEnabled.diff; refreshContextBadges(); });
if (ctxFiles) ctxFiles.addEventListener("click", () => { chatContextEnabled.files = !chatContextEnabled.files; refreshContextBadges(); });

// Simple markdown renderer
function renderMarkdown(text) {
  // Escape HTML
  let html = escapeHtml(text);

  // Code blocks (``` ... ```) — handle both closed and unclosed (streaming)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });
  // Handle unclosed code block at end (during streaming)
  html = html.replace(/```(\w*)\n([\s\S]+)$/g, (_match, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent);">$1</a>');

  // Unordered lists (lines starting with - or *)
  html = html.replace(/((?:^|\n)(?:[*\-] .+(?:\n|$))+)/g, (match) => {
    const items = match.trim().split("\n").map((line) => {
      const content = line.replace(/^[*\-] /, "");
      return `<li>${content}</li>`;
    }).join("");
    return `<ul style="margin:4px 0;padding-left:18px;">${items}</ul>`;
  });

  // Ordered lists (lines starting with 1. 2. etc.)
  html = html.replace(/((?:^|\n)(?:\d+\. .+(?:\n|$))+)/g, (match) => {
    const items = match.trim().split("\n").map((line) => {
      const content = line.replace(/^\d+\. /, "");
      return `<li>${content}</li>`;
    }).join("");
    return `<ol style="margin:4px 0;padding-left:18px;">${items}</ol>`;
  });

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

function addUserMessage(content) {
  if (chatWelcome) chatWelcome.style.display = "none";
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg-user";
  div.innerHTML = `<div class="chat-bubble">${escapeHtml(content)}</div>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function startAssistantMessage() {
  const div = document.createElement("div");
  div.className = "chat-msg chat-msg-assistant";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble chat-streaming-cursor";
  div.appendChild(bubble);
  chatMessages.appendChild(div);
  chatCurrentBubble = bubble;
  chatAutoScroll = true;
  return div;
}

function appendToAssistantMessage(text) {
  if (!chatCurrentBubble) return;
  chatPendingChunks += text;
  if (!chatRafScheduled) {
    chatRafScheduled = true;
    requestAnimationFrame(() => {
      if (chatCurrentBubble) {
        // Get accumulated text from data attribute or empty
        const accumulated = (chatCurrentBubble.dataset.accumulated || "") + chatPendingChunks;
        chatCurrentBubble.dataset.accumulated = accumulated;
        chatCurrentBubble.innerHTML = renderMarkdown(accumulated);
        chatCurrentBubble.classList.add("chat-streaming-cursor");
      }
      chatPendingChunks = "";
      chatRafScheduled = false;
      // Auto-scroll
      if (chatAutoScroll && chatMessages) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
      }
    });
  }
}

function finalizeAssistantMessage(content, usage) {
  if (chatCurrentBubble) {
    chatCurrentBubble.innerHTML = renderMarkdown(content);
    chatCurrentBubble.classList.remove("chat-streaming-cursor");
    if (usage) {
      const usageDiv = document.createElement("div");
      usageDiv.className = "chat-msg-usage";
      usageDiv.textContent = `${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out`;
      chatCurrentBubble.parentElement.appendChild(usageDiv);
    }
  }
  chatCurrentBubble = null;
  chatPendingChunks = "";
  chatRafScheduled = false;
}

function showChatError(error) {
  const div = document.createElement("div");
  div.className = "chat-msg-error";
  div.textContent = error;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Detect scroll position for auto-scroll
if (chatMessages) {
  chatMessages.addEventListener("scroll", () => {
    const atBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 30;
    chatAutoScroll = atBottom;
  });
}

async function sendChatMessage() {
  const text = chatInput?.value?.trim();
  if (!text || chatStreaming) return;

  // Check if API key is configured
  try {
    const hasKey = await window.wotch.claude.hasKey();
    if (!hasKey) {
      showChatError("No API key configured. Go to Settings > Claude API to add your key.");
      return;
    }
  } catch { /* ignore */ }

  // Warn if no project selected (conversation won't persist)
  if (!currentProject && chatMessages.querySelectorAll(".chat-msg").length === 0) {
    showToast("No project selected — conversation won't be saved across restarts", "info");
  }

  addUserMessage(text);
  chatInput.value = "";
  chatInput.style.height = "auto";

  chatStreaming = true;
  if (btnChatSend) btnChatSend.style.display = "none";
  if (btnChatStop) btnChatStop.style.display = "";

  const msgDiv = startAssistantMessage();

  await window.wotch.claude.sendMessage(
    activeTabId,
    currentProject?.path || null,
    text,
    {
      model: chatModelSelect?.value || "claude-sonnet-4-6-20250514",
      contextSources: { ...chatContextEnabled },
    }
  );
}

// Stream handlers
window.wotch.claude.onStreamChunk(({ chunk }) => {
  appendToAssistantMessage(chunk);
});

window.wotch.claude.onStreamEnd(({ content, usage, cost, model }) => {
  finalizeAssistantMessage(content, usage);
  chatStreaming = false;
  if (btnChatSend) btnChatSend.style.display = "";
  if (btnChatStop) btnChatStop.style.display = "none";
  if (cost !== undefined) {
    chatSessionCost += cost;
    if (chatCost) chatCost.textContent = `$${chatSessionCost.toFixed(4)}`;
  }
  if (usage && chatTokens) {
    chatTokens.textContent = `${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out`;
  }
  refreshContextBadges();
});

window.wotch.claude.onStreamError(({ error }) => {
  if (chatCurrentBubble) {
    chatCurrentBubble.classList.remove("chat-streaming-cursor");
    if (!chatCurrentBubble.textContent) {
      chatCurrentBubble.parentElement.remove();
    }
  }
  chatCurrentBubble = null;
  chatPendingChunks = "";
  chatStreaming = false;
  if (btnChatSend) btnChatSend.style.display = "";
  if (btnChatStop) btnChatStop.style.display = "none";
  if (error !== "Stream cancelled") {
    showChatError(error);
  }
});

window.wotch.claude.onBudgetAlert(({ level, spent, limit }) => {
  if (level === "exceeded") {
    showToast(`Budget exceeded: $${spent.toFixed(2)} / $${limit.toFixed(2)} this month`, "error");
  } else {
    showToast(`Budget warning: $${spent.toFixed(2)} / $${limit.toFixed(2)} this month (80%+)`, "info");
  }
});

// Send button
if (btnChatSend) btnChatSend.addEventListener("click", sendChatMessage);

// Stop button
if (btnChatStop) {
  btnChatStop.addEventListener("click", () => {
    window.wotch.claude.stopStream();
  });
}

// Chat input: Enter to send, Shift+Enter for newline
if (chatInput) {
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  // Auto-resize textarea
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + "px";
  });
}

// New conversation
if (btnChatNew) {
  btnChatNew.addEventListener("click", async () => {
    await window.wotch.claude.newConversation(currentProject?.path);
    // Clear chat UI
    chatMessages.innerHTML = "";
    if (chatWelcome) {
      chatWelcome.style.display = "";
      chatMessages.appendChild(chatWelcome);
    }
    chatSessionCost = 0;
    if (chatCost) chatCost.textContent = "$0.00";
    if (chatTokens) chatTokens.textContent = "";
    refreshContextBadges();
  });
}

// Conversation history
if (btnChatHistory) {
  btnChatHistory.addEventListener("click", async () => {
    if (!currentProject) { showToast("Select a project first", "error"); return; }
    const convs = await window.wotch.claude.getConversations(currentProject.path);
    if (chatHistoryList) {
      if (convs.length === 0) {
        chatHistoryList.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:16px;text-align:center;">No conversations yet</div>';
      } else {
        chatHistoryList.innerHTML = convs.map((c) => `
          <div class="chat-history-item" data-id="${escapeHtml(c.id)}">
            <button class="chat-history-delete" data-id="${escapeHtml(c.id)}" title="Delete">&#x2715;</button>
            <div class="ch-date">${new Date(c.createdAt).toLocaleDateString()} ${new Date(c.createdAt).toLocaleTimeString()}</div>
            <div class="ch-preview">${escapeHtml(c.firstMessage || "(empty)")}</div>
            <div class="ch-meta">${c.messageCount} messages</div>
          </div>
        `).join("");
        // Wire clicks
        chatHistoryList.querySelectorAll(".chat-history-item").forEach((el) => {
          el.addEventListener("click", async (e) => {
            if (e.target.classList.contains("chat-history-delete")) return;
            const conv = await window.wotch.claude.loadConversation(el.dataset.id);
            if (conv) {
              loadConversationUI(conv);
              if (chatHistoryOverlay) chatHistoryOverlay.style.display = "none";
            }
          });
        });
        chatHistoryList.querySelectorAll(".chat-history-delete").forEach((btn) => {
          btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const deletedId = btn.dataset.id;
            await window.wotch.claude.deleteConversation(deletedId);
            btn.closest(".chat-history-item").remove();
            if (chatHistoryList.querySelectorAll(".chat-history-item").length === 0) {
              chatHistoryList.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:16px;text-align:center;">No conversations yet</div>';
            }
            // Clear chat panel if the deleted conversation was the active one
            chatMessages.innerHTML = "";
            if (chatWelcome) { chatWelcome.style.display = ""; chatMessages.appendChild(chatWelcome); }
            chatSessionCost = 0;
            if (chatCost) chatCost.textContent = "$0.00";
            if (chatTokens) chatTokens.textContent = "";
          });
        });
      }
    }
    if (chatHistoryOverlay) chatHistoryOverlay.style.display = "";
  });
}

if (btnChatHistoryClose) {
  btnChatHistoryClose.addEventListener("click", () => {
    if (chatHistoryOverlay) chatHistoryOverlay.style.display = "none";
  });
}

function loadConversationUI(conv) {
  chatMessages.innerHTML = "";
  if (chatWelcome) chatWelcome.style.display = "none";
  for (const msg of conv.messages) {
    if (msg.role === "user") {
      addUserMessage(msg.content);
    } else if (msg.role === "assistant") {
      const div = document.createElement("div");
      div.className = "chat-msg chat-msg-assistant";
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      bubble.innerHTML = renderMarkdown(msg.content);
      div.appendChild(bubble);
      if (msg.usage) {
        const usageDiv = document.createElement("div");
        usageDiv.className = "chat-msg-usage";
        usageDiv.textContent = `${msg.usage.input_tokens.toLocaleString()} in / ${msg.usage.output_tokens.toLocaleString()} out`;
        div.appendChild(usageDiv);
      }
      chatMessages.appendChild(div);
    }
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (chatModelSelect && conv.model) chatModelSelect.value = conv.model;
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
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
  { name: "Chat: Toggle Chat Panel", shortcut: "Ctrl+Shift+L", action: () => {
    if (chatView) switchToTerminal(); else switchToChat();
  }},
  { name: "Chat: New Conversation", shortcut: "", action: async () => {
    if (!chatView) switchToChat();
    await window.wotch.claude.newConversation(currentProject?.path);
    chatMessages.innerHTML = "";
    if (chatWelcome) { chatWelcome.style.display = ""; chatMessages.appendChild(chatWelcome); }
    chatSessionCost = 0;
    if (chatCost) chatCost.textContent = "$0.00";
    if (chatTokens) chatTokens.textContent = "";
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
  return getFilteredCommandsWithPlugins();
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

// ── Plugin System (renderer) ────────────────────────────────────
let pluginCommands = []; // [{ id, title, pluginId }]
let pluginPanels = new Map(); // panelId → { pluginId, title, html, icon, location, iframe }

async function renderPluginList() {
  const container = document.getElementById("plugin-list-container");
  if (!container) return;
  try {
    const plugins = await window.wotch.pluginList();
    if (!plugins || plugins.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">No plugins installed</div>';
      return;
    }
    container.innerHTML = plugins.map(p => `
      <div class="setting-row" style="align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div class="setting-label">${escapeHtml(p.displayName)} <span style="font-size:10px;color:var(--text-muted);">v${escapeHtml(p.version)}</span></div>
          <div class="setting-hint">${escapeHtml(p.description)}</div>
          ${p.state === "error" ? `<div style="font-size:10px;color:#f87171;margin-top:2px;">${escapeHtml(p.errors.join(", "))}</div>` : ""}
          ${p.permissions.length > 0 ? `<div style="font-size:9px;color:var(--text-muted);margin-top:2px;">Permissions: ${p.permissions.map(perm =>
            `<span style="color:${p.grantedPermissions[perm] === "granted" ? "var(--green)" : "var(--text-muted)"}">${escapeHtml(perm)}</span>`
          ).join(", ")}</div>` : ""}
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <div class="setting-toggle ${p.enabled ? "on" : ""}" data-plugin-toggle="${escapeHtml(p.id)}" title="${p.enabled ? "Disable" : "Enable"}">
            <div class="setting-toggle-knob"></div>
          </div>
        </div>
      </div>
    `).join("");

    // Bind toggle handlers
    container.querySelectorAll("[data-plugin-toggle]").forEach(toggle => {
      toggle.addEventListener("click", async () => {
        const pluginId = toggle.dataset.pluginToggle;
        const isOn = toggle.classList.contains("on");
        if (isOn) {
          await window.wotch.pluginDisable(pluginId);
        } else {
          // Grant all requested permissions on first enable
          const perms = await window.wotch.pluginGetPermissions(pluginId);
          for (const perm of perms.requested) {
            if (perms.granted[perm] !== "granted") {
              await window.wotch.pluginGrantPermission(pluginId, perm);
            }
          }
          await window.wotch.pluginEnable(pluginId);
        }
        await renderPluginList();
      });
    });
  } catch (err) {
    container.innerHTML = `<div style="font-size:11px;color:#f87171;">Failed to load plugins: ${escapeHtml(err.message)}</div>`;
  }
}

// escapeHtml is already defined above (near diff rendering)

function getFilteredCommandsWithPlugins() {
  const q = paletteInput.value.toLowerCase();
  const all = [
    ...COMMANDS,
    ...pluginCommands.map(pc => ({
      name: pc.title,
      shortcut: "",
      action: () => window.wotch.pluginExecuteCommand(pc.id).catch(err => showToast(`Plugin command failed: ${err.message}`, "error")),
    })),
  ];
  return q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
}

function renderPluginPanel(panel) {
  const container = document.getElementById("plugin-panel-container");
  if (!container) return;

  let entry = pluginPanels.get(panel.id);
  if (entry && entry.iframe) {
    // Update existing iframe
    entry.iframe.srcdoc = panel.html;
    entry.title = panel.title;
    entry.html = panel.html;
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.id = `plugin-panel-${panel.id}`;
  wrapper.style.cssText = "border-top:1px solid var(--border);padding:0;";

  const header = document.createElement("div");
  header.style.cssText = "padding:6px 10px;font-size:11px;color:var(--text-dim);font-weight:600;display:flex;align-items:center;gap:4px;";
  header.textContent = `${panel.icon || "🔌"} ${panel.title}`;
  wrapper.appendChild(header);

  const iframe = document.createElement("iframe");
  iframe.sandbox = "allow-scripts";
  iframe.srcdoc = panel.html;
  iframe.style.cssText = "width:100%;height:200px;border:none;background:transparent;";
  wrapper.appendChild(iframe);

  container.appendChild(wrapper);
  container.style.display = "";

  pluginPanels.set(panel.id, { ...panel, iframe, wrapper });
}

function initPluginListeners() {
  // Plugin commands dynamically added to palette
  window.wotch.onPluginCommandRegistered?.((data) => {
    if (!pluginCommands.find(c => c.id === data.id)) {
      pluginCommands.push({ id: data.id, title: data.title, pluginId: data.pluginId });
    }
  });

  // Plugin panels
  window.wotch.onPluginPanelRegistered?.((data) => {
    renderPluginPanel(data);
  });

  // Plugin notifications
  window.wotch.onPluginNotification?.((data) => {
    showToast(data.message, data.type || "info");
  });

  // Plugin themes
  window.wotch.onPluginThemeRegistered?.((data) => {
    if (!THEMES[data.id]) {
      THEMES[data.id] = data.colors;
    }
  });

  // Plugin status updates
  window.wotch.onPluginStatusUpdate?.((data) => {
    // Plugin list refreshed, re-render if settings open
    if (settingsOpen && Array.isArray(data)) {
      renderPluginList();
    }
  });
}

// ── Agent SDK (renderer) ────────────────────────────────────────
let agentPanelOpen = false;
let currentAgentRunId = null;
let pendingApproval = null; // { runId, actionId }

const agentOverlay = document.getElementById("agent-overlay");
const agentSelector = document.getElementById("agent-selector");
const agentTaskInput = document.getElementById("agent-task-input");
const agentActivity = document.getElementById("agent-activity");
const btnAgentRun = document.getElementById("btn-agent-run");
const btnAgentStop = document.getElementById("btn-agent-stop");
const btnAgentClose = document.getElementById("btn-agent-close");
const agentApprovalOverlay = document.getElementById("agent-approval-overlay");
const agentApprovalTool = document.getElementById("agent-approval-tool");
const agentApprovalInput = document.getElementById("agent-approval-input");

function openAgentPanel() {
  agentPanelOpen = true;
  if (agentOverlay) agentOverlay.style.display = "";
  loadAgentList();
  renderAgentTree();
}

function closeAgentPanel() {
  agentPanelOpen = false;
  if (agentOverlay) agentOverlay.style.display = "none";
}

async function loadAgentList() {
  try {
    const agents = await window.wotch.listAgents();
    if (agentSelector) {
      agentSelector.innerHTML = agents.map(a =>
        `<option value="${escapeHtml(a.id)}">${escapeHtml(a.displayName)} (${escapeHtml(a.approvalMode)})</option>`
      ).join("");
      if (agents.length === 0) {
        agentSelector.innerHTML = '<option value="">No agents available</option>';
      }
    }
  } catch (err) {
    if (agentSelector) agentSelector.innerHTML = `<option value="">Error: ${escapeHtml(err.message)}</option>`;
  }
}

async function runAgent() {
  const agentId = agentSelector?.value;
  const task = agentTaskInput?.value?.trim();
  if (!agentId || !task) { showToast("Select an agent and enter a task", "error"); return; }

  try {
    if (agentActivity) agentActivity.innerHTML = '<div style="color:var(--accent);">Starting agent...</div>';
    if (btnAgentRun) btnAgentRun.style.display = "none";
    if (btnAgentStop) btnAgentStop.style.display = "";

    const result = await window.wotch.startAgent(agentId, { task, projectPath: currentProject?.path });
    currentAgentRunId = result.runId;
  } catch (err) {
    showToast(`Agent failed: ${err.message}`, "error");
    if (btnAgentRun) btnAgentRun.style.display = "";
    if (btnAgentStop) btnAgentStop.style.display = "none";
  }
}

async function stopAgent() {
  if (currentAgentRunId) {
    await window.wotch.stopAgent(currentAgentRunId);
    currentAgentRunId = null;
  }
  if (btnAgentRun) btnAgentRun.style.display = "";
  if (btnAgentStop) btnAgentStop.style.display = "none";
}

function appendAgentActivity(html) {
  if (!agentActivity) return;
  const div = document.createElement("div");
  div.innerHTML = html;
  div.style.cssText = "margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border);";
  agentActivity.appendChild(div);
  agentActivity.scrollTop = agentActivity.scrollHeight;
}

// ── Tool-specific UI rendering ────────────────────────
function renderToolCallRich(tool, input) {
  const shortPath = (p) => p ? escapeHtml(p.split(/[/\\]/).pop()) : "";
  switch (tool) {
    case "FileSystem.readFile":
    case "Read":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:var(--accent);font-size:11px;">&#128196;</span><span style="color:var(--accent);font-size:11px;">Reading</span><code style="font-size:10px;color:var(--text);background:var(--accent-dim);padding:1px 5px;border-radius:3px;">${shortPath(input.path || input.file_path)}</code></div>`;
    case "FileSystem.writeFile":
    case "Write":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:var(--green);font-size:11px;">&#9998;</span><span style="color:var(--green);font-size:11px;">Writing</span><code style="font-size:10px;color:var(--text);background:var(--accent-dim);padding:1px 5px;border-radius:3px;">${shortPath(input.path || input.file_path)}</code><span style="font-size:9px;color:var(--text-muted);">${input.content ? (input.content.length > 1000 ? Math.round(input.content.length / 1024) + "KB" : input.content.length + "B") : ""}</span></div>`;
    case "Edit":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:#facc15;font-size:11px;">&#9998;</span><span style="color:#facc15;font-size:11px;">Editing</span><code style="font-size:10px;color:var(--text);background:var(--accent-dim);padding:1px 5px;border-radius:3px;">${shortPath(input.file_path || input.path)}</code></div>`;
    case "FileSystem.deleteFile":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:#f87171;font-size:11px;">&#128465;</span><span style="color:#f87171;font-size:11px;">Deleting</span><code style="font-size:10px;color:var(--text);background:rgba(248,113,113,0.15);padding:1px 5px;border-radius:3px;">${shortPath(input.path)}</code></div>`;
    case "FileSystem.searchFiles":
    case "Grep":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:var(--accent);font-size:11px;">&#128269;</span><span style="color:var(--accent);font-size:11px;">Searching</span><code style="font-size:10px;color:var(--text);background:var(--accent-dim);padding:1px 5px;border-radius:3px;">${escapeHtml(input.pattern || input.query || "")}</code>${input.path ? `<span style="font-size:9px;color:var(--text-muted);">in ${shortPath(input.path)}</span>` : ""}</div>`;
    case "FileSystem.listFiles":
    case "Glob":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:var(--accent);font-size:11px;">&#128193;</span><span style="color:var(--accent);font-size:11px;">Listing</span><code style="font-size:10px;color:var(--text);background:var(--accent-dim);padding:1px 5px;border-radius:3px;">${shortPath(input.path || input.pattern || ".")}</code></div>`;
    case "Shell.execute":
    case "Bash":
      return `<div><div style="display:flex;align-items:center;gap:6px;"><span style="color:#a78bfa;font-size:11px;">&#9654;</span><span style="color:#a78bfa;font-size:11px;">Shell</span></div><pre style="font-size:10px;color:var(--text);background:rgba(0,0,0,0.3);padding:6px 8px;border-radius:4px;margin:4px 0 0;overflow-x:auto;white-space:pre-wrap;max-height:60px;">${escapeHtml((input.command || "").slice(0, 500))}</pre></div>`;
    case "Git.status":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:#fb923c;font-size:11px;">&#9878;</span><span style="color:#fb923c;font-size:11px;">Git status</span></div>`;
    case "Git.diff":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:#fb923c;font-size:11px;">&#9878;</span><span style="color:#fb923c;font-size:11px;">Git diff</span><span style="font-size:9px;color:var(--text-muted);">${escapeHtml(input.mode || "all")}</span></div>`;
    case "Git.log":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:#fb923c;font-size:11px;">&#9878;</span><span style="color:#fb923c;font-size:11px;">Git log</span><span style="font-size:9px;color:var(--text-muted);">${input.count || 10} commits</span></div>`;
    case "Git.checkpoint":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:var(--green);font-size:11px;">&#10003;</span><span style="color:var(--green);font-size:11px;">Checkpoint</span><span style="font-size:9px;color:var(--text-muted);">${escapeHtml(input.message || "")}</span></div>`;
    case "Git.branchInfo":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:#fb923c;font-size:11px;">&#9878;</span><span style="color:#fb923c;font-size:11px;">Branch info</span></div>`;
    case "Terminal.readBuffer":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:var(--text-dim);font-size:11px;">&#9617;</span><span style="color:var(--text-dim);font-size:11px;">Reading terminal</span><span style="font-size:9px;color:var(--text-muted);">${input.lines || 200} lines</span></div>`;
    case "Agent.spawn":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:#60a5fa;font-size:11px;">&#9881;</span><span style="color:#60a5fa;font-size:11px;">Spawning agent</span><code style="font-size:10px;color:var(--text);background:rgba(96,165,250,0.15);padding:1px 5px;border-radius:3px;">${escapeHtml(input.agentId || "")}</code></div>`;
    case "Wotch.showNotification":
      return `<div style="display:flex;align-items:center;gap:6px;"><span style="color:var(--accent);font-size:11px;">&#128276;</span><span style="color:var(--accent);font-size:11px;">Notification</span><span style="font-size:10px;color:var(--text-muted);">${escapeHtml((input.message || "").slice(0, 80))}</span></div>`;
    default:
      return `<span style="color:var(--accent);font-size:11px;">Tool: ${escapeHtml(tool)}</span> <span style="color:var(--text-muted);font-size:10px;">${escapeHtml(JSON.stringify(input).slice(0, 100))}</span>`;
  }
}

function renderToolResultRich(tool, output, durationMs) {
  const dur = `<span style="font-size:9px;color:var(--text-muted);margin-left:auto;">${durationMs}ms</span>`;
  let parsed = null;
  try { parsed = typeof output === "string" ? JSON.parse(output) : output; } catch { /* not JSON */ }

  switch (tool) {
    case "FileSystem.readFile":
    case "Read": {
      const content = parsed?.content || (typeof output === "string" ? output : "");
      const lines = content.split("\n");
      const lineCount = lines.length;
      const preview = lines.slice(0, 8).join("\n");
      return `<div style="font-size:10px;"><div style="display:flex;align-items:center;gap:6px;color:var(--text-muted);">Read ${lineCount} lines ${dur}</div><pre style="color:var(--text-dim);background:rgba(0,0,0,0.2);padding:4px 6px;border-radius:3px;margin:3px 0 0;overflow-x:auto;white-space:pre-wrap;max-height:80px;font-size:9px;">${escapeHtml(preview)}${lineCount > 8 ? "\n..." : ""}</pre></div>`;
    }
    case "FileSystem.writeFile":
    case "Write":
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--green);">&#10003; Written${parsed?.path ? ` to ${escapeHtml(parsed.path.split(/[/\\]/).pop())}` : ""} ${dur}</div>`;
    case "Edit": {
      const content = parsed?.content || (typeof output === "string" ? output : "");
      if (content.includes("+++") || content.includes("---") || content.includes("@@")) {
        const diffLines = content.split("\n").slice(0, 12);
        const diffHtml = diffLines.map((line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="diff-add">${escapeHtml(line)}</span>`;
          if (line.startsWith("-") && !line.startsWith("---")) return `<span class="diff-del">${escapeHtml(line)}</span>`;
          if (line.startsWith("@@")) return `<span class="diff-hunk">${escapeHtml(line)}</span>`;
          return escapeHtml(line);
        }).join("\n");
        return `<div style="font-size:10px;"><div style="display:flex;align-items:center;gap:6px;color:#facc15;">Edit applied ${dur}</div><pre style="background:rgba(0,0,0,0.2);padding:4px 6px;border-radius:3px;margin:3px 0 0;overflow-x:auto;white-space:pre-wrap;max-height:100px;font-size:9px;">${diffHtml}${diffLines.length < content.split("\n").length ? "\n..." : ""}</pre></div>`;
      }
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:#facc15;">Edit applied ${dur}</div>`;
    }
    case "FileSystem.deleteFile":
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:#f87171;">&#128465; Deleted ${dur}</div>`;
    case "FileSystem.searchFiles":
    case "Grep": {
      const files = parsed?.files || [];
      if (files.length === 0) return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--text-muted);">No matches ${dur}</div>`;
      const shown = files.slice(0, 6);
      return `<div style="font-size:10px;"><div style="display:flex;align-items:center;gap:6px;color:var(--accent);">${files.length} file${files.length !== 1 ? "s" : ""} matched ${dur}</div><div style="color:var(--text-dim);font-size:9px;margin-top:2px;">${shown.map(f => `<div style="padding:1px 0;">&#8226; ${escapeHtml(typeof f === "string" ? f.split(/[/\\]/).pop() : f)}</div>`).join("")}${files.length > 6 ? `<div style="color:var(--text-muted);">...and ${files.length - 6} more</div>` : ""}</div></div>`;
    }
    case "FileSystem.listFiles":
    case "Glob": {
      const files = parsed?.files || [];
      if (files.length === 0) return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--text-muted);">Empty directory ${dur}</div>`;
      const dirs = files.filter(f => f.isDirectory);
      const regular = files.filter(f => !f.isDirectory);
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--accent);">${dirs.length} dir${dirs.length !== 1 ? "s" : ""}, ${regular.length} file${regular.length !== 1 ? "s" : ""} ${dur}</div>`;
    }
    case "Shell.execute":
    case "Bash": {
      const exitCode = parsed?.exitCode ?? null;
      const stdout = parsed?.stdout || (typeof output === "string" ? output : "");
      const lines = stdout.split("\n");
      const preview = lines.slice(0, 10).join("\n");
      const codeColor = exitCode === 0 ? "var(--green)" : exitCode !== null ? "#f87171" : "var(--text-muted)";
      return `<div style="font-size:10px;"><div style="display:flex;align-items:center;gap:6px;"><span style="color:${codeColor};">${exitCode === 0 ? "&#10003;" : exitCode !== null ? "&#10007;" : "&#8943;"} exit ${exitCode ?? "?"}</span>${parsed?.timedOut ? '<span style="color:#f87171;">timed out</span>' : ""} ${dur}</div>${preview.trim() ? `<pre style="color:var(--text-dim);background:rgba(0,0,0,0.3);padding:4px 6px;border-radius:3px;margin:3px 0 0;overflow-x:auto;white-space:pre-wrap;max-height:80px;font-size:9px;">${escapeHtml(preview.slice(0, 1000))}${lines.length > 10 ? "\n..." : ""}</pre>` : ""}</div>`;
    }
    case "Git.status": {
      if (!parsed) return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--text-muted);">Status ${dur}</div>`;
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:#fb923c;">&#9878; ${escapeHtml(parsed.branch || "?")} &middot; ${parsed.changedFiles || 0} changed ${dur}</div>`;
    }
    case "Git.diff": {
      const diff = parsed?.diff || (typeof output === "string" ? output : "");
      if (!diff.trim()) return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--text-muted);">No changes ${dur}</div>`;
      const diffLines = diff.split("\n").slice(0, 15);
      const addCount = diffLines.filter(l => l.startsWith("+") && !l.startsWith("+++")).length;
      const delCount = diffLines.filter(l => l.startsWith("-") && !l.startsWith("---")).length;
      const diffHtml = diffLines.map((line) => {
        if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="diff-add">${escapeHtml(line)}</span>`;
        if (line.startsWith("-") && !line.startsWith("---")) return `<span class="diff-del">${escapeHtml(line)}</span>`;
        if (line.startsWith("@@")) return `<span class="diff-hunk">${escapeHtml(line)}</span>`;
        if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return `<span class="diff-meta">${escapeHtml(line)}</span>`;
        return escapeHtml(line);
      }).join("\n");
      return `<div style="font-size:10px;"><div style="display:flex;align-items:center;gap:6px;color:#fb923c;"><span style="color:var(--green);">+${addCount}</span> <span style="color:#f87171;">-${delCount}</span> ${dur}</div><pre style="background:rgba(0,0,0,0.2);padding:4px 6px;border-radius:3px;margin:3px 0 0;overflow-x:auto;white-space:pre-wrap;max-height:120px;font-size:9px;">${diffHtml}${diff.split("\n").length > 15 ? "\n..." : ""}</pre></div>`;
    }
    case "Git.log": {
      const commits = parsed?.commits || [];
      if (commits.length === 0) return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--text-muted);">No commits ${dur}</div>`;
      const shown = commits.slice(0, 5);
      return `<div style="font-size:10px;"><div style="display:flex;align-items:center;gap:6px;color:#fb923c;">${commits.length} commit${commits.length !== 1 ? "s" : ""} ${dur}</div><div style="font-size:9px;margin-top:2px;">${shown.map(c => `<div style="padding:1px 0;color:var(--text-dim);"><code style="color:#fb923c;font-size:8px;">${escapeHtml((c.hash || "").slice(0, 7))}</code> ${escapeHtml(c.message || "")}</div>`).join("")}${commits.length > 5 ? `<div style="color:var(--text-muted);">...and ${commits.length - 5} more</div>` : ""}</div></div>`;
    }
    case "Git.checkpoint":
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--green);">&#10003; Checkpoint created ${dur}</div>`;
    case "Git.branchInfo":
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:#fb923c;">&#9878; ${escapeHtml(parsed?.branch || output || "")} ${dur}</div>`;
    case "Agent.spawn":
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:#60a5fa;">&#9881; Sub-agent started: ${escapeHtml(parsed?.runId || "")} ${dur}</div>`;
    case "Wotch.showNotification":
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--accent);">&#128276; Sent ${dur}</div>`;
    default:
      return `<div style="font-size:10px;display:flex;align-items:center;gap:6px;color:var(--text-dim);">Result (${durationMs}ms): ${escapeHtml((typeof output === "string" ? output : JSON.stringify(output) || "").slice(0, 200))}</div>`;
  }
}

// ── Agent tree visualization ──────────────────────────
const agentTreeContainer = document.getElementById("agent-tree");
const agentTreeContent = document.getElementById("agent-tree-content");

async function renderAgentTree() {
  if (!window.wotch.getAgentTree) return;
  try {
    const tree = await window.wotch.getAgentTree();
    if (!tree || tree.length === 0) {
      if (agentTreeContainer) agentTreeContainer.style.display = "none";
      return;
    }
    if (agentTreeContainer) agentTreeContainer.style.display = "";
    if (agentTreeContent) agentTreeContent.innerHTML = tree.map(node => renderTreeNode(node, 0)).join("");
  } catch { /* ignore */ }
}

function renderTreeNode(node, indent) {
  const stateColors = {
    running: "var(--accent)", "waiting-approval": "#facc15",
    completed: "var(--green)", failed: "#f87171", stopped: "var(--text-muted)", idle: "var(--text-dim)",
  };
  const stateIcons = {
    running: "&#9654;", "waiting-approval": "&#9208;",
    completed: "&#10003;", failed: "&#10007;", stopped: "&#9632;", idle: "&#9675;",
  };
  const color = stateColors[node.state] || "var(--text-dim)";
  const icon = stateIcons[node.state] || "&#9675;";
  const pad = indent * 20;
  const connector = indent > 0 ? `<span style="color:var(--border);margin-right:4px;">${indent > 1 ? "&#9474; ".repeat(indent - 1) : ""}&#9492;&#9472;</span>` : "";
  const progress = node.state === "running" ? ` <span style="font-size:9px;color:var(--text-muted);">(${node.iteration}/${node.maxTurns})</span>` : "";

  let html = `<div style="padding:3px 0 3px ${pad}px;display:flex;align-items:center;gap:4px;">`;
  html += connector;
  html += `<span style="color:${color};font-size:10px;">${icon}</span>`;
  html += `<span style="color:var(--text);font-size:11px;font-weight:500;">${escapeHtml(node.agentName)}</span>`;
  html += `<span style="color:${color};font-size:9px;">${escapeHtml(node.state)}</span>`;
  html += progress;
  if (node.state === "running" || node.state === "waiting-approval") {
    html += `<button class="settings-reset-btn agent-tree-stop" data-run-id="${escapeHtml(node.runId)}" style="font-size:9px;padding:1px 6px;color:#f87171;margin-left:auto;">Stop</button>`;
  }
  html += `</div>`;

  if (node.children && node.children.length > 0) {
    html += node.children.map(child => renderTreeNode(child, indent + 1)).join("");
  }
  return html;
}

function showApprovalDialog(data) {
  pendingApproval = { runId: data.runId, actionId: data.actionId };
  if (agentApprovalTool) agentApprovalTool.textContent = data.tool;
  if (agentApprovalInput) agentApprovalInput.textContent = JSON.stringify(data.input, null, 2);
  if (agentApprovalOverlay) agentApprovalOverlay.style.display = "flex";
}

function hideApprovalDialog() {
  pendingApproval = null;
  if (agentApprovalOverlay) agentApprovalOverlay.style.display = "none";
}

function initAgentListeners() {
  // Agent events
  window.wotch.onAgentEvent?.((event) => {
    switch (event.type) {
      case "started":
        appendAgentActivity(`<span style="color:var(--green);">Agent started: ${escapeHtml(event.data.agentName)}${event.depth > 0 ? ` (depth ${event.depth})` : ""}</span>`);
        renderAgentTree();
        break;
      case "reasoning":
        appendAgentActivity(`<span style="color:var(--text-dim);">${escapeHtml(event.data.text)}</span>`);
        break;
      case "tool-call":
        appendAgentActivity(renderToolCallRich(event.data.tool, event.data.input || {}));
        break;
      case "tool-result":
        appendAgentActivity(renderToolResultRich(event.data.tool, event.data.output || "", event.data.durationMs));
        break;
      case "error":
        appendAgentActivity(`<span style="color:#f87171;">Error: ${escapeHtml(event.data.message)}</span>`);
        break;
      case "completed":
        appendAgentActivity(`<span style="color:var(--green);">Completed (${event.data.turnsUsed} turns)</span>`);
        if (!event.parentRunId) {
          if (btnAgentRun) btnAgentRun.style.display = "";
          if (btnAgentStop) btnAgentStop.style.display = "none";
          currentAgentRunId = null;
        }
        renderAgentTree();
        break;
      case "stopped":
        appendAgentActivity(`<span style="color:var(--text-muted);">Stopped: ${escapeHtml(event.data.reason)}</span>`);
        if (!event.parentRunId) {
          if (btnAgentRun) btnAgentRun.style.display = "";
          if (btnAgentStop) btnAgentStop.style.display = "none";
          currentAgentRunId = null;
        }
        renderAgentTree();
        break;
    }
  });

  // Approval requests
  window.wotch.onAgentApproval?.((data) => {
    showApprovalDialog(data);
  });

  // Agent suggestions
  window.wotch.onAgentSuggestion?.((data) => {
    showToast(`${data.agentName} can help: ${data.trigger}`, "info");
  });

  // Bind UI buttons
  if (btnAgentRun) btnAgentRun.addEventListener("click", runAgent);
  if (btnAgentStop) btnAgentStop.addEventListener("click", stopAgent);
  if (btnAgentClose) btnAgentClose.addEventListener("click", closeAgentPanel);

  document.getElementById("btn-agent-approve")?.addEventListener("click", () => {
    if (pendingApproval) {
      window.wotch.approveAction(pendingApproval.runId, pendingApproval.actionId, "approve");
      hideApprovalDialog();
    }
  });
  document.getElementById("btn-agent-deny")?.addEventListener("click", () => {
    if (pendingApproval) {
      window.wotch.rejectAction(pendingApproval.runId, pendingApproval.actionId, "User denied");
      hideApprovalDialog();
    }
  });
  document.getElementById("btn-agent-stop-approval")?.addEventListener("click", () => {
    if (pendingApproval) {
      window.wotch.stopAgent(pendingApproval.runId);
      hideApprovalDialog();
    }
  });

  // Agent tree controls
  document.getElementById("btn-agent-tree-refresh")?.addEventListener("click", renderAgentTree);
  document.getElementById("agent-tree-content")?.addEventListener("click", (e) => {
    const stopBtn = e.target.closest(".agent-tree-stop");
    if (stopBtn) {
      const runId = stopBtn.dataset.runId;
      if (runId) window.wotch.stopAgent(runId).then(renderAgentTree);
    }
  });
}

// Tab navigation commands
COMMANDS.push(
  { name: "Next Tab", shortcut: "Ctrl+Tab", action: () => {
    const idx = tabs.findIndex(t => t.id === activeTabId);
    if (tabs.length > 1) activateTab(tabs[(idx + 1) % tabs.length].id);
  }},
  { name: "Previous Tab", shortcut: "Ctrl+Shift+Tab", action: () => {
    const idx = tabs.findIndex(t => t.id === activeTabId);
    if (tabs.length > 1) activateTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
  }},
);

// Add "Run Agent" command to palette
COMMANDS.push(
  { name: "Agent: Open Agent Panel", shortcut: "Ctrl+Shift+A", action: () => openAgentPanel() },
  { name: "Agent: Emergency Stop All", shortcut: "Ctrl+Shift+K", action: async () => {
    try {
      const runs = await window.wotch.getAgentRuns();
      for (const run of runs) { await window.wotch.stopAgent(run.runId); }
      showToast("All agents stopped", "info");
    } catch { showToast("Failed to stop agents", "error"); }
  }},
);

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

  // Initialize plugin system listeners
  initPluginListeners();

  // Initialize agent system listeners
  initAgentListeners();

  // Initialize chat panel model selector
  initChatModelSelector();

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
