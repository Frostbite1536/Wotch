# Pre-Merge Checklist

Use this before merging any PR or accepting any AI-generated change.

## Security
- [ ] `contextIsolation` is still `true` and `nodeIntegration` is still `false`
- [ ] No new `loadURL` calls with remote URLs
- [ ] No new dynamic/catch-all IPC channel forwarding in preload.js
- [ ] No user input interpolated into shell command strings
- [ ] No new runtime dependencies added without justification
- [ ] `npm audit` shows no new vulnerabilities

## Invariants
- [ ] All INV-SEC-* invariants still hold (check `docs/INVARIANTS.md`)
- [ ] All INV-DATA-* invariants still hold
- [ ] All INV-UX-* invariants still hold
- [ ] All INV-PLAT-* invariants still hold

## Cross-Platform
- [ ] Windows behavior verified (or noted as untested)
- [ ] macOS notch/non-notch positioning not broken
- [ ] Linux/Wayland fallback behavior not broken
- [ ] No hardcoded paths (use `os.homedir()`, `path.join()`, platform flags)

## Code Quality
- [ ] No unnecessary new dependencies
- [ ] No new build tooling added to the renderer
- [ ] Files stay under ~1,500 lines (index.html, renderer.js, main.js)
- [ ] New IPC channels added to main.js AND preload.js AND renderer.js
- [ ] Settings changes are backward-compatible (old settings.json still works)
- [ ] New CSS colors added to all 4 theme presets in renderer.js

## Functional
- [ ] App launches and pill is visible
- [ ] Hover-to-reveal works (or hotkey if Wayland)
- [ ] Terminal accepts input and displays output
- [ ] Tabs can be created and closed
- [ ] Settings panel opens and saves
- [ ] Git checkpoint works on a git repo
- [ ] Claude status detection not regressed (if applicable)
- [ ] Terminal search (Ctrl+F) finds text in scrollback
- [ ] Command palette (Ctrl+Shift+P) opens and executes commands
- [ ] Themes switch correctly (all 4 presets)
- [ ] Diff viewer shows color-coded output
- [ ] Drag-to-resize works and persists
- [ ] Drag-to-reorder tabs works without interruption from status updates

## Claude Code Integration
- [ ] Hook receiver starts on localhost:19520 (or next available port)
- [ ] Hook receiver responds to POST /hook/PreToolUse with 200
- [ ] MCP IPC server starts on localhost:19523
- [ ] Integration settings section visible in settings panel
- [ ] Hook/MCP toggle switches work and save
- [ ] Channel health dots update (green when active)
- [ ] "Reconfigure Hooks" button writes to ~/.claude/settings.json
- [ ] "Re-register MCP" button writes to ~/.claude.json
- [ ] Enhanced status detector shows tool-specific descriptions when hooks active
- [ ] Regex fallback works when hooks are unavailable
- [ ] INV-SEC-006: Hook receiver binds to 127.0.0.1 only
- [ ] INV-SEC-007: MCP tools expose only read/additive operations
- [ ] INV-SEC-008: MCP IPC server binds to 127.0.0.1 only

## Git
- [ ] Commit messages are descriptive
- [ ] No secrets, .env files, or node_modules committed
- [ ] No large binary files committed
