# 02 — Agent Definition Format

## Overview

Agents are defined as YAML or JSON files stored in two locations:

- **Global agents:** `~/.wotch/agents/*.yaml` (or `.json`) — available to all projects
- **Per-project agents:** `<projectRoot>/.wotch/agents/*.yaml` (or `.json`) — available only when that project is active

Per-project agents override global agents with the same `name` field. Built-in agents are bundled as YAML files installed to `~/.wotch/agents/` on first run.

## File Discovery

The `AgentLoader` scans both directories on startup and whenever a project is selected. File watcher (`fs.watch`) detects additions, modifications, and deletions.

File naming convention: `<agent-name>.yaml` or `<agent-name>.json`. The filename is not significant — the `name` field inside the file is the canonical identifier.

## Schema Specification

### Top-Level Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | Unique identifier. Lowercase, hyphens allowed. Max 64 chars. |
| `displayName` | string | no | Derived from `name` | Human-readable name shown in UI. |
| `description` | string | yes | — | One-line description shown in agent selector. |
| `version` | string | no | `"1.0.0"` | Semver version of this agent definition. |
| `model` | string | no | `"claude-sonnet-4-20250514"` | Anthropic model ID. |
| `systemPrompt` | string | yes | — | System prompt for the agent. Supports `{{variable}}` template interpolation. |
| `tools` | string[] | yes | — | List of tool names the agent can use. Format: `Category.toolName` or `Category.*` for all tools in a category. |
| `triggers` | Trigger[] | no | `[{ type: "manual" }]` | When the agent should be activated. |
| `approvalMode` | string | no | `"ask-first"` | One of `"suggest-only"`, `"ask-first"`, `"auto-execute"`. |
| `maxTurns` | number | no | `10` | Maximum conversation turns before auto-stop. |
| `maxTokenBudget` | number | no | `50000` | Maximum total tokens (input + output) before auto-stop. |
| `contextSources` | ContextSource[] | no | `[]` | Data to auto-inject into the initial user message. |
| `temperature` | number | no | `0` | Temperature for API calls (0-1). |
| `tags` | string[] | no | `[]` | Freeform tags for organization/filtering. |

### Trigger Object

```yaml
triggers:
  - type: manual              # User manually starts the agent
  - type: onError             # Claude Status Detector reports "error"
    tabScope: active          # "active" (current tab only) or "any"
  - type: onCheckpoint        # After a successful git checkpoint
  - type: onStatusChange      # When Claude status changes
    from: working             # Optional: filter source state
    to: error                 # Required: target state
  - type: cron                # Time-based (requires app to be running)
    schedule: "*/30 * * * *"  # Cron expression (every 30 minutes)
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | One of `"manual"`, `"onError"`, `"onCheckpoint"`, `"onStatusChange"`, `"cron"` |
| `tabScope` | string | no | For terminal-based triggers: `"active"` or `"any"`. Default: `"active"`. |
| `from` | string | no | For `onStatusChange`: filter by source state. |
| `to` | string | no | For `onStatusChange`: filter by target state. |
| `schedule` | string | no | For `cron`: standard cron expression. |
| `debounceMs` | number | no | Minimum ms between automatic triggers. Default: 5000. Prevents rapid re-triggering. |

### ContextSource Object

Context sources automatically inject relevant data into the agent's initial user message, so the agent has the information it needs without making tool calls on the first turn.

```yaml
contextSources:
  - type: terminalBuffer       # Recent terminal output
    lines: 200                 # Number of lines to include
    tabScope: active           # "active" or "any"
  - type: gitDiff              # Current uncommitted changes
    mode: staged               # "staged", "unstaged", or "all"
  - type: gitStatus            # Branch, changed files count
  - type: gitLog               # Recent commit history
    count: 10                  # Number of commits
  - type: projectInfo          # Project name, path, detected language
  - type: file                 # Contents of a specific file
    path: "package.json"       # Relative to project root
  - type: claudeStatus         # Current Claude Code status
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | One of the context types listed above. |
| `lines` | number | no | For `terminalBuffer`: max lines. Default: 200. |
| `tabScope` | string | no | For `terminalBuffer`: `"active"` or `"any"`. Default: `"active"`. |
| `mode` | string | no | For `gitDiff`: `"staged"`, `"unstaged"`, or `"all"`. Default: `"all"`. |
| `count` | number | no | For `gitLog`: number of commits. Default: 10. |
| `path` | string | no | For `file`: path relative to project root. |

### Template Variables in systemPrompt

The `systemPrompt` field supports `{{variable}}` interpolation. Available variables:

| Variable | Value |
|----------|-------|
| `{{projectName}}` | Current project name |
| `{{projectPath}}` | Current project absolute path |
| `{{branch}}` | Current git branch |
| `{{timestamp}}` | ISO 8601 timestamp |
| `{{platform}}` | `"win32"`, `"darwin"`, or `"linux"` |
| `{{shell}}` | Default shell path |

## Validation Rules

The `AgentLoader.validateDefinition()` method checks:

1. `name` is a non-empty string matching `/^[a-z][a-z0-9-]{0,63}$/`
2. `description` is a non-empty string, max 200 chars
3. `systemPrompt` is a non-empty string, max 10000 chars
4. `tools` is a non-empty array of strings, each matching a registered tool (or wildcard `Category.*`)
5. `model` (if present) is a known Anthropic model ID
6. `approvalMode` (if present) is one of the three valid values
7. `maxTurns` (if present) is a positive integer <= 100
8. `maxTokenBudget` (if present) is a positive integer <= 500000
9. `triggers` (if present) is an array of valid Trigger objects
10. `contextSources` (if present) is an array of valid ContextSource objects
11. No unknown top-level keys (warn but don't reject)

Invalid agent files are logged to console and excluded from the agent list. The UI shows a warning icon next to agents with validation warnings.

## Complete Example Agent Definitions

### Example 1: Error Fixer

```yaml
# ~/.wotch/agents/error-fixer.yaml
name: error-fixer
displayName: Error Fixer
description: Detects terminal errors and suggests code fixes
version: "1.0.0"
model: claude-sonnet-4-20250514

systemPrompt: |
  You are an expert debugging assistant integrated into the Wotch terminal.
  The user is working on the project "{{projectName}}" at {{projectPath}}.
  The current git branch is "{{branch}}".

  An error was detected in the terminal output. Your job is to:
  1. Analyze the error message and stack trace
  2. Read the relevant source files to understand the context
  3. Propose a specific, minimal fix

  Rules:
  - Be concise. Explain the root cause in 1-2 sentences.
  - Show the exact code change needed (before/after).
  - If you need to read files, read only the files referenced in the error.
  - Do NOT make speculative changes to unrelated files.
  - If the error is not a code issue (e.g., network timeout, missing env var),
    explain what the user should do instead of proposing a code change.

tools:
  - FileSystem.readFile
  - FileSystem.listFiles
  - FileSystem.searchFiles
  - Terminal.readBuffer
  - Git.status
  - Git.diff

triggers:
  - type: onStatusChange
    to: error
    debounceMs: 10000

approvalMode: suggest-only

contextSources:
  - type: terminalBuffer
    lines: 300
  - type: gitStatus
  - type: projectInfo

maxTurns: 5
maxTokenBudget: 30000
temperature: 0

tags:
  - debugging
  - automatic
```

### Example 2: Code Reviewer

```yaml
# ~/.wotch/agents/code-reviewer.yaml
name: code-reviewer
displayName: Code Reviewer
description: Reviews code changes after each checkpoint
version: "1.0.0"
model: claude-sonnet-4-20250514

systemPrompt: |
  You are a thorough code reviewer for the project "{{projectName}}".
  A checkpoint was just created with new changes. Review the diff and provide
  actionable feedback.

  Focus on:
  - Bugs and logic errors
  - Security issues (injection, secrets, unsafe operations)
  - Performance problems (N+1 queries, unnecessary allocations)
  - Code style and readability
  - Missing error handling
  - Missing or outdated comments

  Format your review as a list of findings. For each finding:
  - State the file and approximate location
  - Describe the issue
  - Suggest a fix (with code if helpful)
  - Rate severity: 🔴 critical, 🟡 suggestion, 🟢 nitpick

  If the code looks good, say so briefly. Do not invent issues.

tools:
  - FileSystem.readFile
  - FileSystem.listFiles
  - FileSystem.searchFiles
  - Git.diff
  - Git.log
  - Git.status

triggers:
  - type: onCheckpoint
    debounceMs: 5000

approvalMode: auto-execute

contextSources:
  - type: gitDiff
    mode: all
  - type: gitLog
    count: 3
  - type: projectInfo

maxTurns: 8
maxTokenBudget: 50000
temperature: 0

tags:
  - review
  - automatic
```

### Example 3: Test Writer

```yaml
# ~/.wotch/agents/test-writer.yaml
name: test-writer
displayName: Test Writer
description: Generates test files for recently changed code
version: "1.0.0"
model: claude-sonnet-4-20250514

systemPrompt: |
  You are a test-writing assistant for the project "{{projectName}}" at {{projectPath}}.
  Platform: {{platform}}.

  Your task is to generate high-quality tests for recently changed files.

  Steps:
  1. Check git status to find changed files
  2. Read each changed source file
  3. Look at existing tests (if any) to match the testing framework and style
  4. Generate new test files or add test cases to existing test files

  Rules:
  - Match the project's existing test framework (jest, pytest, go test, cargo test, etc.)
  - Follow the project's test file naming convention
  - Write focused unit tests that cover the changed code paths
  - Include edge cases and error cases
  - Do NOT modify source files, only create/update test files
  - After writing tests, run the test suite to verify they pass
  - If tests fail, fix them (up to 2 attempts)

tools:
  - FileSystem.readFile
  - FileSystem.writeFile
  - FileSystem.listFiles
  - FileSystem.searchFiles
  - Shell.execute
  - Git.status
  - Git.diff

triggers:
  - type: manual

approvalMode: ask-first

contextSources:
  - type: gitDiff
    mode: all
  - type: gitStatus
  - type: projectInfo

maxTurns: 15
maxTokenBudget: 80000
temperature: 0

tags:
  - testing
  - manual
```

### Example 4: Deploy Assistant

```yaml
# ~/.wotch/agents/deploy-assistant.yaml
name: deploy-assistant
displayName: Deploy Assistant
description: Walks through a deployment checklist with verification steps
version: "1.0.0"
model: claude-sonnet-4-20250514

systemPrompt: |
  You are a deployment assistant for the project "{{projectName}}" at {{projectPath}}.
  Current branch: {{branch}}.

  Walk through the following deployment checklist, executing each step and
  reporting pass/fail. Stop and alert the user if any step fails.

  Checklist:
  1. Verify clean git status (no uncommitted changes)
  2. Run the linter (detect linter from project config)
  3. Run the full test suite
  4. Check that the current branch is up to date with remote
  5. Build the project (detect build command from project config)
  6. Summarize results and recommend whether to proceed with deploy

  For each step, report:
  - Step name
  - Command executed
  - Result (pass/fail)
  - Any output that indicates issues

  IMPORTANT: Do NOT push to remote or deploy automatically.
  Only run verification steps. The actual deploy is up to the user.

tools:
  - Shell.execute
  - FileSystem.readFile
  - FileSystem.listFiles
  - Git.status
  - Git.diff
  - Git.log
  - Wotch.showNotification

triggers:
  - type: manual

approvalMode: ask-first

contextSources:
  - type: gitStatus
  - type: projectInfo

maxTurns: 20
maxTokenBudget: 60000
temperature: 0

tags:
  - deployment
  - manual
```

## AgentDefinition TypeScript-Style Schema (for Implementation Reference)

```typescript
interface AgentDefinition {
  name: string;                          // Required. /^[a-z][a-z0-9-]{0,63}$/
  displayName?: string;                  // Optional. Defaults to titleCase(name).
  description: string;                   // Required. Max 200 chars.
  version?: string;                      // Optional. Semver.
  model?: string;                        // Optional. Default: "claude-sonnet-4-20250514".
  systemPrompt: string;                  // Required. Max 10000 chars. Supports {{vars}}.
  tools: string[];                       // Required. Non-empty. e.g., ["FileSystem.readFile", "Git.*"]
  triggers?: Trigger[];                  // Optional. Default: [{ type: "manual" }].
  approvalMode?: "suggest-only" | "ask-first" | "auto-execute";  // Default: "ask-first".
  maxTurns?: number;                     // Optional. 1-100. Default: 10.
  maxTokenBudget?: number;               // Optional. 1-500000. Default: 50000.
  contextSources?: ContextSource[];      // Optional. Default: [].
  temperature?: number;                  // Optional. 0-1. Default: 0.
  tags?: string[];                       // Optional.

  // Internal (set by AgentLoader, not user-authored)
  _filePath?: string;                    // Absolute path to the definition file
  _source?: "builtin" | "global" | "project";  // Where it was loaded from
  _errors?: string[];                    // Validation errors/warnings
}

interface Trigger {
  type: "manual" | "onError" | "onCheckpoint" | "onStatusChange" | "cron";
  tabScope?: "active" | "any";           // Default: "active"
  from?: string;                         // For onStatusChange
  to?: string;                           // For onStatusChange
  schedule?: string;                     // For cron
  debounceMs?: number;                   // Default: 5000
}

interface ContextSource {
  type: "terminalBuffer" | "gitDiff" | "gitStatus" | "gitLog" | "projectInfo" | "file" | "claudeStatus";
  lines?: number;        // terminalBuffer
  tabScope?: string;     // terminalBuffer
  mode?: string;         // gitDiff
  count?: number;        // gitLog
  path?: string;         // file
}
```

## Agent Loader Implementation Notes

### `parseAgentFile(filePath)`

```javascript
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

function parseAgentFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf-8');

  let def;
  if (ext === '.yaml' || ext === '.yml') {
    def = yaml.load(raw);
  } else if (ext === '.json') {
    def = JSON.parse(raw);
  } else {
    throw new Error(`Unsupported agent file extension: ${ext}`);
  }

  def._filePath = filePath;
  return def;
}
```

### `scanAgents(projectPath)`

```javascript
function scanAgents(projectPath) {
  const agents = [];

  // 1. Scan global dir
  const globalDir = path.join(os.homedir(), '.wotch', 'agents');
  if (fs.existsSync(globalDir)) {
    for (const file of fs.readdirSync(globalDir)) {
      if (/\.(yaml|yml|json)$/.test(file)) {
        try {
          const def = parseAgentFile(path.join(globalDir, file));
          def._source = 'global';
          const errors = validateDefinition(def);
          def._errors = errors;
          agents.push(def);
        } catch (err) {
          console.log(`[wotch] Failed to parse agent ${file}:`, err.message);
        }
      }
    }
  }

  // 2. Scan per-project dir (overrides globals with same name)
  if (projectPath) {
    const projectDir = path.join(projectPath, '.wotch', 'agents');
    if (fs.existsSync(projectDir)) {
      for (const file of fs.readdirSync(projectDir)) {
        if (/\.(yaml|yml|json)$/.test(file)) {
          try {
            const def = parseAgentFile(path.join(projectDir, file));
            def._source = 'project';
            const errors = validateDefinition(def);
            def._errors = errors;
            // Override global agent with same name
            const idx = agents.findIndex(a => a.name === def.name);
            if (idx >= 0) agents[idx] = def;
            else agents.push(def);
          } catch (err) {
            console.log(`[wotch] Failed to parse project agent ${file}:`, err.message);
          }
        }
      }
    }
  }

  return agents;
}
```

### Template Interpolation

```javascript
function interpolateSystemPrompt(template, context) {
  const vars = {
    projectName: context.projectName || 'unknown',
    projectPath: context.projectPath || os.homedir(),
    branch: context.branch || 'main',
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    shell: process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/bash'),
  };

  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return vars[key] !== undefined ? vars[key] : match;
  });
}
```

## Built-in Agent Installation

On first run (or when `~/.wotch/agents/` doesn't exist), the `AgentManager.initialize()` method copies built-in agent definitions from the app bundle to `~/.wotch/agents/`. Built-in agents have `_source: "builtin"` internally but are stored as regular files that users can edit.

```javascript
async function installBuiltinAgents() {
  const agentsDir = path.join(os.homedir(), '.wotch', 'agents');
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  const builtins = ['error-fixer.yaml', 'code-reviewer.yaml', 'test-writer.yaml', 'deploy-assistant.yaml'];
  const bundledDir = path.join(__dirname, 'agents'); // src/agents/ in the app bundle

  for (const filename of builtins) {
    const destPath = path.join(agentsDir, filename);
    if (!fs.existsSync(destPath)) {
      const srcPath = path.join(bundledDir, filename);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
```

The bundled agent files live at `src/agents/*.yaml` and are included in the Electron build via the `files` array in `package.json`.
