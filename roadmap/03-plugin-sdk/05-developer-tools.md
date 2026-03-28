# 05 - Developer Tools

## Overview

This document covers the developer experience for building Wotch plugins: the SDK package, scaffolding CLI, hot-reload, debugging, and a complete walkthrough of building a plugin from scratch.

## `@wotch/sdk` Package

The SDK is an npm package that provides TypeScript types, a test harness, and a development server. It is NOT a runtime dependency of Wotch itself -- it is a development dependency for plugin authors.

### Package Contents

```
@wotch/sdk/
  package.json
  types/
    index.d.ts          // All TypeScript type definitions from 03-api-surface.md
    plugin-context.d.ts // PluginContext, PluginStorage, Disposable
    renderer-api.d.ts   // wotch.commands, wotch.status, wotch.ui, etc.
    main-api.d.ts       // wotch.fs, wotch.process, wotch.net, wotch.git
    manifest.d.ts       // PluginManifest type for manifest.json
  test/
    harness.js          // Test harness that mocks the wotch API
    harness.d.ts        // Types for the test harness
  dev/
    server.js           // Development server with hot-reload
  cli/
    init.js             // Plugin scaffolding CLI
  README.md
```

### TypeScript Types (`@wotch/sdk/types`)

Plugin authors add `@wotch/sdk` as a dev dependency and reference types:

```typescript
// In plugin's main.js or renderer.js (with JSDoc)

/** @type {import('@wotch/sdk/types').PluginContext} */
// Or in TypeScript:
import type { PluginContext } from '@wotch/sdk/types';

export function activate(context: PluginContext) {
  // Full autocomplete and type checking for wotch.*
}
```

The types file re-exports everything from `03-api-surface.md` as TypeScript declarations.

### Test Harness (`@wotch/sdk/test`)

The test harness provides mock implementations of the entire `wotch` API, allowing plugins to be tested without running Electron.

```javascript
const { createTestHarness } = require('@wotch/sdk/test/harness');

// Create a harness with mock permissions
const harness = createTestHarness({
  permissions: ['terminal.read', 'ui.notifications'],
  settings: {
    'my-plugin.refreshInterval': 10
  }
});

// Load and activate the plugin
const plugin = require('./renderer.js');
await plugin.activate(harness.context);

// Simulate terminal data
harness.terminal.emit('data', { tabId: 'tab-1', data: 'hello world\n' });

// Check what the plugin did
console.log(harness.notifications); // [{ message: '...', type: 'info' }]
console.log(harness.commands);      // [{ id: 'my-plugin.greet', title: '...' }]

// Deactivate
await plugin.deactivate();

// Verify cleanup
console.log(harness.subscriptions.disposed); // true
```

**Harness API:**

```typescript
interface TestHarness {
  /** The PluginContext passed to activate(). */
  context: PluginContext;

  /** Mock wotch API with recording capabilities. */
  api: MockWotchAPI;

  /** All notifications shown by the plugin. */
  notifications: NotificationOptions[];

  /** All commands registered by the plugin. */
  commands: CommandDefinition[];

  /** All status detectors registered. */
  statusDetectors: Map<string, StatusDetectorCallback>;

  /** Simulated terminal for emitting data events. */
  terminal: {
    emit(event: 'data', payload: { tabId: string; data: string }): void;
  };

  /** Simulated status for emitting changes. */
  status: {
    emit(status: TabStatus): void;
  };

  /** Track subscription disposal. */
  subscriptions: {
    count: number;
    disposed: boolean;
  };

  /** Reset all recorded state. */
  reset(): void;
}
```

### Development Server (`@wotch/sdk/dev`)

The dev server watches plugin files and triggers hot-reload in a running Wotch instance.

```bash
# From the plugin directory
npx @wotch/sdk dev

# Or with specific options
npx @wotch/sdk dev --port 9222 --plugin-dir .
```

The dev server:

1. Watches the plugin directory for file changes using `fs.watch`.
2. On change, sends a reload signal to Wotch via the local API (Plan 1) or via a special IPC mechanism if the local API is not yet available.
3. Wotch's PluginHost deactivates and re-activates the changed plugin.
4. Console output from the plugin (via the scoped `console` in the vm context) is forwarded to the dev server's terminal.

**Fallback without Local API:** If Plan 1 (Local API) has not been implemented yet, the dev server writes a trigger file `~/.wotch/plugin-dev-reload` containing the plugin name. The PluginHost watches for this file and reloads accordingly.

## Plugin Scaffolding CLI

### `wotch-plugin init`

The CLI creates a new plugin project with all boilerplate:

```bash
npx @wotch/sdk init my-plugin
```

Interactive prompts:

```
? Plugin name: my-plugin
? Display name: My Plugin
? Description: A cool Wotch plugin
? Author: Your Name
? Plugin type:
  > Command plugin (renderer only)
    Status detector (renderer only)
    Panel plugin (renderer + main)
    Full plugin (main + renderer)
    Theme pack (renderer, declarative)
? Permissions needed:
  [ ] fs.read - Read files
  [ ] fs.write - Write files
  [ ] process.exec - Execute commands
  [ ] net.fetch - HTTP requests
  [ ] git.read - Read git info
  [ ] git.write - Git commits
  [x] terminal.read - Terminal output
  [ ] terminal.write - Terminal input
  [x] ui.panels - Panel views
  [ ] ui.notifications - Notifications
? Use TypeScript? No

Creating my-plugin/
  manifest.json
  renderer.js
  package.json
  .gitignore
  README.md

Done! Next steps:
  cd my-plugin
  npm install
  ln -s $(pwd) ~/.wotch/plugins/my-plugin
  npx @wotch/sdk dev
```

### Generated Files

**`manifest.json`** -- Pre-filled from prompts:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "displayName": "My Plugin",
  "description": "A cool Wotch plugin",
  "author": "Your Name",
  "license": "MIT",
  "renderer": "renderer.js",
  "permissions": ["terminal.read", "ui.panels"],
  "activationEvents": ["*"],
  "contributes": {
    "commands": [
      {
        "id": "my-plugin.hello",
        "title": "My Plugin: Hello"
      }
    ]
  },
  "engines": {
    "wotch": ">=1.0.0"
  }
}
```

**`renderer.js`** -- Starter code:

```javascript
/** @type {import('@wotch/sdk/types').PluginContext} */
let ctx;

module.exports = {
  activate(context) {
    ctx = context;

    const cmd = wotch.commands.register({
      id: 'my-plugin.hello',
      title: 'My Plugin: Hello',
      handler() {
        wotch.ui.showNotification({ message: 'Hello from My Plugin!' });
      }
    });
    context.subscriptions.push(cmd);
  },

  deactivate() {
    // Subscriptions are auto-disposed, but clean up other resources here.
  }
};
```

**`package.json`** -- Minimal:

```json
{
  "name": "wotch-plugin-my-plugin",
  "version": "0.1.0",
  "private": true,
  "devDependencies": {
    "@wotch/sdk": "^1.0.0"
  }
}
```

## Hot-Reload During Development

### How It Works

1. Developer symlinks their plugin directory into `~/.wotch/plugins/`:
   ```bash
   ln -s /path/to/my-plugin ~/.wotch/plugins/my-plugin
   ```

2. Developer starts the dev server:
   ```bash
   npx @wotch/sdk dev
   ```

3. On file save, the dev server writes a reload trigger:
   ```bash
   echo "my-plugin" > ~/.wotch/plugin-dev-reload
   ```

4. The PluginHost `fs.watch` on `~/.wotch/plugin-dev-reload` detects the change.

5. PluginHost:
   a. Calls `deactivate()` on the plugin
   b. Destroys the vm context / iframe
   c. Invalidates any cached code (the vm context is recreated from scratch)
   d. Re-reads the manifest (in case it changed)
   e. Re-validates the manifest
   f. Creates a fresh vm context / iframe
   g. Loads the updated code
   h. Calls `activate(context)`

6. The dev server terminal shows:
   ```
   [wotch-dev] File changed: renderer.js
   [wotch-dev] Reloading my-plugin...
   [wotch-dev] Plugin reloaded successfully.
   ```

### Reload Timing

Hot-reload is debounced: multiple file changes within 300ms trigger a single reload. This handles editors that write files atomically (write to temp, rename).

### Reload Failures

If the reloaded plugin fails to activate (syntax error, runtime error), the PluginHost:
- Logs the error with full stack trace
- Sets the plugin state to `error`
- Displays the error in the dev server terminal
- Does NOT revert to the previous version (the developer needs to fix the bug)

## Debugging

### Attach to Electron DevTools

Plugin renderer code runs in iframes within the Electron renderer. Developers can debug using Chrome DevTools:

1. Launch Wotch with DevTools:
   ```bash
   npx electron . --inspect
   ```

2. Or toggle DevTools from within Wotch via a developer command. Add this to the command palette when `devMode` is enabled in settings:
   ```
   Developer: Open DevTools
   Developer: Reload Plugins
   Developer: Show Plugin Logs
   ```

3. In DevTools, the iframe's JS context appears in the "Sources" panel under the plugin's iframe origin. Breakpoints work normally.

### Main-Process Plugin Debugging

Main-process plugins run in vm contexts on the main thread. Debugging options:

1. **Console logging.** The scoped `console` provided to plugins routes output to Electron's main-process console with a `[wotch:plugin:<id>]` prefix.

2. **Inspect main process.** Launch with `--inspect-brk`:
   ```bash
   npx electron . --inspect-brk=9229
   ```
   Attach from `chrome://inspect` or VS Code. Breakpoints in vm-evaluated code work but require the `sourceURL` pragma (automatically added by PluginLoader).

3. **Plugin log file.** When `devMode` is enabled, all plugin console output is written to `~/.wotch/plugin-logs/<pluginId>.log`.

### devMode Setting

A `devMode` boolean setting (default `false`) enables developer features:

- Plugin hot-reload watching
- Plugin console output to log files
- Developer commands in command palette
- Verbose plugin lifecycle logging to main process console

Enable it in settings.json:
```json
{ "devMode": true }
```

Or via the command palette: "Developer: Enable Dev Mode"

## Example Plugin Walkthrough: Word Count Status Detector

This walkthrough builds a complete plugin from scratch that monitors terminal output and displays word/line counts when a file is saved or viewed with `wc` or `cat`.

### Step 1: Scaffold

```bash
npx @wotch/sdk init word-count
# Choose: Status detector
# Permissions: terminal.read
```

### Step 2: Write manifest.json

```json
{
  "name": "word-count",
  "version": "1.0.0",
  "displayName": "Word Count",
  "description": "Displays word and line count from terminal output in the status pill.",
  "author": "You",
  "license": "MIT",
  "renderer": "renderer.js",
  "permissions": ["terminal.read"],
  "activationEvents": ["*"],
  "contributes": {
    "statusDetectors": [
      {
        "id": "word-count.detector",
        "label": "Word Count",
        "priority": 30
      }
    ],
    "commands": [
      {
        "id": "word-count.clear",
        "title": "Word Count: Clear"
      }
    ]
  },
  "engines": {
    "wotch": ">=1.0.0"
  }
}
```

### Step 3: Write renderer.js

```javascript
/**
 * Word Count Status Detector for Wotch
 *
 * Watches terminal output for patterns like:
 *   - `wc` output: "  42  316 2048 filename.txt"
 *   - `cat filename | wc -l` output
 *   - Editor save messages with line counts
 */

let lastCount = null;

module.exports = {
  activate(context) {
    // Register the status detector
    const detector = wotch.status.registerDetector('word-count.detector', (data) => {
      // Match `wc` output format: lines words bytes filename
      const wcMatch = data.cleanData.match(
        /^\s*(\d+)\s+(\d+)\s+\d+\s+(.+)$/m
      );
      if (wcMatch) {
        const lines = parseInt(wcMatch[1]);
        const words = parseInt(wcMatch[2]);
        const file = wcMatch[3].trim();
        lastCount = { lines, words, file };
        return {
          state: 'idle',
          description: `${file}: ${words}w ${lines}L`
        };
      }

      // Match just `wc -l` output: "42 filename" or just "42"
      const wclMatch = data.cleanData.match(/^\s*(\d+)\s*(.*)$/m);
      if (wclMatch && data.cleanData.includes('wc')) {
        const lines = parseInt(wclMatch[1]);
        const file = wclMatch[2].trim() || 'stdin';
        lastCount = { lines, words: null, file };
        return {
          state: 'idle',
          description: `${file}: ${lines} lines`
        };
      }

      // No match -- defer to other detectors
      return null;
    });
    context.subscriptions.push(detector);

    // Register clear command
    const clearCmd = wotch.commands.register({
      id: 'word-count.clear',
      title: 'Word Count: Clear',
      handler() {
        lastCount = null;
      }
    });
    context.subscriptions.push(clearCmd);
  },

  deactivate() {
    lastCount = null;
  }
};
```

### Step 4: Install for Development

```bash
# Symlink into plugins directory
ln -s $(pwd)/word-count ~/.wotch/plugins/word-count

# Start dev server
cd word-count
npx @wotch/sdk dev
```

### Step 5: Test

1. Open Wotch (or it hot-reloads if already running).
2. In the terminal, run: `wc src/main.js`
3. Observe the pill status shows the word/line count.
4. Open command palette (Ctrl+Shift+P), search "Word Count: Clear".
5. Status resets.

### Step 6: Write Automated Tests

Create `test.js`:

```javascript
const { createTestHarness } = require('@wotch/sdk/test/harness');
const plugin = require('./renderer.js');

async function test() {
  const harness = createTestHarness({
    permissions: ['terminal.read']
  });

  await plugin.activate(harness.context);

  // Verify detector was registered
  const detector = harness.statusDetectors.get('word-count.detector');
  if (!detector) throw new Error('Detector not registered');

  // Simulate wc output
  const result = detector({
    tabId: 'tab-1',
    rawData: '  42  316 2048 readme.md\n',
    cleanData: '  42  316 2048 readme.md\n'
  });

  if (!result) throw new Error('Detector returned null');
  if (result.description !== 'readme.md: 316w 42L') {
    throw new Error(`Unexpected description: ${result.description}`);
  }

  // Test non-matching input
  const nullResult = detector({
    tabId: 'tab-1',
    rawData: 'ls -la\n',
    cleanData: 'ls -la\n'
  });
  if (nullResult !== null) throw new Error('Should return null for non-matching input');

  await plugin.deactivate();

  console.log('All tests passed!');
}

test().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```

Run:
```bash
node test.js
```

### Step 7: Distribute

To share the plugin:

1. Zip the plugin directory (excluding `node_modules/`).
2. Users extract to `~/.wotch/plugins/word-count/`.
3. Restart Wotch or use "Developer: Reload Plugins".
4. The permission prompt appears, user grants `terminal.read`.
5. Plugin is active.

## Publishing Guidelines

### Directory Structure Requirements

A distributable plugin must contain:
- `manifest.json` (required, validated)
- Entry point files referenced in manifest (required)
- No `node_modules/` (plugins cannot use npm dependencies at runtime; bundle if needed)
- No native binaries or `.node` files
- Total uncompressed size should be under 5MB

### Naming Conventions

- Plugin name (directory and `manifest.name`): `kebab-case`, 3-50 chars
- Command IDs: `<plugin-name>.<camelCase>` (e.g., `word-count.clear`)
- Setting IDs: `<plugin-name>.<camelCase>` (e.g., `word-count.refreshInterval`)
- Panel IDs: `<plugin-name>.<camelCase>` (e.g., `gh-pr-status.mainPanel`)

### Bundling Dependencies

Plugins cannot use `require()` to load npm packages. If a plugin needs library code, it must be bundled into the entry point file. Recommended approach:

```bash
# Use esbuild to bundle
npx esbuild src/main.ts --bundle --outfile=main.js --platform=node --format=cjs
npx esbuild src/renderer.ts --bundle --outfile=renderer.js --platform=browser --format=cjs
```

The scaffold CLI includes an optional esbuild configuration for this.

### Version Updates

When updating a plugin:
1. Increment `version` in manifest.json.
2. If new permissions are needed, add them to the `permissions` array.
3. Users replace the plugin directory. Wotch detects the change and prompts for new permissions if needed.
