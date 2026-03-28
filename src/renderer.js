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
          <div class="proj-opt-name">${proj.name}</div>
          <div class="proj-opt-path">${proj.path}</div>
        </div>
        <span class="proj-opt-source">${label}</span>
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

  // cd the active terminal into the project directory
  if (activeTabId) {
    window.wotch.writePty(activeTabId, `cd "${project.path}"\r`);
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab) {
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
    const result = await window.wotch.gitCheckpoint(currentProject.path);
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
async function createTab(cwdOverride) {
  tabCounter++;
  const tabId = `tab-${tabCounter}`;
  const cwd = cwdOverride || (currentProject ? currentProject.path : await window.wotch.getCwd());
  const name = currentProject ? currentProject.name : `Session ${tabCounter}`;

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

  // Create PTY
  await window.wotch.createPty(tabId, cwd);

  // Wire PTY ↔ xterm
  term.onData((data) => window.wotch.writePty(tabId, data));
  term.onResize(({ cols, rows }) => window.wotch.resizePty(tabId, cols, rows));

  const tab = { id: tabId, name, term, fitAddon, searchAddon, el: containerEl, cwd };
  tabs.push(tab);

  renderTabBar();
  activateTab(tabId);

  // Auto-launch Claude if enabled
  try {
    const s = await window.wotch.getSettings();
    if (s.autoLaunchClaude) {
      setTimeout(() => window.wotch.writePty(tabId, "claude\r"), 500);
    }
  } catch { /* ignore */ }

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
    const tabState = tabStatuses[tab.id]?.state || "idle";
    btn.innerHTML = `<span class="tab-dot status-${tabState}"></span>${tab.name}<span class="tab-close" data-close="${tab.id}">✕</span>`;
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
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) tab.term.write(data);
});

window.wotch.onPtyExit(({ tabId, exitCode }) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.term.writeln(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m`);
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

function updateClaudeStatus(aggregate) {
  const { state, description } = aggregate;
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
  updateClaudeStatus(aggregate);
  tabStatuses = perTab || {};
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
btnAddTab.addEventListener("click", () => createTab());

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
    if (paletteOpen) closePalette();
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

function openSettings() {
  settingsOpen = true;
  settingsOverlay.classList.add("open");
  loadSettingsUI();
}

function closeSettings() {
  settingsOpen = false;
  settingsOverlay.classList.remove("open");
  // Re-focus terminal
  const active = tabs.find((t) => t.id === activeTabId);
  if (active) active.term.focus();
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
          `<option value="${d.index}">${d.label} (${d.width}x${d.height})${d.primary ? " — primary" : ""}</option>`
        ).join("");
        setDisplay.value = s.displayIndex || 0;
      } catch { /* ignore */ }
    }
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

document.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  const pos = document.body.classList.contains("position-left") ? "left"
    : document.body.classList.contains("position-right") ? "right" : "top";
  if (pos === "left") {
    const delta = e.screenX - resizeStartX;
    window.wotch.resizeWindow(resizeStartWidth + delta);
  } else if (pos === "right") {
    const delta = resizeStartX - e.screenX;
    window.wotch.resizeWindow(resizeStartWidth + delta);
  } else {
    const delta = e.screenY - resizeStartY;
    window.wotch.resizeWindow(resizeStartHeight + delta);
  }
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
      // cd the first tab into the project
      window.wotch.writePty(tabs[0].id, `cd "${autoProject.path}"\r`);
      tabs[0].name = autoProject.name;
      tabs[0].cwd = autoProject.path;
      renderTabBar();
    }
  } catch { /* no projects found, that's fine */ }
})();
