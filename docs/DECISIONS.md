# Decision Log

Significant architectural and product decisions, recorded for future context.

## 2026-03-28: Initial Architecture

**Decision:** Single `index.html` for the renderer with inline CSS and JS.
**Context:** The renderer UI (pill, terminal, tabs, settings) is small enough that splitting into separate files and adding a bundler would add more complexity than it solves.
**Trade-off:** Harder to navigate as it grows. If `index.html` exceeds ~1,500 lines, extract components into separate `.js` files loaded via `<script>` tags.

## 2026-03-28: node-pty for Terminal Emulation

**Decision:** Use `node-pty` instead of `child_process.spawn`.
**Context:** `child_process` doesn't provide a real PTY, which means no ANSI color, no readline, no full-screen TUI apps (like vim, htop, or Claude Code's interactive mode).
**Trade-off:** Requires native compilation (Visual Studio Build Tools on Windows, Xcode on macOS). This is the main barrier to local development. Mitigated by providing pre-built installers via GitHub Actions.

## 2026-03-28: Mouse Polling for Hover Detection

**Decision:** Poll `screen.getCursorScreenPoint()` on an interval instead of relying on DOM mouse events.
**Context:** The app needs to detect when the mouse enters a zone *around* the window (the hover padding), not just within the window itself. DOM events only fire inside the window bounds.
**Trade-off:** Uses CPU continuously (mitigated by configurable interval, default 100ms). Doesn't work on Wayland (mitigated by hotkey fallback).

## 2026-03-28: GitHub Actions for Builds

**Decision:** Use CI/CD to build distributable installers rather than requiring users to have build tools locally.
**Context:** `node-pty` requires Visual Studio Build Tools (Windows) or Xcode (macOS) to compile. Most users don't have these installed and shouldn't need them just to run Wotch.
**Trade-off:** Depends on GitHub Actions minutes. Free tier has limits; paid minutes are cheap (~$0.05/build).

## 2026-03-28: Claude Status Detection via Pattern Matching

**Decision:** Detect Claude Code's state by parsing ANSI-stripped terminal output against regex patterns.
**Context:** Claude Code doesn't expose a structured status API. The only signal available is what it prints to the terminal — spinner characters, status messages, file paths, prompts, etc.
**Trade-off:** Heuristic-based, not guaranteed accurate. Can produce false positives on non-Claude output. Acceptable because status display is UX sugar, not a security control.

## 2026-03-28: Project Documentation Setup

**Decision:** Adopt safe-vibe-coding documentation structure (ARCHITECTURE.md, INVARIANTS.md, ROADMAP.md, THREAT_MODEL.md, engineering prompt, checklist, decision log).
**Context:** Following the safe-vibe-coding guide from https://github.com/Frostbite1536/safe-vibe-coding to establish clear guardrails for AI-assisted development on this project.
**Trade-off:** Upfront documentation effort. Pays off by preventing drift and giving AI collaborators clear constraints.

## 2026-03-28: Extract renderer.js from index.html

**Decision:** Move all renderer JavaScript into a separate `src/renderer.js` file loaded via `<script type="module" src="renderer.js">`.
**Context:** After implementing Phase 6 features, index.html exceeded 1,500 lines. The file was getting hard to navigate with inline CSS + HTML + JS all mixed together.
**Trade-off:** Two files to maintain instead of one. Mitigated by clear separation: CSS/HTML in index.html, all JS in renderer.js. No build tooling needed — native ES modules work in Electron.

## 2026-03-28: CSS Custom Properties for Theming

**Decision:** Implement themes as preset objects that map CSS variable names to values, applied via `document.documentElement.style.setProperty()`.
**Context:** Needed runtime theme switching without rebuilding. CSS custom properties (`:root` vars) are already used throughout the codebase for colors.
**Trade-off:** Theme presets are hardcoded in renderer.js. A future custom theme editor would need to extend this pattern. Terminal themes (xterm.js) must be updated separately from CSS vars.

## 2026-03-28: execFileSync for Git Commit Messages

**Decision:** Replace `execSync(\`git commit -m "${msg}"\`)` with `execFileSync("git", ["commit", "-m", msg])` for checkpoint creation.
**Context:** The original code used shell string interpolation, which was vulnerable to injection if a custom message contained quotes, backticks, or `$()`. While the auto-generated timestamp messages were safe, user-provided messages were not.
**Trade-off:** None — `execFileSync` with argument arrays is strictly better for parameterized commands. Other git commands that use fixed strings (`git status`, `git diff HEAD~1`) remain as `execSync` since they have no user input.

## 2026-03-28: Multi-Monitor via Display Index

**Decision:** Add a `displayIndex` setting and `getTargetDisplay()` helper that selects from `screen.getAllDisplays()`, with fallback to primary on disconnect.
**Context:** Users with multiple monitors may want Wotch on a secondary display. The original code hardcoded `screen.getPrimaryDisplay()` in all positioning functions.
**Trade-off:** Adds complexity to positioning logic. All `getPillBounds`/`getExpandedBounds` calls now add `display.bounds.x/y` offsets. Risk of positioning bugs on unusual multi-monitor arrangements.
