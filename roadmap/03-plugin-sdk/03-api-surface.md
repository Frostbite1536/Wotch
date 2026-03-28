# 03 - Plugin API Surface

## Overview

Plugins interact with Wotch through a `wotch` API object injected into their execution context. The API is permission-gated: calling a method that requires a permission the plugin was not granted throws a `PermissionDeniedError`.

The API is split into two execution environments:
- **Renderer API** -- available to plugins with a `renderer` entry point, executing in a sandboxed iframe.
- **Main-process API** -- available to plugins with a `main` entry point, executing in a `vm` context.

Some namespaces are available in both environments (e.g., `wotch.settings`), while others are environment-specific.

## TypeScript Type Definitions

All types below are provided by the `@wotch/sdk` package as `@wotch/sdk/types`.

### Core Types

```typescript
/** Disposable subscription handle. Call dispose() to unsubscribe. */
interface Disposable {
  dispose(): void;
}

/** Plugin activation context, passed to activate(). */
interface PluginContext {
  /** Absolute path to the plugin's directory. */
  pluginPath: string;
  /** The plugin's parsed manifest. */
  manifest: PluginManifest;
  /** Storage scoped to this plugin. Persisted across restarts. */
  storage: PluginStorage;
  /** Subscriptions registered during activation. Auto-disposed on deactivate. */
  subscriptions: Disposable[];
}

/** Key-value storage scoped to a single plugin. */
interface PluginStorage {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Error thrown when a permission check fails. */
declare class PermissionDeniedError extends Error {
  readonly permission: string;
  constructor(permission: string, method: string);
}

/** Claude/terminal status states. */
type StatusState = 'idle' | 'thinking' | 'working' | 'waiting' | 'done' | 'error';

/** Status information for a tab. */
interface TabStatus {
  tabId: string;
  state: StatusState;
  description: string;
}

/** Tab information. */
interface TabInfo {
  id: string;
  name: string;
  connectionType: 'local' | 'ssh';
  cwd: string;
  isActive: boolean;
}

/** Project information. */
interface ProjectInfo {
  name: string;
  path: string;
  source: string;
}

/** Git status information. */
interface GitStatusInfo {
  branch: string;
  changedFiles: number;
  checkpointCount: number;
  isGitRepo: boolean;
}

/** Git diff result. */
interface GitDiffResult {
  diff: string;
  stats: { additions: number; deletions: number; files: number };
}

/** Notification options. */
interface NotificationOptions {
  message: string;
  type?: 'info' | 'success' | 'error';
  duration?: number; // ms, default 3000
}

/** Command definition. */
interface CommandDefinition {
  id: string;
  title: string;
  handler: () => void | Promise<void>;
}

/** Status detector callback. */
interface StatusDetectorCallback {
  (data: { tabId: string; rawData: string; cleanData: string }):
    { state: StatusState; description: string } | null;
}

/** Panel definition for renderer plugins. */
interface PanelDefinition {
  id: string;
  title: string;
  html: string;           // HTML content for the panel
  onMessage?: (msg: any) => void;  // Handle messages from panel iframe
}

/** Setting value change event. */
interface SettingChangeEvent {
  id: string;
  oldValue: any;
  newValue: any;
}

/** Fetch options (subset of standard RequestInit). */
interface PluginFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number; // ms, default 30000
}

/** Fetch response. */
interface PluginFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  ok: boolean;
}

/** File stat result. */
interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  modifiedMs: number;
  createdMs: number;
}

/** Process execution result. */
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Process execution options. */
interface ExecOptions {
  cwd?: string;
  timeout?: number; // ms, default 30000
  maxBuffer?: number; // bytes, default 1MB (1048576)
  env?: Record<string, string>; // merged with process.env
}
```

---

## Renderer API

Available to plugins with a `renderer` entry point. Accessed as `wotch.*` in the plugin's renderer.js.

### `wotch.commands` -- Command Palette Integration

**Required permission:** none

```typescript
namespace wotch.commands {
  /**
   * Register a command that appears in the command palette.
   * The command ID must match one declared in manifest.contributes.commands.
   * Returns a Disposable; call dispose() to unregister.
   */
  function register(command: CommandDefinition): Disposable;

  /**
   * Execute a command by ID. Can execute commands from other plugins.
   * Throws if the command ID does not exist.
   */
  function execute(commandId: string): Promise<void>;

  /**
   * Get list of all registered command IDs (including from other plugins).
   */
  function list(): Promise<string[]>;
}
```

**Example:**

```javascript
module.exports = {
  activate(context) {
    const disposable = wotch.commands.register({
      id: 'my-plugin.greet',
      title: 'My Plugin: Greet',
      handler() {
        wotch.ui.showNotification({ message: 'Hello from my plugin!' });
      }
    });
    context.subscriptions.push(disposable);
  },
  deactivate() {}
};
```

### `wotch.status` -- Status Detection

**Required permission for `onChanged`:** none
**Required permission for `registerDetector`:** `terminal.read`

```typescript
namespace wotch.status {
  /**
   * Subscribe to status changes for any tab.
   * Fires whenever the built-in Claude detector or any plugin detector updates status.
   */
  function onChanged(callback: (status: TabStatus) => void): Disposable;

  /**
   * Get current status for all tabs.
   */
  function getAll(): Promise<TabStatus[]>;

  /**
   * Get current status for a specific tab.
   */
  function get(tabId: string): Promise<TabStatus | null>;

  /**
   * Register a custom status detector.
   * The detector ID must match one declared in manifest.contributes.statusDetectors.
   * The callback receives terminal data chunks and returns a status object,
   * or null to defer to lower-priority detectors.
   *
   * Detectors are called in priority order (highest first).
   * The first non-null result wins.
   * The built-in Claude detector has priority 90.
   */
  function registerDetector(
    detectorId: string,
    callback: StatusDetectorCallback
  ): Disposable;
}
```

**Example:**

```javascript
wotch.status.registerDetector('word-count.detector', (data) => {
  const match = data.cleanData.match(/(\d+)\s+lines?,\s+(\d+)\s+words?/);
  if (match) {
    return {
      state: 'idle',
      description: `${match[2]} words, ${match[1]} lines`
    };
  }
  return null; // defer to other detectors
});
```

### `wotch.ui` -- User Interface

**Required permission for `addPanel`:** `ui.panels`
**Required permission for `showNotification`:** `ui.notifications`

```typescript
namespace wotch.ui {
  /**
   * Add a panel to the expanded view.
   * The panel ID must match one declared in manifest.contributes.panels.
   * The html string is loaded into a sandboxed iframe.
   * Returns a handle to update or remove the panel.
   */
  function addPanel(panel: PanelDefinition): PanelHandle;

  /**
   * Show a toast notification.
   */
  function showNotification(options: NotificationOptions): void;

  /**
   * Get whether the window is currently expanded.
   */
  function isExpanded(): Promise<boolean>;

  /**
   * Subscribe to expansion state changes.
   */
  function onExpansionChanged(callback: (expanded: boolean) => void): Disposable;
}

interface PanelHandle extends Disposable {
  /** Update the panel's HTML content. */
  setHtml(html: string): void;
  /** Send a message to the panel iframe. Received via window.addEventListener('message'). */
  postMessage(data: any): void;
  /** Show or hide the panel. */
  setVisible(visible: boolean): void;
}
```

### `wotch.tabs` -- Tab Management

**Required permission:** none (read-only tab info). `terminal.write` required for `sendInput`.

```typescript
namespace wotch.tabs {
  /**
   * Get information about all open tabs.
   */
  function list(): Promise<TabInfo[]>;

  /**
   * Get the active tab.
   */
  function getActive(): Promise<TabInfo | null>;

  /**
   * Subscribe to tab creation events.
   */
  function onCreated(callback: (tab: TabInfo) => void): Disposable;

  /**
   * Subscribe to tab close events.
   */
  function onClosed(callback: (tabId: string) => void): Disposable;

  /**
   * Subscribe to active tab change events.
   */
  function onActivated(callback: (tabId: string) => void): Disposable;
}
```

### `wotch.terminal` -- Terminal Data

**Required permission for `onData`:** `terminal.read`
**Required permission for `write`:** `terminal.write`

```typescript
namespace wotch.terminal {
  /**
   * Subscribe to terminal output data for all tabs.
   * Receives raw terminal data including ANSI escape sequences.
   */
  function onData(callback: (event: { tabId: string; data: string }) => void): Disposable;

  /**
   * Subscribe to terminal output data for a specific tab.
   */
  function onTabData(tabId: string, callback: (data: string) => void): Disposable;

  /**
   * Write input to a terminal tab (as if the user typed it).
   */
  function write(tabId: string, data: string): void;

  /**
   * Write input to the active terminal tab.
   */
  function writeActive(data: string): void;
}
```

### `wotch.settings` -- Plugin Settings

**Required permission:** none

```typescript
namespace wotch.settings {
  /**
   * Get the current value of a plugin setting.
   * The settingId must be one declared in manifest.contributes.settings.
   * Returns the stored value or the declared default.
   */
  function get(settingId: string): Promise<any>;

  /**
   * Set a plugin setting value. Validates against the manifest type/constraints.
   */
  function set(settingId: string, value: any): Promise<void>;

  /**
   * Subscribe to changes for a specific setting.
   */
  function onChanged(settingId: string, callback: (event: SettingChangeEvent) => void): Disposable;

  /**
   * Get all settings for this plugin as a key-value object.
   */
  function getAll(): Promise<Record<string, any>>;
}
```

### `wotch.project` -- Project Context

**Required permission:** none

```typescript
namespace wotch.project {
  /**
   * Get the currently selected project, if any.
   */
  function getCurrent(): Promise<ProjectInfo | null>;

  /**
   * Subscribe to project selection changes.
   */
  function onChanged(callback: (project: ProjectInfo | null) => void): Disposable;

  /**
   * Get all detected projects.
   */
  function list(): Promise<ProjectInfo[]>;
}
```

---

## Main-Process API

Available to plugins with a `main` entry point. Accessed as `wotch.*` in the plugin's vm context.

The main-process API includes everything in the Renderer API above (commands, status, ui, tabs, terminal, settings, project), plus these additional namespaces that require Node.js capabilities:

### `wotch.fs` -- Filesystem Access

**Required permission:** `fs.read` for read operations, `fs.write` for write operations.

```typescript
namespace wotch.fs {
  /**
   * Read a file as UTF-8 text.
   * Path is resolved relative to the current project directory if relative,
   * or used as-is if absolute.
   * Maximum file size: 10MB.
   */
  function readFile(filePath: string): Promise<string>;

  /**
   * Read a file as a Buffer (base64-encoded string in the API).
   */
  function readFileBuffer(filePath: string): Promise<string>;

  /**
   * Write text content to a file. Creates parent directories if needed.
   * File permissions are set to 0o644.
   */
  function writeFile(filePath: string, content: string): Promise<void>;

  /**
   * Append text to a file.
   */
  function appendFile(filePath: string, content: string): Promise<void>;

  /**
   * Check if a path exists.
   */
  function exists(filePath: string): Promise<boolean>;

  /**
   * Get file/directory metadata.
   */
  function stat(filePath: string): Promise<FileStat>;

  /**
   * List directory contents. Returns array of filenames (not full paths).
   * Does not recurse.
   */
  function readdir(dirPath: string): Promise<string[]>;

  /**
   * Create a directory (recursive).
   */
  function mkdir(dirPath: string): Promise<void>;

  /**
   * Delete a file.
   */
  function unlink(filePath: string): Promise<void>;
}
```

**Path restrictions:** All paths are validated to prevent traversal outside allowed directories. Allowed roots:
- The current project directory (if a project is selected)
- The plugin's own directory (`~/.wotch/plugins/<pluginName>/`)
- The plugin's data directory (`~/.wotch/plugin-data/<pluginName>/`)
- User's home directory (only with explicit `fs.read` / `fs.write`)

Paths containing `..` that would escape these roots are rejected. Symlinks are resolved and checked against roots.

### `wotch.process` -- Command Execution

**Required permission:** `process.exec`

```typescript
namespace wotch.process {
  /**
   * Execute a shell command and return the result.
   * The command runs in a child process with a timeout.
   *
   * SECURITY: The command string is passed to execFile with shell=true.
   * Plugins are responsible for input sanitization.
   * The permission prompt tells the user this plugin can run arbitrary commands.
   */
  function exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * Execute a command with arguments as an array (safer, no shell interpretation).
   */
  function execFile(
    file: string,
    args: string[],
    options?: ExecOptions
  ): Promise<ExecResult>;

  /**
   * Get the current working directory of the Wotch process.
   */
  function cwd(): Promise<string>;

  /**
   * Get an environment variable value.
   */
  function env(name: string): Promise<string | undefined>;
}
```

### `wotch.net` -- Network Access

**Required permission:** `net.fetch`

```typescript
namespace wotch.net {
  /**
   * Make an HTTP request. Similar to the Fetch API but simplified.
   * Only HTTP and HTTPS protocols are allowed.
   * Localhost/private IP requests are allowed (needed for local services).
   * Response body is returned as a string (for JSON, call JSON.parse).
   * Maximum response body size: 10MB.
   */
  function fetch(url: string, options?: PluginFetchOptions): Promise<PluginFetchResponse>;
}
```

### `wotch.git` -- Git Operations

**Required permission:** `git.read` for read operations, `git.write` for write operations.

```typescript
namespace wotch.git {
  /**
   * Get git status for the current project or a specified path.
   */
  function status(projectPath?: string): Promise<GitStatusInfo>;

  /**
   * Get git diff for the current project or a specified path.
   * Mode: 'staged', 'unstaged', 'last-checkpoint', 'head'.
   */
  function diff(projectPath?: string, mode?: string): Promise<GitDiffResult>;

  /**
   * Get the current branch name.
   */
  function branch(projectPath?: string): Promise<string>;

  /**
   * Get recent commit log entries.
   */
  function log(projectPath?: string, count?: number): Promise<Array<{
    hash: string;
    message: string;
    author: string;
    date: string;
  }>>;

  /**
   * Create a Wotch checkpoint (git add + commit on checkpoint branch).
   * Requires git.write permission.
   */
  function checkpoint(projectPath?: string, message?: string): Promise<{
    success: boolean;
    message: string;
  }>;
}
```

---

## Event Summary

All events are subscribed via `on*` methods that return a `Disposable`. Calling `dispose()` removes the listener.

| Event | Namespace | Permission | Payload |
|-------|-----------|------------|---------|
| Status changed | `wotch.status.onChanged` | none | `TabStatus` |
| Tab created | `wotch.tabs.onCreated` | none | `TabInfo` |
| Tab closed | `wotch.tabs.onClosed` | none | `string` (tabId) |
| Tab activated | `wotch.tabs.onActivated` | none | `string` (tabId) |
| Terminal data | `wotch.terminal.onData` | `terminal.read` | `{ tabId, data }` |
| Expansion changed | `wotch.ui.onExpansionChanged` | none | `boolean` |
| Setting changed | `wotch.settings.onChanged` | none | `SettingChangeEvent` |
| Project changed | `wotch.project.onChanged` | none | `ProjectInfo \| null` |

## API Availability Matrix

| Namespace | Renderer (`renderer.js`) | Main Process (`main.js`) |
|-----------|:------------------------:|:------------------------:|
| `wotch.commands` | yes | yes |
| `wotch.status` | yes | yes |
| `wotch.ui` | yes | yes (proxied to renderer) |
| `wotch.tabs` | yes | yes |
| `wotch.terminal` | yes | yes |
| `wotch.settings` | yes | yes |
| `wotch.project` | yes | yes |
| `wotch.fs` | no | yes |
| `wotch.process` | no | yes |
| `wotch.net` | no | yes |
| `wotch.git` | no | yes |

Renderer plugins that need filesystem, process, network, or git access must have a companion `main.js` entry point. The renderer entry communicates with the main entry via `wotch.settings` (for configuration) or by registering commands that the main entry handles.

## API Versioning

The plugin API is versioned alongside Wotch. The `engines.wotch` field in the manifest declares compatibility. The API object exposes a version property:

```typescript
/** Read-only version info on the API object. */
wotch.version: string;  // e.g., "1.0.0"
```

Future API additions will be backward-compatible (new methods, not changed signatures). Breaking changes will bump the major version of Wotch.
