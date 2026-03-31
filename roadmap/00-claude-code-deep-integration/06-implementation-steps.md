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

Create the `EnhancedClaudeStatusDetector` class as specified in `05-enhanced-status-detection.md`. Initially, only the regex source is active.

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

**Lines changed**: ~50 in main.js, ~200 new in enhanced-status-detector.js, ~80 new in claude-integration-manager.js

---

## Step 2: Hook Receiver

**Goal**: Add the HTTP hook receiver server and wire it into the enhanced detector.

### 2.1 Create `src/hook-receiver.js`

Implement the `HookReceiver` class as specified in `02-hooks-integration.md`.

### 2.2 Modify `src/claude-integration-manager.js`

- Instantiate `HookReceiver` with configured port
- Wire `hook-event` events to `EnhancedClaudeStatusDetector.updateFromSource()`
- Add hook-to-status mapping logic

### 2.3 Modify `src/main.js`

- Start hook receiver in `app.whenReady()` callback
- Stop hook receiver in `app.on('before-quit')` handler
- Add settings for `integration.hooksEnabled` and `integration.hooksPort`
- Add default settings values

### 2.4 Add auto-configuration

- Add `configureClaudeHooks()` function to main.js
- Call it on startup if `integration.autoConfigureHooks` is true and `~/.claude/` exists
- Show first-run confirmation dialog before modifying Claude Code settings

### 2.5 Modify `src/preload.js`

- Add `window.wotch.getIntegrationStatus()` method (IPC `integration-status`)

### 2.6 Test

- Start Wotch → verify hook receiver starts on port 19520
- `curl -X POST http://localhost:19520/hook -H 'Content-Type: application/json' -d '{"event":"PreToolUse","tool":"BashTool","session":"test-123"}'` → verify 200 response
- Verify enhanced detector receives hook event
- Launch Claude Code with hooks configured → verify status updates arrive via hooks
- Kill hook receiver → verify regex fallback activates
- Test rate limiting: send 200 requests in 1 second → verify 429 after 100

**Lines changed**: ~150 new in hook-receiver.js, ~60 in claude-integration-manager.js, ~40 in main.js, ~5 in preload.js

---

## Step 3: MCP Server

**Goal**: Expose Wotch as an MCP server that Claude Code can discover and use.

### 3.1 Install dependency

```bash
npm install @modelcontextprotocol/sdk
```

### 3.2 Create `src/mcp-server.js`

Implement the standalone MCP server script as specified in `03-mcp-server.md`. This runs as a separate Node.js process launched by Claude Code.

### 3.3 Create MCP IPC server in `src/main.js`

- Add `MCPIPCServer` class (TCP server on port 19523)
- Register handlers for: `gitCheckpoint`, `gitGetStatus`, `gitGetDiff`, `getProjectInfo`, `terminalBuffer`, `notify`, `listTabs`, `tabStatus`
- Start in `app.whenReady()`, stop in `before-quit`

### 3.4 Add terminal buffer IPC

The `wotch_terminal_buffer` MCP tool needs to read xterm.js buffer content from the renderer. Add a new IPC round-trip:

- **main.js**: Handler for MCP `terminalBuffer` request → sends `terminal-buffer-read` to renderer → waits for response
- **preload.js**: Add `onTerminalBufferRead` and `sendTerminalBuffer` methods
- **renderer.js**: Listen for `terminal-buffer-read`, extract text from xterm.js `Terminal.buffer`, send back via IPC

### 3.5 Auto-register MCP server

- Add `registerMCPServer()` function to main.js
- Call on startup if `integration.autoRegisterMCP` is true
- Write Wotch MCP server entry to `~/.claude/settings.json` under `mcpServers`

### 3.6 Add settings

- `integration.mcpEnabled` (default: true)
- `integration.mcpTransport` (default: "stdio")
- `integration.mcpIpcPort` (default: 19523)

### 3.7 Test

- Start Wotch → verify MCP IPC server starts on port 19523
- Run `node src/mcp-server.js` manually with `WOTCH_IPC_PORT=19523` → verify it connects
- Configure MCP server in Claude Code → launch Claude Code → verify `wotch_*` tools appear
- Ask Claude Code to "create a checkpoint using wotch" → verify checkpoint created
- Ask Claude Code to "check git status via wotch" → verify correct status returned
- Kill Wotch → verify MCP server exits cleanly

**Lines changed**: ~250 new in mcp-server.js, ~120 in main.js, ~15 in preload.js, ~20 in renderer.js

### 3.8 Package the MCP server script

- Add `src/mcp-server.js` to electron-builder's `extraResources` so it's available at a known path in the installed app
- Update `registerMCPServer()` to use the correct path based on `app.isPackaged`

---

## Step 4: Bridge Adapter

**Goal**: Implement the bridge client that connects to Claude Code's IDE bridge protocol.

### 4.1 Create `src/bridge-adapter.js`

Implement the `BridgeAdapter` class as specified in `04-bridge-adapter.md`. Uses the `ws` package (already a dependency for Plan 1; install now if not present).

### 4.2 Install `ws` if needed

```bash
npm install ws
```

### 4.3 Modify `src/claude-integration-manager.js`

- Instantiate `BridgeAdapter` with configured port
- Wire `state-update`, `tool-start`, `tool-end`, `context-request` events
- Map bridge state updates to enhanced detector via `updateFromSource()`
- Handle `context-request` events by gathering data from main.js

### 4.4 Modify `src/main.js`

- Set `CLAUDE_BRIDGE_PORT` environment variable in PTY spawn
- Set `WOTCH_TAB_ID` environment variable in PTY spawn
- Start bridge adapter in `app.whenReady()`
- Stop bridge adapter in `before-quit`

### 4.5 Add settings

- `integration.bridgeEnabled` (default: true)
- `integration.bridgePort` (default: 19521)

### 4.6 Test

- Start Wotch → verify bridge WebSocket server starts on port 19521
- Create new terminal tab → verify `CLAUDE_BRIDGE_PORT` is set in environment
- Launch Claude Code in tab → observe bridge connection (if Claude Code supports it)
- If bridge connects: verify state updates flow through enhanced detector
- If bridge doesn't connect: verify hooks and regex fallback work normally
- Kill Claude Code → verify clean bridge disconnection

**Lines changed**: ~200 new in bridge-adapter.js, ~40 in claude-integration-manager.js, ~30 in main.js

---

## Step 5: Switch Status Detection to Enhanced Detector

**Goal**: Route all status IPC through the enhanced detector instead of the old regex detector.

### 5.1 Modify `src/main.js`

- Replace all `claudeStatus.getStatus(tabId)` calls with `integrationManager.getStatus(tabId)`
- Replace all `claudeStatus.on('status-changed', ...)` listeners with `integrationManager.enhancedDetector.on('status-changed', ...)`
- Keep the old `ClaudeStatusDetector` instantiated (it's now a source for the enhanced detector)

### 5.2 Update IPC payload

- The `claude-status` IPC event now sends the enhanced status object (with `source`, `tool`, `file`, `line` fields)
- Ensure backward compatibility: renderer handles both old and new formats

### 5.3 Update renderer.js

- Read enhanced fields from status events
- Update pill label to show tool-specific descriptions when available
- Add source badge in debug/settings mode

### 5.4 Test

- Verify pill shows "Editing main.js" instead of "Working..." when bridge or hooks are active
- Verify pill shows "Working..." when only regex is available
- Verify all existing pill behavior (colors, transitions, idle timeout) still works
- Verify per-tab status isolation

**Lines changed**: ~30 in main.js, ~40 in renderer.js

---

## Step 6: Settings UI

**Goal**: Add integration status display and configuration to the settings panel.

### 6.1 Modify `src/index.html`

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
    <div class="channel-row">
      <span class="channel-dot" id="bridge-dot"></span>
      <span>Bridge</span>
      <label class="toggle">
        <input type="checkbox" id="setting-bridge-enabled">
        <span class="toggle-slider"></span>
      </label>
    </div>
  </div>
  <button id="btn-reconfigure-hooks">Reconfigure Hooks</button>
  <button id="btn-reregister-mcp">Re-register MCP</button>
</div>
```

### 6.2 Modify `src/renderer.js`

- Poll integration status every 5 seconds via IPC
- Update channel dots (green = active, gray = inactive, red = error)
- Wire toggle switches to settings save
- Wire reconfigure buttons to IPC handlers

### 6.3 Add CSS for all 4 themes

- Channel dot colors (using existing theme variables)
- Channel row layout
- Toggle switch styling (reuse existing pattern from settings)

### 6.4 Test

- Open settings → verify integration section visible
- Toggle hooks off → verify hook receiver stops
- Toggle hooks on → verify hook receiver restarts
- Check channel dots reflect actual connection state
- Click "Reconfigure Hooks" → verify `~/.claude/settings.json` updated
- Verify all 4 themes render the section correctly

**Lines changed**: ~60 in index.html, ~80 in renderer.js, ~5 in preload.js

---

## Step 7: Documentation & Invariants

**Goal**: Update project documentation to reflect the new integration layer.

### 7.1 Update `docs/INVARIANTS.md`

Add new invariants:
- **INV-SEC-006**: Hook receiver binds to 127.0.0.1 only
- **INV-SEC-007**: MCP tools must not expose destructive operations
- **INV-SEC-008**: Bridge adapter validates all messages against known schema

### 7.2 Update `docs/ARCHITECTURE.md`

Add new section describing the ClaudeIntegrationManager, three channels, and enhanced status detector.

### 7.3 Update `docs/DECISIONS.md`

Add decision entry for hooks-first integration approach.

### 7.4 Update `docs/THREAT_MODEL.md`

Add new attack surfaces: hook receiver HTTP endpoint, MCP IPC server, bridge WebSocket.

### 7.5 Update `prompts/engineering.md`

Add the new files (hook-receiver.js, mcp-server.js, bridge-adapter.js, etc.) to the architecture overview. Document the new IPC channels and settings.

### 7.6 Update `CHECKLIST.md`

Add checklist items for integration channel testing.

---

## Implementation Timeline

```
Step 1: Enhanced detector scaffolding     ████
Step 2: Hook receiver                     ████████
Step 3: MCP server                        ████████████
Step 4: Bridge adapter                    ████████
Step 5: Switch to enhanced detector       ████
Step 6: Settings UI                       ██████
Step 7: Documentation                     ████
```

Steps 1–4 can be merged individually. Step 5 depends on at least Steps 1–2. Steps 6–7 can proceed in parallel with Steps 3–4.

---

## File Summary

### New Files

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `src/enhanced-status-detector.js` | ~200 | Multi-source status fusion |
| `src/claude-integration-manager.js` | ~150 | Central coordinator |
| `src/hook-receiver.js` | ~150 | HTTP server for hook events |
| `src/mcp-server.js` | ~250 | Standalone MCP server script |
| `src/bridge-adapter.js` | ~200 | WebSocket bridge client |

### Modified Files

| File | Lines changed (est.) | Nature of changes |
|------|---------------------|-------------------|
| `src/main.js` | ~200 | Integration manager setup, IPC server, env vars |
| `src/preload.js` | ~25 | New bridge methods |
| `src/renderer.js` | ~120 | Enhanced status display, settings UI logic |
| `src/index.html` | ~80 | Settings UI HTML/CSS |
| `package.json` | ~3 | New dependencies |
| `docs/INVARIANTS.md` | ~20 | New invariants |
| `docs/ARCHITECTURE.md` | ~60 | New section |
| `docs/DECISIONS.md` | ~15 | New decision entry |
| `docs/THREAT_MODEL.md` | ~30 | New attack surfaces |
| `prompts/engineering.md` | ~20 | Updated file list |
| `CHECKLIST.md` | ~10 | New checklist items |

### Total Estimated New/Changed Code

- New: ~950 lines across 5 files
- Modified: ~580 lines across 11 files
- **Total: ~1,530 lines**
