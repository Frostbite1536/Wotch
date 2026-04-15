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

## 2026-03-28: Customizable Notch Position (Top / Left / Right)

**Decision:** Add a `position` setting (`"top"`, `"left"`, `"right"`) that controls which screen edge the pill and expanded panel anchor to.
**Context:** Users wanted flexibility in where the notch appears — some prefer a vertical sidebar-style pill on the left or right edge rather than the default top-center placement.
**Implementation:**
- Main process: `getPillBounds()` and `getExpandedBounds()` calculate position based on `display.workArea` (not `display.bounds`) to correctly account for taskbars and menu bars on all platforms. Left/right pill dimensions are swapped (width↔height). Expanded panel height is clamped to work area height.
- Mouse tracking: Each position extends its edge-slam zone to the physical display boundary (`display.bounds`) so users can slam the cursor to the edge to trigger hover-reveal.
- Renderer: Position changes apply a CSS class (`position-left`, `position-right`) to `<body>`, which overrides pill/panel border-radius, flex direction, border sides, and resize handle orientation.
- IPC: A `position-changed` event notifies the renderer when position changes.
**Trade-off:** Adds ~60 lines of CSS position variants and ~50 lines of branching logic in bounds calculations. The CSS approach (class switching) keeps visual changes declarative and avoids JS-driven style manipulation.

## 2026-03-28: ssh2 Pure-JS Library for Remote Terminals

**Decision:** Use the `ssh2` npm package (pure JavaScript SSH2 client) instead of shelling out to the system `ssh` CLI binary.
**Context:** Users wanted to connect to remote VPS instances running Claude Code. Options were: (A) set `defaultShell` to an SSH command (works but limited), (B) shell out to `ssh` binary, or (C) use a programmatic SSH library.
**Implementation:**
- SSH sessions use a parallel data path alongside local PTY sessions. The `sshSessions` Map mirrors `ptyProcesses`. SSH shell channels produce the same byte stream as local PTYs, routed through the same `pty-data`/`pty-write`/`pty-resize` IPC channels. The renderer doesn't need to know the transport type.
- Host key verification uses `~/.wotch/known_hosts.json` with user confirmation dialogs for new/changed keys.
- Credentials (passwords, key passphrases) are prompted in the renderer, passed via IPC, used once, discarded. Never stored.
- Connection profiles (host, port, username, auth method, key path) are stored in `settings.sshProfiles`, managed via dedicated IPC handlers isolated from general settings saves.
**Trade-off:** Adds `ssh2` as a runtime dependency (pure JS, no native bindings, well-maintained). Adds ~150 lines to main.js, ~200 lines to renderer.js, and ~100 lines of HTML/CSS. The transparent transport approach means Claude status detection, tab management, and xterm.js integration all work identically for SSH tabs.

## 2026-03-31: Claude Code Deep Integration (Hooks-First Approach)

**Decision:** Replace regex-based Claude Code status detection with structured integration using two channels: hooks (24 lifecycle events via `type: http` hooks) and MCP (Wotch as tool server). Hooks are the primary channel for status detection; MCP provides tool access in the reverse direction.
**Context:** Analysis of Claude Code's architecture revealed that Claude Code exposes two structured integration surfaces usable by third-party tools: a hook system for lifecycle events (configured in `~/.claude/settings.json`) and MCP server support (configured in `~/.claude.json`). A third surface — the IDE bridge — exists but is proprietary (TCP with ephemeral lock-file auth, undocumented protocol, not designed for third parties). The existing regex-based detection in `ClaudeStatusDetector` is fragile (false positives on non-Claude output, missed transitions, invisible states like context compression and agent spawning). The hook system solves all of these issues with 24 event types delivered as JSON payloads.
**Implementation:**
- A `ClaudeIntegrationManager` coordinates two channels: `HookReceiver` (HTTP server on localhost:19520 receiving `type: http` hook payloads) and `WotchMCPServer` (stdio MCP server exposing Wotch tools, registered in `~/.claude.json`).
- An `EnhancedClaudeStatusDetector` fuses data from hooks and regex fallback using priority-based resolution (hooks > regex).
- Each channel is independently toggleable and degrades gracefully. With no channels active, the existing regex detector serves as fallback.
- Hooks are configured as `type: http` entries in `~/.claude/settings.json` — Claude Code natively POSTs the hook's JSON payload to Wotch's HTTP endpoint. No curl or shell command intermediary needed.
- MCP server entry is written to `~/.claude.json` with `"type": "stdio"` (auto-registration with user consent, never overwriting existing config).
- New files: `src/hook-receiver.js`, `src/mcp-server.js`, `src/claude-integration-manager.js`, `src/enhanced-status-detector.js`.
**Trade-off:** Adds 2 localhost servers (HTTP for hooks, TCP for MCP IPC) and 4 new source files (~700 lines). Port management complexity is minor (configurable with auto-fallback). The hook system's `type: http` support may not be available in very old Claude Code versions — mitigated by regex fallback. MCP protocol may evolve — mitigated by pinning SDK version.

---

## 2026-04-02: claudeActive / aiType Stickiness — Problem Analysis & Proposed Fix

**Status:** Unimplemented. Recorded here for the next engineer who picks this up.

**The Problem:**
`claudeActive` (and its sibling `aiType`, added during Gemini CLI integration) are
one-way latches on the per-tab state object in `ClaudeStatusDetector`. Once any
AI CLI output is seen in a tab, the flag is set to `true` and never cleared within
that tab's lifetime, even after the user exits the AI and returns to a plain shell.
Consequence: if a user runs `claude`, exits, then runs `gemini` in the same tab,
`aiType` stays `"claude"` — notifications mislabel, and the status detector keeps
evaluating AI-specific patterns on all shell output indefinitely.

**Root Cause:**
The flag was designed to answer "has this tab ever seen an AI CLI?" to gate pattern
matching and avoid false-positive status indicators during normal shell use. That's
a sound goal, but it conflates two different questions:

1. *Has* an AI CLI ever run here? (one-way latch — current behaviour)
2. *Is* an AI CLI currently running? (dynamic — what we actually need)

The latch is appropriate for (1) but wrong for (2).

**Options Considered:**

**Option A — Reset on shell prompt detection (simple, fragile)**
When the existing "shell prompt" idle pattern fires, also reset `claudeActive` and
`aiType`. Minimal code change.
- *Problem:* The prompt patterns (`[❯➜→▶$#%]\s*$`, `^\s*\$\s*$`) are already
  heuristic. AI CLIs sometimes emit shell-like characters in code blocks, tool
  output, or example commands. A single false match would flicker the detector off
  mid-session and immediately re-latch once the next AI output appears — creating a
  brief window of wrong state on every false trigger.

**Option B — PTY process tracking (precise, platform-specific)**
Read the PTY's foreground process group (`ioctl TIOCGPGRP` or `/proc/{pid}/status`
on Linux) to determine what's actually running, and derive `aiType` directly from
the process name (`claude`, `gemini`, etc.) rather than from output content.
- *Problem:* Requires platform-specific native code. `/proc` is Linux-only; macOS
  needs `ps` or `libproc`; Windows needs WMI or `QueryFullProcessImageName`. Doesn't
  work at all for SSH tabs where the process is remote. Adds ongoing maintenance
  surface for OS differences.

**Option C — Hook-based session boundaries for Claude Code (precise, asymmetric)**
The hooks system already delivers `SessionStart` and `SessionEnd` events from Claude
Code. Wire `SessionEnd` to immediately reset `claudeActive` / `aiType`. For
hook-free CLIs like Gemini, fall back to heuristics.
- *Problem:* Asymmetric — Claude Code gets precise session edges, Gemini and any
  future AI CLIs don't. Hooks may not always fire (timing edge cases, misconfigured
  install). Doesn't solve the general problem, just mitigates it for one CLI.

**Option D — Debounced idle reset (simple, eventual correctness)**
Add a timer: after the tab has been in the "idle" state continuously for N seconds
(e.g. 10s), reset `claudeActive` and `aiType`. The status detector returns to
"watching for any AI."
- *Problem:* 10-second delay before `aiType` can change. If the user exits Claude
  Code and immediately types `gemini`, the first 10 seconds of the Gemini session
  carry the wrong label. Tuning the timeout trades false-resets (too short) against
  stale type (too long).

**Option E — Debounced idle reset with output-based cancellation (recommended)**
Combine the core ideas of A and D with hysteresis:

1. When a shell-prompt pattern fires, start a short "pending reset" timer (3 seconds).
2. If any AI-specific output appears during those 3 seconds, cancel the timer — the
   AI is still active; the prompt match was a false trigger.
3. If the timer fires without cancellation, reset: `claudeActive = false`,
   `aiType = null`, `state = "idle"`.
4. For Claude Code specifically, also wire `SessionEnd` hook events to fire the
   reset immediately (no timer), since that signal is authoritative.

This handles the key cases:
- *False prompt in AI output* — cancelled by the next AI output chunk within 3s.
- *Clean exit → pause → different CLI* — the 3s window elapses, type resets, new
  CLI's startup output sets the correct type.
- *Clean exit → immediate re-launch* — the new CLI's startup output arrives within
  3s in the common case, cancelling the pending reset. If startup takes longer than
  3s (unlikely), the reset fires and the new detection picks up the correct type
  once startup output appears. A brief "idle" interlude is the worst case.
- *Claude Code exit via hooks* — `SessionEnd` fires the reset immediately with no
  timer, giving precise behaviour for the well-instrumented case.

**Implementation Sketch:**
```
// Per-tab state additions:
resetPendingTimer: null

// In shell prompt detection:
if (!tab.resetPendingTimer) {
  tab.resetPendingTimer = setTimeout(() => {
    tab.resetPendingTimer = null;
    tab.claudeActive = false;
    tab.aiType = null;
    tab.state = "idle";
    tab.description = "";
    tab.recentFiles = [];
    this.broadcast();
  }, 3000);
}

// In AI activation detection (when !tab.claudeActive becomes true):
// (no change needed — the latch re-sets correctly after a reset)

// In AI output detection (when claudeActive is already true):
if (tab.resetPendingTimer) {
  clearTimeout(tab.resetPendingTimer);
  tab.resetPendingTimer = null;
}

// In HookReceiver SessionEnd handler:
tab.claudeActive = false;
tab.aiType = null;
// (immediate, no timer)
```

The timer also needs clearing in `removeTab()` to avoid firing after a tab is closed.

**Trade-offs:**
The 3-second window is tunable but arbitrary. The hysteresis approach is still
heuristic-based — consistent with the existing detector's design philosophy
("heuristic, not authoritative; acceptable because it's UX sugar, not a security
control"). Option B would be more accurate but the complexity and platform fragmentation
make it disproportionate to the problem.

**Files that need to change:**
- `src/main.js` — `ClaudeStatusDetector` (timer logic, state reset)
- `src/enhanced-status-detector.js` — propagate reset to the enhanced detector's
  per-tab state so hooks-sourced status also resets
- `src/hook-receiver.js` — emit reset event on `SessionEnd`

---

## 2026-03-28: claudeStatus.removeTab in pty-kill Handler

**Decision:** Add `claudeStatus.removeTab(tabId)` to the `pty-kill` IPC handler.
**Context:** Pre-existing bug: the `pty-kill` handler at line 1232 didn't clean up Claude status tracking. Cleanup only happened in the PTY `onExit` callback, which may not fire if the process is force-killed. Discovered during SSH implementation when modifying the handler for dual PTY/SSH routing.
**Trade-off:** None — strictly a bugfix. The call is idempotent (safe if `onExit` also fires).
