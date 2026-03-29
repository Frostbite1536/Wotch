# 04 - Permission System

## Overview

Every plugin declares the permissions it needs in `manifest.json`. Permissions are granted by the user at install/enable time and can be revoked at any time via the settings panel. The permission system uses capability-based access control: the API proxy objects provided to plugins only include methods the plugin is authorized to call.

## Permission Scopes

| Permission | Description | Risk Level | Gated Methods |
|-----------|-------------|:----------:|---------------|
| `fs.read` | Read files from the filesystem | Medium | `wotch.fs.readFile`, `wotch.fs.readFileBuffer`, `wotch.fs.exists`, `wotch.fs.stat`, `wotch.fs.readdir` |
| `fs.write` | Write, create, and delete files | High | `wotch.fs.writeFile`, `wotch.fs.appendFile`, `wotch.fs.mkdir`, `wotch.fs.unlink` |
| `process.exec` | Execute shell commands | Critical | `wotch.process.exec`, `wotch.process.execFile` |
| `net.fetch` | Make outbound HTTP/HTTPS requests | High | `wotch.net.fetch` |
| `git.read` | Read git status, branches, diffs, logs | Low | `wotch.git.status`, `wotch.git.diff`, `wotch.git.branch`, `wotch.git.log` |
| `git.write` | Create git commits and checkpoints | Medium | `wotch.git.checkpoint` |
| `terminal.read` | Receive terminal output data | Medium | `wotch.terminal.onData`, `wotch.terminal.onTabData`, `wotch.status.registerDetector` |
| `terminal.write` | Send input to terminal | High | `wotch.terminal.write`, `wotch.terminal.writeActive` |
| `ui.panels` | Create panel views in the expanded UI | Low | `wotch.ui.addPanel` |
| `ui.notifications` | Show toast notifications to the user | Low | `wotch.ui.showNotification` |

### Risk Levels

- **Low:** No access to user data or system resources. Cosmetic or informational.
- **Medium:** Read access to potentially sensitive data (files, terminal output).
- **High:** Write access to files, network access, or ability to inject terminal input.
- **Critical:** Ability to execute arbitrary system commands. Displayed with prominent warning.

## Permission Prompting Flow

### Install-Time Prompting

When a user enables a plugin for the first time, Wotch shows a permission prompt dialog before activating the plugin. The dialog lists all requested permissions with their descriptions and risk levels.

```
+--------------------------------------------------+
|  Enable "GitHub PR Status"?                      |
|                                                  |
|  This plugin requests the following permissions: |
|                                                  |
|  [!] net.fetch                                   |
|      Make outbound HTTP/HTTPS requests           |
|                                                  |
|  [ ] git.read                                    |
|      Read git status, branches, diffs            |
|                                                  |
|  [ ] ui.panels                                   |
|      Create panel views in the expanded UI       |
|                                                  |
|  [ ] ui.notifications                            |
|      Show toast notifications                    |
|                                                  |
|  [!] = elevated risk                             |
|                                                  |
|         [Allow All]   [Deny]   [Choose...]       |
+--------------------------------------------------+
```

**Buttons:**
- **Allow All:** Grants all requested permissions and activates the plugin.
- **Deny:** Cancels enabling the plugin. No permissions granted.
- **Choose...:** Expands to show checkboxes for each permission, allowing selective granting.

### Selective Permission Granting

If the user chooses "Choose...", they can grant a subset of permissions. The plugin activates with only the granted permissions. API calls requiring ungrantable permissions will throw `PermissionDeniedError`.

This is useful for plugins that have optional features. For example, a plugin might request `net.fetch` for an optional feature but work fine without it.

### Runtime Prompting

Runtime prompting is **not used** in v1. All permission decisions are made at enable-time. This simplifies the model and avoids disruptive mid-workflow popups.

If a plugin calls a method it does not have permission for, a `PermissionDeniedError` is thrown immediately. The error is logged and the plugin can handle it gracefully.

Future versions may add an opt-in runtime prompting mode for specific high-risk operations (e.g., `process.exec` could prompt per-command).

## Permission Enforcement Architecture

### Capability-Based API Proxies

The core enforcement mechanism is **API proxy construction**. When a plugin is activated, the PluginHost builds a `wotch` API object that only includes methods the plugin is authorized to call. Unauthorized namespaces are either omitted entirely or replaced with stub objects that throw `PermissionDeniedError`.

```javascript
// src/plugin-api-main.js

function buildPermissionGatedAPI(pluginId, grantedPermissions, services) {
  const api = {
    version: APP_VERSION,

    // Always available (no permission required)
    commands: buildCommandsAPI(pluginId, services),
    status: buildStatusAPI(pluginId, grantedPermissions, services),
    tabs: buildTabsAPI(pluginId, services),
    settings: buildSettingsAPI(pluginId, services),
    project: buildProjectAPI(pluginId, services),
    ui: buildUIAPI(pluginId, grantedPermissions, services),
  };

  // Permission-gated namespaces
  if (grantedPermissions.includes('terminal.read') || grantedPermissions.includes('terminal.write')) {
    api.terminal = buildTerminalAPI(pluginId, grantedPermissions, services);
  } else {
    api.terminal = createDeniedProxy('terminal', ['terminal.read', 'terminal.write']);
  }

  if (grantedPermissions.includes('fs.read') || grantedPermissions.includes('fs.write')) {
    api.fs = buildFsAPI(pluginId, grantedPermissions, services);
  } else {
    api.fs = createDeniedProxy('fs', ['fs.read', 'fs.write']);
  }

  if (grantedPermissions.includes('process.exec')) {
    api.process = buildProcessAPI(pluginId, services);
  } else {
    api.process = createDeniedProxy('process', ['process.exec']);
  }

  if (grantedPermissions.includes('net.fetch')) {
    api.net = buildNetAPI(pluginId, services);
  } else {
    api.net = createDeniedProxy('net', ['net.fetch']);
  }

  if (grantedPermissions.includes('git.read') || grantedPermissions.includes('git.write')) {
    api.git = buildGitAPI(pluginId, grantedPermissions, services);
  } else {
    api.git = createDeniedProxy('git', ['git.read', 'git.write']);
  }

  // Freeze the API to prevent plugins from modifying it
  return Object.freeze(api);
}
```

### Denied Proxy Objects

When a plugin lacks a permission, the corresponding namespace is replaced with a proxy that throws on any property access or method call:

```javascript
function createDeniedProxy(namespace, requiredPermissions) {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        return () => `[PermissionDenied: ${namespace}]`;
      }
      return function() {
        throw new PermissionDeniedError(
          requiredPermissions.join(' or '),
          `${namespace}.${String(prop)}`
        );
      };
    }
  });
}
```

### Method-Level Checks

Within a granted namespace, individual methods may require sub-permissions. For example, `wotch.fs` is available if either `fs.read` or `fs.write` is granted, but write methods check specifically for `fs.write`:

```javascript
function buildFsAPI(pluginId, grantedPermissions, services) {
  const canRead = grantedPermissions.includes('fs.read');
  const canWrite = grantedPermissions.includes('fs.write');

  return {
    readFile(filePath) {
      if (!canRead) throw new PermissionDeniedError('fs.read', 'fs.readFile');
      return services.fs.readFile(validatePath(pluginId, filePath));
    },
    writeFile(filePath, content) {
      if (!canWrite) throw new PermissionDeniedError('fs.write', 'fs.writeFile');
      return services.fs.writeFile(validatePath(pluginId, filePath), content);
    },
    // ... other methods with appropriate checks
  };
}
```

### Renderer Permission Enforcement

For renderer plugins running in iframes, permission enforcement happens in the PluginBridge in `src/renderer.js`. When the iframe sends a `postMessage` API call, the PluginBridge checks the plugin's granted permissions before forwarding to the main process:

```javascript
// In PluginBridge (src/plugin-bridge.js)
function handlePluginCall(pluginId, method, args) {
  const plugin = pluginRegistry.get(pluginId);
  const requiredPerm = getRequiredPermission(method);

  if (requiredPerm && !plugin.grantedPermissions.includes(requiredPerm)) {
    return { error: `Permission denied: ${requiredPerm} required for ${method}` };
  }

  // Forward to main process via IPC
  return window.wotch.pluginRendererCall(pluginId, method, args);
}
```

## Permission Escalation Prevention

### No Dynamic Permission Requests

Plugins cannot request new permissions at runtime. The set of permissions is fixed by the manifest and granted at enable-time. A plugin update that adds new permissions requires the user to re-approve.

### No Permission Delegation

A plugin cannot grant its permissions to another plugin or to code loaded at runtime. The API proxy is frozen and cannot be extended.

### Entry Point Validation

Plugin entry points (`main.js`, `renderer.js`) are loaded once at activation time. Plugins cannot dynamically load additional code files via `require()`, `import()`, or `eval()` -- these are all blocked in the vm context (`codeGeneration: { strings: false, wasm: false }` and no `require` global).

### Path Restriction for fs Operations

All filesystem operations validate paths against an allowlist of directory roots. This prevents a plugin with `fs.read` from reading arbitrary system files like `/etc/shadow` or `~/.ssh/id_rsa`:

```javascript
const ALLOWED_ROOTS = [
  // The plugin's own directory (always allowed for read)
  path.join(PLUGINS_DIR, pluginId),
  // The plugin's data directory
  path.join(PLUGIN_DATA_DIR, pluginId),
  // The current project directory (if a project is selected)
  () => currentProject?.path,
  // User home directory (only with explicit fs.read/fs.write)
  os.homedir(),
];

// Explicitly blocked paths, even within allowed roots
const BLOCKED_PATHS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.wotch/settings.json',  // use wotch.settings API instead
  '.wotch/api-token',
  '.wotch/credentials',
  '.env',
  '.env.local',
];

function validatePath(pluginId, requestedPath) {
  const resolved = path.resolve(requestedPath);

  // Check blocked paths
  for (const blocked of BLOCKED_PATHS) {
    if (resolved.includes(path.sep + blocked) || resolved.endsWith(path.sep + blocked)) {
      throw new Error(`Access denied: ${blocked} is a protected path`);
    }
  }

  // Check against allowed roots
  const roots = ALLOWED_ROOTS.map(r => typeof r === 'function' ? r() : r).filter(Boolean);
  const isAllowed = roots.some(root => resolved.startsWith(path.resolve(root)));

  if (!isAllowed) {
    throw new Error(`Access denied: path outside allowed directories`);
  }

  return resolved;
}
```

### Process Execution Restrictions

Plugins with `process.exec` can run arbitrary commands, which is inherently dangerous. The permission prompt makes this explicit. Additional safeguards:

1. **Timeout.** All commands have a default 30-second timeout (configurable up to 5 minutes).
2. **Buffer limit.** Output is limited to 1MB by default to prevent memory exhaustion.
3. **No shell for `execFile`.** The `execFile` method does not use a shell, preventing command injection if the plugin passes user input as arguments.
4. **Logging.** All `process.exec` calls are logged with the plugin ID, command, and timestamp for auditability.

## Permission Revocation

### Settings UI

The plugin management section in the settings panel shows each plugin's permissions with toggle switches:

```
+--------------------------------------------------+
|  Plugins                                          |
|                                                  |
|  [ON]  GitHub PR Status v0.2.0                   |
|        Permissions:                               |
|          [x] net.fetch                            |
|          [x] git.read                             |
|          [x] ui.panels                            |
|          [x] ui.notifications                     |
|        [Disable] [Uninstall]                     |
|                                                  |
|  [OFF] Snippet Runner v1.0.0                     |
|        [Enable]                                   |
|                                                  |
+--------------------------------------------------+
```

### Revocation Flow

When a user unchecks a permission:

1. The permission is removed from the plugin's granted set in `settings.json`.
2. If the plugin is currently activated:
   a. The plugin is deactivated (full lifecycle: `deactivate()` called).
   b. The plugin is re-activated with the reduced permission set.
   c. API methods requiring the revoked permission now throw `PermissionDeniedError`.
3. A toast notification confirms: "Permission revoked. Plugin reloaded."

### Disabling a Plugin

Disabling a plugin (toggling the ON/OFF switch):

1. Calls `deactivate()` on the plugin.
2. Removes all contributed commands, panels, status detectors, themes.
3. Sets `plugins.<name>.enabled = false` in settings.
4. The plugin remains installed but inactive.

### Uninstalling a Plugin

The "Uninstall" button:

1. Deactivates the plugin if active.
2. Removes the plugin directory from `~/.wotch/plugins/`.
3. Removes the plugin's data directory from `~/.wotch/plugin-data/`.
4. Removes the plugin's entry from `settings.json`.
5. Shows confirmation toast.

## Permission State Storage

Permissions are stored in `~/.wotch/settings.json`:

```json
{
  "plugins": {
    "gh-pr-status": {
      "enabled": true,
      "permissions": {
        "net.fetch": "granted",
        "git.read": "granted",
        "ui.panels": "granted",
        "ui.notifications": "granted"
      }
    }
  }
}
```

Permission values are one of:
- `"granted"` -- User approved this permission.
- `"denied"` -- User explicitly denied this permission.
- Absent key -- Not yet prompted (treated as not granted).

## Permission Change Detection

When a plugin is updated (directory contents change), the PluginHost compares the new manifest's permissions with the stored grants:

- **New permissions added:** The user is prompted for the new permissions only. Previously granted permissions remain.
- **Permissions removed:** Removed permissions are cleaned from storage silently.
- **No change:** No prompt needed.

This is detected by comparing `manifest.permissions` with `Object.keys(settings.plugins[name].permissions)` on each plugin load.
