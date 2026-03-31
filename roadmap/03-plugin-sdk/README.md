# Plan 3: Wotch Plugin/Extension SDK

## Overview

This plan introduces a plugin system to Wotch, transforming it from a standalone floating terminal into an extensible platform. Third-party developers can build plugins that add commands, status detectors, UI panels, themes, and service integrations -- all running within a permission-gated sandbox.

## Goals

1. **Extensibility without core changes.** Plugin authors extend Wotch without forking or modifying `src/main.js`, `src/renderer.js`, or `src/preload.js`.
2. **Security by default.** Plugins declare permissions in a manifest; capabilities not granted are unavailable. Main-process plugins run in isolated `vm` contexts. Renderer plugins run in sandboxed iframes.
3. **Low friction for developers.** A TypeScript SDK package (`@wotch/sdk`) provides types, a test harness, and a CLI scaffolding tool. Hot-reload during development. Full DevTools access.
4. **Discoverable and manageable.** Users install plugins by dropping folders into `~/.wotch/plugins/`. A settings panel lists installed plugins with enable/disable/uninstall controls and permission review.
5. **Backward compatible.** The plugin system is additive. Wotch with zero plugins behaves identically to today's build.

## Scope

### In scope

- Plugin manifest format (`manifest.json`) with validation
- Plugin discovery from `~/.wotch/plugins/<plugin-name>/`
- Plugin lifecycle: `init` -> `activate` -> `deactivate` -> `dispose`
- Main-process plugin host running plugins in Node.js `vm` contexts with permission-gated API proxies
- Renderer-side plugin bridge: sandboxed iframes for panel contributions, message-passing API for command/status contributions
- Permission system: 10 permission scopes, install-time prompting, revocation UI
- Plugin API surface: ~30 methods across renderer and main-process namespaces
- Command palette integration: plugins register commands that appear in Ctrl+Shift+P
- Settings integration: plugins register configuration keys that appear in the settings panel
- `@wotch/sdk` npm package: TypeScript types, test harness, dev server, scaffolding CLI
- Hot-reload in development mode

### Out of scope (non-goals)

- **Plugin marketplace / registry.** No centralized store. Plugins are distributed as directories or tarballs. A marketplace can be added later.
- **Plugin auto-update.** Plugins are manually updated by replacing their directory.
- **Cross-plugin dependencies.** Plugins cannot declare dependencies on other plugins. Each plugin is self-contained.
- **Renderer DOM injection.** Plugins cannot inject arbitrary HTML/CSS/JS into the main renderer document. They get sandboxed iframes for panels and message-passing APIs for everything else.
- **Native module loading.** Plugins cannot load native Node.js addons (`.node` files). They are limited to pure JavaScript.
- **Network server plugins.** Plugins cannot open listening sockets. Outbound fetch is available via `net.fetch` permission.

## Success Criteria

1. A "hello world" plugin can be scaffolded, installed, and activated in under 5 minutes.
2. A plugin can register a command that appears in the command palette and executes custom logic.
3. A plugin can register a custom status detector that changes the pill color/text based on terminal output patterns.
4. A plugin can add a side panel visible in the expanded view with arbitrary HTML content.
5. A plugin requesting `process.exec` triggers a permission prompt before the call succeeds.
6. A plugin without `terminal.read` permission receives no terminal data events.
7. Disabling a plugin in settings immediately deactivates it and removes all its contributions.
8. All existing functionality works identically with zero plugins installed.
9. Plugin crashes do not crash Wotch.

## Example Plugin Ideas

### 1. Word Count Status Detector
Monitors terminal output for file-save events and displays word/line count of the active file in the status pill. Permissions: `fs.read`. Contribution: `statusDetectors`.

### 2. GitHub PR Status
Polls GitHub API for PR status on the current branch and shows review state in a panel. Permissions: `net.fetch`, `git.read`. Contributions: `panels`, `commands`.

### 3. Pomodoro Timer
Adds a command palette action "Start Pomodoro" that shows a 25-minute countdown in the pill status area and sends a notification when done. Permissions: `ui.notifications`. Contributions: `commands`, `statusDetectors`.

### 4. Custom Theme Pack
Registers additional themes (Solarized, Nord, Dracula) available in the theme selector. Permissions: none. Contributions: `themes`.

### 5. Snippet Manager
Registers a panel and commands for saving/inserting frequently used terminal commands. Permissions: `terminal.write`, `ui.panels`. Contributions: `commands`, `panels`.

### 6. Build Watcher
Monitors terminal output for build errors/warnings and displays a summary panel with clickable file paths. Permissions: `terminal.read`, `ui.panels`. Contributions: `panels`, `statusDetectors`.

## Dependency: Plan 0 (Claude Code Deep Integration)

Plan 3 benefits from Plan 0's structured event system:

- **Plugin event API**: Plugins can subscribe to structured hook events (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`) via `wotch.events.onClaudeHook(callback)` instead of parsing terminal output with their own regex. This is the recommended approach for plugins that need to react to Claude Code activity.
- **MCP-compatible plugins**: The plugin manifest can declare MCP tools, and the plugin host can register them with Claude Code via the existing MCP server infrastructure. A plugin that adds a "deploy" tool automatically becomes callable by Claude Code.
- **Bridge context providers**: Plugins can register as context providers for the bridge adapter. When Claude Code requests workspace context, plugins can contribute their own data (e.g., a Docker plugin providing container status).

If Plan 0 is not yet implemented, plugins fall back to the `wotch.terminal.onData()` API for raw terminal output access. All plugin capabilities work — they just have less structured Claude Code data to work with.

---

## Document Index

| Document | Description |
|----------|-------------|
| [01-architecture.md](./01-architecture.md) | Plugin system architecture, isolation model, IPC design |
| [02-manifest-spec.md](./02-manifest-spec.md) | Plugin manifest.json specification |
| [03-api-surface.md](./03-api-surface.md) | Complete plugin API reference with TypeScript types |
| [04-permissions.md](./04-permissions.md) | Permission system design and enforcement |
| [05-developer-tools.md](./05-developer-tools.md) | SDK package, CLI, hot-reload, debugging, walkthrough |
| [06-implementation-steps.md](./06-implementation-steps.md) | Step-by-step build guide with exact file modifications |
