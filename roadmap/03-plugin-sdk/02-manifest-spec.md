# 02 - Plugin Manifest Specification

## Overview

Every plugin must contain a `manifest.json` at its root directory. This file declares the plugin's identity, entry points, permissions, and contributions. The `ManifestValidator` in `src/plugin-manifest.js` validates this file at discovery time.

## Complete Field Reference

### Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | **yes** | -- | Unique plugin identifier. Must match `^[a-z][a-z0-9-]{2,49}$` (lowercase, hyphens, 3-50 chars). Must match the directory name. |
| `version` | `string` | **yes** | -- | SemVer string (e.g., `"1.0.0"`, `"0.3.2-beta.1"`). Validated with regex `^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$`. |
| `displayName` | `string` | **yes** | -- | Human-readable name shown in UI. 1-100 characters. |
| `description` | `string` | **yes** | -- | Short description. 1-500 characters. |
| `author` | `string` or `object` | no | `"Unknown"` | Plugin author. If string, treated as name. If object, must have `name` field and optionally `email` and `url`. |
| `license` | `string` | no | `"UNLICENSED"` | SPDX license identifier (e.g., `"MIT"`, `"Apache-2.0"`). |
| `main` | `string` | no | -- | Relative path to main-process entry point (e.g., `"main.js"`). Must end in `.js`. Path traversal (`..`) is rejected. |
| `renderer` | `string` | no | -- | Relative path to renderer entry point (e.g., `"renderer.js"`). Must end in `.js`. Path traversal (`..`) is rejected. |
| `permissions` | `string[]` | no | `[]` | List of permission scope strings the plugin requires. See [04-permissions.md](./04-permissions.md). |
| `activationEvents` | `string[]` | no | `["*"]` | Events that trigger plugin activation. See Activation Events below. |
| `contributes` | `object` | no | `{}` | Contributions to the Wotch UI and systems. See Contributions below. |
| `engines` | `object` | no | `{}` | Compatibility constraints. See Engines below. |

**Validation rule:** At least one of `main` or `renderer` must be specified. A manifest with neither is rejected.

### `author` Object Format

```json
{
  "author": {
    "name": "Jane Developer",
    "email": "jane@example.com",
    "url": "https://github.com/janedeveloper"
  }
}
```

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | **yes** |
| `email` | `string` | no |
| `url` | `string` | no |

### `permissions` Array

Each element must be one of the recognized permission strings:

- `fs.read` -- Read files from the filesystem
- `fs.write` -- Write/create/delete files
- `process.exec` -- Execute shell commands
- `net.fetch` -- Make outbound HTTP requests
- `git.read` -- Read git status, branches, diffs
- `git.write` -- Create commits, checkpoints
- `terminal.read` -- Receive terminal output data
- `terminal.write` -- Send input to terminal
- `ui.panels` -- Create panel views in the expanded UI
- `ui.notifications` -- Show toast notifications

Unknown permission strings cause validation failure.

### `activationEvents` Array

Determines when a plugin is activated. Lazy activation improves startup time.

| Event | Description |
|-------|-------------|
| `"*"` | Activate immediately on Wotch startup (default) |
| `"onCommand:<commandId>"` | Activate when a specific command is invoked |
| `"onStatus:<state>"` | Activate when Claude status enters a specific state (`idle`, `thinking`, `working`, `waiting`, `done`, `error`) |
| `"onTerminalCreated"` | Activate when a new terminal tab is created |
| `"onSettingsOpened"` | Activate when the user opens settings |

If the array contains `"*"`, all other events are ignored and the plugin activates immediately.

If a plugin contributes commands with `onCommand:` activation, the command palette shows the command immediately but the plugin is loaded only when the command is first invoked.

### `contributes` Object

#### `contributes.commands`

Array of commands to add to the command palette.

```json
{
  "contributes": {
    "commands": [
      {
        "id": "my-plugin.sayHello",
        "title": "My Plugin: Say Hello",
        "shortcut": ""
      }
    ]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Unique command ID. Must be prefixed with plugin name (e.g., `"my-plugin.doThing"`). Validated: `^[a-z][a-z0-9-]+\.[a-zA-Z][a-zA-Z0-9.]+$`. |
| `title` | `string` | **yes** | Display text in command palette. 1-100 characters. |
| `shortcut` | `string` | no | Keyboard shortcut hint shown in palette (display only; shortcut binding is not implemented in v1). |

#### `contributes.statusDetectors`

Array of custom status detector registrations. These are activated by the renderer plugin and contribute to the pill status display.

```json
{
  "contributes": {
    "statusDetectors": [
      {
        "id": "my-plugin.buildStatus",
        "label": "Build Status",
        "priority": 50
      }
    ]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Unique detector ID. Must be prefixed with plugin name. |
| `label` | `string` | **yes** | Human-readable label for the detector. |
| `priority` | `number` | no | Priority for display when multiple detectors report status. Higher = more important. Default `50`. Range: 0-100. The built-in Claude detector has priority 90. |

#### `contributes.panels`

Array of panel views that appear in the expanded UI.

```json
{
  "contributes": {
    "panels": [
      {
        "id": "my-plugin.mainPanel",
        "title": "My Panel",
        "icon": "📊",
        "location": "sidebar"
      }
    ]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Unique panel ID. Must be prefixed with plugin name. |
| `title` | `string` | **yes** | Panel tab/header title. 1-50 characters. |
| `icon` | `string` | no | Emoji or single character for the panel tab. Default: plugin name first char. |
| `location` | `string` | no | Where the panel appears. `"sidebar"` (right side of expanded view) or `"bottom"` (below terminal). Default: `"sidebar"`. |

Requires `ui.panels` permission.

#### `contributes.settings`

Array of configuration keys the plugin registers, appearing in the settings panel under a plugin-specific section.

```json
{
  "contributes": {
    "settings": [
      {
        "id": "my-plugin.refreshInterval",
        "title": "Refresh Interval (seconds)",
        "type": "number",
        "default": 30,
        "minimum": 5,
        "maximum": 3600,
        "description": "How often to poll for updates."
      },
      {
        "id": "my-plugin.showNotifications",
        "title": "Show Notifications",
        "type": "boolean",
        "default": true,
        "description": "Whether to show toast notifications."
      },
      {
        "id": "my-plugin.outputFormat",
        "title": "Output Format",
        "type": "string",
        "default": "compact",
        "enum": ["compact", "detailed", "json"],
        "description": "Display format for results."
      }
    ]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Setting key. Must be prefixed with plugin name. Stored in `~/.wotch/settings.json` under `pluginSettings.<id>`. |
| `title` | `string` | **yes** | Label shown in settings UI. |
| `type` | `string` | **yes** | One of: `"string"`, `"number"`, `"boolean"`. |
| `default` | `any` | **yes** | Default value. Must match declared type. |
| `description` | `string` | no | Help text shown below the input. |
| `minimum` | `number` | no | For `type: "number"`. Minimum allowed value. |
| `maximum` | `number` | no | For `type: "number"`. Maximum allowed value. |
| `enum` | `string[]` | no | For `type: "string"`. Restricts to listed values, rendered as a dropdown. |

#### `contributes.themes`

Array of custom themes. Each theme provides CSS variable overrides and terminal color values matching the existing theme structure in `renderer.js`.

```json
{
  "contributes": {
    "themes": [
      {
        "id": "my-plugin.nord",
        "name": "Nord",
        "colors": {
          "--bg": "rgba(46, 52, 64, 0.97)",
          "--bg-solid": "#2e3440",
          "--border": "rgba(76, 86, 106, 0.3)",
          "--accent": "#88c0d0",
          "--accent-dim": "rgba(136, 192, 208, 0.15)",
          "--text": "#eceff4",
          "--text-dim": "#d8dee9",
          "--text-muted": "#4c566a",
          "--green": "#a3be8c",
          "termBg": "#2e3440",
          "termFg": "#eceff4",
          "termCursor": "#88c0d0"
        }
      }
    ]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | **yes** | Unique theme ID. Must be prefixed with plugin name. |
| `name` | `string` | **yes** | Display name in theme selector. 1-30 characters. |
| `colors` | `object` | **yes** | Color definitions. Must include all required keys (see below). |

Required color keys: `--bg`, `--bg-solid`, `--border`, `--accent`, `--accent-dim`, `--text`, `--text-dim`, `--text-muted`, `--green`, `termBg`, `termFg`, `termCursor`. Values must be valid CSS color strings.

No permission required for theme contributions.

### `engines` Object

```json
{
  "engines": {
    "wotch": ">=1.0.0"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `wotch` | `string` | no | SemVer range string specifying compatible Wotch versions. Uses standard node-semver range syntax (`>=1.0.0`, `^1.2.0`, `1.x`). If omitted, no version check is performed. If present and incompatible, the plugin is rejected with an informative error. |

## Validation Rules Summary

The `ManifestValidator` applies these checks in order. The first failure stops validation and the plugin is marked `invalid`.

1. File `manifest.json` must exist and parse as valid JSON.
2. `name` must be present, match `^[a-z][a-z0-9-]{2,49}$`, and match the directory name.
3. `version` must be present and match SemVer format.
4. `displayName` must be present, 1-100 characters.
5. `description` must be present, 1-500 characters.
6. At least one of `main` or `renderer` must be specified.
7. `main`, if present, must end in `.js`, not contain `..`, and the file must exist on disk.
8. `renderer`, if present, must end in `.js`, not contain `..`, and the file must exist on disk.
9. `permissions`, if present, must be an array of recognized permission strings.
10. `activationEvents`, if present, must be an array of valid event strings.
11. `contributes.commands[].id` must match `^[a-z][a-z0-9-]+\.[a-zA-Z][a-zA-Z0-9.]+$` and be prefixed with the plugin name.
12. `contributes.statusDetectors[].id` must be prefixed with the plugin name.
13. `contributes.panels[].id` must be prefixed with the plugin name. `ui.panels` must be in `permissions`.
14. `contributes.settings[].id` must be prefixed with the plugin name. `type` must be one of `string`, `number`, `boolean`. `default` must match declared type.
15. `contributes.themes[].colors` must contain all required CSS variable keys.
16. `engines.wotch`, if present, must be a valid SemVer range and the current Wotch version must satisfy it.

## Full Example Manifests

### Example 1: Status Detector Plugin (renderer only)

```json
{
  "name": "word-count",
  "version": "1.0.0",
  "displayName": "Word Count",
  "description": "Displays word and line count of the active file based on terminal output.",
  "author": "Jane Developer",
  "license": "MIT",
  "renderer": "renderer.js",
  "permissions": [
    "terminal.read"
  ],
  "activationEvents": ["*"],
  "contributes": {
    "statusDetectors": [
      {
        "id": "word-count.detector",
        "label": "Word Count",
        "priority": 30
      }
    ]
  },
  "engines": {
    "wotch": ">=1.0.0"
  }
}
```

### Example 2: Command + Panel Plugin (main + renderer)

```json
{
  "name": "gh-pr-status",
  "version": "0.2.0",
  "displayName": "GitHub PR Status",
  "description": "Shows pull request status for the current branch with review details.",
  "author": {
    "name": "Dev Team",
    "url": "https://github.com/devteam/gh-pr-status"
  },
  "license": "MIT",
  "main": "main.js",
  "renderer": "renderer.js",
  "permissions": [
    "net.fetch",
    "git.read",
    "ui.panels",
    "ui.notifications"
  ],
  "activationEvents": ["*"],
  "contributes": {
    "commands": [
      {
        "id": "gh-pr-status.refresh",
        "title": "GitHub: Refresh PR Status"
      },
      {
        "id": "gh-pr-status.openInBrowser",
        "title": "GitHub: Open PR in Browser"
      }
    ],
    "panels": [
      {
        "id": "gh-pr-status.panel",
        "title": "PR Status",
        "icon": "🔀",
        "location": "sidebar"
      }
    ],
    "settings": [
      {
        "id": "gh-pr-status.token",
        "title": "GitHub Token",
        "type": "string",
        "default": "",
        "description": "Personal access token for GitHub API. Required for private repos."
      },
      {
        "id": "gh-pr-status.pollInterval",
        "title": "Poll Interval (seconds)",
        "type": "number",
        "default": 60,
        "minimum": 10,
        "maximum": 600,
        "description": "How often to check PR status."
      }
    ]
  },
  "engines": {
    "wotch": ">=1.0.0"
  }
}
```

### Example 3: Theme Pack (no code, declaration only)

```json
{
  "name": "extra-themes",
  "version": "1.0.0",
  "displayName": "Extra Themes",
  "description": "Additional themes: Nord, Solarized Dark, Dracula.",
  "author": "Theme Author",
  "license": "MIT",
  "renderer": "renderer.js",
  "permissions": [],
  "activationEvents": ["*"],
  "contributes": {
    "themes": [
      {
        "id": "extra-themes.nord",
        "name": "Nord",
        "colors": {
          "--bg": "rgba(46, 52, 64, 0.97)",
          "--bg-solid": "#2e3440",
          "--border": "rgba(76, 86, 106, 0.3)",
          "--accent": "#88c0d0",
          "--accent-dim": "rgba(136, 192, 208, 0.15)",
          "--text": "#eceff4",
          "--text-dim": "#d8dee9",
          "--text-muted": "#4c566a",
          "--green": "#a3be8c",
          "termBg": "#2e3440",
          "termFg": "#eceff4",
          "termCursor": "#88c0d0"
        }
      },
      {
        "id": "extra-themes.dracula",
        "name": "Dracula",
        "colors": {
          "--bg": "rgba(40, 42, 54, 0.97)",
          "--bg-solid": "#282a36",
          "--border": "rgba(98, 114, 164, 0.3)",
          "--accent": "#bd93f9",
          "--accent-dim": "rgba(189, 147, 249, 0.15)",
          "--text": "#f8f8f2",
          "--text-dim": "#6272a4",
          "--text-muted": "#44475a",
          "--green": "#50fa7b",
          "termBg": "#282a36",
          "termFg": "#f8f8f2",
          "termCursor": "#bd93f9"
        }
      }
    ]
  },
  "engines": {
    "wotch": ">=1.0.0"
  }
}
```

The `renderer.js` for a theme-only plugin can be minimal:

```javascript
module.exports = {
  activate(context) {
    // Themes are registered declaratively via manifest.
    // No runtime code needed.
  },
  deactivate() {}
};
```

### Example 4: Lazy-Activated Command Plugin (main only)

```json
{
  "name": "snippet-runner",
  "version": "1.0.0",
  "displayName": "Snippet Runner",
  "description": "Save and run frequently used terminal command sequences.",
  "author": "Plugin Dev",
  "main": "main.js",
  "permissions": [
    "terminal.write",
    "fs.read",
    "fs.write"
  ],
  "activationEvents": [
    "onCommand:snippet-runner.run",
    "onCommand:snippet-runner.save"
  ],
  "contributes": {
    "commands": [
      {
        "id": "snippet-runner.run",
        "title": "Snippets: Run Snippet"
      },
      {
        "id": "snippet-runner.save",
        "title": "Snippets: Save Current Command"
      }
    ],
    "settings": [
      {
        "id": "snippet-runner.storageFile",
        "title": "Snippets File Path",
        "type": "string",
        "default": "~/.wotch/snippets.json",
        "description": "Where to store saved snippets."
      }
    ]
  },
  "engines": {
    "wotch": ">=1.0.0"
  }
}
```
