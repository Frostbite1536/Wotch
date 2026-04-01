# Architecture

## Overview

Wotch is an Electron desktop app that provides a floating, notch-style terminal overlay. It runs a frameless, always-on-top window that can be positioned at the top (default), left, or right edge of the screen. The window exists in two states: a small "pill" indicator and an expanded terminal panel. Users interact via hover-to-reveal, a global hotkey, or the system tray.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Electron Main Process              │
│                       (main.js)                      │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Window   │  │ PTY Mgr  │  │ Claude Status     │  │
│  │ Manager  │  │ (Map)    │  │ Detector          │  │
│  │          │  │          │  │                   │  │
│  │ - pill   │  │ - spawn  │  │ - ANSI parsing    │  │
│  │ - expand │  │ - write  │  │ - pattern match   │  │
│  │ - mouse  │  │ - resize │  │ - state machine   │  │
│  │ - hotkey │  │ - kill   │  │ - idle timeouts   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  ┌──────────┐                                        │
│  │ SSH Mgr  │  Parallel transport to PTY Mgr.        │
│  │ (Map)    │  ssh2 Client → shell channel → same    │
│  │          │  pty-data/pty-write/pty-resize IPC.     │
│  │ - connect│  Host key verify via known_hosts.json.  │
│  │ - auth   │  Profiles stored in settings.           │
│  │ - recon. │                                        │
│  └──────────┘                                        │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │      Claude Integration Manager              │    │
│  │                                              │    │
│  │  ┌─────────────┐  ┌──────────────────────┐  │    │
│  │  │ Hook        │  │ Enhanced Status       │  │    │
│  │  │ Receiver    │  │ Detector              │  │    │
│  │  │ (HTTP:19520)│  │ (hooks > regex)       │  │    │
│  │  └─────────────┘  └──────────────────────┘  │    │
│  │                                              │    │
│  │  ┌─────────────┐  ┌──────────────────────┐  │    │
│  │  │ MCP IPC     │  │ Auto-Config          │  │    │
│  │  │ Server      │  │ (hooks + MCP)        │  │    │
│  │  │ (TCP:19523) │  │                      │  │    │
│  │  └─────────────┘  └──────────────────────┘  │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Settings │  │ Git Ops  │  │ Project           │  │
│  │ (~/.wotch│  │          │  │ Detection         │  │
│  │ /settings│  │ - status │  │                   │  │
│  │  .json)  │  │ - commit │  │ - VS Code         │  │
│  │          │  │          │  │ - JetBrains       │  │
│  └──────────┘  └──────────┘  │ - dev dirs        │  │
│                              └───────────────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │              System Tray                     │    │
│  └──────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────┤
│                  IPC Bridge                          │
│                 (preload.js)                         │
│          contextBridge.exposeInMainWorld             │
├──────────────────────────────────────────────────────┤
│                Renderer Process                      │
│           (index.html + renderer.js)                 │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Pill UI  │  │ Tab Mgr  │  │ Settings Panel    │  │
│  │          │  │          │  │                   │  │
│  │ - dot    │  │ - create │  │ - appearance      │  │
│  │ - label  │  │ - switch │  │ - dimensions      │  │
│  │ - badge  │  │ - close  │  │ - behavior/shell  │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ xterm.js │  │ Project  │  │ Git Status Bar    │  │
│  │ Terminal │  │ Picker   │  │ + Diff Viewer     │  │
│  │ + Search │  │          │  │                   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Themes   │  │ Command  │  │ Drag Resize       │  │
│  │          │  │ Palette  │  │                   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Components

### Main Process (`src/main.js`)

| Component | Responsibility |
|-----------|---------------|
| **Window Manager** | Creates frameless, transparent BrowserWindow. Manages pill/expanded states, position calculations (top/left/right), always-on-top behavior. Uses `display.workArea` for accurate placement that respects taskbars and menu bars. Handles platform-specific window types (dock on Linux). |
| **Mouse Tracker** | Polls `screen.getCursorScreenPoint()` at configurable intervals. Detects hover-to-reveal zone with edge-slam activation (extends detection to the physical display edge for the pill's anchor side). Position-aware: adapts hover zones for top/left/right placement. Handles Wayland fallback (hotkey-only mode when cursor position is unavailable). |
| **PTY Manager** | Spawns `node-pty` processes per tab. Routes data between PTY and renderer via IPC. Auto-detects shell (PowerShell/zsh/bash) per platform. |
| **SSH Manager** | Manages `ssh2` Client connections per tab. Creates shell channels that produce the same byte stream as local PTYs, routed through the same `pty-data`/`pty-write`/`pty-resize` IPC channels. Handles host key verification (`~/.wotch/known_hosts.json`), credential prompting (password/passphrase via renderer dialog), and reconnection (auto for key auth, prompt for password auth). Connection profiles stored in `settings.sshProfiles`. |
| **Claude Status Detector** | Class that parses ANSI-stripped terminal output against regex patterns to detect Claude Code's state (idle/thinking/working/waiting/done/error). Maintains per-tab state with idle timeouts. Feeds into the Enhanced Status Detector as the regex fallback source. |
| **Claude Integration Manager** | Central coordinator for Claude Code deep integration (`src/claude-integration-manager.js`). Manages two channels: Hook Receiver (HTTP server on localhost:19520 receiving structured lifecycle events from Claude Code's `type: http` hooks) and MCP IPC Server (TCP on localhost:19523, used by the standalone MCP server script). Contains the Enhanced Status Detector which fuses hook events (priority 1) with regex fallback (priority 2) for reliable status detection. Handles auto-configuration of `~/.claude/settings.json` (hooks) and `~/.claude.json` (MCP server registration). |
| **MCP Server** | Standalone Node.js script (`src/mcp-server.js`) launched by Claude Code via stdio transport. Exposes 8 tools (checkpoint, git status, git diff, project info, terminal buffer, notify, list tabs, tab status). Connects back to Wotch main process via the MCP IPC TCP server for data access. Registered in `~/.claude.json` with `"type": "stdio"`. |
| **Project Detection** | Discovers projects from VS Code, JetBrains, Xcode, Visual Studio configs and common dev directories. Identifies projects by marker files (.git, package.json, Cargo.toml, etc.). |
| **Git Operations** | Creates checkpoint commits (`wotch-checkpoint-*`), reads git status (branch, changed files, checkpoint count), and generates diffs for the diff viewer. Uses `execFileSync` for commit messages (injection-safe). |
| **Settings Manager** | Reads/writes `~/.wotch/settings.json`. Merges with defaults on load. Settings include theme, display index, position (top/left/right), auto-launch, and all UI dimensions. |
| **System Tray** | Provides toggle/quit menu. Uses platform-appropriate tray icon. |
| **macOS Notch Detection** | Detects notch via menu bar height threshold (>30px) and known notch display resolutions. Adjusts window Y position accordingly. |
| **Auto-Updater** | Checks GitHub Releases for updates via `electron-updater`. Downloads and installs on quit. Only active in packaged builds. |
| **Notification Manager** | Fires Electron `Notification` when Claude transitions from thinking/working to done/error while the window is unfocused. Checks `Notification.isSupported()`. |
| **Display Manager** | Supports multi-monitor via `getTargetDisplay()` helper. Falls back to primary display on disconnect. Configurable via `displayIndex` setting. |

### Preload Script (`src/preload.js`)

Secure IPC bridge using `contextBridge.exposeInMainWorld`. Exposes the `window.wotch` API with:
- PTY operations (create, write, resize, kill, onData, onExit)
- SSH operations (connect, credential response, host key verify, profile CRUD, key file browse)
- Expansion and pin state callbacks
- Position change notifications
- Claude status updates
- Project detection and git operations (checkpoint, status, diff)
- Settings CRUD
- Platform info
- Auto-update notifications
- Display management
- Window resize
- Integration status (hooks/MCP health), hook reconfiguration, MCP re-registration
- Terminal buffer read/response (for MCP server terminal buffer access)

### Renderer (`src/index.html` + `src/renderer.js`)

HTML/CSS in `index.html`, all JS logic in `renderer.js`. xterm.js UMD modules loaded via `<script>` tags. Contains:
- **Pill UI**: Status dot (color-coded by Claude state), label, dropdown arrow
- **Tab bar**: Create/switch/close/reorder terminal tabs with per-tab status dots (drag-to-reorder). Keyboard: Ctrl+Tab (next), Ctrl+Shift+Tab (prev), Ctrl+1-9 (jump)
- **Split panes**: Each tab contains a tree of panes (`SplitNode` model). Split horizontal (Ctrl+Shift+D), vertical (Ctrl+Shift+E), navigate (Alt+Arrow), drag dividers to resize. Data model: `Tab { id, name, rootNode: SplitNode, activePaneId, el }` where `SplitNode` is a tree of `{ type: "leaf", paneId }` and `{ type: "split", direction, children, ratio }` nodes. All panes tracked in global `paneMap` (paneId → `{ term, fitAddon, searchAddon, el, cwd }`). PTY processes keyed by paneId.
- **xterm.js terminals**: Full terminal emulation with fit and search addons. Copy-on-select: auto-copies selection to clipboard. tmux mouse passthrough works natively.
- **Terminal search**: Ctrl+F search overlay with prev/next navigation (operates on active pane)
- **Project picker**: Dropdown of detected projects (VS Code, JetBrains, Xcode, Visual Studio, filesystem scan)
- **Git status bar**: Branch name, changed file count, checkpoint count, checkpoint button, diff viewer button
- **Diff viewer**: Color-coded git diff overlay (green/red/blue syntax)
- **Command palette**: Ctrl+Shift+P fuzzy-filtered command overlay
- **Themes**: Dark, light, purple, green presets via CSS custom property swapping
- **Position handling**: Applies CSS position classes (`position-top`, `position-left`, `position-right`) to `<body>` for layout adaptation
- **Settings panel**: Appearance (theme), dimensions, position (top/left/right), behavior (auto-launch Claude, hover enable/disable), display selector, shell, SSH profiles, Claude Code integration (hooks/MCP/bridge channel toggles), plugin list, agent settings
- **SSH UI**: Profile editor dialog, credential prompt (password/passphrase), host key verification dialog, new-tab menu with SSH profile quick-connect
- **Drag to resize**: Centered resize for top position (grows symmetrically). Side edge handle for width adjustment (left/right positions)
- **Directory persistence**: Tracks cwd via OSC 7 escape sequences, restores tabs with saved directories on restart

## Data Flow

```
User hovers pill edge → Mouse poller detects (position-aware zones) → expand() → setBounds() → send "expansion-state" to renderer
Position changed → save-settings IPC → main repositions window → send "position-changed" → renderer applies CSS class
User types in terminal → xterm.js onData → IPC "pty-write" → node-pty.write() OR ssh2 stream.write()
PTY/SSH output → node-pty onData / ssh2 stream data → IPC "pty-data" → xterm.js write() + ClaudeStatusDetector.feed()
SSH connect → renderer createTab(sshProfile) → IPC "ssh-connect" → ssh2 Client.connect() → shell channel → same pty-data path
Claude status change → broadcast() → feeds regex source → EnhancedStatusDetector resolves → IPC "claude-status" → renderer updates pill dot/label
Claude Code hook → HTTP POST to localhost:19520 → HookReceiver → mapHookToStatus → feeds hooks source → EnhancedStatusDetector resolves (hooks priority > regex)
Claude Code calls MCP tool → stdio to mcp-server.js → TCP to MCP IPC server → main process handler → response
Ctrl+` pressed → globalShortcut → toggle() → expand or collapse
Ctrl+S pressed → renderer → IPC "git-checkpoint" → execSync git commands → return status
```

## External Dependencies

| Dependency | Purpose | Why chosen |
|-----------|---------|------------|
| `electron` | Desktop app framework | Cross-platform window management, system tray, global shortcuts |
| `node-pty` | Pseudoterminal | Real terminal emulation (not just subprocess stdout) |
| `@xterm/xterm` | Terminal UI | Industry-standard terminal renderer for the web |
| `@xterm/addon-fit` | Terminal sizing | Auto-fit terminal to container dimensions |
| `@xterm/addon-search` | Terminal search | Find text in terminal scrollback (Ctrl+F) |
| `@xterm/addon-web-links` | Clickable links | Makes URLs in terminal output clickable |
| `electron-updater` | Auto-update | Checks GitHub Releases and installs updates on quit |
| `ssh2` | SSH client | Pure-JS SSH2 client for remote terminal connections. No native bindings needed. |
| `@modelcontextprotocol/sdk` | MCP server | Model Context Protocol SDK for exposing Wotch tools to Claude Code. Used by standalone `mcp-server.js`. |
| `zod` | Schema validation | Runtime schema validation for MCP tool parameters. Required by MCP SDK. |

## Key Design Decisions

1. **Frameless transparent window** — Required for the pill/notch visual effect. Uses `transparent: true` and `frame: false` with CSS-driven UI.

2. **Mouse polling instead of mouse events** — The window needs to detect hover *outside* its bounds (the hover padding zone). DOM mouse events only fire within the window, so we poll `screen.getCursorScreenPoint()`.

3. **Single window, two states** — Rather than two separate windows, we resize one window between pill and expanded bounds. This avoids focus-stealing issues and Z-order complexity.

4. **Split renderer code** — HTML/CSS in `index.html`, all JS in `renderer.js`. Originally inline, extracted when the file exceeded 1,500 lines after Phase 6 features. No bundler needed — `renderer.js` is loaded as a native ES module via `<script type="module" src="renderer.js">`.

5. **node-pty over child_process** — `child_process.spawn` doesn't give a real TTY, which means no color codes, no readline, no full-screen TUI support. `node-pty` provides a proper pseudoterminal.

6. **Wayland graceful degradation** — When Wayland blocks cursor position, Wotch falls back to hotkey-only mode rather than crashing or showing broken behavior.

7. **Position via CSS class switching** — Left/right positions are implemented by adding `position-left` or `position-right` classes to `<body>`, which override pill/panel border-radius, flex direction, border sides, and resize handle orientation. The main process handles window bounds calculation and the renderer handles visual adaptation, keeping concerns separated.

## Security Considerations

- **Context isolation enabled** — `contextIsolation: true` and `nodeIntegration: false` in webPreferences. The renderer cannot access Node.js APIs directly.
- **Preload bridge** — Only specific IPC channels are exposed via `contextBridge`. No arbitrary IPC.
- **No remote content** — The app loads only local files (`loadFile`), never remote URLs.
- **Shell execution** — PTY spawns the user's configured shell. Git checkpoint uses `execFileSync` with argument arrays (no shell interpolation). Other git operations use `execSync` with fixed command strings.
- **Settings file** — Stored in user home directory with standard file permissions. SSH profiles store only connection metadata (host, port, username, key path) — never passwords or key contents.
- **SSH credential handling** — Passwords and key passphrases are prompted in the renderer, sent via IPC to the main process, used once for `ssh2.Client.connect()`, then discarded. They exist transiently in main process memory during the connection attempt but are never written to disk.
- **SSH host key verification** — First-connect requires explicit user acceptance. Changed keys trigger a warning. Accepted fingerprints stored in `~/.wotch/known_hosts.json`.

## Performance Considerations

- **Mouse polling interval** — Configurable (default 100ms). Lower = more responsive hover, higher CPU. Disabled entirely on Wayland when cursor position is unavailable.
- **Terminal buffer** — Claude status detector keeps a rolling 2000-char buffer per tab to avoid unbounded memory growth.
- **Idle timeouts** — Status detector auto-transitions to idle after 5s of inactivity, preventing stale state display.
- **PTY cleanup** — Processes are killed and removed from the map on tab close or window destroy.
- **SSH cleanup** — SSH clients are ended and channels closed on tab close, reconnect timer cancellation, or app quit. Same invariant as PTY map (INV-DATA-004).
