# Roadmap

## Phase 1: Core Terminal (Complete)
**Status:** Done
**Goal:** Functional floating terminal with hover-to-reveal and global hotkey.

### Features
- [x] Frameless always-on-top pill window
- [x] Hover-to-reveal expansion
- [x] Global hotkey toggle (Ctrl+` / Cmd+`)
- [x] Real terminal via node-pty + xterm.js
- [x] Multi-tab support
- [x] Platform-specific shell detection
- [x] System tray with toggle/quit
- [x] Pin mode

### Success Criteria
- Terminal works on Windows, macOS, and Linux
- Pill is always visible and responsive

---

## Phase 2: Claude Code Integration (Complete)
**Status:** Done
**Goal:** Make Wotch aware of Claude Code's state and show it in the pill.

### Features
- [x] Claude Code status detection (idle/thinking/working/waiting/done/error)
- [x] Color-coded pill dot reflecting state
- [x] Status description in pill label
- [x] Per-tab state tracking
- [x] Idle timeout auto-transition

### Success Criteria
- Pill accurately reflects what Claude Code is doing
- No false positives on non-Claude terminal output

---

## Phase 3: Project & Git Awareness (Complete)
**Status:** Done
**Goal:** Auto-detect projects, provide git checkpointing.

### Features
- [x] Project detection (VS Code, JetBrains, Xcode, Visual Studio, dev dirs)
- [x] Project picker in UI
- [x] Auto-cd into selected project for new tabs
- [x] Git checkpoint creation (Ctrl+S)
- [x] Git status bar (branch, changes, checkpoint count)

### Success Criteria
- Users can one-click checkpoint before Claude makes changes
- Projects are discovered without manual configuration

---

## Phase 4: Settings & Polish (Complete)
**Status:** Done
**Goal:** User-configurable behavior, cross-platform polish.

### Features
- [x] Settings panel with live save
- [x] Configurable dimensions, delays, shell override
- [x] macOS notch detection and positioning
- [x] Wayland graceful degradation
- [x] Linux window type hints (dock)
- [x] Remember pin state across restarts
- [x] Reset to defaults

### Success Criteria
- Works on all target platforms without manual tweaking
- Settings persist across restarts

---

## Phase 5: Distribution & Install (Complete)
**Status:** Done
**Goal:** Users can install Wotch without build tools.

### Features
- [x] GitHub Actions workflow for Windows .exe build
- [x] GitHub Actions for macOS .dmg and Linux .AppImage/.deb
- [x] Auto-update mechanism (electron-updater)
- [x] GitHub Releases with release notes
- [ ] Signed builds (Windows code signing, macOS notarization) — deferred, requires paid certificates

### Exclusions
- No app store distribution (yet)
- No code signing yet ($99/year Apple, varies for Windows)

### Success Criteria
- Users can download and run a single installer on any supported platform
- No Node.js or build tools required to use Wotch

---

## Phase 6: Quality of Life (Complete)
**Status:** Done
**Goal:** Quality of life improvements.

### Features
- [x] Themes / custom pill colors (dark, light, purple, green)
- [x] Multiple monitor support (display selector in settings)
- [x] Terminal search (Ctrl+F) via @xterm/addon-search
- [x] Drag to resize expanded panel (bottom edge handle)
- [x] Notification when Claude finishes (Electron Notification API)
- [x] Command palette (Ctrl+Shift+P)
- [x] Checkpoint diff viewer (color-coded git diff overlay)
- [x] Claude Code auto-launch in new tabs (optional setting)

- [x] Customizable notch position (top, left, right) with position-aware hover zones and resize handles

### Deferred
- [ ] Split panes within a tab — high complexity, deferred until simpler features are stable
- [ ] Plugin/extension system — significant security implications, deferred indefinitely

### Success Criteria
- All features accessible via keyboard shortcuts or settings UI
- No regressions to core terminal functionality

---

## Phase 7: Future Ideas
**Status:** Not Started
**Goal:** Next round of improvements based on usage feedback.

### Candidates (unprioritized)
- [ ] Split panes within a tab
- [ ] Plugin/extension system
- [ ] Screen share protection mode (blur/hide terminal content)
- [ ] Code signing for all platforms
- [x] Terminal tabs reordering via drag
- [ ] Custom keyboard shortcut bindings
- [ ] Session persistence (restore tabs on restart)

---

## Decision Log

| Date | Decision | Reason |
|------|----------|--------|
| 2026-03-28 | Use GitHub Actions for builds instead of requiring local build tools | Most users don't have Visual Studio Build Tools installed; cloud builds are more reliable |
| 2026-03-28 | Single `index.html` for renderer instead of a build system | Keeps the project simple; the UI is small enough that a bundler adds more complexity than value |
| 2026-03-28 | Extract renderer JS into `src/renderer.js` | index.html exceeded 1,500 lines after Phase 6 features; split to maintain readability |
| 2026-03-28 | Use CSS custom properties for theming | Allows runtime theme switching without rebuilding; themes are just variable maps |
| 2026-03-28 | Defer split panes and plugin system | Split panes require pane tree data structure and focus tracking (~4hr effort); plugins have security implications (main process access) |
| 2026-03-28 | Use `execFileSync` for git commit instead of `execSync` | Prevents shell injection via checkpoint messages (INV-SEC-004) |
| 2026-03-28 | Add customizable notch position (top/left/right) | Users requested sidebar-style placement; uses workArea for accurate positioning across platforms |
