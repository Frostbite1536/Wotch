# Plan 4: Claude Agent SDK Integration

## Overview

Embed the Claude Agent SDK into Wotch so that autonomous AI agents can run inside the Electron main process, observe terminal output, react to events (build failures, test results, checkpoint creation), and execute multi-step tasks with configurable levels of human oversight.

Agents are defined as declarative YAML/JSON files, loaded from `~/.wotch/agents/` (global) or `.wotch/agents/` (per-project). They use a curated set of built-in tools (shell execution, file I/O, git operations, terminal observation) and are governed by a graduated trust model that ranges from "suggest-only" to fully autonomous.

## Goals

1. **Agent Runtime** — Run Claude Agent SDK agent loops in the Electron main process, each agent in its own isolated context with a controlled tool set.
2. **Declarative Agent Definitions** — Let users author and share agents as simple YAML files with tools, triggers, system prompts, and approval modes.
3. **Built-in Tools** — Expose Wotch's existing capabilities (PTY, git, file system, status detection) as Agent SDK tools with well-defined schemas.
4. **Graduated Trust** — Three approval modes (`suggest-only`, `ask-first`, `auto-execute`) with per-agent configuration and dangerous-action detection.
5. **Agent UI Panel** — A collapsible side panel in the renderer showing agent activity, streaming reasoning, tool calls, and action approval dialogs.
6. **Built-in Agents** — Ship four useful agents out of the box: Error Fixer, Code Reviewer, Test Writer, Deploy Assistant.

## Scope

### In scope

- `@anthropic-ai/sdk` dependency installation and main-process integration
- Agent definition format specification and loader (YAML + JSON)
- Agent runtime manager (start, stop, pause, emergency stop)
- 18 built-in tools across 6 categories (Shell, FileSystem, Git, Terminal, Project, Wotch)
- Trust/approval system with UI prompts and audit logging
- Agent panel UI with streaming activity display
- 4 built-in agent definitions
- IPC channels for all agent UI communication
- Preload bridge additions for agent control
- Settings integration for agent trust preferences

### Not in scope

- Custom tool authoring by users (Plan 3 Plugin SDK covers extensibility)
- Multi-agent orchestration / agent-to-agent communication
- Remote agent execution (agents run locally only)
- Agent marketplace or distribution system
- Fine-tuning or model training
- Streaming audio or image tool outputs
- MCP server integration (separate future plan)

## Non-Goals

- Agents must NOT bypass the existing security model (contextIsolation, no nodeIntegration in renderer)
- Agents must NOT have unrestricted shell access — all shell execution goes through the PTY manager with audit logging
- Agents must NOT access the network directly — no HTTP client tool is provided
- Agents must NOT modify Wotch's own source code or settings without user consent
- The agent panel must NOT break the pill/expand/collapse UX — it is additive

## Success Criteria

1. A user can create a `.wotch/agents/my-agent.yaml` file and see it listed in the agent selector within 2 seconds of file save.
2. The Error Fixer agent triggers automatically when the Claude Status Detector reports `error` state, reads the terminal buffer, and proposes a fix within one agent turn.
3. The Code Reviewer agent triggers on `git-checkpoint` and produces inline review comments in the agent panel within 30 seconds.
4. In `suggest-only` mode, no tool call executes without explicit user approval via the UI.
5. In `auto-execute` mode, dangerous actions (file deletion, force push) still require confirmation.
6. Emergency stop (Ctrl+Shift+K) halts all running agents within 500ms.
7. The agent panel renders streaming reasoning tokens at the same frame rate as xterm.js terminal output.
8. All agent actions are persisted to `~/.wotch/agent-logs/` with timestamps, tool calls, and results.

## Example Agent Scenarios

### Scenario 1: Automatic Error Recovery

```
1. User is running `npm test` in a Wotch terminal tab
2. Tests fail — Claude Status Detector transitions to "error" state
3. Error Fixer agent triggers (configured with trigger: onStatusChange → error)
4. Agent reads the terminal buffer (last 500 lines), identifies the failing test
5. Agent reads the relevant source file using the FileSystem.readFile tool
6. Agent proposes a code fix in the agent panel (suggest-only mode)
7. User reviews the suggestion, clicks "Apply", agent writes the fix
8. User re-runs tests — they pass
```

### Scenario 2: Checkpoint Code Review

```
1. User clicks the checkpoint button in Wotch
2. Git checkpoint is created (commit hash abc1234)
3. Code Reviewer agent triggers (trigger: onCheckpoint)
4. Agent runs git diff against the previous checkpoint
5. Agent analyzes the diff, produces review comments
6. Comments appear in the agent panel with file paths and line numbers
7. User reads the review, makes adjustments
```

### Scenario 3: On-Demand Test Generation

```
1. User opens the command palette (Ctrl+Shift+P), selects "Run Agent: Test Writer"
2. Test Writer agent starts (manual trigger)
3. Agent reads git status to find changed files
4. Agent reads each changed file
5. Agent generates test files, shows them in the agent panel
6. User approves, agent writes the test files to disk
7. Agent runs the test suite to verify the new tests pass
```

### Scenario 4: Deploy Checklist

```
1. User triggers Deploy Assistant from the agent selector
2. Agent loads the project's deploy checklist from .wotch/agents/deploy.yaml
3. Agent walks through each step: run linter, run tests, check git status, build
4. Each step shows pass/fail in the agent panel
5. Agent pauses at "Push to remote" step (dangerous action, requires approval)
6. User approves, agent executes git push
7. Agent reports deployment summary
```

## Document Index

| File | Contents |
|------|----------|
| [01-architecture.md](./01-architecture.md) | System architecture, data flow, agent runtime lifecycle |
| [02-agent-definition-format.md](./02-agent-definition-format.md) | YAML/JSON agent definition specification with examples |
| [03-tool-definitions.md](./03-tool-definitions.md) | Complete specification of all built-in agent tools |
| [04-trust-model.md](./04-trust-model.md) | Graduated trust and approval system |
| [05-agent-ui.md](./05-agent-ui.md) | Agent UI panel design, wireframes, HTML/CSS |
| [06-built-in-agents.md](./06-built-in-agents.md) | Specifications for 4 shipped agents |
| [07-implementation-steps.md](./07-implementation-steps.md) | Step-by-step implementation guide |

## Dependencies

- `@anthropic-ai/sdk` — Anthropic SDK for TypeScript/JavaScript (agent loop built on top of this)
- `js-yaml` — YAML parsing for agent definition files
- `chokidar` — File watcher for hot-reloading agent definitions (optional, can use fs.watch)

## Existing Wotch Capabilities Leveraged

| Capability | Location | How agents use it |
|---|---|---|
| PTY Manager | `src/main.js` — `createPty()`, `ptyProcesses` Map | Shell execution tool |
| Claude Status Detector | `src/main.js` — `ClaudeStatusDetector` class | Trigger source, terminal observation |
| Git Operations | `src/main.js` — `gitCheckpoint()`, `gitGetStatus()` | Git tools, checkpoint trigger |
| Project Detection | `src/main.js` — `detectProjects()` | Project context for agents |
| Settings Manager | `src/main.js` — `loadSettings()`, `saveSettings()` | Trust persistence, agent preferences |
| IPC Bridge | `src/preload.js` — `contextBridge` | Agent UI communication |
| Notification System | `src/main.js` — `Notification` | Agent completion alerts |
