# Implementation Steps — Wotch Plugin/Extension SDK

## Step 1: Plugin Directory and Discovery

**Files:** `src/main.js`

Create `~/.wotch/plugins/` directory structure. `discoverPlugins()` scans for subdirectories containing `manifest.json`, validates each manifest, returns array of discovered plugins.

**Testing:** Valid plugin discovered. Invalid manifest skipped with warning. Missing manifest skipped.

---

## Step 2: Manifest Validation

**Files:** `src/main.js`

`validateManifest(manifest)` checks required fields (name, version, displayName, description), at least one of main or renderer, name format (lowercase alphanumeric with hyphens), semver version, valid permissions list, and command contributions.

Valid permissions: `fs.read`, `fs.write`, `process.exec`, `net.fetch`, `git.read`, `git.write`, `terminal.read`, `terminal.write`, `ui.panels`, `ui.notifications`.

**Testing:** Valid manifest passes. Missing fields, bad format, unknown permissions all produce errors.

---

## Step 3: Plugin Host (Main Process)

**Files:** `src/main.js`

`PluginHost` class managing plugin lifecycle: discovered → validated → enabled → activated → deactivated → disposed.

- `loadAll()` — discover plugins, validate manifests, auto-activate enabled ones from settings
- `activate(id)` — create vm context, load plugin's main file, call `activate(context)`, register commands/detectors
- `deactivate(id)` — call `deactivate()`, clean up commands and detectors, destroy vm context
- `getPluginList()` — return list with state and permissions for UI
- `savePluginState(id)` — persist enabled/disabled and permissions to `settings.plugins`

**Lifecycle:** Call `pluginHost.loadAll()` after `app.whenReady()`.

**Testing:** Activate/deactivate lifecycle works. Error in activate → state 'error', app doesn't crash.

---

## Step 4: Plugin API (Permission-Gated)

**Files:** `src/main.js`

`createPluginApi(pluginId, grantedPermissions)` returns an API object with:

**Always available (no permissions):**
- `commands.register(id, title, handler)` — register command in palette
- `status.onChanged(callback)` — subscribe to status changes
- `settings.get/set/getAll/onChanged` — per-plugin settings under `plugins.<name>.settings`

**Requires `terminal.read`:**
- `status.registerDetector(detectorId, callback)` — custom status detector (receives terminal data)

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

Expose plugin management to renderer: `plugin-list`, `plugin-enable`, `plugin-disable`, `plugin-execute-command`, `plugin-get-settings`, `plugin-save-setting`.

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

Plugins with `ui.panels` permission can register custom panels via `api.ui.addPanel()`. Panels appear as additional view toggle buttons alongside Terminal and Chat. Panel content is rendered inside a sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`). Communication happens via `postMessage`.

---

## Step 10: Example Plugin

Create `~/.wotch/plugins/word-counter/` with manifest.json and index.js. Simple plugin that counts words in terminal output and registers a "Reset Word Count" command. Validates the entire plugin system end-to-end.

---

## Step 11: Plugin-Related Invariants

**Files:** `docs/INVARIANTS.md`

- **INV-SEC-017:** Plugin Isolation — no raw Node.js access, renderer plugins run in sandboxed iframes, no cross-plugin state access
- **INV-SEC-018:** Plugin Permission Enforcement — checks at API boundary via capability-based proxies, not implementation
- **INV-DATA-007:** Plugin Settings Isolation — under `plugins.<name>` in settings.json, preserved on general save, not deleted on deactivate

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
| `docs/INVARIANTS.md` | INV-SEC-017, INV-SEC-018, INV-DATA-007 |

## New IPC Channels (10)

`plugin-list`, `plugin-enable`, `plugin-disable`, `plugin-execute-command`, `plugin-get-settings`, `plugin-save-setting`, `plugin-command-registered` (m→r), `plugin-settings-registered` (m→r), `plugin-panel-registered` (m→r), `plugin-status-update` (m→r)
