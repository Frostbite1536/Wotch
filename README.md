# Wotch

A cross-platform floating terminal for Claude Code — **the notch, for those without**. Inspired by [Notchy for macOS](https://github.com/adamlyttleapps/notchy). A small pill lives at the top-center of your screen — hover over it or press `Ctrl+`` ` (`⌘+`` ` on Mac) to reveal a full terminal panel.

Works on Windows, macOS (with or without a notch), and Linux (X11 and Wayland).

![concept](https://img.shields.io/badge/status-prototype-blueviolet)

## Features

- **Notch-style pill** — small indicator at the top, left, or right edge of your screen
- **Hover to reveal** — mouse over the pill to expand the terminal panel
- **Global hotkey** — `Ctrl+`` ` (or `⌘+`` ` on Mac) toggles the panel from anywhere
- **Multi-tab terminals** — run multiple shell sessions with per-tab status dots, drag-to-reorder, `Ctrl+Tab`/`Ctrl+1-9` navigation
- **Split panes** — split any tab horizontally (`Ctrl+Shift+D`) or vertically (`Ctrl+Shift+E`), navigate panes with `Alt+Arrow`, drag dividers to resize
- **Real terminal** — full PowerShell/bash/zsh via node-pty + xterm.js
- **Copy-on-select** — selecting text in the terminal automatically copies to clipboard
- **Terminal search** — `Ctrl+F` to search terminal scrollback
- **Command palette** — `Ctrl+Shift+P` for quick access to all commands
- **Themes** — dark, light, purple, and green presets
- **Project detection** — auto-discovers VS Code, JetBrains, Xcode, Visual Studio projects and common dev dirs
- **Git checkpoints** — `Ctrl+S` / `⌘S` snapshots your project before Claude makes changes
- **Checkpoint diff viewer** — see what changed since the last checkpoint
- **Live git status** — shows branch, changed files, and checkpoint count
- **Directory persistence** — tabs remember their working directory across restarts
- **Claude finish notification** — system notification when Claude is done (while Wotch is in background)
- **Auto-launch Claude** — optionally type `claude` in every new tab
- **Per-tab AI profiles** — run Claude Code in one tab and Kimi K3, Qwen, or any other CLI in the next, each with its own command and environment
- **Disable hover** — toggle hover-to-open off in settings for hotkey-only mode
- **Customizable position** — place the notch at the top, left, or right edge of your screen
- **Centered resize** — drag to resize expands symmetrically from center (top position)
- **Multiple monitor support** — choose which display to show the pill on
- **macOS notch detection** — positions in the notch area on notch Macs, below the menu bar on others
- **Always on top** — stays above all other windows
- **Auto-update** — checks GitHub Releases for new versions
- **System tray** — right-click tray icon to toggle or quit
- **Claude Code integration** — three-channel architecture: hooks (status events), MCP (tool access), IDE bridge (bidirectional WebSocket)
- **[OpenClaude](https://gitlawb.com/node/repos/z6MkqDnb/openclaude) compatible** — use any LLM (GPT-4o, DeepSeek, Gemini, Llama, etc.) instead of Claude. Set the launch command to `openclaude` in Settings
- **Plugin SDK** — extend Wotch with custom commands, status detectors, and panel views
- **Durable Agent Runtime v2** — project-scoped trust, redacted audit history, queued runs, opt-in memory and automation, and recoverable approvals
- **Local API** — HTTP + WebSocket API for external tool integration

## Install

Download the latest release for your platform from [GitHub Releases](https://github.com/Frostbite1536/Wotch/releases):

- **Windows** — `.exe` installer
- **macOS** — `.dmg` disk image
- **Linux** — `.AppImage` or `.deb` package

No Node.js or build tools required.

## Quick Start

1. **Launch Wotch** — a small pill appears at the top-center of your screen (configurable to left or right edge)
2. **Hover the pill** (or press `Ctrl+`` `) — the terminal panel slides open
3. **Open a project** — click the project dropdown to auto-detect your VS Code/JetBrains projects
4. **Create a checkpoint** — press `Ctrl+S` before letting Claude make changes
5. **Let Claude work** — the pill dot changes color to show Claude's status in real-time
6. **View the diff** — click "Diff" in the git bar to see what changed
7. **Roll back if needed** — `git reset --hard <checkpoint-hash>` to undo

**Tips:**
- Press `Ctrl+Shift+P` to open the command palette for quick access to all actions
- Press `Ctrl+Shift+D` to split the current pane horizontally, `Ctrl+Shift+E` for vertical
- Press `Ctrl+Tab` to cycle tabs, `Ctrl+1-9` to jump to a tab by number
- Press `Alt+Arrow` to navigate between split panes
- Press `Ctrl+F` to search terminal output
- Selecting text auto-copies it to the clipboard
- Drag tabs to reorder them, drag split dividers to resize panes
- Click the pin icon to pin the panel open while you work in other windows
- Disable hover in Settings if you prefer hotkey-only mode (`Ctrl+\``)
- Right-click the system tray icon to toggle or quit

## Using with OpenClaude (Any LLM)

Wotch works with [OpenClaude](https://gitlawb.com/node/repos/z6MkqDnb/openclaude), which lets you use any OpenAI-compatible model (GPT-4o, DeepSeek, Gemini, Llama, Mistral, etc.) instead of Claude.

1. Install OpenClaude: `npm install -g openclaude`
2. Set your environment variables:
   ```bash
   export CLAUDE_CODE_USE_OPENAI=1
   export OPENAI_API_KEY=sk-your-key
   export OPENAI_MODEL=gpt-4o          # or deepseek-chat, llama3.3:70b, etc.
   ```
3. In Wotch Settings, set **Launch command** to `openclaude` and enable **Auto-launch command**
4. New tabs will auto-run OpenClaude with your configured model

All three integration channels (hooks, MCP, IDE bridge) work with OpenClaude since it's built on the same Claude Code codebase and reads the same config files (`~/.claude/settings.json`, `~/.claude/ide/`).

## AI Profiles (open-weight models via OpenRouter)

A profile is a command plus the environment it runs under. Each tab launches one, so you can keep Claude Code in one tab and an open-weight model like Kimi K3 or Qwen in the next. Configure them in **Settings > AI Profiles**, then open a tab with `Ctrl+Shift+P` > **New Tab: \<profile\>**.

**Secrets stay out of Wotch.** Env values may reference variables from your own environment with `$NAME` — Wotch expands them when it spawns the shell and never writes the value to `~/.wotch/settings.json` (see INV-SEC-020). Saving a profile is rejected outright if a key like `API_KEY` or `AUTH_TOKEN` holds a literal value instead of a reference. Export the key once in your shell profile or OS environment:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

**Profile for an OpenAI-compatible CLI** (the supported path for non-Anthropic models — [OpenRouter is natively OpenAI-compatible](https://openrouter.ai/docs/quickstart)):

| Field | Value |
|-------|-------|
| Name | `Kimi K3` |
| Command | `openclaude` |
| Environment | `CLAUDE_CODE_USE_OPENAI=1`<br>`OPENAI_BASE_URL=https://openrouter.ai/api/v1`<br>`OPENAI_API_KEY=$OPENROUTER_API_KEY`<br>`OPENAI_MODEL=moonshotai/kimi-k3` |

**Profile for Claude Code against OpenRouter's Anthropic-compatible endpoint:**

| Field | Value |
|-------|-------|
| Name | `Claude via OpenRouter` |
| Command | `claude` |
| Environment | `ANTHROPIC_BASE_URL=https://openrouter.ai/api`<br>`ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY`<br>`ANTHROPIC_API_KEY=` |

> **Caveat, straight from OpenRouter's own docs:** this second shape is *"only guaranteed to work with the Anthropic first-party provider"* — Claude Code *"is optimized for Anthropic models and may not work correctly with other providers."* Pointing it at Kimi K3 or Qwen may work but is unsupported; prefer an OpenAI-compatible CLI for those. See [OpenRouter's Claude Code integration guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

Split panes inherit their tab's profile, so `Ctrl+Shift+D` inside a Kimi tab gives you another Kimi pane rather than silently switching providers.

## Development Setup

If you want to build from source:

### Requirements
- Node.js 24.11.1 and npm 11.10.0 (see `.node-version` and `packageManager`)
- C++ build tools for native module compilation (node-pty)

### 1. Install build tools (one-time)

**Windows:** Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload.

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

### 2. Install and run

```bash
cd wotch
npm ci
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
| Hover pill edge | same | Expand panel |
| Move mouse away | same | Collapse (unless pinned) |

## Building a distributable

```bash
npm run dist          # current platform
npm run dist:win      # Windows .exe
npm run dist:mac      # macOS .dmg
npm run dist:linux    # Linux .AppImage + .deb
```

This creates an installer in the `dist/` folder. Or push a version tag to build all platforms via GitHub Actions:

```bash
git tag v1.2.0
git push origin v1.2.0
```

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

The pill can sit at the **top** (default), **left**, or **right** edge of your screen. Change the position in Settings > Position.

```
 Top (default)              Left                     Right
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│  ┌────────────┐  │   │┌─┐               │   │               ┌─┐│
│  │ ● claude ▾ │  │   ││●│               │   │               │●││
│  └────────────┘  │   ││c│               │   │               │c││
│                  │   ││l│               │   │               │l││
│   On hover or    │   ││a│               │   │               │a││
│   Ctrl+` :       │   ││u│               │   │               │u││
│  ┌────────────┐  │   ││d│               │   │               │d││
│  │ Session 1 +│  │   ││e│               │   │               │e││
│  ├────────────┤  │   │└─┘               │   │               └─┘│
│  │ $ claude   │  │   │                  │   │                  │
│  │ ● Working  │  │   │ Expands right →  │   │ ← Expands left  │
│  │ ✓ Fixed!   │  │   │                  │   │                  │
│  └────────────┘  │   └──────────────────┘   └──────────────────┘
└──────────────────┘
```

### Architecture

- **main.js** — Electron main process: window management, position-aware pill/panel placement (top/left/right), PTY processes, mouse tracking with edge-slam activation, global hotkey, Claude status detection, project scanning, git operations, auto-updater, system notifications, multi-monitor display management
- **preload.js** — secure IPC bridge (25 methods) between main and renderer
- **index.html** — renderer HTML and CSS: pill, panel, overlays, settings panel, position-variant styles for left/right placement
- **renderer.js** — renderer JavaScript: tab management, themes, terminal search, command palette, diff viewer, position-aware drag-to-resize, drag-to-reorder tabs, settings wiring

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

**Appearance:** theme (dark, light, purple, green) — changes colors for the entire app including terminals.

**Panel Dimensions:** expanded width/height, pill width — resize the panel to your liking. You can also drag the bottom edge of the panel to resize live (or the side edge for left/right positions).

**Position:** place the notch at the top (horizontal, default), left (vertical), or right (vertical) edge of the screen. Left and right modes display the pill vertically and expand the panel from the corresponding screen edge.

**Behavior:** collapse delay (how long before the panel closes on mouse leave), hover padding (how far from the pill the hover zone extends), start expanded (open panel on launch), remember pin state (persist pin across restarts), auto-launch command (run the tab's profile command in every new tab).

**AI Profiles:** the command and environment each tab launches with — see [AI Profiles](#ai-profiles-open-weight-models-via-openrouter) above. Your existing `launchCommand` is migrated into a profile named "Default" on first run.

**Display:** target display — choose which monitor to show the pill on (for multi-monitor setups).

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
- **[Agent Runtime v2](docs/AGENT_RUNTIME.md)** — Durable runs, policy, trust, memory, automation, storage, and security boundaries
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

GNU Affero General Public License v3.0
