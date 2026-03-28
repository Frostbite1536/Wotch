const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage, Notification } = require("electron");
const path = require("path");
const pty = require("node-pty");
const os = require("os");
const fs = require("fs");
const { execSync, execFileSync, exec } = require("child_process");

// ── Platform detection ──────────────────────────────────────────────
const IS_WIN = os.platform() === "win32";
const IS_MAC = os.platform() === "darwin";
const IS_LINUX = os.platform() === "linux";

function isWayland() {
  if (!IS_LINUX) return false;
  return (
    process.env.WAYLAND_DISPLAY != null ||
    process.env.XDG_SESSION_TYPE === "wayland" ||
    (process.env.GDK_BACKEND || "").includes("wayland")
  );
}

const WAYLAND = isWayland();

// ── macOS notch detection ───────────────────────────────────────────
// Notch MacBooks have specific display resolutions at the native panel.
// We detect the notch by checking if the menu bar area (the gap between
// display.bounds.y and display.workArea.y) is taller than the traditional
// 25px menu bar. Notch Macs report ~37-38px because the menu bar extends
// to cover the notch height.
function detectMacNotch() {
  if (!IS_MAC) return false;
  try {
    const primary = screen.getPrimaryDisplay();
    const menuBarHeight = primary.workArea.y - primary.bounds.y;
    // Notch Macs have a menu bar height of ~37-38px (scaled).
    // Non-notch Macs have ~25px. Use 30 as the threshold.
    if (menuBarHeight > 30) return true;
    // Also check by known notch display widths (native resolution / scale)
    // 14" MBP: 3024x1964, 16" MBP: 3456x2234, 13"/15" MBA: 2560x1664 / 2880x1864
    const { width, height } = primary.size;
    const notchResolutions = [
      [3024, 1964], [3456, 2234], [2560, 1664], [2880, 1864],
      // Scaled equivalents that Electron might report
      [1512, 982], [1728, 1117], [1280, 832], [1440, 932],
      [1800, 1169], [2056, 1329],
    ];
    return notchResolutions.some(([w, h]) => width === w && height === h);
  } catch {
    return false;
  }
}

// Lazy-init after app is ready and screen API is available
let HAS_NOTCH = false;

// ── Config ──────────────────────────────────────────────────────────
const SETTINGS_DIR = path.join(os.homedir(), ".wotch");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

const DEFAULT_SETTINGS = {
  pillWidth: 200,
  pillHeight: 36,
  expandedWidth: 640,
  expandedHeight: 440,
  hoverPadding: 20,
  collapseDelay: 400,
  mousePollingMs: 100,
  defaultShell: "",          // empty = auto-detect
  startExpanded: false,
  pinned: false,             // remember pin state across restarts
  theme: "dark",
  autoLaunchClaude: false,
  displayIndex: 0,           // 0 = primary display
  position: "top",           // "top", "left", or "right"
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...raw };
    }
  } catch (err) {
    console.log("[wotch] Failed to load settings, using defaults:", err.message);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.log("[wotch] Failed to save settings:", err.message);
    return false;
  }
}

let settings = loadSettings();

let mainWindow = null;
let tray = null;
let isExpanded = false;
let isPinned = settings.pinned || false;
let mousePoller = null;
let collapseTimeout = null;
let ptyProcesses = new Map(); // tabId → pty

// ── Window positioning ──────────────────────────────────────────────
function getTargetDisplay() {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return screen.getPrimaryDisplay();
  const idx = Math.min(settings.displayIndex || 0, displays.length - 1);
  return displays[idx];
}

function getTopOffset() {
  if (IS_MAC && !HAS_NOTCH) {
    const display = getTargetDisplay();
    return display.workArea.y - display.bounds.y;
  }
  return 0;
}

function getPillBounds() {
  const display = getTargetDisplay();
  const wa = display.workArea; // { x, y, width, height } — excludes taskbar/menu bar
  const pos = settings.position || "top";

  if (pos === "left") {
    return {
      x: wa.x,
      y: wa.y + Math.round((wa.height - settings.pillWidth) / 2),
      width: settings.pillHeight,
      height: settings.pillWidth,
    };
  }
  if (pos === "right") {
    return {
      x: wa.x + wa.width - settings.pillHeight,
      y: wa.y + Math.round((wa.height - settings.pillWidth) / 2),
      width: settings.pillHeight,
      height: settings.pillWidth,
    };
  }
  // "top" (default)
  const yOffset = getTopOffset();
  return {
    x: wa.x + Math.round((wa.width - settings.pillWidth) / 2),
    y: display.bounds.y + yOffset,
    width: settings.pillWidth,
    height: settings.pillHeight,
  };
}

function getExpandedBounds() {
  const display = getTargetDisplay();
  const wa = display.workArea;
  const pos = settings.position || "top";

  if (pos === "left") {
    const clampedH = Math.min(settings.expandedHeight, wa.height);
    const clampedW = Math.min(settings.expandedWidth, wa.width);
    return {
      x: wa.x,
      y: wa.y + Math.round((wa.height - clampedH) / 2),
      width: clampedW,
      height: clampedH,
    };
  }
  if (pos === "right") {
    const clampedH = Math.min(settings.expandedHeight, wa.height);
    const clampedW = Math.min(settings.expandedWidth, wa.width);
    return {
      x: wa.x + wa.width - clampedW,
      y: wa.y + Math.round((wa.height - clampedH) / 2),
      width: clampedW,
      height: clampedH,
    };
  }
  // "top" (default)
  const yOffset = getTopOffset();
  return {
    x: wa.x + Math.round((wa.width - settings.expandedWidth) / 2),
    y: display.bounds.y + yOffset,
    width: settings.expandedWidth,
    height: settings.expandedHeight,
  };
}

// ── Create window ───────────────────────────────────────────────────
function getAlwaysOnTopLevel() {
  // Wayland compositors don't support "screen-saver" level well.
  // "floating" is the safest cross-platform option on Linux.
  // On Windows/macOS "screen-saver" keeps it above fullscreen apps.
  if (WAYLAND) return "floating";
  if (IS_LINUX) return "floating";
  return "screen-saver";
}

function createWindow() {
  const pill = getPillBounds();

  const windowOpts = {
    x: pill.x,
    y: pill.y,
    width: pill.width,
    height: pill.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: !WAYLAND, // Wayland compositors handle shadows themselves
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // On Linux, set the window type hint so the WM treats it as a panel/dock.
  // This helps with always-on-top, prevents it from appearing in alt-tab,
  // and avoids Wayland compositors applying unwanted decorations.
  if (IS_LINUX) {
    windowOpts.type = "dock";
  }

  mainWindow = new BrowserWindow(windowOpts);

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Prevent the window from being moved
  mainWindow.setMovable(false);

  // Set always-on-top with the right level for the platform
  mainWindow.setAlwaysOnTop(true, getAlwaysOnTopLevel());

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.webContents.send("position-changed", settings.position || "top");
    startMouseTracking();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    stopMouseTracking();
  });

  // Re-assert always-on-top on blur (some WMs will demote it)
  mainWindow.on("blur", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, getAlwaysOnTopLevel());
    }
  });
}

// ── Expand / Collapse ───────────────────────────────────────────────
function expand() {
  if (isExpanded || !mainWindow) return;
  isExpanded = true;

  if (collapseTimeout) {
    clearTimeout(collapseTimeout);
    collapseTimeout = null;
  }

  const bounds = getExpandedBounds();
  mainWindow.setBounds(bounds, true);
  mainWindow.webContents.send("expansion-state", { expanded: true, pinned: isPinned });
}

function collapse() {
  if (!isExpanded || !mainWindow) return;
  // Don't collapse if pinned (hover-triggered collapse is blocked)
  if (isPinned) return;

  collapseTimeout = setTimeout(() => {
    isExpanded = false;
    const bounds = getPillBounds();
    mainWindow.setBounds(bounds, true);
    mainWindow.webContents.send("expansion-state", { expanded: false, pinned: isPinned });
    collapseTimeout = null;
  }, settings.collapseDelay);
}

function toggle() {
  // Toggle always works, even when pinned
  if (isExpanded) {
    if (collapseTimeout) clearTimeout(collapseTimeout);
    isExpanded = false;
    const bounds = getPillBounds();
    mainWindow.setBounds(bounds, true);
    mainWindow.webContents.send("expansion-state", { expanded: false, pinned: isPinned });
  } else {
    expand();
  }
}

function setPinned(pinned) {
  isPinned = pinned;
  settings.pinned = pinned;
  saveSettings(settings);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pin-state", isPinned);
  }
  // If we just pinned and aren't expanded, expand
  if (isPinned && !isExpanded) {
    expand();
  }
}

// ── Mouse tracking for hover-to-reveal ──────────────────────────────
// On Wayland, screen.getCursorScreenPoint() may return {x:0, y:0}
// because Wayland doesn't expose global cursor position to apps.
// We use a fallback: if we detect Wayland and cursor always reports 0,0,
// we rely solely on the global hotkey for toggling.
let waylandCursorBroken = false;
let cursorCheckCount = 0;

function startMouseTracking() {
  mousePoller = setInterval(() => {
    if (!mainWindow) return;

    const mousePos = screen.getCursorScreenPoint();

    // Detect if Wayland is blocking cursor position
    if (WAYLAND && cursorCheckCount < 20) {
      cursorCheckCount++;
      if (mousePos.x === 0 && mousePos.y === 0) {
        if (cursorCheckCount >= 10) {
          waylandCursorBroken = true;
          console.log("[wotch] Wayland: global cursor position unavailable, using hotkey-only mode");
          clearInterval(mousePoller);
          mousePoller = null;
          return;
        }
      } else {
        // Got a real position, cursor tracking works (XWayland or compatible compositor)
        cursorCheckCount = 20; // stop checking
      }
    }

    if (waylandCursorBroken) return;

    const winBounds = mainWindow.getBounds();

    // Check if mouse is within the window bounds + padding.
    // Edge-slam: extend detection to the target display edge for the anchor side.
    const pad = settings.hoverPadding;
    const pos = settings.position || "top";
    const display = getTargetDisplay();

    let inZoneX, inZoneY;

    if (pos === "left") {
      // Extend left edge to display boundary for slam-to-left activation
      inZoneX =
        mousePos.x >= display.bounds.x &&
        mousePos.x <= winBounds.x + winBounds.width + pad;
      inZoneY =
        mousePos.y >= winBounds.y - pad &&
        mousePos.y <= winBounds.y + winBounds.height + pad;
    } else if (pos === "right") {
      // Extend right edge to physical display boundary for slam-to-right activation
      const screenRight = display.bounds.x + display.bounds.width;
      inZoneX =
        mousePos.x >= winBounds.x - pad &&
        mousePos.x <= screenRight;
      inZoneY =
        mousePos.y >= winBounds.y - pad &&
        mousePos.y <= winBounds.y + winBounds.height + pad;
    } else {
      // "top" — extend to display top edge for slam-up activation
      const screenTop = display.bounds.y;
      inZoneX =
        mousePos.x >= winBounds.x - pad &&
        mousePos.x <= winBounds.x + winBounds.width + pad;
      inZoneY =
        mousePos.y >= Math.max(screenTop, winBounds.y - pad) &&
        mousePos.y <= winBounds.y + winBounds.height + pad;
    }

    const inZone = inZoneX && inZoneY;

    if (inZone && !isExpanded) {
      expand();
    } else if (!inZone && isExpanded && !isPinned) {
      collapse();
    } else if (inZone && collapseTimeout) {
      // Cancel pending collapse if mouse re-entered
      clearTimeout(collapseTimeout);
      collapseTimeout = null;
    }
  }, settings.mousePollingMs);
}

function stopMouseTracking() {
  if (mousePoller) {
    clearInterval(mousePoller);
    mousePoller = null;
  }
}

// ── PTY management ──────────────────────────────────────────────────
function createPty(tabId, cwd) {
  let shell;
  if (settings.defaultShell) {
    shell = settings.defaultShell;
  } else if (IS_WIN) {
    shell = "powershell.exe";
  } else if (IS_MAC) {
    shell = process.env.SHELL || "/bin/zsh";
  } else {
    shell = process.env.SHELL || "/bin/bash";
  }
  const startDir = cwd || os.homedir();

  const ptyProc = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: startDir,
    env: { ...process.env, TERM: "xterm-256color" },
  });

  ptyProc.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty-data", { tabId, data });
    }
    // Feed data to status detector
    claudeStatus.feed(tabId, data);
  });

  ptyProc.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pty-exit", { tabId, exitCode });
    }
    ptyProcesses.delete(tabId);
    claudeStatus.removeTab(tabId);
  });

  ptyProcesses.set(tabId, ptyProc);
  claudeStatus.addTab(tabId);
  return tabId;
}

// ── Claude Code Status Detection ────────────────────────────────────
// Parses terminal output to detect Claude Code's state and generate
// short descriptions of what it's doing.
//
// States: idle, thinking, working, waiting, done, error
//
class ClaudeStatusDetector {
  constructor() {
    this.tabs = new Map(); // tabId → { state, description, buffer, lastActivity, claudeActive }
    this.previousStates = new Map(); // tabId → previous state
    this.broadcastTimer = null;
  }

  addTab(tabId) {
    this.tabs.set(tabId, {
      state: "idle",
      description: "",
      buffer: "",         // rolling buffer of recent clean text
      lastActivity: 0,
      claudeActive: false,
      recentFiles: [],
      recentTools: [],
    });
  }

  removeTab(tabId) {
    this.tabs.delete(tabId);
  }

  // Strip ANSI escape codes to get clean text
  stripAnsi(str) {
    return str.replace(
      // eslint-disable-next-line no-control-regex
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]/g,
      ""
    ).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); // strip other control chars
  }

  feed(tabId, rawData) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const clean = this.stripAnsi(rawData);
    tab.lastActivity = Date.now();

    // Append to rolling buffer, keep last ~2000 chars
    tab.buffer += clean;
    if (tab.buffer.length > 2000) {
      tab.buffer = tab.buffer.slice(-2000);
    }

    // ── Detect if Claude Code session is active ──
    // Claude Code shows distinctive patterns when launched
    if (!tab.claudeActive) {
      if (
        /claude\s/i.test(clean) ||
        /╭─/u.test(clean) ||
        /Claude Code/i.test(clean) ||
        /claude\.ai/i.test(clean)
      ) {
        tab.claudeActive = true;
      }
    }

    if (!tab.claudeActive) {
      tab.state = "idle";
      tab.description = "";
      this.broadcast();
      return;
    }

    // ── Pattern matching for state detection ──
    const prevState = tab.state;
    const prevDesc = tab.description;

    // Check for spinner characters (braille spinner used by many CLI tools)
    const hasSpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/u.test(rawData);

    // Check for Claude Code specific patterns
    const patterns = {
      // Thinking / Processing
      thinking: [
        /thinking/i,
        /processing/i,
        /analyzing/i,
        /understanding/i,
        /planning/i,
        /reasoning/i,
      ],
      // Tool use — reading, writing, executing
      toolUse: [
        /(?:Read|Reading)\s+(.{1,60})/i,
        /(?:Write|Writing)\s+(.{1,60})/i,
        /(?:Edit|Editing)\s+(.{1,60})/i,
        /(?:Update|Updating)\s+(.{1,60})/i,
        /(?:Create|Creating)\s+(.{1,60})/i,
        /(?:Delete|Deleting)\s+(.{1,60})/i,
        /(?:Search|Searching)\s+(.{1,60})/i,
        /(?:Replace|Replacing)\s+(.{1,60})/i,
        /(?:Run|Running|Execute|Executing)\s+(.{1,60})/i,
        /(?:Install|Installing)\s+(.{1,60})/i,
        /(?:Compile|Compiling|Build|Building)\s+(.{1,60})/i,
        /(?:Test|Testing)\s+(.{1,60})/i,
      ],
      // File paths in output
      filePaths: [
        /([a-zA-Z0-9_\-/.]+\.(ts|js|py|rs|go|jsx|tsx|css|html|json|toml|yaml|yml|md|txt|c|cpp|h|java|rb|php|swift|kt|sh|sql))\b/,
      ],
      // Waiting for user input
      waiting: [
        /\?\s*$/,
        /would you like/i,
        /do you want/i,
        /shall I/i,
        /should I/i,
        /choose|select|pick/i,
        /\(y\/n\)/i,
        /\[Y\/n\]/i,
        /approve|accept|reject|deny/i,
      ],
      // Done / Success
      done: [
        /[✓✔]\s*(.{0,60})/u,
        /(?:Done|Complete|Finished|Success|Applied)\b/i,
        /changes applied/i,
        /wrote \d+ file/i,
        /updated \d+ file/i,
      ],
      // Error
      error: [
        /[✗✘×]\s*(.{0,60})/u,
        /(?:Error|Failed|Failure)\b/i,
        /command failed/i,
        /permission denied/i,
        /not found/i,
      ],
      // Shell prompt (back to idle)
      prompt: [
        /[❯➜→▶\$#%]\s*$/,
        /^\s*\$\s*$/m,
      ],
    };

    // Priority-based state detection (check recent chunk)
    const recentClean = tab.buffer.slice(-500);

    // 1. Check for errors
    for (const re of patterns.error) {
      const m = clean.match(re);
      if (m) {
        tab.state = "error";
        tab.description = this.extractDescription(m, clean, "Error");
        break;
      }
    }

    // 2. Check for completion
    if (tab.state !== "error") {
      for (const re of patterns.done) {
        const m = clean.match(re);
        if (m) {
          tab.state = "done";
          tab.description = this.extractDescription(m, clean, "Done");
          break;
        }
      }
    }

    // 3. Check for waiting on user
    if (tab.state !== "error" && tab.state !== "done") {
      for (const re of patterns.waiting) {
        if (re.test(clean)) {
          tab.state = "waiting";
          tab.description = "Waiting for input";
          break;
        }
      }
    }

    // 4. Check for tool use (file operations, commands)
    if (tab.state !== "error" && tab.state !== "done" && tab.state !== "waiting") {
      for (const re of patterns.toolUse) {
        const m = clean.match(re);
        if (m) {
          tab.state = "working";
          const target = (m[1] || "").trim();
          // Extract just the filename from path
          const shortTarget = target.includes("/") ? target.split("/").pop() : target;
          tab.description = shortTarget ? `Working on ${shortTarget.slice(0, 40)}` : "Working...";
          // Track recent files
          if (shortTarget && !tab.recentFiles.includes(shortTarget)) {
            tab.recentFiles.push(shortTarget);
            if (tab.recentFiles.length > 5) tab.recentFiles.shift();
          }
          break;
        }
      }
    }

    // 5. Check for file paths (secondary working indicator)
    if (tab.state !== "error" && tab.state !== "done" && tab.state !== "waiting" && tab.state !== "working") {
      for (const re of patterns.filePaths) {
        const m = clean.match(re);
        if (m) {
          const fileName = m[1].split("/").pop();
          if (fileName && fileName.length > 2) {
            tab.state = "working";
            tab.description = `Touching ${fileName}`;
            if (!tab.recentFiles.includes(fileName)) {
              tab.recentFiles.push(fileName);
              if (tab.recentFiles.length > 5) tab.recentFiles.shift();
            }
          }
          break;
        }
      }
    }

    // 6. Check for thinking/spinner
    if (tab.state !== "error" && tab.state !== "done" && tab.state !== "waiting" && tab.state !== "working") {
      if (hasSpinner) {
        tab.state = "thinking";
        tab.description = tab.description || "Thinking...";
      } else {
        for (const re of patterns.thinking) {
          if (re.test(clean)) {
            tab.state = "thinking";
            tab.description = "Thinking...";
            break;
          }
        }
      }
    }

    // 7. Shell prompt → back to idle (only if no other activity)
    if (tab.state !== "error" && tab.state !== "done" && tab.state !== "waiting" &&
        tab.state !== "working" && tab.state !== "thinking") {
      for (const re of patterns.prompt) {
        if (re.test(clean)) {
          tab.state = "idle";
          tab.description = tab.claudeActive ? "Ready" : "";
          break;
        }
      }
    }

    // Generate richer descriptions based on accumulated context
    if (tab.state === "working" && tab.recentFiles.length > 1) {
      const count = tab.recentFiles.length;
      const latest = tab.recentFiles[tab.recentFiles.length - 1];
      tab.description = `Editing ${count} files (${latest})`;
    }

    // Only broadcast if something changed
    if (tab.state !== prevState || tab.description !== prevDesc) {
      this.broadcast();
    }
  }

  extractDescription(match, clean, fallback) {
    // Try to get a meaningful snippet from the match
    if (match[1] && match[1].trim().length > 2) {
      return match[1].trim().slice(0, 50);
    }
    // Try to get context from surrounding text
    const words = clean.trim().split(/\s+/).slice(0, 8).join(" ");
    return words.length > 3 ? words.slice(0, 50) : fallback;
  }

  // Get the "most interesting" status across all tabs
  getAggregateStatus() {
    const priority = { error: 6, working: 5, thinking: 4, waiting: 2, done: 1, idle: 0 };
    let best = { state: "idle", description: "", tabId: null };

    for (const [tabId, tab] of this.tabs) {
      const p = priority[tab.state] || 0;
      const bestP = priority[best.state] || 0;
      if (p > bestP || (p === bestP && tab.lastActivity > (this.tabs.get(best.tabId)?.lastActivity || 0))) {
        best = { state: tab.state, description: tab.description, tabId };
      }
    }

    return best;
  }

  getTabStatus(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return { state: "idle", description: "" };
    return { state: tab.state, description: tab.description };
  }

  broadcast() {
    // Debounce broadcasts to avoid flooding
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;

      // Check for done/error transitions → fire notification
      for (const [tabId, tab] of this.tabs) {
        const prev = this.previousStates.get(tabId) || "idle";
        if ((prev === "thinking" || prev === "working") &&
            (tab.state === "done" || tab.state === "error")) {
          if (mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
            try {
              const notif = new Notification({
                title: "Wotch",
                body: tab.state === "error"
                  ? `Claude error: ${tab.description || "Unknown"}`
                  : `Claude finished: ${tab.description || "Task complete"}`,
                silent: false,
              });
              notif.show();
            } catch { /* notifications may not be available */ }
          }
        }
        this.previousStates.set(tabId, tab.state);
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        const aggregate = this.getAggregateStatus();
        const perTab = {};
        for (const [tabId, tab] of this.tabs) {
          perTab[tabId] = { state: tab.state, description: tab.description };
        }
        mainWindow.webContents.send("claude-status", { aggregate, perTab });
      }
    }, 150);
  }
}

const claudeStatus = new ClaudeStatusDetector();

// Also detect idle timeout — if no output for 5s while in thinking/working, might be done
setInterval(() => {
  const now = Date.now();
  for (const [tabId, tab] of claudeStatus.tabs) {
    if ((tab.state === "thinking" || tab.state === "working") && now - tab.lastActivity > 5000) {
      // Likely finished — transition to idle/done
      tab.state = "idle";
      tab.description = "Ready";
      claudeStatus.broadcast();
    }
    // Clear "done" state after 8 seconds
    if (tab.state === "done" && now - tab.lastActivity > 8000) {
      tab.state = "idle";
      tab.description = "Ready";
      claudeStatus.broadcast();
    }
    // Clear "error" state after 10 seconds
    if (tab.state === "error" && now - tab.lastActivity > 10000) {
      tab.state = "idle";
      tab.description = "Ready";
      claudeStatus.broadcast();
    }
  }
}, 2000);

// ── Project Detection ───────────────────────────────────────────────
const PROJECT_MARKERS = [
  // Git
  ".git",
  // Node / JS
  "package.json",
  // Python
  "pyproject.toml", "setup.py", "requirements.txt",
  // Rust
  "Cargo.toml",
  // Go
  "go.mod",
  // .NET / C#
  "*.sln", "*.csproj",
  // Java
  "pom.xml", "build.gradle",
  // General
  "Makefile", "CMakeLists.txt", "Dockerfile",
];

// Check if a directory looks like a project root
function isProjectDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath);
    return PROJECT_MARKERS.some((marker) => {
      if (marker.startsWith("*")) {
        const ext = marker.slice(1);
        return entries.some((e) => e.endsWith(ext));
      }
      return entries.includes(marker);
    });
  } catch {
    return false;
  }
}

// Detect projects from VS Code recently-opened or running instances
function detectProjects() {
  const projects = [];

  // Strategy 1: Check VS Code's recently opened workspaces (Windows)
  if (IS_WIN) {
    const storagePath = path.join(
      os.homedir(),
      "AppData", "Roaming", "Code", "User", "globalStorage", "storage.json"
    );
    try {
      const data = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
      const recent = data.openedPathsList?.workspaces3 || data.openedPathsList?.entries || [];
      for (const entry of recent.slice(0, 20)) {
        const p = typeof entry === "string" ? entry : entry.folderUri || entry.configPath || "";
        const folderPath = p.replace("file:///", "").replace(/\//g, path.sep);
        if (folderPath && fs.existsSync(folderPath) && isProjectDir(folderPath)) {
          projects.push({
            name: path.basename(folderPath),
            path: folderPath,
            source: "vscode-recent",
          });
        }
      }
    } catch { /* no VS Code storage found */ }
  }

  // Strategy 2: Check VS Code's recently opened (macOS/Linux)
  if (!IS_WIN) {
    const storagePaths = [
      // Standard VS Code on Linux
      path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "storage.json"),
      // VS Code OSS (Arch, etc.)
      path.join(os.homedir(), ".config", "Code - OSS", "User", "globalStorage", "storage.json"),
      // VSCodium
      path.join(os.homedir(), ".config", "VSCodium", "User", "globalStorage", "storage.json"),
      // Flatpak VS Code
      path.join(os.homedir(), ".var", "app", "com.visualstudio.code", "config", "Code", "User", "globalStorage", "storage.json"),
      // Snap VS Code
      path.join(os.homedir(), "snap", "code", "current", ".config", "Code", "User", "globalStorage", "storage.json"),
      // macOS
      path.join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "storage.json"),
    ];
    for (const storagePath of storagePaths) {
      try {
        const data = JSON.parse(fs.readFileSync(storagePath, "utf-8"));
        const recent = data.openedPathsList?.workspaces3 || data.openedPathsList?.entries || [];
        for (const entry of recent.slice(0, 20)) {
          const p = typeof entry === "string" ? entry : entry.folderUri || entry.configPath || "";
          const folderPath = p.replace("file://", "");
          if (folderPath && fs.existsSync(folderPath) && isProjectDir(folderPath)) {
            projects.push({
              name: path.basename(folderPath),
              path: folderPath,
              source: "vscode-recent",
            });
          }
        }
      } catch { /* skip */ }
    }
  }

  // Strategy 3: Try to detect running VS Code instances via CLI
  try {
    let cmd;
    if (IS_WIN) {
      cmd = 'wmic process where "name like \'%Code%\'" get CommandLine /format:list 2>nul';
    } else if (IS_MAC) {
      // macOS ps doesn't have -oP, use perl for regex
      cmd = "ps aux | grep '[C]ode' | perl -nle 'print $1 if /--folder-uri=(\\S+)/'";
    } else {
      // Linux — try grep -oP first (GNU grep), fall back to perl
      cmd = "ps aux | grep '[C]ode' | grep -oP '(?<=--folder-uri=)\\S+' 2>/dev/null || ps aux | grep '[C]ode' | perl -nle 'print $1 if /--folder-uri=(\\S+)/' 2>/dev/null";
    }
    const output = execSync(cmd, { encoding: "utf-8", timeout: 3000 });

    // Parse folder URIs from output
    let folderUris = [];
    if (IS_WIN) {
      folderUris = output.match(/--folder-uri[= ]file:\/\/\/([^\s"]+)/g) || [];
    } else {
      // On Unix, the grep/perl output gives us the raw URIs line by line
      const lines = output.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const uri = line.replace(/^--folder-uri=/, "").trim();
        if (uri.startsWith("file://")) {
          folderUris.push(uri);
        } else if (uri.startsWith("/")) {
          // Already a path
          folderUris.push("file://" + uri);
        }
      }
    }

    for (const raw of folderUris) {
      const cleaned = raw
        .replace(/--folder-uri[= ]/, "")
        .replace(/^file:\/\//, "")     // Unix: file:///path → /path
        .replace(/^\/([A-Z]:)/, "$1"); // Windows: /C: → C:
      const folderPath = decodeURIComponent(cleaned);
      if (fs.existsSync(folderPath) && isProjectDir(folderPath)) {
        projects.push({
          name: path.basename(folderPath),
          path: folderPath,
          source: "vscode-running",
        });
      }
    }
  } catch { /* process scan failed */ }

  // Strategy 3b: JetBrains IDEs (IntelliJ, PyCharm, WebStorm, etc.)
  try {
    const jetbrainsConfigDirs = [];
    if (IS_WIN) {
      const appData = path.join(os.homedir(), "AppData", "Roaming", "JetBrains");
      if (fs.existsSync(appData)) jetbrainsConfigDirs.push(appData);
    } else if (IS_MAC) {
      const libDir = path.join(os.homedir(), "Library", "Application Support", "JetBrains");
      if (fs.existsSync(libDir)) jetbrainsConfigDirs.push(libDir);
    } else {
      const configDir = path.join(os.homedir(), ".config", "JetBrains");
      if (fs.existsSync(configDir)) jetbrainsConfigDirs.push(configDir);
    }

    for (const jbDir of jetbrainsConfigDirs) {
      try {
        // Each IDE version has its own folder (e.g., IntelliJIdea2024.1)
        const ideVersions = fs.readdirSync(jbDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        for (const ideVer of ideVersions) {
          const recentPath = path.join(jbDir, ideVer, "options", "recentProjects.xml");
          if (!fs.existsSync(recentPath)) continue;
          try {
            const xml = fs.readFileSync(recentPath, "utf-8");
            // Extract project paths from the XML — they appear as key="$USER_HOME$/path" or key="/absolute/path"
            const pathMatches = xml.match(/key="([^"]+)"/g) || [];
            for (const raw of pathMatches.slice(0, 10)) {
              let projPath = raw.replace('key="', "").replace('"', "")
                .replace("$USER_HOME$", os.homedir());
              if (IS_WIN) projPath = projPath.replace(/\//g, path.sep);
              if (fs.existsSync(projPath) && isProjectDir(projPath)) {
                const ideName = ideVer.replace(/\d{4}\.\d.*/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
                if (!projects.some((p) => p.path === projPath)) {
                  projects.push({
                    name: path.basename(projPath),
                    path: projPath,
                    source: `jetbrains`,
                  });
                }
              }
            }
          } catch { /* skip unreadable xml */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* JetBrains detection failed */ }

  // Strategy 3c: Xcode (macOS only) — check DerivedData and recent workspaces
  if (IS_MAC) {
    try {
      // Check DerivedData for recently built projects
      const derivedData = path.join(os.homedir(), "Library", "Developer", "Xcode", "DerivedData");
      if (fs.existsSync(derivedData)) {
        const entries = fs.readdirSync(derivedData, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "ModuleCache") continue;
          // DerivedData folders are named ProjectName-hashstring
          const infoPath = path.join(derivedData, entry.name, "info.plist");
          if (fs.existsSync(infoPath)) {
            try {
              const plist = fs.readFileSync(infoPath, "utf-8");
              const wsMatch = plist.match(/<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/);
              if (wsMatch) {
                const wsPath = wsMatch[1];
                const projDir = path.dirname(wsPath);
                if (fs.existsSync(projDir) && !projects.some((p) => p.path === projDir)) {
                  projects.push({
                    name: path.basename(projDir),
                    path: projDir,
                    source: "xcode",
                  });
                }
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* Xcode detection failed */ }
  }

  // Strategy 3d: Visual Studio (Windows only)
  if (IS_WIN) {
    try {
      // Check VS recent projects from Start Page data
      const vsBaseDirs = [
        path.join(os.homedir(), "AppData", "Local", "Microsoft", "VisualStudio"),
        path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "VisualStudio"),
      ];
      for (const vsBase of vsBaseDirs) {
        if (!fs.existsSync(vsBase)) continue;
        const versions = fs.readdirSync(vsBase, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
        for (const ver of versions) {
          // ApplicationPrivateSettings.xml contains recent projects
          const settingsPath = path.join(vsBase, ver, "ApplicationPrivateSettings.xml");
          if (!fs.existsSync(settingsPath)) continue;
          try {
            const xml = fs.readFileSync(settingsPath, "utf-8");
            // Extract solution paths
            const slnMatches = xml.match(/[A-Z]:\\[^<"]+\.sln/gi) || [];
            for (const slnPath of slnMatches.slice(0, 10)) {
              const projDir = path.dirname(slnPath);
              if (fs.existsSync(projDir) && !projects.some((p) => p.path === projDir)) {
                projects.push({
                  name: path.basename(projDir),
                  path: projDir,
                  source: "visualstudio",
                });
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* Visual Studio detection failed */ }
  }

  // Strategy 4: Scan common dev directories
  const devDirs = [
    path.join(os.homedir(), "Projects"),
    path.join(os.homedir(), "projects"),
    path.join(os.homedir(), "dev"),
    path.join(os.homedir(), "Development"),
    path.join(os.homedir(), "src"),
    path.join(os.homedir(), "repos"),
    path.join(os.homedir(), "code"),
    path.join(os.homedir(), "workspace"),
    path.join(os.homedir(), "Documents", "Projects"),
    path.join(os.homedir(), "Documents", "GitHub"),
  ];

  for (const devDir of devDirs) {
    try {
      if (!fs.existsSync(devDir)) continue;
      const entries = fs.readdirSync(devDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const fullPath = path.join(devDir, entry.name);
        if (isProjectDir(fullPath)) {
          // Avoid duplicates
          if (!projects.some((p) => p.path === fullPath)) {
            projects.push({
              name: entry.name,
              path: fullPath,
              source: "scan",
            });
          }
        }
      }
    } catch { /* skip inaccessible dir */ }
  }

  // Deduplicate by path
  const seen = new Set();
  return projects.filter((p) => {
    if (seen.has(p.path)) return false;
    seen.add(p.path);
    return true;
  });
}

// ── Git Checkpointing ──────────────────────────────────────────────
function gitCheckpoint(projectPath, message) {
  const result = { success: false, message: "", details: {} };

  try {
    // Verify it's a git repo
    execSync("git rev-parse --is-inside-work-tree", { cwd: projectPath, encoding: "utf-8", timeout: 5000 });
  } catch {
    result.message = "Not a git repository";
    return result;
  }

  try {
    // Get current branch
    const branch = execSync("git branch --show-current", {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    // Check for uncommitted changes
    const status = execSync("git status --porcelain", {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    if (!status) {
      result.message = "No changes to checkpoint";
      result.details = { branch, changedFiles: 0 };
      return result;
    }

    const changedFiles = status.split("\n").length;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const checkpointMsg = message || `wotch-checkpoint-${timestamp}`;

    // Stage all changes
    execSync("git add -A", { cwd: projectPath, timeout: 5000 });

    // Create checkpoint commit
    execFileSync("git", ["commit", "-m", checkpointMsg], {
      cwd: projectPath, encoding: "utf-8", timeout: 10000,
    });

    // Get the short hash
    const hash = execSync("git rev-parse --short HEAD", {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    result.success = true;
    result.message = `Checkpoint created: ${hash}`;
    result.details = { branch, hash, changedFiles, commitMessage: checkpointMsg };
    return result;
  } catch (err) {
    result.message = `Checkpoint failed: ${err.message}`;
    return result;
  }
}

function gitGetStatus(projectPath) {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: projectPath, encoding: "utf-8", timeout: 5000 });
  } catch {
    return null;
  }

  try {
    const branch = execSync("git branch --show-current", {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    const status = execSync("git status --porcelain", {
      cwd: projectPath, encoding: "utf-8", timeout: 5000,
    }).trim();

    const changedFiles = status ? status.split("\n").length : 0;

    let lastCommit = "";
    try {
      lastCommit = execSync('git log -1 --format="%h %s"', {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"], // suppress stderr
      }).trim();
    } catch { /* no commits yet */ }

    // Count wotch checkpoints
    let checkpointCount = 0;
    try {
      const cpLog = execSync('git log --oneline --grep="wotch-checkpoint"', {
        cwd: projectPath, encoding: "utf-8", timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      checkpointCount = cpLog ? cpLog.split("\n").length : 0;
    } catch { /* ignore */ }

    return { branch, changedFiles, lastCommit, checkpointCount };
  } catch {
    return null;
  }
}

// ── IPC handlers ────────────────────────────────────────────────────
ipcMain.handle("pty-create", (_event, { tabId, cwd }) => {
  return createPty(tabId, cwd);
});

ipcMain.on("pty-write", (_event, { tabId, data }) => {
  const p = ptyProcesses.get(tabId);
  if (p) p.write(data);
});

ipcMain.on("pty-resize", (_event, { tabId, cols, rows }) => {
  const p = ptyProcesses.get(tabId);
  if (p) p.resize(cols, rows);
});

ipcMain.on("pty-kill", (_event, { tabId }) => {
  const p = ptyProcesses.get(tabId);
  if (p) p.kill();
  ptyProcesses.delete(tabId);
});

ipcMain.handle("get-cwd", () => os.homedir());

// Project detection
ipcMain.handle("detect-projects", () => {
  return detectProjects();
});

// Git checkpoint
ipcMain.handle("git-checkpoint", (_event, { projectPath, message }) => {
  return gitCheckpoint(projectPath, message);
});

// Git status
ipcMain.handle("git-status", (_event, { projectPath }) => {
  return gitGetStatus(projectPath);
});

// Platform info for the renderer
ipcMain.handle("get-platform-info", () => ({
  platform: os.platform(),
  isMac: IS_MAC,
  isWayland: WAYLAND,
  waylandCursorBroken,
  hasNotch: HAS_NOTCH,
}));

// Settings
ipcMain.handle("get-settings", () => ({ ...settings }));

ipcMain.handle("save-settings", (_event, newSettings) => {
  const prev = { ...settings };
  Object.assign(settings, newSettings);
  const ok = saveSettings(settings);

  const positionChanged = prev.position !== settings.position;

  // If position changed, reposition the window and notify renderer
  if (positionChanged && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
    mainWindow.webContents.send("position-changed", settings.position || "top");
  }
  // If dimensions changed and we're expanded, re-apply bounds
  else if (isExpanded && mainWindow && (
    prev.expandedWidth !== settings.expandedWidth ||
    prev.expandedHeight !== settings.expandedHeight
  )) {
    mainWindow.setBounds(getExpandedBounds(), true);
  }

  return ok;
});

ipcMain.handle("reset-settings", () => {
  settings = { ...DEFAULT_SETTINGS };
  saveSettings(settings);
  isPinned = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
    mainWindow.webContents.send("pin-state", false);
    mainWindow.webContents.send("position-changed", settings.position || "top");
  }
  return { ...settings };
});

// Pin mode
ipcMain.handle("set-pinned", (_event, pinned) => {
  setPinned(pinned);
  return isPinned;
});

ipcMain.handle("get-pinned", () => isPinned);

// Git diff
ipcMain.handle("git-diff", (_event, { projectPath, mode }) => {
  try {
    const cmd = mode === "last-checkpoint" ? "git diff HEAD~1" : "git diff";
    const output = execSync(cmd, {
      cwd: projectPath, encoding: "utf-8", timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return { success: true, diff: output || "(no changes)" };
  } catch (err) {
    return { success: false, diff: err.message };
  }
});

// Display management
ipcMain.handle("get-displays", () => {
  return screen.getAllDisplays().map((d, i) => ({
    index: i,
    label: `Display ${i + 1}`,
    width: d.bounds.width,
    height: d.bounds.height,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
});

// Window resize (from drag handle)
ipcMain.on("resize-window", (_event, size) => {
  if (!mainWindow || !isExpanded) return;
  const pos = settings.position || "top";
  if (pos === "left" || pos === "right") {
    // For side positions, drag handle adjusts width
    const clamped = Math.max(400, Math.min(1200, size));
    settings.expandedWidth = clamped;
  } else {
    const clamped = Math.max(200, Math.min(900, size));
    settings.expandedHeight = clamped;
  }
  const bounds = getExpandedBounds();
  mainWindow.setBounds(bounds, false);
  saveSettings(settings);
});

// ── Electron CLI flags for Wayland support ─────────────────────────
// Enable Ozone so Electron can run natively on Wayland when available.
// This must be called before app.whenReady().
if (IS_LINUX) {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch("enable-features", "UseOzonePlatform,WaylandWindowDecorations");
}

// ── App lifecycle ───────────────────────────────────────────────────
const HOTKEY_LABEL = IS_MAC ? "⌘+`" : "Ctrl+`";

app.whenReady().then(() => {
  // Detect macOS notch (needs screen API, only available after app ready)
  HAS_NOTCH = detectMacNotch();
  if (IS_MAC) {
    console.log(`[wotch] macOS: ${HAS_NOTCH ? "notch detected — pill sits in notch area" : "no notch — pill below menu bar"}`);
  }

  createWindow();

  // If settings say start expanded or pinned, expand immediately
  if (settings.startExpanded || isPinned) {
    setTimeout(() => expand(), 300);
  }

  // Global hotkey: Ctrl/Cmd + ` (backtick)
  globalShortcut.register("CommandOrControl+`", toggle);

  // System tray
  const trayIcon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOklEQVQ4y2P4z8DwHwMNMDAwMIxqIE0DI7kGMJFrABM+l4xqGBYaWMh1AQu5BrCQawALBYkUGwB1AACvQBJP3QAAAABJRU5ErkJggg=="
  );

  tray = new Tray(trayIcon);
  tray.setToolTip("Wotch");

  const platformLabel = IS_WIN ? "Windows" : IS_MAC ? `macOS${HAS_NOTCH ? " (notch)" : ""}` : `Linux${WAYLAND ? " (Wayland)" : ""}`;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Toggle (${HOTKEY_LABEL})`, click: toggle },
      { type: "separator" },
      {
        label: `Platform: ${platformLabel}`,
        enabled: false,
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );

  tray.on("click", toggle);

  if (WAYLAND) {
    console.log("[wotch] Running on Wayland — hover-to-reveal may be limited, use Ctrl+` to toggle");
  }

  // Fall back to primary display if current display is disconnected
  screen.on("display-removed", () => {
    const displays = screen.getAllDisplays();
    if (settings.displayIndex >= displays.length) {
      settings.displayIndex = 0;
      saveSettings(settings);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBounds(isExpanded ? getExpandedBounds() : getPillBounds(), true);
      }
    }
  });

  // ── Auto-update (only in packaged builds) ──
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.logger = null;
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;

      autoUpdater.on("update-available", (info) => {
        console.log(`[wotch] Update available: v${info.version}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("update-available", info.version);
        }
      });

      autoUpdater.on("update-downloaded", (info) => {
        console.log(`[wotch] Update downloaded: v${info.version}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("update-downloaded", info.version);
        }
      });

      autoUpdater.on("error", (err) => {
        console.log("[wotch] Auto-update error:", err.message);
      });

      setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }, 10000);
    } catch (err) {
      console.log("[wotch] Auto-update not available:", err.message);
    }
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  for (const [, p] of ptyProcesses) p.kill();
  ptyProcesses.clear();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
