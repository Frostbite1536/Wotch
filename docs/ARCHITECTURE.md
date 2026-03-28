# Architecture

## Overview

Wotch is an Electron desktop app that provides a floating, notch-style terminal overlay. It runs a frameless, always-on-top window positioned at the top-center of the screen. The window exists in two states: a small "pill" indicator and an expanded terminal panel. Users interact via hover-to-reveal, a global hotkey, or the system tray.

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
│                  (index.html)                        │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Pill UI  │  │ Tab Mgr  │  │ Settings Panel    │  │
│  │          │  │          │  │                   │  │
│  │ - dot    │  │ - create │  │ - dimensions      │  │
│  │ - label  │  │ - switch │  │ - behavior        │  │
│  │ - badge  │  │ - close  │  │ - shell           │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ xterm.js │  │ Project  │  │ Git Status Bar    │  │
│  │ Terminal │  │ Picker   │  │                   │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Components

### Main Process (`src/main.js`)

| Component | Responsibility |
|-----------|---------------|
| **Window Manager** | Creates frameless, transparent BrowserWindow. Manages pill/expanded states, position calculations, always-on-top behavior. Handles platform-specific window types (dock on Linux). |
| **Mouse Tracker** | Polls `screen.getCursorScreenPoint()` at configurable intervals. Detects hover-to-reveal zone. Handles Wayland fallback (hotkey-only mode when cursor position is unavailable). |
| **PTY Manager** | Spawns `node-pty` processes per tab. Routes data between PTY and renderer via IPC. Auto-detects shell (PowerShell/zsh/bash) per platform. |
| **Claude Status Detector** | Class that parses ANSI-stripped terminal output against regex patterns to detect Claude Code's state (idle/thinking/working/waiting/done/error). Maintains per-tab state with idle timeouts. |
| **Project Detection** | Discovers projects from VS Code, JetBrains, Xcode, Visual Studio configs and common dev directories. Identifies projects by marker files (.git, package.json, Cargo.toml, etc.). |
| **Git Operations** | Creates checkpoint commits (`wotch-checkpoint-*`) and reads git status (branch, changed files, checkpoint count). |
| **Settings Manager** | Reads/writes `~/.wotch/settings.json`. Merges with defaults on load. |
| **System Tray** | Provides toggle/quit menu. Uses platform-appropriate tray icon. |
| **macOS Notch Detection** | Detects notch via menu bar height threshold (>30px) and known notch display resolutions. Adjusts window Y position accordingly. |

### Preload Script (`src/preload.js`)

Secure IPC bridge using `contextBridge.exposeInMainWorld`. Exposes the `window.wotch` API with:
- PTY operations (create, write, resize, kill, onData, onExit)
- Expansion and pin state callbacks
- Claude status updates
- Project detection and git operations
- Settings CRUD
- Platform info

### Renderer (`src/index.html`)

Single-page app with inline CSS and JS. Contains:
- **Pill UI**: Status dot (color-coded by Claude state), label, dropdown arrow
- **Tab bar**: Create/switch/close terminal tabs, project name display
- **xterm.js terminals**: Full terminal emulation with fit and web-links addons
- **Project picker**: Dropdown of detected projects, sets CWD for new tabs
- **Git status bar**: Branch name, changed file count, checkpoint count, checkpoint button
- **Settings panel**: Sliders and inputs for all configurable options

## Data Flow

```
User hovers pill → Mouse poller detects → expand() → setBounds() → send "expansion-state" to renderer
User types in terminal → xterm.js onData → IPC "pty-write" → node-pty.write()
PTY output → node-pty onData → IPC "pty-data" → xterm.js write() + ClaudeStatusDetector.feed()
Claude status change → broadcast() → IPC "claude-status" → renderer updates pill dot/label
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
| `@xterm/addon-web-links` | Clickable links | Makes URLs in terminal output clickable |

## Key Design Decisions

1. **Frameless transparent window** — Required for the pill/notch visual effect. Uses `transparent: true` and `frame: false` with CSS-driven UI.

2. **Mouse polling instead of mouse events** — The window needs to detect hover *outside* its bounds (the hover padding zone). DOM mouse events only fire within the window, so we poll `screen.getCursorScreenPoint()`.

3. **Single window, two states** — Rather than two separate windows, we resize one window between pill and expanded bounds. This avoids focus-stealing issues and Z-order complexity.

4. **Inline renderer code** — All renderer HTML/CSS/JS lives in a single `index.html`. For a UI of this size, this avoids build tooling complexity while keeping everything in one place.

5. **node-pty over child_process** — `child_process.spawn` doesn't give a real TTY, which means no color codes, no readline, no full-screen TUI support. `node-pty` provides a proper pseudoterminal.

6. **Wayland graceful degradation** — When Wayland blocks cursor position, Wotch falls back to hotkey-only mode rather than crashing or showing broken behavior.

## Security Considerations

- **Context isolation enabled** — `contextIsolation: true` and `nodeIntegration: false` in webPreferences. The renderer cannot access Node.js APIs directly.
- **Preload bridge** — Only specific IPC channels are exposed via `contextBridge`. No arbitrary IPC.
- **No remote content** — The app loads only local files (`loadFile`), never remote URLs.
- **Shell execution** — PTY spawns the user's configured shell. Git operations use `execSync` with fixed command templates (no user-controlled interpolation in commands).
- **Settings file** — Stored in user home directory with standard file permissions. No secrets stored.

## Performance Considerations

- **Mouse polling interval** — Configurable (default 100ms). Lower = more responsive hover, higher CPU. Disabled entirely on Wayland when cursor position is unavailable.
- **Terminal buffer** — Claude status detector keeps a rolling 2000-char buffer per tab to avoid unbounded memory growth.
- **Idle timeouts** — Status detector auto-transitions to idle after 5s of inactivity, preventing stale state display.
- **PTY cleanup** — Processes are killed and removed from the map on tab close or window destroy.
