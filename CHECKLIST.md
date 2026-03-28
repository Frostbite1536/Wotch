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
- [ ] Files stay under ~1,500 lines
- [ ] New IPC channels added to both main.js AND preload.js
- [ ] Settings changes are backward-compatible (old settings.json still works)

## Functional
- [ ] App launches and pill is visible
- [ ] Hover-to-reveal works (or hotkey if Wayland)
- [ ] Terminal accepts input and displays output
- [ ] Tabs can be created and closed
- [ ] Settings panel opens and saves
- [ ] Git checkpoint works on a git repo
- [ ] Claude status detection not regressed (if applicable)

## Git
- [ ] Commit messages are descriptive
- [ ] No secrets, .env files, or node_modules committed
- [ ] No large binary files committed
