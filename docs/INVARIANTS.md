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

### INV-SEC-005: SSH Credential Handling
Private key contents, passwords, and key passphrases must never be stored in settings, logs, or the renderer process state. They exist transiently in main process memory during connection establishment only. SSH profiles store only the key file *path*, never key contents. Passwords are prompted each time.

**Rationale:** Storing credentials on disk would create a high-value target. Transient memory exposure during connection is inherent to the architecture (renderer can't access ssh2 directly per INV-SEC-001).

**Enforcement:** Code review. `sshProfiles` array must never contain `password` or `privateKey` fields. The `save-settings` handler preserves `sshProfiles` via dedicated handlers, never from renderer-supplied settings objects.

## Data Integrity (continued)

### INV-DATA-004: SSH Session Map Consistency
Every entry in the `sshSessions` Map must correspond to a live SSH connection. When a shell channel closes, the entry must be cleaned up. When a tab is killed or the app quits, SSH clients must be ended and channels closed. Mirrors INV-DATA-002 for PTY processes.

**Rationale:** Orphaned SSH connections leak network sockets and can leave remote shells running.

**Enforcement:** Cleanup in stream close handler, pty-kill handler, and app will-quit handler.

### INV-DATA-005: sshProfiles Isolation
`settings.sshProfiles` must only be modified through the `ssh-save-profile` and `ssh-delete-profile` IPC handlers. The general `save-settings` handler must preserve the existing `sshProfiles` value (not overwrite from renderer-supplied objects).

**Rationale:** The renderer's `debouncedSave()` does not include `sshProfiles` in its payload. Without this invariant, every settings save would silently delete all SSH profiles.

**Enforcement:** The `save-settings` handler stores `settings.sshProfiles` before `Object.assign` and restores it after.

## UI / UX

### INV-UX-001: Always-on-Top
The Wotch window must always remain above other windows. If the OS or window manager demotes it (e.g., on blur), the app must re-assert always-on-top.

**Rationale:** The entire value proposition depends on Wotch being visible at all times.

**Enforcement:** Re-assert in the `blur` event handler.

### INV-UX-002: Pill Must Always Be Visible
The pill must always be visible and positioned on the configured edge (top, left, or right) of the target display (primary by default, configurable via `displayIndex`). It must never be moved off-screen, hidden behind other elements, or become unclickable. If the target display is disconnected, the pill must fall back to the primary display. For left/right positions, the expanded panel height is clamped to the work area height to prevent off-screen overflow.

**Rationale:** If the user can't see or reach the pill, they can't use Wotch.

**Enforcement:** Position calculation uses `getTargetDisplay()` which falls back to `screen.getPrimaryDisplay()`. All positions use `display.workArea` to respect taskbars and menu bars. `display-removed` event handler resets `displayIndex` and repositions.

### INV-UX-003: Pin Prevents Hover Collapse
When pinned (`isPinned === true`), the panel must not collapse due to mouse leaving the hover zone. Only the toggle hotkey or explicit unpin should collapse a pinned panel.

**Rationale:** Pin mode exists specifically to keep the panel open while working in other windows.

**Enforcement:** `collapse()` checks `isPinned` and returns early if true.

### INV-UX-004: Hotkey Always Toggles
The global hotkey (Ctrl+` / Cmd+`) must always toggle the panel, regardless of pin state, focus state, or expansion state.

**Rationale:** The hotkey is the universal escape hatch, especially on Wayland where hover doesn't work.

**Enforcement:** `toggle()` unconditionally flips the expanded state.

### INV-UX-005: Split Pane Tree Integrity
Each tab's `rootNode` must be a valid tree where every leaf node's `paneId` corresponds to a live entry in `paneMap`, and every `paneMap` entry corresponds to an active PTY process. When a pane is closed, it must be removed from both `paneMap` and `ptyProcesses`, and its sibling must be promoted in the tree. `activePaneId` must always point to an existing pane in the current tab's tree.

**Rationale:** A dangling pane reference (paneId in tree but not in paneMap) causes null-pointer crashes on terminal focus, resize, or data routing. An orphaned PTY (in ptyProcesses but not in any tree) leaks system resources.

**Enforcement:** `closePaneById()` removes from paneMap, kills PTY, and updates activePaneId before re-rendering. `closeTab()` walks the entire tree via `getAllPaneIds()` to kill all PTYs.

## Cross-Platform

### INV-PLAT-001: Wayland Graceful Degradation
On Wayland, if `screen.getCursorScreenPoint()` returns only (0,0) for 10+ consecutive checks, the app must disable mouse polling and switch to hotkey-only mode. It must not crash, spin, or show broken hover behavior.

**Rationale:** Wayland compositors block global cursor position for security. The app must still be fully usable.

**Enforcement:** `waylandCursorBroken` flag and early-return logic in mouse tracker.

### INV-PLAT-002: macOS Notch Awareness
On macOS, the pill Y position must account for notch/non-notch displays. Notch Macs: `y=0`. Non-notch Macs: `y=menuBarHeight`. The app must never render the pill behind the menu bar where it can't be hovered.

**Rationale:** On non-notch Macs the menu bar blocks mouse events at y=0.

**Enforcement:** `getTopOffset()` checks `HAS_NOTCH` and adjusts.

### INV-SEC-006: Hook Receiver Localhost Binding
The hook receiver HTTP server must bind to `127.0.0.1` only. It must never bind to `0.0.0.0` or any external interface.

**Rationale:** The hook receiver accepts Claude Code lifecycle events. Binding to an external interface would allow remote attackers to inject fake hook events and manipulate status display.

**Enforcement:** `HookReceiver` constructor hardcodes `'127.0.0.1'` in `server.listen()`. Code review.

### INV-SEC-007: MCP Tools Must Not Expose Destructive Operations
MCP tools exposed to Claude Code must never allow: file write/delete, shell command execution, git push/reset/rebase/force operations, settings modification, SSH credential access, or PTY write (typing into terminals).

**Rationale:** Claude Code has full tool access. Exposing destructive operations via MCP would allow Claude to make irreversible changes to the user's system without explicit terminal interaction.

**Enforcement:** Code review of `mcp-server.js` tool definitions. Only read operations and additive-only operations (checkpoint) are allowed.

### INV-SEC-008: MCP IPC Server Localhost Binding
The MCP IPC TCP server must bind to `127.0.0.1` only, same as INV-SEC-006.

**Enforcement:** `MCPIPCServer` hardcodes `'127.0.0.1'` in `server.listen()`.

### INV-SEC-009: API Localhost Binding
The API server must bind exclusively to `127.0.0.1`. It must never listen on `0.0.0.0`, `::`, or any network interface. The `server.listen()` call must always specify `'127.0.0.1'` as the hostname.

**Rationale:** Network-accessible API with bearer token auth (no TLS) would expose the token and all terminal data to network sniffers.

**Enforcement:** Code review. The listen call must include the hostname parameter.

### INV-SEC-010: API Token Storage Permissions
The `~/.wotch/api-token` file must be written with mode `0o600` (owner read/write only). The token must never be logged, sent to the renderer (except via explicit `api-copy-token` IPC), or included in error messages.

**Rationale:** The token is the sole authorization mechanism for the API. Exposure compromises all API-accessible data.

**Enforcement:** Code review. Check `fs.writeFileSync` calls for the token file.

### INV-SEC-011: DNS Rebinding Protection
Every HTTP request and WebSocket upgrade must validate the `Host` header against a whitelist of localhost aliases (`localhost`, `127.0.0.1`, `[::1]`, with optional port). Requests with any other Host value must be rejected with 403 before any processing occurs.

**Rationale:** DNS rebinding attacks can bypass the localhost binding by making the browser send requests to `127.0.0.1` with a malicious Host header.

**Enforcement:** Code review. The validation function must run before routing, auth, and body parsing.

### INV-SEC-012: API Token Comparison
API token comparison must use `crypto.timingSafeEqual()`, not `===` or `.includes()`. This applies to both HTTP bearer token validation and WebSocket auth message validation.

**Rationale:** Timing side-channels in string comparison can leak token bytes one at a time.

**Enforcement:** Code review.

### INV-SEC-013: No SSH Profile Exposure via API
The API must never include `settings.sshProfiles` in any response or WebSocket event. The `GET /v1/settings` endpoint must strip it. The `PATCH /v1/settings` endpoint must reject it. The `settings:changed` WebSocket event must exclude it.

**Rationale:** SSH profiles contain hostnames, usernames, and key file paths. Combined with terminal access, this could facilitate lateral movement by a compromised local process.

**Enforcement:** Code review. Grep for `sshProfiles` in `api-server.js`.

### INV-SEC-014: API Key Encryption at Rest
The Anthropic API key must always be encrypted before writing to disk. It must never be stored in plaintext in any file. The `~/.wotch/credentials` file must contain only the encrypted (Base64-encoded) key, never the raw key. Uses Electron `safeStorage` (OS keychain) when available, falls back to AES-256-GCM with machine-derived key.

**Rationale:** An API key stored in plaintext would be trivially stolen by any process with read access to the user's home directory.

**Enforcement:** `CredentialManager.setKey()` always encrypts. No other code path writes to the credentials file. File mode is `0o600`.

### INV-SEC-015: API Key Never in Renderer
The decrypted API key must never be sent to the renderer process via IPC. The `getKey()` method has no IPC handler. The renderer can only check `hasKey()` (boolean) and call `setKey()`/`deleteKey()`/`validateKey()`.

**Rationale:** The renderer is the less-trusted process (it renders terminal output that could theoretically be crafted). If the renderer had the API key, a compromised renderer could exfiltrate it.

**Enforcement:** Code review of `preload.js` and IPC handlers. No IPC handler returns the decrypted key.

### INV-DATA-006: Conversation Persistence Resilience
If conversation JSON files in `~/.wotch/conversations/` are missing, corrupted, or contain invalid JSON, the app must handle gracefully — skip the file and continue. Loading conversations must never crash the app.

**Rationale:** Conversation files may be corrupted by a crash during write, manually edited, or deleted by the user.

**Enforcement:** try/catch around JSON.parse in all conversation loading code.

### INV-SEC-017: Plugin Isolation
Plugins running in the main process execute inside `vm.createContext()` sandboxes with no access to `require`, `process`, `__dirname`, or any Node.js globals beyond basic JS builtins and the permission-gated `wotch` API. Renderer plugins run in `<iframe sandbox="allow-scripts">` with no `allow-same-origin`. Plugins cannot access each other's state, memory, or subscriptions.

**Rationale:** A plugin must not be able to access Node.js APIs directly (file system, network, child processes) without going through the permission system. Cross-plugin isolation prevents a malicious plugin from tampering with or reading data from other plugins.

**Enforcement:** `vm.createContext` with `codeGeneration: { strings: false, wasm: false }`. Renderer iframes lack `allow-same-origin`. Code review of sandbox setup. Each plugin gets its own API proxy instance.

### INV-SEC-018: Plugin Permission Enforcement
Every permission-gated API call must check permissions at the API boundary (in `createPluginApi`) before executing. Permission checks must use a capability-based model — the API proxy is constructed with only the methods the plugin is allowed to call. Unpermitted calls throw `PermissionDeniedError` synchronously.

**Rationale:** If permission checks were done inside the implementation rather than at the boundary, a code path might accidentally bypass them. The capability model ensures a plugin physically cannot call a method it lacks permission for.

**Enforcement:** Code review. The `createPluginApi` function gates each namespace method with `requirePermission()`.

### INV-DATA-007: Plugin Settings Isolation
Plugin settings are stored under `settings.plugins.<name>` in `~/.wotch/settings.json`. Each plugin's settings are namespaced by plugin name. Plugin settings are preserved when general settings are saved or reset. Disabling a plugin does not delete its settings or storage data.

**Rationale:** Plugins should not lose user configuration when disabled/re-enabled. Plugin settings must not collide with core settings or each other.

**Enforcement:** Plugin settings are accessed exclusively via `settings.plugins[pluginId].settings`. The `reset-settings` handler preserves `plugins`. Plugin storage is in a separate `~/.wotch/plugin-data/<name>/` directory.

## Agents

### INV-AGENT-001: Agent Process Isolation
Agents run in the Electron main process but have no direct access to Electron APIs (BrowserWindow, ipcMain, etc.). They interact with the system exclusively through the ToolRegistry. Agent code cannot import Electron modules or access the `mainWindow` object.

**Rationale:** Direct Electron API access would let an agent manipulate the UI, register IPC handlers, or bypass the trust model entirely.

**Enforcement:** Agent tools are injected functions, not module references. The AgentRuntime never passes Electron objects to tool implementations.

### INV-AGENT-002: Agent File Sandbox
All file operations by agents are sandboxed to the project directory. The `ensureInProject()` function resolves paths and verifies they are within the project root. Path traversal (`..`) that escapes the project is rejected. Symlinks pointing outside the project directory are rejected.

**Rationale:** An agent with file write access must not be able to modify system files, SSH keys, or Wotch's own configuration.

**Enforcement:** Every FileSystem tool calls `ensureInProject()` before any fs operation. The function uses `path.resolve()` and `startsWith()` checks.

### INV-AGENT-003: Agent API Key Isolation
The Anthropic API key used by agents is stored in the main process only (via the existing CredentialManager). It is never sent to the renderer process. The AgentRuntime receives the key directly from `credentialManager.getKey()`.

**Rationale:** The renderer is the less-trusted process. API key exposure in the renderer would allow exfiltration via crafted terminal output.

**Enforcement:** No IPC handler returns the API key. Code review of agent IPC channels.

### INV-AGENT-004: Agent Shell Safety
Shell commands executed by agents use `pty.spawn` with explicit arguments. The `Shell.execute` tool runs commands in a temporary PTY (not the user's visible terminal). Dangerous command patterns (rm -rf, git push --force, sudo, etc.) are detected and always require approval regardless of trust mode.

**Rationale:** Shell execution is the highest-risk agent capability. Separating agent PTYs from user terminals prevents interference, and dangerous pattern detection prevents catastrophic commands.

**Enforcement:** `DANGEROUS_COMMAND_PATTERNS` regex array in main.js. The `_needsApproval()` method in AgentRuntime checks all patterns.

### INV-AGENT-005: Dangerous Action Approval
Actions classified as `dangerous` (file deletion, force push, etc.) require explicit user approval in ALL trust modes, including `auto-execute`. There is no mode that bypasses all approvals.

**Rationale:** Certain actions are irreversible. Even a fully trusted agent should not delete files or force-push without human confirmation.

**Enforcement:** `_needsApproval()` returns `true` for `dangerous` danger level regardless of trust mode.

### INV-AGENT-006: Emergency Stop
Emergency stop (Ctrl+Shift+K) aborts all running agents within 500ms by setting `cancelled = true` on every AgentRuntime and resolving all pending approval promises as "stop". No agent code can block, catch, or prevent emergency stop. After emergency stop, each affected agent's trust level is automatically demoted by one tier.

**Rationale:** The user must always have an immediate escape hatch. An agent that blocks emergency stop would be a critical safety failure.

**Enforcement:** `emergencyStopAll()` method iterates all runtimes synchronously. The `cancelled` flag is checked at every loop iteration and tool boundary.

### INV-SEC-019: IDE Bridge Security
The IDE Bridge WebSocket server must bind to `127.0.0.1` only. Authentication uses a per-startup random token (`crypto.randomBytes(24)`) written to `~/.claude/ide/[PORT].lock` with `0o600` permissions. The `X-Claude-Code-Ide-Authorization` header is validated on every WebSocket upgrade. Host header validation prevents DNS rebinding. The lockfile is deleted on app shutdown.

**Rationale:** The bridge exposes the same tools as the MCP server. Without localhost binding, auth token, and DNS rebinding protection, a remote attacker could call Wotch tools (read terminal, create checkpoints, get project info).

**Enforcement:** `BridgeServer` constructor hardcodes `host: "127.0.0.1"` in `WebSocket.Server()`. `verifyClient` callback validates auth token and Host header. Lockfile written with `mode: 0o600`.

### INV-AGENT-007: Sub-Agent Depth Limit
Sub-agent spawning via `Agent.spawn` is limited to a maximum nesting depth of `MAX_AGENT_DEPTH = 3`. Each spawned sub-agent counts toward the global `maxConcurrentAgents` limit. Stopping a parent agent cascades to all its descendants recursively. Sub-agents inherit project context but get their own conversation loop, tool instances, and approval queue.

**Rationale:** Without depth limits, a recursive or runaway agent could spawn infinite sub-agents, exhausting API credits and system resources. The cascading stop ensures no orphaned agent runs persist after a parent is halted.

**Enforcement:** `Agent.spawn` tool checks `context._agentDepth` before spawning. `AgentRuntime.stop()` iterates `childRunIds` and stops each recursively. `AgentManager.startAgent()` enforces `maxConcurrentAgents` globally.

## Invariant Change Log

| Date | Invariant | Change | Reason |
|------|-----------|--------|--------|
| 2026-03-28 | All | Initial creation | Project documentation setup |
| 2026-03-28 | INV-SEC-004 | Git commit now uses execFileSync with args array | Eliminates shell injection in checkpoint messages |
| 2026-03-28 | INV-UX-002 | Updated for multi-monitor support | Pill can now target any display, falls back to primary on disconnect |
| 2026-03-28 | INV-UX-002 | Updated for customizable position | Pill can sit on top, left, or right edge; uses workArea for accurate placement; clamps expanded panel to screen bounds |
| 2026-03-28 | INV-SEC-005, INV-DATA-004, INV-DATA-005 | Added for SSH support | SSH credentials never persisted; SSH session map follows same cleanup pattern as PTY map; sshProfiles isolated from general settings saves |
| 2026-03-31 | INV-SEC-006, INV-SEC-007, INV-SEC-008 | Added for Claude Code deep integration | Hook receiver and MCP IPC server localhost-only; MCP tools read-only + additive |
| 2026-03-31 | INV-SEC-009 through INV-SEC-013 | Added for Local API | API localhost-only, token file permissions, DNS rebinding protection, timing-safe comparison, SSH profile redaction |
| 2026-03-31 | INV-SEC-014, INV-SEC-015, INV-DATA-006 | Added for Claude API integration | API key encryption at rest, API key never in renderer, conversation persistence resilience |
| 2026-03-31 | INV-SEC-017, INV-SEC-018, INV-DATA-007 | Added for Plugin SDK | Plugin vm/iframe isolation, permission boundary enforcement, plugin settings isolation |
| 2026-03-31 | INV-AGENT-001 through INV-AGENT-006 | Added for Agent SDK | Agent process isolation, file sandbox, API key isolation, shell safety, dangerous action approval, emergency stop |
| 2026-03-31 | INV-AGENT-007 | Added for sub-agent spawning | Depth limit, cascading stop, global concurrent limit enforcement |
| 2026-03-31 | INV-SEC-019 | Added for IDE Bridge | Bridge WebSocket localhost-only, token auth, DNS rebinding protection, lockfile cleanup |
| 2026-03-31 | INV-UX-005 | Added for split panes | Pane tree integrity, paneMap consistency, activePaneId validity |
