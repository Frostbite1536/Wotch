# Wotch Testing Guide

Manual testing guide for Wotch, organized by priority and risk level. Use this alongside the pre-merge checklist in `CHECKLIST.md`.

> **Note:** Wotch currently has no automated test suite. All verification is manual.

---

## Critical — Data Loss / Core UX Breakage

### 1. Split Pane Lifecycle

Split panes manage a tree data structure that must stay consistent.

- **Create horizontal split:** Ctrl+Shift+D
- **Create vertical split:** Ctrl+Shift+E
- **Navigate between panes:** Alt+Arrow keys
- **Close active pane:** Ctrl+Shift+W

**Verify:**
- Closing a pane removes it from the tree without affecting siblings
- No orphaned PTY processes remain after closing (check task manager)
- Closing the last pane in a tab closes the tab
- Rapidly opening and closing splits does not corrupt the pane tree
- Resize dividers between remaining panes still function after a close

### 2. Git Checkpoints

Checkpoints create git commits as snapshots before Claude makes changes.

- **Create checkpoint:** Ctrl+S

**Verify:**
- Checkpoint creates a commit on the current branch without modifying the working tree
- `git log` shows the checkpoint commit with the expected message format
- Diff viewer (click checkpoint in status bar) shows correct color-coded changes
- Creating a checkpoint in a repo with no changes is handled gracefully (no empty commit or error)
- Checkpoint works when the repo has staged but uncommitted changes

### 3. Settings Persistence and Resilience

Settings are stored in `~/.wotch/settings.json`.

**Verify:**
- Change theme, position, shell, and dimensions — close and reopen the app. All settings should persist.
- Delete `~/.wotch/settings.json` — app should launch with defaults and recreate the file
- Replace file contents with invalid JSON (`{{{`) — app should launch with defaults, not crash
- Replace file contents with an empty object (`{}`) — app should launch with defaults for all missing keys

---

## High — Recently Shipped Integration Features

### 4. Claude Code Hook Receiver (localhost:19520)

The hook receiver listens for 24 lifecycle events from Claude Code.

**Verify:**
- With Claude Code running in a Wotch terminal, the pill's status dot changes color to reflect Claude's state:
  - **Thinking** (processing a prompt)
  - **Working** (running tools/writing code)
  - **Waiting** (waiting for user input)
  - **Done** (task complete)
  - **Error** (something failed)
- Status reverts to idle when Claude Code exits
- Hook receiver recovers if Claude Code disconnects and reconnects
- Verify the server is only bound to localhost (not 0.0.0.0) — `netstat -an | findstr 19520`

### 5. MCP Server Auto-Configuration

Wotch exposes tools (checkpoints, git status, notifications) to Claude Code via MCP.

**Verify:**
- `~/.claude.json` contains the Wotch MCP server entry after first launch
- Claude Code can discover and call Wotch's MCP tools
- MCP server responds correctly when Claude Code requests git status or creates a checkpoint
- Removing the MCP entry from `~/.claude.json` and restarting Wotch re-adds it

### 6. Local API Server (localhost:19519)

HTTP + WebSocket API for external tool access with bearer token authentication.

**Verify:**
- Authenticated requests (correct bearer token) return expected data
- Unauthenticated requests are rejected with 401
- Requests with an incorrect token are rejected
- DNS rebinding protection: requests with a `Host` header that is not `localhost` or `127.0.0.1` are rejected
- WebSocket connections require the same token auth
- Server is bound to localhost only — `netstat -an | findstr 19519`

### 7. SSH Terminals

Remote terminal connections via ssh2.

**Verify:**
- Connect with password authentication
- Connect with key-based authentication (RSA, Ed25519)
- First connection to a new host prompts for host key verification
- Subsequent connections to the same host do not prompt (key is in known_hosts)
- Connection failure (wrong password, unreachable host) shows a clear error, not a crash
- Closing an SSH tab cleanly terminates the connection
- Terminal resize events propagate to the remote PTY

---

## Medium — UX Polish and Cross-Platform

### 8. Position Modes (Top / Left / Right)

The pill and panel can be positioned on different screen edges.

**Verify:**
- Switch between top, left, and right positions in settings
- Pill appears on the correct edge in each mode
- Panel expands in the correct direction
- Bottom bar shortcuts are visible and correctly stacked in all positions
- Resize handles work correctly in each position

### 9. Hover and Pin Behavior

The panel reveals on hover and can be pinned open.

**Verify:**
- Hovering over the pill expands the panel
- Moving the cursor away from the panel collapses it (when not pinned)
- Pin mode keeps the panel open when clicking outside
- Global hotkey (Ctrl+`) toggles the panel regardless of pin state
- Hover toggle setting (if disabled) prevents hover-to-reveal, requiring hotkey only

### 10. Multi-Tab and Directory Persistence

Tabs track working directories via OSC 7 escape sequences.

**Verify:**
- Open 3+ tabs, `cd` to different directories in each
- Close and reopen the app — each tab should restore its last working directory
- New tab opens in the default shell directory (or last-used directory, per settings)
- Drag-to-reorder tabs maintains correct terminal-to-tab mapping
- Tab status indicators reflect running/idle state correctly

### 11. Copy-on-Select

Text selection automatically copies to clipboard.

**Verify:**
- Select text in the terminal by clicking and dragging — it should auto-copy
- Paste the copied text in another application to confirm
- Selection does not interfere with normal terminal mouse events (e.g., in vim or htop)
- Copy-on-select works in split panes across all pane positions

### 12. Command Palette (Ctrl+Shift+P)

Quick access to commands with fuzzy filtering.

**Verify:**
- Opens with Ctrl+Shift+P
- Typing filters commands with fuzzy matching
- Selecting a command executes it
- Escape or clicking outside closes the palette
- All expected commands are listed (new tab, new split, toggle pin, change theme, etc.)

---

## Lower Priority — Advanced Features

### 13. Agent SDK

Embedded Claude agents with graduated trust and approval workflows.

**Verify:**
- Agent approval prompt appears for dangerous commands (rm, git push --force, etc.)
- Approving allows the command to execute
- Denying blocks the command
- Emergency stop halts a running agent immediately
- Sub-agent depth limit is enforced (agents cannot spawn infinite sub-agents)
- Agent file sandbox prevents access outside the project directory

### 14. Plugin SDK

Sandboxed plugin system with permissions.

**Verify:**
- A plugin can be loaded and its lifecycle hooks fire (init, activate, deactivate)
- Plugin sandbox prevents filesystem access outside its allowed scope
- Plugin settings are isolated from core settings and other plugins
- A crashing plugin does not bring down the main application
- Plugin permissions are enforced (a plugin without network permission cannot make HTTP requests)

### 15. Claude API Chat Panel

Direct Anthropic API integration with context injection.

**Verify:**
- API key can be saved and is stored encrypted (via Electron safeStorage)
- Chat panel sends messages and receives streaming responses
- Context injection toggles work: terminal buffer and git diffs can be included in the conversation
- Invalid or expired API key shows a clear error message
- Chat history persists across panel open/close (within the same session)

---

## Cross-Platform Matrix

If testing on multiple platforms, verify these platform-specific behaviors:

| Feature | Windows | macOS (notch) | macOS (non-notch) | Linux X11 | Linux Wayland |
|---|---|---|---|---|---|
| Pill position | Top center | Centered on notch | Top center | Top center | Top center |
| Hover-to-reveal | Works | Works | Works | Works | Hotkey only (no cursor pos) |
| Global hotkey | Ctrl+` | Cmd+` | Cmd+` | Ctrl+` | Ctrl+` |
| Default shell | PowerShell | zsh | zsh | bash/zsh | bash/zsh |
| Always-on-top | Works | Works | Works | Works | Compositor-dependent |
| Multi-monitor | Display selector | Display selector | Display selector | Display selector | Limited |

---

## Security Spot Checks

These map to invariants in `INVARIANTS.md` — verify they haven't regressed:

- **INV-SEC-001:** Context isolation is enabled (`contextIsolation: true` in BrowserWindow)
- **INV-SEC-002:** No remote URLs are loaded (only local files via `file://` protocol)
- **INV-SEC-003:** IPC channels are scoped — renderer cannot invoke arbitrary main-process functions
- **INV-SEC-004:** No command injection — user input is never interpolated into shell commands
- **INV-SEC-005:** SSH credentials are not logged or written to disk in plaintext
- **INV-SEC-010:** API credentials are encrypted with Electron safeStorage
- **INV-SEC-011:** Plugin sandboxing prevents privilege escalation

---

## Future: Automated Testing

Priority areas for automated test coverage when a framework is adopted:

1. **Unit tests** for pane tree operations (split, close, navigate) — pure data structure logic
2. **Unit tests** for settings load/save with corruption recovery
3. **Unit tests** for enhanced status detector (hook data + regex fallback fusion)
4. **Integration tests** for hook receiver HTTP endpoints
5. **Integration tests** for API server auth and DNS rebinding protection
6. **E2E tests** for basic app lifecycle (launch, create tab, type command, close)
