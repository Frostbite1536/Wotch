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

## Phase 5: Distribution & Install
**Status:** In Progress
**Goal:** Users can install Wotch without build tools.

### Features
- [x] GitHub Actions workflow for Windows .exe build
- [ ] GitHub Actions for macOS .dmg and Linux .AppImage/.deb
- [ ] Auto-update mechanism (electron-updater)
- [ ] Signed builds (Windows code signing, macOS notarization)
- [ ] GitHub Releases with release notes

### Exclusions
- No app store distribution (yet)

### Success Criteria
- Users can download and run a single installer on any supported platform
- No Node.js or build tools required to use Wotch

### Risks
- Code signing requires certificates ($99/year for Apple, varies for Windows)
- Auto-update adds complexity and a server dependency

---

## Phase 6: Future Ideas
**Status:** Not Started
**Goal:** Quality of life improvements based on usage feedback.

### Candidates (unprioritized)
- [ ] Themes / custom pill colors
- [ ] Multiple monitor support (pill on each display)
- [ ] Terminal search (Ctrl+F)
- [ ] Split panes within a tab
- [ ] Drag to resize expanded panel
- [ ] Notification when Claude finishes (system toast)
- [ ] Command palette
- [ ] Plugin/extension system
- [ ] Checkpoint diff viewer (see what changed since last checkpoint)
- [ ] Claude Code auto-launch in new tabs

### Decision Criteria
Features will be prioritized based on user feedback and alignment with the core value proposition: a lightweight, always-visible terminal for Claude Code.

---

## Decision Log

| Date | Decision | Reason |
|------|----------|--------|
| 2026-03-28 | Use GitHub Actions for builds instead of requiring local build tools | Most users don't have Visual Studio Build Tools installed; cloud builds are more reliable |
| 2026-03-28 | Single `index.html` for renderer instead of a build system | Keeps the project simple; the UI is small enough that a bundler adds more complexity than value |
