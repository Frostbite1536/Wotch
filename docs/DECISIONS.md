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
