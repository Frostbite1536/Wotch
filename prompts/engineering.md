# Engineering Prompt — Wotch

You are working on **Wotch**, a cross-platform Electron desktop app that provides a floating, notch-style terminal overlay for Claude Code.

## Tech Stack
- **Runtime:** Electron 33+ (Chromium + Node.js)
- **Terminal:** node-pty (native PTY) + @xterm/xterm (terminal UI)
- **Build:** electron-builder for distributable installers
- **Languages:** JavaScript (Node.js in main process, vanilla JS in renderer)
- **Platforms:** Windows 10/11, macOS 10.15+, Linux (X11 and Wayland)

## Architecture
- `src/main.js` — Electron main process. Window management, PTY spawning, mouse tracking, global hotkey, Claude status detection, project detection, git operations, settings, system tray.
- `src/preload.js` — Secure IPC bridge. `contextBridge.exposeInMainWorld("wotch", {...})`. Only specific channels.
- `src/index.html` — Renderer. Single-page app with inline CSS/JS. xterm.js terminals, tab management, pill UI, settings panel, project picker, git status bar.

## Before Making Changes
1. Read `docs/ARCHITECTURE.md` to understand components and data flow.
2. Read `docs/INVARIANTS.md` to understand non-negotiable rules.
3. If your change touches security boundaries (IPC, preload, webPreferences), verify against INV-SEC-* invariants.
4. If your change touches git operations, verify against INV-DATA-003.

## Code Style
- No build system or bundler for the renderer — keep it as a single index.html.
- No TypeScript — the project uses plain JavaScript.
- No external UI frameworks — the renderer uses vanilla DOM manipulation.
- Keep files under ~1,500 lines. If main.js grows too large, extract modules with clear responsibilities.
- Prefer simple, readable code over clever abstractions.
- Platform-specific code should use the existing `IS_WIN`/`IS_MAC`/`IS_LINUX`/`WAYLAND` flags.

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
- **IPC channels:** Adding a new IPC channel requires changes in both main.js and preload.js. Never expose channels dynamically.

## Security Rules (Non-Negotiable)
- `contextIsolation: true` and `nodeIntegration: false` — always.
- No `loadURL` with remote content — only `loadFile` with local files.
- No dynamic IPC channel forwarding in preload.js.
- No string interpolation of user input into shell commands.
