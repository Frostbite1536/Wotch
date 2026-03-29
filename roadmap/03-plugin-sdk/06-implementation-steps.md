# Implementation Steps — Wotch Plugin/Extension SDK

## Step 1: Plugin Directory and Discovery

**Files:** `src/main.js`

Create `~/.wotch/plugins/` directory structure. `discoverPlugins()` scans for subdirectories containing `manifest.json`, validates each manifest, returns array of discovered plugins.

**Testing:** Valid plugin discovered. Invalid manifest skipped with warning. Missing manifest skipped.

---

## Step 2: Manifest Validation

**Files:** `src/main.js`

`validateManifest(manifest)` checks required fields (name, version, displayName, main), name format (lowercase alphanumeric with hyphens), semver version, valid permissions list, and command contributions.

Valid permissions: `fs.read`, `fs.write`, `process.exec`, `net.fetch`, `git.read`, `git.write`, `terminal.read`, `terminal.write`, `ui.panels`, `ui.notifications`.

**Testing:** Valid manifest passes. Missing fields, bad format, unknown permissions all produce errors.

---

## Step 3: Plugin Host (Main Process)

**Files:** `src/main.js`

`PluginHost` class managing plugin lifecycle: discovered → loaded → active → disposed.

- `loadAll()` — discover plugins, auto-activate enabled ones from settings
- `activate(id)` — require plugin's main file, call `activate(api)`, register commands/detectors
- `deactivate(id)` — call `deactivate()`, clean up commands and detectors
- `getPluginList()` — return list with state and permissions for UI
- `saveEnabledPlugins()` — persist to `settings.enabledPlugins`

**Lifecycle:** Call `pluginHost.loadAll()` after `app.whenReady()`.

**Testing:** Activate/deactivate lifecycle works. Error in activate → state 'error', app doesn't crash.

---

## Step 4: Plugin API (Permission-Gated)

**Files:** `src/main.js`

`createPluginApi(pluginId, grantedPermissions)` returns an API object with:

**Always available (no permissions):**
- `commands.register(id, title, handler)` — register command in palette
- `status.registerDetector(detector)` — custom status detector
- `status.onChanged(callback)` — subscribe to status changes
- `log.info/warn/error(msg)` — prefixed logging
- `settings.register/get/set` — per-plugin settings under `settings.pluginData[pluginId]`

**Permission-gated:**
- `fs.readFile/writeFile/listDir` — requires `fs.read`/`fs.write`
- `process.exec` — requires `process.exec` (enforced timeout/cwd)
- `net.fetch` — requires `net.fetch`
- `git.status/diff/checkpoint` — requires `git.read`/`git.write`
- `terminal.onData/write` — requires `terminal.read`/`terminal.write`
- `ui.showNotification/addPanel` — requires `ui.notifications`/`ui.panels`

**Testing:** Permitted calls work. Unpermitted calls throw "Permission denied".

---

## Step 5: Plugin IPC Bridge

**Files:** `src/preload.js`, `src/main.js`

Expose plugin management to renderer: `getPluginList`, `activatePlugin`, `deactivatePlugin`, `executePluginCommand`, `getPluginSettings`, `savePluginSetting`.

Events from main: `plugin-command-registered`, `plugin-settings-registered`, `plugin-panel-registered`, `plugin-status-update`.

---

## Step 6: Command Palette Integration

**Files:** `src/renderer.js`

Dynamic registration of plugin commands into existing command palette. Plugin commands appear with plugin name prefix.

---

## Step 7: Plugin Management UI

**Files:** `src/index.html`, `src/renderer.js`

"Plugins" section in settings panel showing installed plugins with name, description, version, permissions, and enable/disable toggle. "Install plugins to `~/.wotch/plugins/`" hint.

---

## Step 8: Plugin Status Detector Integration

**Files:** `src/main.js`

In PTY onData handler, after feeding ClaudeStatusDetector, iterate plugin status detectors. Results sent to renderer via `plugin-status-update`.

Terminal data callbacks for plugins with `terminal.read` permission.

---

## Step 9: Panel Extension Points

**Files:** `src/index.html`, `src/renderer.js`, `src/preload.js`

Plugins with `ui.panels` permission can register custom panels via `api.ui.addPanel()`. Panels appear as additional view toggle buttons alongside Terminal and Chat. Panel HTML is sanitized (no scripts, no event handlers, no javascript: URLs).

---

## Step 10: Example Plugin

Create `~/.wotch/plugins/word-counter/` with manifest.json and index.js. Simple plugin that counts words in terminal output and registers a "Reset Word Count" command. Validates the entire plugin system end-to-end.

---

## Step 11: Plugin-Related Invariants

**Files:** `docs/INVARIANTS.md`

- **INV-SEC-012:** Plugin Isolation — no raw Node.js access, HTML sanitized, no cross-plugin state access
- **INV-SEC-013:** Plugin Permission Enforcement — checks at API boundary, not implementation
- **INV-DATA-007:** Plugin Settings Isolation — under `pluginData[pluginId]`, preserved on general save, not deleted on deactivate

---

## Step 12: Cleanup and Error Handling

**Files:** `src/main.js`

- App will-quit: deactivate all active plugins
- Global error boundary: detect plugin origin from stack trace, auto-deactivate crashing plugins, don't crash app

---

## Summary of Changes by File

| File | Changes |
|------|---------|
| `src/main.js` | PluginHost class, plugin API factory, manifest validation, discovery, IPC handlers, terminal data routing, error boundaries |
| `src/preload.js` | ~8 new IPC bridge methods |
| `src/index.html` | Plugin settings section HTML/CSS |
| `src/renderer.js` | Plugin list rendering, command palette integration, panel extension rendering, HTML sanitization |
| `docs/INVARIANTS.md` | INV-SEC-012, INV-SEC-013, INV-DATA-007 |

## New IPC Channels (10)

`get-plugin-list`, `activate-plugin`, `deactivate-plugin`, `execute-plugin-command`, `get-plugin-settings`, `save-plugin-setting`, `plugin-command-registered` (m→r), `plugin-settings-registered` (m→r), `plugin-panel-registered` (m→r), `plugin-status-update` (m→r)
