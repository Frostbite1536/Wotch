# Plan 0: Implementation Steps

## Overview

Step-by-step build guide for the Claude Code deep integration. Each step is independently testable and mergeable. The implementation order minimizes risk by starting with the least invasive change (enhanced detector scaffolding) and progressively adding channels.

---

## Prerequisites

- Node.js 20+
- Wotch development environment (`npm install && npm start`)
- Claude Code installed (`claude` command available)
- Familiarity with `src/main.js`, `src/preload.js`, `src/renderer.js`, `src/index.html`

---

## Step 1: Enhanced Status Detector Scaffolding

**Goal**: Create the multi-source status detector and wire it alongside the existing regex detector without changing any behavior.

### 1.1 Create `src/enhanced-status-detector.js`

Create the `EnhancedClaudeStatusDetector` class as specified in `05-enhanced-status-detection.md`. Two sources: hooks and regex. Initially, only the regex source is active.

### 1.2 Create `src/claude-integration-manager.js`

Create the `ClaudeIntegrationManager` class as specified in `01-architecture.md`. At this stage, it instantiates only the enhanced detector and wraps the existing regex detector.

### 1.3 Modify `src/main.js`

- Import `ClaudeIntegrationManager`
- Instantiate it after `ClaudeStatusDetector`
- Wire the existing detector's events into the enhanced detector as the regex source
- Keep all existing IPC handlers unchanged — they still read from the old detector

### 1.4 Test

- `npm start` — verify app launches normally
- Claude Code status detection works exactly as before
- No new ports opened, no new config files modified
- Console logs show enhanced detector receiving regex events

**Lines changed**: ~50 in main.js, ~180 new in enhanced-status-detector.js, ~80 new in claude-integration-manager.js

---

## Step 2: Hook Receiver

**Goal**: Add the HTTP hook receiver server and wire it into the enhanced detector.

### 2.1 Create `src/hook-receiver.js`

Implement the `HookReceiver` class as specified in `02-hooks-integration.md`. Accepts HTTP POST requests at `/hook/<EventType>` paths. Parses the body as JSON (Claude Code's hook stdin payload).

### 2.2 Modify `src/claude-integration-manager.js`

- Instantiate `HookReceiver` with configured port
- Wire `hook-event` events to `EnhancedClaudeStatusDetector.updateFromSource()`
- Add hook-to-status mapping logic (`mapHookToStatus()` function)
- Add session-to-tab mapping (track `session_id` → `tabId` via `cwd` matching on `SessionStart`)

### 2.3 Modify `src/main.js`

- Start hook receiver in `app.whenReady()` callback
- Stop hook receiver in `app.on('before-quit')` handler
- Add settings for `integration.hooksEnabled` and `integration.hooksPort`
- Add default settings values

### 2.4 Add auto-configuration

- Add `configureClaudeHooks()` function to main.js
- Writes `type: http` hooks to `~/.claude/settings.json` for 12 subscribed events
- Call on startup if `integration.autoConfigureHooks` is true and `~/.claude/` exists
- Show first-run confirmation dialog before modifying Claude Code settings
- Never overwrite existing hooks (append only, idempotent)

### 2.5 Modify `src/preload.js`

- Add `window.wotch.getIntegrationStatus()` method (IPC `integration-status`)

### 2.6 Test

- Start Wotch → verify hook receiver starts on port 19520
- `curl -X POST http://localhost:19520/hook/PreToolUse -H 'Content-Type: application/json' -d '{"session_id":"test-123","tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"/tmp","hook_event_name":"PreToolUse"}'` → verify 200 response
- Verify enhanced detector receives hook event and maps it to `working` state
- Check `~/.claude/settings.json` has `type: http` hooks (not `type: command` with curl)
- Launch Claude Code with hooks configured → verify status updates arrive via hooks
- Kill hook receiver → verify regex fallback activates
- Test rate limiting: send 200 requests in 1 second → verify 429 after 100

**Lines changed**: ~150 new in hook-receiver.js, ~80 in claude-integration-manager.js, ~40 in main.js, ~5 in preload.js

---

## Step 3: MCP Server

**Goal**: Expose Wotch as an MCP server that Claude Code can discover and use.

### 3.1 Install dependency

```bash
npm install @modelcontextprotocol/sdk
```

### 3.2 Create `src/mcp-server.js`

Implement the standalone MCP server script as specified in `03-mcp-server.md`. This runs as a separate Node.js process launched by Claude Code via stdio transport.

### 3.3 Create MCP IPC server in `src/main.js`

- Add `MCPIPCServer` class (TCP server on port 19523, bound to 127.0.0.1)
- Register handlers for: `gitCheckpoint`, `gitGetStatus`, `gitGetDiff`, `getProjectInfo`, `terminalBuffer`, `notify`, `listTabs`, `tabStatus`
- Start in `app.whenReady()`, stop in `before-quit`

### 3.4 Add terminal buffer IPC

The `wotch_terminal_buffer` MCP tool needs to read xterm.js buffer content from the renderer:

- **main.js**: Handler for MCP `terminalBuffer` request → sends `terminal-buffer-read` to renderer → waits for response
- **preload.js**: Add `onTerminalBufferRead` and `sendTerminalBuffer` methods
- **renderer.js**: Listen for `terminal-buffer-read`, extract text from xterm.js `Terminal.buffer`, send back via IPC

### 3.5 Auto-register MCP server

- Add `registerMCPServer()` function to main.js
- Write Wotch MCP server entry to **`~/.claude.json`** (NOT `~/.claude/settings.json`)
- Config format: `{ "type": "stdio", "command": "node", "args": [...], "env": {...} }`
- Call on startup if `integration.autoRegisterMCP` is true

### 3.6 Add settings

- `integration.mcpEnabled` (default: true)
- `integration.mcpTransport` (default: "stdio")
- `integration.mcpIpcPort` (default: 19523)

### 3.7 Test

- Start Wotch → verify MCP IPC server starts on port 19523
- Run `node src/mcp-server.js` manually with `WOTCH_IPC_PORT=19523` → verify it connects
- Check `~/.claude.json` has `wotch` entry with `"type": "stdio"` (not missing type field)
- Configure MCP server in Claude Code → launch Claude Code → verify `wotch_*` tools appear
- Ask Claude Code to "create a checkpoint using wotch" → verify checkpoint created
- Ask Claude Code to "check git status via wotch" → verify correct status returned
- Kill Wotch → verify MCP server exits cleanly

**Lines changed**: ~250 new in mcp-server.js, ~120 in main.js, ~15 in preload.js, ~20 in renderer.js

### 3.8 Package the MCP server script

- Add `src/mcp-server.js` to electron-builder's `extraResources` so it's available at a known path in the installed app
- Update `registerMCPServer()` to use the correct path based on `app.isPackaged`

---

## Step 4: Switch Status Detection to Enhanced Detector

**Goal**: Route all status IPC through the enhanced detector instead of the old regex detector.

### 4.1 Modify `src/main.js`

- Replace all `claudeStatus.getStatus(tabId)` calls with `integrationManager.getStatus(tabId)`
- Replace all `claudeStatus.on('status-changed', ...)` listeners with `integrationManager.statusDetector.on('status-changed', ...)`
- Keep the old `ClaudeStatusDetector` instantiated (it's a source for the enhanced detector)

### 4.2 Update IPC payload

- The `claude-status` IPC event now sends the enhanced status object (with `source`, `tool`, `file` fields)
- Ensure backward compatibility: renderer handles both old and new formats

### 4.3 Update renderer.js

- Read enhanced fields from status events
- Update pill label to show tool-specific descriptions when available
- Add source badge in debug/settings mode

### 4.4 Test

- Verify pill shows "Editing main.js" instead of "Working..." when hooks are active
- Verify pill shows "Working..." when only regex is available
- Verify all existing pill behavior (colors, transitions, idle timeout) still works
- Verify per-tab status isolation

**Lines changed**: ~30 in main.js, ~40 in renderer.js

---

## Step 5: Settings UI

**Goal**: Add integration status display and configuration to the settings panel.

### 5.1 Modify `src/index.html`

Add a new "Claude Code Integration" section to the settings panel:

```html
<div class="settings-section">
  <h3>Claude Code Integration</h3>
  <div class="integration-channels">
    <div class="channel-row">
      <span class="channel-dot" id="hooks-dot"></span>
      <span>Hooks</span>
      <label class="toggle">
        <input type="checkbox" id="setting-hooks-enabled">
        <span class="toggle-slider"></span>
      </label>
    </div>
    <div class="channel-row">
      <span class="channel-dot" id="mcp-dot"></span>
      <span>MCP Server</span>
      <label class="toggle">
        <input type="checkbox" id="setting-mcp-enabled">
        <span class="toggle-slider"></span>
      </label>
    </div>
  </div>
  <button id="btn-reconfigure-hooks">Reconfigure Hooks</button>
  <button id="btn-reregister-mcp">Re-register MCP</button>
</div>
```

### 5.2 Modify `src/renderer.js`

- Poll integration status every 5 seconds via IPC
- Update channel dots (green = active, gray = inactive)
- Wire toggle switches to settings save
- Wire reconfigure buttons to IPC handlers

### 5.3 Add CSS for all 4 themes

- Channel dot colors
- Channel row layout
- Toggle switch styling (reuse existing pattern)

### 5.4 Test

- Open settings → verify integration section visible
- Toggle hooks off → verify hook receiver stops
- Toggle hooks on → verify hook receiver restarts
- Check channel dots reflect actual connection state
- Click "Reconfigure Hooks" → verify `~/.claude/settings.json` updated with `type: http` hooks
- Click "Re-register MCP" → verify `~/.claude.json` updated
- Verify all 4 themes render the section correctly

**Lines changed**: ~50 in index.html, ~70 in renderer.js, ~5 in preload.js

---

## Step 6: Documentation & Invariants

**Goal**: Update project documentation to reflect the new integration layer.

### 6.1 Update `docs/INVARIANTS.md`

Add new invariants:
- **INV-SEC-006**: Hook receiver binds to 127.0.0.1 only
- **INV-SEC-007**: MCP tools must not expose destructive operations

### 6.2 Update `docs/ARCHITECTURE.md`

Add new section describing the ClaudeIntegrationManager, two channels, and enhanced status detector.

### 6.3 Update `docs/THREAT_MODEL.md`

Add new attack surfaces: hook receiver HTTP endpoint, MCP IPC server.

### 6.4 Update `prompts/engineering.md`

Add the new files (hook-receiver.js, mcp-server.js, etc.) to the architecture overview. Document the new IPC channels, settings, and config file locations (`~/.claude/settings.json` for hooks, `~/.claude.json` for MCP).

### 6.5 Update `CHECKLIST.md`

Add checklist items for integration channel testing.

---

## Implementation Timeline

```
Step 1: Enhanced detector scaffolding     ████
Step 2: Hook receiver + auto-config       ████████
Step 3: MCP server                        ████████████
Step 4: Switch to enhanced detector       ████
Step 5: Settings UI                       ██████
Step 6: Documentation                     ████
```

Steps 1–3 can be merged individually. Step 4 depends on Steps 1–2. Steps 5–6 can proceed in parallel with Step 3.

---

## File Summary

### New Files

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/enhanced-status-detector.js` | ~180 | Two-source status fusion |
| `src/claude-integration-manager.js` | ~120 | Central coordinator |
| `src/hook-receiver.js` | ~150 | HTTP server for hook events |
| `src/mcp-server.js` | ~250 | Standalone MCP server script |

### Modified Files

| File | Lines changed (est.) | Nature of changes |
|------|---------------------|-------------------|
| `src/main.js` | ~180 | Integration manager setup, MCP IPC server, auto-config |
| `src/preload.js` | ~20 | New integration status methods |
| `src/renderer.js` | ~110 | Enhanced status display, settings UI logic |
| `src/index.html` | ~70 | Settings UI HTML/CSS |
| `package.json` | ~2 | New dependency |
| `docs/INVARIANTS.md` | ~15 | New invariants |
| `docs/ARCHITECTURE.md` | ~50 | New section |
| `docs/DECISIONS.md` | ~15 | Already updated |
| `docs/THREAT_MODEL.md` | ~20 | New attack surfaces |
| `prompts/engineering.md` | ~15 | Updated file list |
| `CHECKLIST.md` | ~8 | New checklist items |

### Total Estimated New/Changed Code

- New: ~700 lines across 4 files
- Modified: ~505 lines across 11 files
- **Total: ~1,205 lines**

### Configuration Files Touched (at runtime)

| File | What Wotch writes | When |
|------|-------------------|------|
| `~/.claude/settings.json` | `hooks` object with `type: http` entries | Auto-configure on first run |
| `~/.claude.json` | `mcpServers.wotch` with `type: stdio` | Auto-register on first run |
| `~/.wotch/settings.json` | `integration` settings | When user changes integration settings |
