# Engineering Prompt — Wotch

You are working on **Wotch**, a cross-platform Electron desktop app that provides a floating, notch-style terminal overlay for Claude Code.

## Tech Stack
- **Runtime:** Electron 33+ (Chromium + Node.js)
- **Terminal:** node-pty (native PTY) + @xterm/xterm (terminal UI)
- **Build:** electron-builder for distributable installers
- **Languages:** JavaScript (Node.js in main process, vanilla JS in renderer)
- **Platforms:** Windows 10/11, macOS 10.15+, Linux (X11 and Wayland)

## Architecture
- `src/main.js` — Electron main process. Window management, PTY spawning, mouse tracking, global hotkey, Claude status detection, project detection, git operations, settings, system tray, auto-updater, notifications, multi-monitor display management.
- `src/preload.js` — Secure IPC bridge. `contextBridge.exposeInMainWorld("wotch", {...})`. Only specific channels (24 methods).
- `src/index.html` — Renderer HTML and CSS. Pill, panel, tabs, settings panel, overlays (diff viewer, command palette, search bar).
- `src/renderer.js` — Renderer JavaScript (ES module). All UI logic: tab management, themes, search, diff viewer, command palette, drag-to-resize, settings wiring.

## Before Making Changes
1. Read `docs/ARCHITECTURE.md` to understand components and data flow.
2. Read `docs/INVARIANTS.md` to understand non-negotiable rules.
3. If your change touches security boundaries (IPC, preload, webPreferences), verify against INV-SEC-* invariants.
4. If your change touches git operations, verify against INV-DATA-003.

## Code Style
- No build system or bundler — renderer.js is a native ES module loaded via `<script type="module">`.
- No TypeScript — the project uses plain JavaScript.
- No external UI frameworks — the renderer uses vanilla DOM manipulation.
- Keep files under ~1,500 lines. If main.js grows too large, extract classes (e.g., `ClaudeStatusDetector`) into separate files.
- Prefer simple, readable code over clever abstractions.
- Platform-specific code should use the existing `IS_WIN`/`IS_MAC`/`IS_LINUX`/`WAYLAND` flags.
- Themes use CSS custom properties — add new colors to all 4 theme presets in `THEMES` object in renderer.js.

## Testing Changes
- Run `npm start` to launch the app and manually verify.
- Test on the current platform. Note in your PR if changes need cross-platform testing.
- For PTY-related changes, test with both a regular shell command and Claude Code.
- For UI changes, test both pill and expanded states.

## Common Pitfalls
- **Wayland:** `screen.getCursorScreenPoint()` may return (0,0). Always handle this case.
- **macOS:** Window positioning must account for notch vs non-notch displays.
- **node-pty:** Requires native compilation. Don't add alternative PTY libraries without good reason.
- **Always-on-top:** Some window managers demote the window on blur. The blur handler re-asserts it.
- **IPC channels:** Adding a new IPC channel requires changes in main.js, preload.js, and renderer.js. Never expose channels dynamically.
- **Themes:** New CSS colors must be added to all 4 theme presets. Terminal themes (xterm.js) are separate from CSS vars — update `getTermTheme()` and `applyTheme()`.
- **Multi-monitor:** Positioning uses `getTargetDisplay()` not `screen.getPrimaryDisplay()`. Always add `display.bounds.x/y` offsets.
- **Settings:** New settings need: default in `DEFAULT_SETTINGS` (main.js), UI element in index.html, wiring in renderer.js (`loadSettingsUI`, `debouncedSave`, event listener).
- **Tab bar re-renders:** `renderTabBar()` is called frequently (on status updates, tab changes). It skips re-render when `dragTabId` is set to avoid interrupting drag-to-reorder. If you add new callers of `renderTabBar()`, this guard still protects you.

## Security Rules (Non-Negotiable)
- `contextIsolation: true` and `nodeIntegration: false` — always.
- No `loadURL` with remote content — only `loadFile` with local files.
- No dynamic IPC channel forwarding in preload.js.
- No string interpolation of user input into shell commands.
