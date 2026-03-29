# 01 - Plugin System Architecture

## High-Level Architecture

The plugin system spans both the Electron main process and the renderer process, with strict isolation boundaries between them.

```
+-------------------------------------------------------------------+
|                        ~/.wotch/plugins/                          |
|  my-plugin/          gh-status/          pomodoro/                |
|    manifest.json       manifest.json       manifest.json          |
|    main.js             main.js             renderer.js            |
|    renderer.js         renderer.js                                |
+-------------------------------------------------------------------+
         |                    |                    |
         v                    v                    v
+-------------------------------------------------------------------+
|                     MAIN PROCESS (src/main.js)                    |
|                                                                   |
|  +-------------------------------------------------------------+ |
|  |                    PluginHost                                | |
|  |                                                              | |
|  |  +------------------+  +------------------+  +------------+  | |
|  |  | PluginDiscovery  |  | ManifestValidator|  | Permission |  | |
|  |  | - scans dir      |  | - validates JSON |  | Manager    |  | |
|  |  | - watches changes|  | - checks compat  |  | - grants   |  | |
|  |  +------------------+  +------------------+  | - checks   |  | |
|  |                                               | - prompts  |  | |
|  |  +------------------+  +------------------+  +------------+  | |
|  |  | PluginRegistry   |  | PluginLoader     |                  | |
|  |  | - enabled list   |  | - vm contexts    |                  | |
|  |  | - state machine  |  | - API proxies    |                  | |
|  |  | - lifecycle mgmt |  | - error isolation|                  | |
|  |  +------------------+  +------------------+                  | |
|  +-------------------------------------------------------------+ |
|         |              |                |                          |
|         v              v                v                          |
|  +-----------+  +------------+  +-------------+                   |
|  | PTY Mgr   |  | Git Ops    |  | Settings    |                  |
|  | (existing) |  | (existing) |  | (existing)  |                  |
|  +-----------+  +------------+  +-------------+                   |
+-------------------------------------------------------------------+
         |  IPC (contextBridge)
         v
+-------------------------------------------------------------------+
|                   RENDERER (src/renderer.js)                      |
|                                                                   |
|  +-------------------------------------------------------------+ |
|  |                 PluginBridge                                 | |
|  |                                                              | |
|  |  +------------------+  +------------------+  +------------+  | |
|  |  | CommandRegistry  |  | StatusRegistry   |  | PanelMgr   |  | |
|  |  | - plugin cmds    |  | - custom detect  |  | - iframes  |  | |
|  |  | - palette merge  |  | - event routing  |  | - sandboxed|  | |
|  |  +------------------+  +------------------+  +------------+  | |
|  |                                                              | |
|  |  +------------------+  +------------------+                  | |
|  |  | SettingsRegistry |  | EventBus         |                  | |
|  |  | - plugin configs |  | - pub/sub        |                  | |
|  |  | - UI generation  |  | - cross-plugin   |                  | |
|  |  +------------------+  +------------------+                  | |
|  +-------------------------------------------------------------+ |
|                                                                   |
|  +-------------------------------------------------------------+ |
|  |  Existing UI: Tabs | Terminal | Settings | Cmd Palette       | |
|  +-------------------------------------------------------------+ |
+-------------------------------------------------------------------+
```

## Plugin Discovery

### Directory Structure

Plugins live in `~/.wotch/plugins/`. Each plugin is a subdirectory containing at minimum a `manifest.json`:

```
~/.wotch/plugins/
  my-plugin/
    manifest.json      (required)
    main.js            (optional - main process entry)
    renderer.js        (optional - renderer entry)
    assets/            (optional - static files)
    README.md          (optional - not loaded, for humans)
  another-plugin/
    manifest.json
    main.js
```

### Discovery Process

1. On app startup, `PluginDiscovery` reads `~/.wotch/plugins/` directory.
2. For each subdirectory, it checks for `manifest.json`.
3. `ManifestValidator` parses and validates the manifest (see `02-manifest-spec.md`).
4. Valid plugins are registered in `PluginRegistry`.
5. A `fs.watch` on the plugins directory detects additions/removals at runtime.

### Discovery Timing

```
app.whenReady()
  -> createWindow()
  -> PluginHost.init()
       -> PluginDiscovery.scan()          // read ~/.wotch/plugins/
       -> ManifestValidator.validateAll() // validate manifests
       -> PluginRegistry.register()       // register valid plugins
       -> PluginHost.activateEnabled()    // activate plugins marked enabled
       -> PluginDiscovery.watch()         // watch for new plugins
```

## Plugin Lifecycle

Every plugin moves through a state machine:

```
  [discovered] --> [validated] --> [enabled] --> [activated] --> [deactivated]
       |               |              |              |                |
       v               v              v              v                v
  [invalid]       [disabled]     [disabled]    [error]          [disposed]
```

### States

| State | Description |
|-------|-------------|
| `discovered` | Directory found, manifest not yet parsed |
| `validated` | Manifest parsed successfully, plugin is known |
| `invalid` | Manifest failed validation; plugin ignored |
| `enabled` | User has enabled this plugin (persisted in settings) |
| `disabled` | User has disabled this plugin |
| `activated` | Plugin code is loaded and running |
| `deactivated` | Plugin code has been stopped gracefully |
| `error` | Plugin threw during activation or runtime |
| `disposed` | Plugin fully cleaned up, ready for removal |

### Lifecycle Hooks

Each plugin entry point (main and/or renderer) exports lifecycle functions:

```javascript
// main.js or renderer.js
module.exports = {
  activate(context) {
    // Called when plugin is activated.
    // `context` provides the permission-gated API.
    // Register commands, listeners, etc.
    // Can return a Promise.
  },
  deactivate() {
    // Called when plugin is disabled or Wotch is shutting down.
    // Clean up resources, timers, subscriptions.
    // Can return a Promise.
  }
};
```

### Activation Sequence

```
PluginHost.activate(pluginId):
  1. Load manifest
  2. Check permissions are granted (prompt if first run)
  3. If manifest.main exists:
     a. Create vm.Context with permission-gated API
     b. Load and execute main.js in the context
     c. Call exported activate(context)
  4. If manifest.renderer exists:
     a. Send IPC 'plugin-activate-renderer' to renderer
     b. Renderer PluginBridge loads renderer.js in sandboxed iframe
     c. iframe calls exported activate(context)
  5. Register contributed commands, settings, themes, etc.
  6. Set state to 'activated'
```

### Deactivation Sequence

```
PluginHost.deactivate(pluginId):
  1. Call main.js deactivate() (with 5s timeout)
  2. Send IPC 'plugin-deactivate-renderer' to renderer
  3. Renderer PluginBridge calls renderer.js deactivate() (with 5s timeout)
  4. Remove all contributed commands, settings, themes
  5. Destroy vm.Context / iframe
  6. Set state to 'deactivated'
```

## Isolation Model

### Main-Process Plugins: `vm` Contexts

Main-process plugins (`manifest.main`) run inside Node.js `vm.createContext()`. This provides:

- **Separate global scope.** Plugin code cannot access `require`, `process`, `__dirname`, or any Node.js globals directly.
- **Controlled API surface.** The only globals available are the permission-gated API proxy object and basic JS builtins (`console`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `Promise`, `JSON`, `Math`, `Date`, `Map`, `Set`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Error`, `RegExp`, `Symbol`, `WeakMap`, `WeakSet`, `Proxy`, `Reflect`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `AbortController`, `crypto.randomUUID`, `structuredClone`, `atob`, `btoa`).
- **Error containment.** Uncaught exceptions in a plugin's vm context are caught by the PluginHost and do not crash the main process. The plugin is moved to `error` state.

**Why `vm` and not `worker_threads`:**
- `worker_threads` provide stronger isolation but have significant overhead for IPC (structured clone for every message). Plugins need frequent, low-latency access to terminal data events and status updates.
- `vm` contexts run on the main thread but with a controlled global scope. Since plugins are JS-only (no native modules) and we control what they can call, vm is sufficient.
- If a plugin enters an infinite loop, we use `vm.runInContext` with a `timeout` option for the initial load. For ongoing execution, long-running plugin code must be async; we add a watchdog timer that kills plugins exceeding CPU thresholds.

**vm context setup (pseudocode):**

```javascript
const vm = require('vm');

function createPluginContext(pluginId, manifest, permissionManager) {
  const api = buildPermissionGatedAPI(pluginId, manifest.permissions, permissionManager);

  const sandbox = {
    console: createScopedConsole(pluginId),
    setTimeout, setInterval, clearTimeout, clearInterval,
    Promise, JSON, Math, Date,
    Map, Set, WeakMap, WeakSet,
    Array, Object, String, Number, Boolean,
    Error, TypeError, RangeError, SyntaxError, ReferenceError,
    RegExp, Symbol, Proxy, Reflect,
    URL, URLSearchParams,
    TextEncoder, TextDecoder,
    AbortController,
    atob, btoa,
    structuredClone,
    wotch: api,              // <-- the permission-gated API
    module: { exports: {} }, // <-- for CommonJS-style plugins
    exports: {},
  };

  const context = vm.createContext(sandbox, {
    name: `plugin:${pluginId}`,
    codeGeneration: { strings: false, wasm: false }, // no eval(), no WASM
  });

  return context;
}
```

### Renderer Plugins: Sandboxed Iframes

Renderer-side plugin code (`manifest.renderer`) runs inside sandboxed `<iframe>` elements:

```html
<iframe
  sandbox="allow-scripts"
  src="about:blank"
  style="display:none;"
></iframe>
```

**Key properties:**
- `sandbox="allow-scripts"` permits JS execution but blocks top-level navigation, form submission, popups, and same-origin access.
- No `allow-same-origin`: the iframe cannot access the parent document's DOM, cookies, or storage.
- Communication happens exclusively via `postMessage` / `onmessage`.

**For panel contributions**, the iframe is made visible within a designated panel container in the expanded view. The iframe's `srcdoc` is set to the plugin's renderer HTML, with an injected communication bridge script.

**For non-panel contributions** (commands, status detectors, settings), the iframe remains hidden (`display:none`). The plugin registers callbacks via `postMessage` to the PluginBridge, which proxies them into the main renderer's command palette, status system, etc.

### Renderer Plugin Bridge Communication

```
+---------------------------+         +---------------------------+
|   Main Renderer           |         |   Plugin Iframe           |
|   (src/renderer.js)       |         |   (sandboxed)             |
|                           |         |                           |
|   PluginBridge            |         |   Plugin renderer.js      |
|     |                     |         |     |                     |
|     |  window.postMessage |  <--->  |  parent.postMessage       |
|     |  (structured clone) |         |  (structured clone)       |
|     |                     |         |                           |
|   Validates origin        |         |   wotch.* API shim        |
|   Routes to subsystem     |         |   (provided by bridge)    |
+---------------------------+         +---------------------------+
```

Message format between renderer and plugin iframe:

```javascript
// Renderer -> Plugin iframe
{
  type: 'wotch-plugin',
  action: 'status-changed',  // or 'terminal-data', 'settings-changed', etc.
  pluginId: 'my-plugin',
  payload: { /* event data */ }
}

// Plugin iframe -> Renderer
{
  type: 'wotch-plugin-call',
  pluginId: 'my-plugin',
  callId: 'uuid-123',       // for request/response correlation
  method: 'commands.register',
  args: [{ id: 'my-cmd', title: 'My Command' }]
}

// Renderer -> Plugin iframe (response)
{
  type: 'wotch-plugin-result',
  pluginId: 'my-plugin',
  callId: 'uuid-123',
  result: { success: true }  // or { error: 'message' }
}
```

## Inter-Plugin Communication

Plugins cannot directly communicate with each other. All communication is mediated through the Wotch API:

1. **Shared events.** Plugins subscribe to the same Wotch events (status changes, terminal data, tab events). They cannot send custom events to other plugins.
2. **Shared state.** Plugins can read shared state (current status, active tab, settings) but cannot write to each other's state.
3. **Command invocation.** A plugin can programmatically execute a command registered by another plugin via `wotch.commands.execute(commandId)`, but only if the calling plugin has the necessary permissions.

This prevents plugin coupling and ensures any plugin can be removed without breaking others.

## Integration with Existing IPC

The plugin system adds new IPC channels to the existing `preload.js` bridge. All new channels are prefixed with `plugin-`:

```
Existing channels (unchanged):
  pty-create, pty-write, pty-resize, pty-kill, pty-data, pty-exit
  get-cwd, detect-projects, git-checkpoint, git-status, git-diff
  get-settings, save-settings, reset-settings
  set-pinned, get-pinned, pin-state
  expansion-state, claude-status
  ssh-connect, ssh-credential-*, ssh-host-verify-*
  resize-window, position-changed
  get-platform-info, get-displays
  update-available, update-downloaded

New channels (plugin system):
  plugin-list              // Get list of discovered plugins
  plugin-enable            // Enable a plugin
  plugin-disable           // Disable a plugin
  plugin-get-permissions   // Get plugin's permission state
  plugin-grant-permission  // User grants a permission
  plugin-revoke-permission // User revokes a permission
  plugin-activate-renderer // Main -> Renderer: load plugin renderer code
  plugin-deactivate-renderer // Main -> Renderer: unload plugin renderer code
  plugin-renderer-call     // Renderer -> Main: plugin API call from renderer
  plugin-renderer-event    // Main -> Renderer: event for a plugin's renderer
  plugin-renderer-result   // Main -> Renderer: result of a renderer API call
```

### IPC Flow for a Renderer Plugin API Call

```
Plugin iframe                    Renderer                      Main Process
    |                                |                              |
    |-- postMessage(call) ---------> |                              |
    |                                |-- ipcRenderer.invoke ------> |
    |                                |   ('plugin-renderer-call',   |
    |                                |    {pluginId, method, args}) |
    |                                |                              |
    |                                |                   PluginHost |
    |                                |                   checks     |
    |                                |                   permissions|
    |                                |                   executes   |
    |                                |                              |
    |                                | <-- result ------------------|
    |                                |                              |
    | <-- postMessage(result) -------|                              |
```

## Plugin State Persistence

Plugin enable/disable state and granted permissions are stored in `~/.wotch/settings.json` under a `plugins` key:

```json
{
  "pillWidth": 200,
  "expandedWidth": 640,
  "plugins": {
    "my-plugin": {
      "enabled": true,
      "permissions": {
        "fs.read": "granted",
        "net.fetch": "granted",
        "process.exec": "denied"
      }
    },
    "another-plugin": {
      "enabled": false,
      "permissions": {}
    }
  }
}
```

This integrates with the existing `loadSettings()` / `saveSettings()` functions in `src/main.js`. The `DEFAULT_SETTINGS` object gains a `plugins: {}` default.

## Error Handling Strategy

### Plugin load failure
If a plugin's `main.js` or `renderer.js` throws during loading, the PluginHost catches the error, logs it with `[wotch:plugin:<id>]` prefix, sets the plugin state to `error`, and continues loading other plugins. The error is displayed in the plugin management UI.

### Plugin runtime error
If a plugin's event handler throws, the PluginHost catches it, logs it, and increments an error counter. After 10 errors in 60 seconds, the plugin is automatically deactivated with a notification to the user.

### Plugin timeout
The `activate()` and `deactivate()` calls have a 10-second timeout. If exceeded, the plugin is forcibly disposed and marked as `error`.

### Renderer plugin crash
If a plugin iframe becomes unresponsive (no heartbeat response in 5 seconds), the PluginBridge destroys and optionally recreates the iframe. The panel shows an error state.

## File Layout for Implementation

New files to create:

```
src/
  plugin-host.js           // Main-process PluginHost class
  plugin-discovery.js       // Directory scanning and watching
  plugin-manifest.js        // ManifestValidator
  plugin-registry.js        // Plugin state machine and registry
  plugin-loader.js          // vm context creation and code loading
  plugin-permissions.js     // PermissionManager
  plugin-bridge.js          // Renderer-side PluginBridge (loaded in renderer.js)
  plugin-api-main.js        // Main-process API factory
  plugin-api-renderer.js    // Renderer API factory (runs in iframe bridge)
```

Existing files to modify:

```
src/main.js                // Import PluginHost, init on startup, add IPC handlers
src/preload.js             // Add plugin-* IPC channel bindings
src/renderer.js            // Import PluginBridge, init on startup, integrate commands/panels/settings
src/index.html             // Add plugin panel container, plugin settings UI section
package.json               // No new dependencies needed (vm is built-in)
```
