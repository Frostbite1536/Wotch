# Wotch

A cross-platform floating terminal for Claude Code — **the notch, for those without**. Inspired by [Notchy for macOS](https://github.com/adamlyttleapps/notchy). A small pill lives at the top-center of your screen — hover over it or press `Ctrl+`` ` (`⌘+`` ` on Mac) to reveal a full terminal panel.

Works on Windows, macOS (with or without a notch), and Linux (X11 and Wayland).

![concept](https://img.shields.io/badge/status-prototype-blueviolet)

## Features

- **Notch-style pill** — small indicator at the top-center of your screen
- **Hover to reveal** — mouse over the pill to expand the terminal panel
- **Global hotkey** — `Ctrl+`` ` (or `⌘+`` ` on Mac) toggles the panel from anywhere
- **Multi-tab terminals** — run multiple shell sessions side by side, with per-tab status dots
- **Real terminal** — full PowerShell/bash/zsh via node-pty + xterm.js
- **Terminal search** — `Ctrl+F` to search terminal scrollback
- **Command palette** — `Ctrl+Shift+P` for quick access to all commands
- **Themes** — dark, light, purple, and green presets
- **Project detection** — auto-discovers VS Code, JetBrains, Xcode, Visual Studio projects and common dev dirs
- **Git checkpoints** — `Ctrl+S` / `⌘S` snapshots your project before Claude makes changes
- **Checkpoint diff viewer** — see what changed since the last checkpoint
- **Live git status** — shows branch, changed files, and checkpoint count
- **Claude finish notification** — system notification when Claude is done (while Wotch is in background)
- **Auto-launch Claude** — optionally type `claude` in every new tab
- **Drag to resize** — drag the bottom edge to resize the panel
- **Multiple monitor support** — choose which display to show the pill on
- **macOS notch detection** — positions in the notch area on notch Macs, below the menu bar on others
- **Always on top** — stays above all other windows
- **Auto-update** — checks GitHub Releases for new versions
- **System tray** — right-click tray icon to toggle or quit

## Requirements

- Windows 10/11, macOS 10.15+, or Linux (X11 or Wayland)
- Node.js 18+
- Build tools for native module compilation (see setup below)

## Setup

### 1. Install build tools (one-time, for node-pty native compilation)

**Windows:**
```bash
npm install -g windows-build-tools
```
Or install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) manually.

**Ubuntu / Debian:**
```bash
sudo apt install build-essential python3 libx11-dev libxkbfile-dev
```

**Fedora:**
```bash
sudo dnf install gcc-c++ make python3 libX11-devel libxkbfile-devel
```

**Arch Linux:**
```bash
sudo pacman -S base-devel python libx11 libxkbfile
```

**macOS:**
```bash
xcode-select --install
```

### 2. Install dependencies

```bash
cd wotch
npm install
```

### 3. Rebuild native modules for Electron

```bash
npm run rebuild
```

### 4. Run

```bash
npm start
```

## Usage

| Shortcut | macOS | Action |
|----------|-------|--------|
| `Ctrl+`` ` | `⌘+`` ` | Toggle panel |
| `Ctrl+S` | `⌘S` | Git checkpoint |
| `Ctrl+T` | `⌘T` | New tab |
| `Ctrl+W` | `⌘W` | Close tab |
| `Ctrl+F` | `⌘F` | Search terminal |
| `Ctrl+Shift+P` | `⌘Shift+P` | Command palette |
| `Ctrl+P` | `⌘P` | Pin / unpin panel |
| `Escape` | same | Close overlay / settings |
| Hover top-center | same | Expand panel |
| Move mouse away | same | Collapse (unless pinned) |

## Building a distributable

```bash
npm run dist
```

This creates an installer in the `dist/` folder using electron-builder.

## Project Structure

```
wotch/
├── src/
│   ├── main.js          # Electron main process (window, PTY, hotkey, status, git, updater)
│   ├── preload.js       # Secure IPC bridge (contextBridge, 24 methods)
│   ├── renderer.js      # Renderer JS (tabs, themes, search, palette, diff, resize)
│   └── index.html       # Renderer HTML/CSS (pill, panel, overlays, settings)
├── assets/
│   └── icon.png         # App icon (used by electron-builder for all platforms)
├── docs/
│   ├── ARCHITECTURE.md  # Component diagram, data flow, design decisions
│   ├── INVARIANTS.md    # Non-negotiable rules (security, data, UX, platform)
│   ├── ROADMAP.md       # Phased plan with status and future ideas
│   ├── THREAT_MODEL.md  # STRIDE analysis, attack surface, mitigations
│   └── DECISIONS.md     # Architectural decision log
├── prompts/
│   └── engineering.md   # Default coding prompt for AI-assisted development
├── .github/
│   └── workflows/
│       └── build.yml    # GitHub Actions: build .exe/.dmg/.AppImage on version tag
├── CHECKLIST.md         # Pre-merge checklist
├── package.json
├── .gitignore
└── README.md
```

## How it works

```
┌─────────────────────────────────────────────┐
│              Screen top edge                │
│         ┌──────────────────┐                │
│         │   ● claude  ▾   │  ← pill        │
│         └──────────────────┘                │
│                                             │
│   On hover / Ctrl+` :                       │
│         ┌──────────────────────────┐        │
│         │ Session 1 │ Session 2  + │        │
│         ├──────────────────────────┤        │
│         │ $ claude "fix the bug"   │        │
│         │ ● Reading auth.ts...     │        │
│         │ ✓ Fixed!                 │        │
│         │ $                        │        │
│         ├──────────────────────────┤        │
│         │ Ctrl+`  Ctrl+T  Ctrl+W  │        │
│         └──────────────────────────┘        │
│                                             │
└─────────────────────────────────────────────┘
```

### Architecture

- **main.js** — Electron main process: frameless always-on-top window, mouse polling for hover detection, global hotkey, PTY process management, Claude Code status detection, project scanning, git operations
- **preload.js** — secure IPC bridge between main and renderer
- **index.html** — renderer with xterm.js terminals, tab management, project picker, git status bar, live status display, and the notch UI

## Live Claude Code Status

Wotch monitors terminal output in real-time to detect what Claude Code is doing and reflects it in the pill and status badge:

| State | Pill dot | Description |
|-------|---------|-------------|
| **Idle** | 🟢 solid green | `claude` (default label) |
| **Thinking** | 🟣 pulsing purple | `Thinking...` |
| **Working** | 🔵 pulsing blue | `Editing auth.ts`, `Working on 3 files` |
| **Waiting** | 🟡 slow pulse yellow | `Needs input` |
| **Done** | 🟢 bright green | `Done` |
| **Error** | 🔴 solid red | Error description |

The detector works by parsing ANSI-stripped terminal output against Claude Code patterns — spinner characters, file operations, prompts, success/error indicators. It maintains state per tab and shows the most active tab's status in the pill.

Idle timeout: if no output for 5 seconds while thinking/working, auto-transitions to idle. Done/error states clear after 8-10 seconds.

## Project Detection

Wotch automatically finds your projects using multiple strategies:

1. **Running VS Code instances** — detects folders open in active VS Code windows
2. **VS Code recent workspaces** — reads storage.json for recently opened projects (includes Code-OSS, VSCodium, Flatpak, Snap)
3. **JetBrains IDEs** — reads recentProjects.xml from IntelliJ, PyCharm, WebStorm, GoLand, etc.
4. **Xcode** (macOS) — checks DerivedData for recently built projects
5. **Visual Studio** (Windows) — reads ApplicationPrivateSettings.xml for recent solutions
6. **Common dev directories** — scans `~/Projects`, `~/dev`, `~/src`, `~/repos`, `~/code`, `~/workspace`, `~/Documents/Projects`, `~/Documents/GitHub`

Projects are identified by the presence of markers like `.git`, `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `*.sln`, `pom.xml`, `Makefile`, `Dockerfile`, etc.

When you select a project, new terminal tabs auto-cd into it and the tab name reflects the project.

## Git Checkpoints

Press `Ctrl+S` (or click the 📸 button) to create a checkpoint — a git commit that snapshots the current state of your project. This is useful before letting Claude Code make changes so you can easily roll back.

Checkpoints are named `wotch-checkpoint-YYYY-MM-DDTHH-MM-SS` and the git status bar shows how many you've created. To undo Claude's changes:

```bash
git log --oneline          # find your checkpoint hash
git reset --hard <hash>    # reset to that checkpoint
```

## Pin Mode

Click the 📌 button (or press `Ctrl+P` / `⌘P`) to pin the panel open. When pinned, the panel won't collapse when your mouse leaves — it stays visible until you either unpin it or toggle it with the hotkey. Useful when you want to keep an eye on Claude while working in another window.

The "Remember pin state" toggle in settings persists the pin across restarts.

## Settings

Click the ⚙ gear in the bottom-right corner to open the settings panel. All changes save automatically to `~/.wotch/settings.json`.

**Panel Dimensions:** expanded width/height, pill width — resize the panel to your liking.

**Behavior:** collapse delay (how long before the panel closes on mouse leave), hover padding (how far from the pill the hover zone extends), start expanded (open panel on launch), remember pin state (persist pin across restarts).

**Shell:** override the default shell (leave empty for auto-detect: PowerShell on Windows, zsh on macOS, bash on Linux).

To reset everything: click "Reset to defaults" at the bottom of the settings panel, or delete `~/.wotch/settings.json`.

## macOS Notes

Wotch works on both notch and non-notch Macs. It auto-detects which you have.

**MacBooks with a notch (2021+ MacBook Pro 14"/16", 2022+ MacBook Air):**
The pill positions at `y: 0`, sitting directly in the notch area — just like the original Notchy app. Hover-to-reveal works perfectly since the notch area is "dead space" that the system doesn't use for the menu bar title.

**Macs without a notch (older MacBooks, iMac, Mac Mini, Mac Pro with external displays):**
The pill positions just below the menu bar. Wotch detects the menu bar height from `display.workArea.y` and offsets accordingly. You can still trigger hover-to-reveal by pushing the cursor to the top of the screen — the hover zone extends up to the menu bar edge.

**Detection method:**
Notch detection uses two signals: menu bar height (notch Macs report ~37px vs ~25px for non-notch) and known display resolutions for notch models. This runs once at startup.

**Keyboard shortcuts:**
All shortcuts show `⌘` instead of `Ctrl` on macOS (e.g., `⌘+`` `, `⌘S`, `⌘T`, `⌘W`).

## Linux & Wayland Notes

Wotch runs on both X11 and Wayland. Here's what to know:

**X11 (GNOME on Xorg, KDE X11, i3, etc.):**
Everything works out of the box — hover-to-reveal, always-on-top, global hotkey, system tray.

**Wayland (GNOME on Wayland, Sway, Hyprland, etc.):**
- **Hover-to-reveal may not work.** Wayland doesn't expose global cursor position to apps for security. Wotch auto-detects this and falls back to hotkey-only mode (`Ctrl+\``).
- **Always-on-top** uses the `"floating"` level which works with most compositors. Some tiling WMs may need manual rules.
- **Global hotkey** works via Electron's shortcut registration, which goes through the compositor's key grab support. If `Ctrl+\`` doesn't work on your compositor, set a custom shortcut via your WM config.
- **System tray** requires a tray implementation (most DEs have one; Sway users may need `waybar` with tray support).
- Electron uses the Ozone platform layer with `--ozone-platform-hint=auto` for native Wayland rendering (no XWayland fallback needed).

**Window manager tips:**
- *Sway/Hyprland*: You may want to add a rule to float the Wotch window and pin it. Example for Sway:
  ```
  for_window [app_id="wotch"] floating enable, sticky enable, border none
  ```
- *GNOME*: Works without extra config. The dock window type keeps it above other windows.
- *KDE*: Works without extra config on both X11 and Wayland.

**VS Code detection on Linux:**
Wotch checks for VS Code, Code-OSS, and VSCodium config paths, including Flatpak and Snap installs.

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — Components, data flow, design decisions, dependency rationale
- **[Invariants](docs/INVARIANTS.md)** — Non-negotiable rules for security, data integrity, UX, and cross-platform behavior
- **[Roadmap](docs/ROADMAP.md)** — Phased plan with current status and future ideas
- **[Threat Model](docs/THREAT_MODEL.md)** — STRIDE analysis, attack surface, trust boundaries, mitigations
- **[Decisions](docs/DECISIONS.md)** — Architectural decision log with context and trade-offs
- **[Checklist](CHECKLIST.md)** — Pre-merge checklist for code review
- **[Engineering Prompt](prompts/engineering.md)** — Default prompt for AI-assisted development on this project

## Contributing

Before making changes, read:
1. `docs/ARCHITECTURE.md` to understand how the pieces fit together
2. `docs/INVARIANTS.md` to know what rules cannot be broken
3. `CHECKLIST.md` before submitting a PR

## License

MIT
