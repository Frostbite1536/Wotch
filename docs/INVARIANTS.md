# Invariants

Non-negotiable rules that must hold true at all times. Any change that violates an invariant must be rejected.

## Security

### INV-SEC-001: Context Isolation
The renderer process must never have direct access to Node.js APIs. `contextIsolation` must be `true` and `nodeIntegration` must be `false` in all BrowserWindow webPreferences.

**Rationale:** A compromised renderer (e.g., via malicious terminal output interpreted as HTML) must not be able to execute arbitrary system commands.

**Enforcement:** Code review. Never change webPreferences security settings.

### INV-SEC-002: No Remote Content
The app must only load local files via `loadFile()`. Never use `loadURL()` with `http://` or `https://` schemes.

**Rationale:** Loading remote content in an Electron app with PTY access would allow remote code execution.

**Enforcement:** Code review. Grep for `loadURL`.

### INV-SEC-003: Preload Bridge Scoping
The preload script must only expose specific, named IPC channels via `contextBridge`. No catch-all or dynamic channel forwarding (e.g., never `ipcRenderer.send(anyChannel, ...)`).

**Rationale:** An open IPC bridge would let the renderer call any main-process handler, bypassing the security boundary.

**Enforcement:** Code review of preload.js. Every exposed function must map to a specific channel.

### INV-SEC-004: No Command Injection in Git/Shell Operations
All `execSync`/`exec` calls must use fixed command templates. User-provided values (project paths, messages) must never be interpolated directly into shell command strings without sanitization.

**Rationale:** A malicious project name or git message could execute arbitrary commands.

**Enforcement:** Code review. Prefer argument arrays over string interpolation where possible.

## Data Integrity

### INV-DATA-001: Settings File Resilience
If `~/.wotch/settings.json` is missing, corrupted, or contains invalid JSON, the app must fall back to `DEFAULT_SETTINGS` and continue running. Settings load must never crash the app.

**Rationale:** Users may hand-edit the file or it may be corrupted by a crash during write.

**Enforcement:** try/catch around JSON.parse with fallback to defaults.

### INV-DATA-002: PTY Map Consistency
Every entry in the `ptyProcesses` Map must correspond to a living PTY process. When a PTY exits (onExit fires), it must be removed from the Map immediately. When the window closes, all PTY processes must be killed.

**Rationale:** Orphaned PTY processes leak system resources and can leave zombie shells running.

**Enforcement:** Cleanup in onExit handler and window close/app quit handlers.

### INV-DATA-003: Git Checkpoint Safety
Git checkpoint operations must never force-push, reset, rebase, or modify existing commits. Checkpoints only create new commits. If the working directory is not a git repo, the operation must fail gracefully (return an error message, not crash).

**Rationale:** Wotch exists to protect user work. Destructive git operations would undermine its purpose.

**Enforcement:** Only use `git add` and `git commit` in checkpoint code.

## UI / UX

### INV-UX-001: Always-on-Top
The Wotch window must always remain above other windows. If the OS or window manager demotes it (e.g., on blur), the app must re-assert always-on-top.

**Rationale:** The entire value proposition depends on Wotch being visible at all times.

**Enforcement:** Re-assert in the `blur` event handler.

### INV-UX-002: Pill Must Always Be Visible
The pill must always be visible and positioned at the top-center of the target display (primary by default, configurable via `displayIndex`). It must never be moved off-screen, hidden behind other elements, or become unclickable. If the target display is disconnected, the pill must fall back to the primary display.

**Rationale:** If the user can't see or reach the pill, they can't use Wotch.

**Enforcement:** Position calculation uses `getTargetDisplay()` which falls back to `screen.getPrimaryDisplay()`. `display-removed` event handler resets `displayIndex` and repositions.

### INV-UX-003: Pin Prevents Hover Collapse
When pinned (`isPinned === true`), the panel must not collapse due to mouse leaving the hover zone. Only the toggle hotkey or explicit unpin should collapse a pinned panel.

**Rationale:** Pin mode exists specifically to keep the panel open while working in other windows.

**Enforcement:** `collapse()` checks `isPinned` and returns early if true.

### INV-UX-004: Hotkey Always Toggles
The global hotkey (Ctrl+` / Cmd+`) must always toggle the panel, regardless of pin state, focus state, or expansion state.

**Rationale:** The hotkey is the universal escape hatch, especially on Wayland where hover doesn't work.

**Enforcement:** `toggle()` unconditionally flips the expanded state.

## Cross-Platform

### INV-PLAT-001: Wayland Graceful Degradation
On Wayland, if `screen.getCursorScreenPoint()` returns only (0,0) for 10+ consecutive checks, the app must disable mouse polling and switch to hotkey-only mode. It must not crash, spin, or show broken hover behavior.

**Rationale:** Wayland compositors block global cursor position for security. The app must still be fully usable.

**Enforcement:** `waylandCursorBroken` flag and early-return logic in mouse tracker.

### INV-PLAT-002: macOS Notch Awareness
On macOS, the pill Y position must account for notch/non-notch displays. Notch Macs: `y=0`. Non-notch Macs: `y=menuBarHeight`. The app must never render the pill behind the menu bar where it can't be hovered.

**Rationale:** On non-notch Macs the menu bar blocks mouse events at y=0.

**Enforcement:** `getTopOffset()` checks `HAS_NOTCH` and adjusts.

## Invariant Change Log

| Date | Invariant | Change | Reason |
|------|-----------|--------|--------|
| 2026-03-28 | All | Initial creation | Project documentation setup |
| 2026-03-28 | INV-SEC-004 | Git commit now uses execFileSync with args array | Eliminates shell injection in checkpoint messages |
| 2026-03-28 | INV-UX-002 | Updated for multi-monitor support | Pill can now target any display, falls back to primary on disconnect |
