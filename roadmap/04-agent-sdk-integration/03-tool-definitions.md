# 03 — Tool Definitions

## Overview

Agents interact with the system through a curated set of 18 built-in tools organized into 6 categories. Each tool is registered in the `ToolRegistry` and exposed to the Anthropic API as a tool definition with a JSON Schema for input validation.

Tools are the only way agents can affect the system. All tool executions go through the `TrustManager` for approval checks and are recorded in the audit log.

## Tool Categories

| Category | Tools | Description |
|----------|-------|-------------|
| Shell | 2 | Execute commands, read terminal buffer |
| FileSystem | 5 | Read, write, list, search, delete files |
| Git | 5 | Status, diff, log, checkpoint, branch info |
| Terminal | 2 | Observe terminal output, detect patterns |
| Project | 2 | List projects, get project info |
| Wotch | 2 | Get Claude status, show notifications |

---

## Category: Shell

### Shell.execute

Execute a shell command in the project directory and return its output.

**Description:** Runs a command in a temporary PTY process (not the user's visible terminal). The command runs in the project directory. Stdout and stderr are captured and returned. The PTY is destroyed after the command completes or times out.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The shell command to execute. Must be a single command or pipeline. No background processes (&)."
    },
    "cwd": {
      "type": "string",
      "description": "Working directory. Defaults to project root. Must be within the project directory."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. Default: 30000. Maximum: 120000."
    }
  },
  "required": ["command"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "exitCode": { "type": "number" },
    "stdout": { "type": "string" },
    "stderr": { "type": "string" },
    "timedOut": { "type": "boolean" },
    "durationMs": { "type": "number" }
  }
}
```

**Permission Requirements:**
- Requires approval in `suggest-only` and `ask-first` modes.
- In `auto-execute` mode, still requires approval for dangerous commands (see below).
- Dangerous command patterns: `rm -rf`, `rm -r /`, `git push --force`, `git reset --hard`, `sudo`, `chmod 777`, `curl | sh`, `wget | sh`, `dd if=`, `mkfs`, `> /dev/`, commands containing `&&` followed by dangerous commands.

**Validation Rules:**
- `command` must not be empty.
- `command` must not contain `&` at the end (no background execution).
- `cwd` (if provided) must be a subdirectory of the project path (no path traversal).
- `timeoutMs` must be between 1000 and 120000.

**Implementation Notes:**
```javascript
async function shellExecute(input, context) {
  const { command, cwd, timeoutMs = 30000 } = input;
  const projectPath = context.projectPath;
  const workDir = cwd ? path.resolve(projectPath, cwd) : projectPath;

  // Security: ensure workDir is within project
  if (!workDir.startsWith(projectPath)) {
    return { exitCode: 1, stdout: '', stderr: 'Working directory must be within the project', timedOut: false, durationMs: 0 };
  }

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = pty.spawn(shell, [shellFlag, command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workDir,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, Math.min(timeoutMs, 120000));

    proc.onData((data) => {
      // Strip ANSI codes for clean output
      stdout += stripAnsi(data);
      // Cap output at 100KB
      if (stdout.length > 102400) {
        stdout = stdout.slice(0, 102400) + '\n[output truncated at 100KB]';
        timedOut = true;
        proc.kill();
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode || 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
        durationMs: Date.now() - startTime,
      });
    });
  });
}
```

**Example:**
```json
// Input
{ "command": "npm test", "timeoutMs": 60000 }

// Output
{
  "exitCode": 1,
  "stdout": "FAIL src/utils.test.js\n  ● add() should handle negative numbers\n    Expected: -1\n    Received: 1",
  "stderr": "",
  "timedOut": false,
  "durationMs": 3420
}
```

### Shell.readVisibleTerminal

Read the current visible content of a user's terminal tab.

**Description:** Returns the last N lines from the terminal buffer of the active (or specified) tab. This reads from the xterm.js buffer data that the main process has accumulated via the ClaudeStatusDetector's rolling buffer.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "tabId": {
      "type": "string",
      "description": "Tab ID to read from. Defaults to the active tab."
    },
    "lines": {
      "type": "number",
      "description": "Number of lines to read from the end of the buffer. Default: 100. Max: 1000."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "content": { "type": "string", "description": "Terminal buffer text (ANSI-stripped)" },
    "lineCount": { "type": "number" },
    "tabId": { "type": "string" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes except `suggest-only`.

**Example:**
```json
// Input
{ "lines": 50 }

// Output
{
  "content": "$ npm test\n\nFAIL src/utils.test.js\n  ...",
  "lineCount": 50,
  "tabId": "tab-1"
}
```

---

## Category: FileSystem

### FileSystem.readFile

Read the contents of a file.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File path relative to project root, or absolute path within the project."
    },
    "maxLines": {
      "type": "number",
      "description": "Maximum lines to read. Default: 2000. Max: 10000."
    },
    "offset": {
      "type": "number",
      "description": "Line number to start from (1-based). Default: 1."
    }
  },
  "required": ["path"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "content": { "type": "string" },
    "lineCount": { "type": "number" },
    "truncated": { "type": "boolean" },
    "path": { "type": "string", "description": "Resolved absolute path" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in `ask-first` and `auto-execute` modes.
- In `suggest-only` mode: auto-approved for source code files, requires approval for config files containing potential secrets (`.env`, `credentials.*`, `*.pem`, `*.key`).

**Validation Rules:**
- Resolved path must be within the project directory (no `../` traversal outside project).
- File must exist and be a regular file (not a directory, symlink to outside project, or device).
- Binary files are rejected with an error message.
- File size limit: 1MB. Larger files return an error.

**Example:**
```json
// Input
{ "path": "src/utils.js", "maxLines": 100 }

// Output
{
  "content": "function add(a, b) {\n  return Math.abs(a + b);\n}\n\nmodule.exports = { add };",
  "lineCount": 5,
  "truncated": false,
  "path": "/home/user/projects/myapp/src/utils.js"
}
```

### FileSystem.writeFile

Write content to a file (create or overwrite).

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File path relative to project root."
    },
    "content": {
      "type": "string",
      "description": "Full file content to write."
    },
    "createDirectories": {
      "type": "boolean",
      "description": "Create parent directories if they don't exist. Default: true."
    }
  },
  "required": ["path", "content"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "success": { "type": "boolean" },
    "path": { "type": "string", "description": "Resolved absolute path" },
    "bytesWritten": { "type": "number" },
    "created": { "type": "boolean", "description": "True if file was newly created" }
  }
}
```

**Permission Requirements:**
- Always requires approval in `suggest-only` mode.
- Requires approval in `ask-first` mode.
- In `auto-execute` mode: auto-approved for source/test files, requires approval for config files, build scripts, and dotfiles.

**Validation Rules:**
- Path must resolve to within the project directory.
- Cannot write to `.git/` directory.
- Cannot write to `node_modules/` or other dependency directories.
- Content size limit: 500KB.

**Example:**
```json
// Input
{ "path": "src/__tests__/utils.test.js", "content": "const { add } = require('../utils');\n\ntest('add handles negatives', () => {\n  expect(add(-1, 0)).toBe(-1);\n});\n" }

// Output
{ "success": true, "path": "/home/user/projects/myapp/src/__tests__/utils.test.js", "bytesWritten": 117, "created": true }
```

### FileSystem.listFiles

List files in a directory.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Directory path relative to project root. Default: project root."
    },
    "recursive": {
      "type": "boolean",
      "description": "List files recursively. Default: false."
    },
    "pattern": {
      "type": "string",
      "description": "Glob pattern to filter files. Example: '*.ts', '**/*.test.js'"
    },
    "maxResults": {
      "type": "number",
      "description": "Maximum files to return. Default: 500. Max: 2000."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": { "type": "string" },
          "name": { "type": "string" },
          "isDirectory": { "type": "boolean" },
          "size": { "type": "number" }
        }
      }
    },
    "truncated": { "type": "boolean" },
    "totalCount": { "type": "number" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes except `suggest-only`.

**Validation Rules:**
- Path must resolve within project directory.
- Excludes `.git/`, `node_modules/`, and other common dependency/build directories by default.

### FileSystem.searchFiles

Search file contents using regex or literal string.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Search pattern (regex or literal string)."
    },
    "path": {
      "type": "string",
      "description": "Directory to search in, relative to project root. Default: project root."
    },
    "filePattern": {
      "type": "string",
      "description": "Glob to filter which files to search. Example: '*.js'"
    },
    "maxResults": {
      "type": "number",
      "description": "Maximum matches to return. Default: 50. Max: 200."
    },
    "caseSensitive": {
      "type": "boolean",
      "description": "Case-sensitive search. Default: false."
    }
  },
  "required": ["pattern"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "matches": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "number" },
          "column": { "type": "number" },
          "text": { "type": "string", "description": "Matching line content" },
          "context": { "type": "string", "description": "3 lines before and after" }
        }
      }
    },
    "totalMatches": { "type": "number" },
    "truncated": { "type": "boolean" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes except `suggest-only`.

**Implementation Notes:**
Uses `child_process.execFileSync` with `grep -rn` (or `findstr` on Windows) for performance. Falls back to Node.js `fs.readFileSync` + regex for platforms without grep.

### FileSystem.deleteFile

Delete a file.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File path relative to project root."
    }
  },
  "required": ["path"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "success": { "type": "boolean" },
    "path": { "type": "string" }
  }
}
```

**Permission Requirements:**
- **Always dangerous.** Requires approval in ALL modes, including `auto-execute`.

**Validation Rules:**
- Path must resolve within project directory.
- Cannot delete directories (only files).
- Cannot delete `.git/` contents.
- Cannot delete the agent definition file itself.

---

## Category: Git

### Git.status

Get the current git status of the project.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "projectPath": {
      "type": "string",
      "description": "Project path. Defaults to current project."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "branch": { "type": "string" },
    "changedFiles": { "type": "number" },
    "stagedFiles": { "type": "array", "items": { "type": "string" } },
    "unstagedFiles": { "type": "array", "items": { "type": "string" } },
    "untrackedFiles": { "type": "array", "items": { "type": "string" } },
    "lastCommit": { "type": "string" },
    "checkpointCount": { "type": "number" },
    "isClean": { "type": "boolean" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes.

**Implementation:** Wraps the existing `gitGetStatus()` function in `src/main.js` with additional parsing for staged/unstaged/untracked file lists.

### Git.diff

Get the diff of current changes.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": ["staged", "unstaged", "all", "commit"],
      "description": "Diff mode. 'all' shows both staged and unstaged. 'commit' shows last commit diff."
    },
    "file": {
      "type": "string",
      "description": "Specific file to diff. Optional — defaults to all files."
    },
    "contextLines": {
      "type": "number",
      "description": "Number of context lines in diff. Default: 3."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "diff": { "type": "string", "description": "Unified diff output" },
    "filesChanged": { "type": "number" },
    "insertions": { "type": "number" },
    "deletions": { "type": "number" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes.

**Implementation:** Uses `execFileSync("git", ["diff", ...args])` with appropriate flags based on mode. The `mode: "commit"` uses `git diff HEAD~1..HEAD`.

### Git.log

Get recent commit history.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "count": {
      "type": "number",
      "description": "Number of commits. Default: 10. Max: 50."
    },
    "format": {
      "type": "string",
      "enum": ["oneline", "full"],
      "description": "Output format. Default: 'oneline'."
    },
    "file": {
      "type": "string",
      "description": "Show only commits affecting this file."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "commits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "hash": { "type": "string" },
          "shortHash": { "type": "string" },
          "message": { "type": "string" },
          "author": { "type": "string" },
          "date": { "type": "string" },
          "isCheckpoint": { "type": "boolean" }
        }
      }
    }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes.

### Git.checkpoint

Create a Wotch checkpoint (stages all changes and commits).

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "Checkpoint commit message. Auto-generated if not provided."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "success": { "type": "boolean" },
    "hash": { "type": "string" },
    "message": { "type": "string" },
    "changedFiles": { "type": "number" }
  }
}
```

**Permission Requirements:**
- Requires approval in `suggest-only` and `ask-first` modes.
- Auto-approved in `auto-execute` mode.

**Implementation:** Wraps the existing `gitCheckpoint()` function.

### Git.branchInfo

Get information about branches.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "includeRemote": {
      "type": "boolean",
      "description": "Include remote branches. Default: false."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "current": { "type": "string" },
    "local": { "type": "array", "items": { "type": "string" } },
    "remote": { "type": "array", "items": { "type": "string" } },
    "ahead": { "type": "number", "description": "Commits ahead of upstream" },
    "behind": { "type": "number", "description": "Commits behind upstream" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes.

---

## Category: Terminal

### Terminal.readBuffer

Read the ANSI-stripped terminal buffer for a tab.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "tabId": {
      "type": "string",
      "description": "Tab ID. Defaults to active tab."
    },
    "lines": {
      "type": "number",
      "description": "Lines to read from the end. Default: 200. Max: 1000."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "content": { "type": "string" },
    "lineCount": { "type": "number" },
    "tabId": { "type": "string" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes except `suggest-only`.

**Implementation Notes:**
The `ClaudeStatusDetector` already maintains a rolling buffer per tab (`tab.buffer`). This tool reads from that buffer. To support more than 2000 chars, the buffer size should be increased to 50,000 chars for tabs with active agent observation.

When an agent declares `Terminal.readBuffer` in its tools, the `AgentManager` sets an `agentObserving` flag on the relevant tab's status detector entry, which increases the buffer retention.

### Terminal.detectPattern

Wait for a pattern to appear in terminal output.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Regex pattern to watch for."
    },
    "tabId": {
      "type": "string",
      "description": "Tab ID. Defaults to active tab."
    },
    "timeoutMs": {
      "type": "number",
      "description": "How long to wait. Default: 30000. Max: 120000."
    }
  },
  "required": ["pattern"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "matched": { "type": "boolean" },
    "matchText": { "type": "string", "description": "The text that matched" },
    "context": { "type": "string", "description": "Lines around the match" },
    "timedOut": { "type": "boolean" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in `ask-first` and `auto-execute` modes.

**Implementation Notes:**
Registers a temporary listener on the `ClaudeStatusDetector`'s feed for the specified tab. The listener tests each incoming chunk against the pattern. Resolves when matched or timed out.

---

## Category: Project

### Project.list

List all detected projects.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {},
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "projects": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "path": { "type": "string" },
          "source": { "type": "string" }
        }
      }
    },
    "currentProject": {
      "type": "object",
      "nullable": true,
      "properties": {
        "name": { "type": "string" },
        "path": { "type": "string" }
      }
    }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes.

**Implementation:** Calls the existing `detectProjects()` function.

### Project.getInfo

Get detailed information about the current or specified project.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "projectPath": {
      "type": "string",
      "description": "Project path. Defaults to current project."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "path": { "type": "string" },
    "language": { "type": "string", "description": "Detected primary language" },
    "framework": { "type": "string", "description": "Detected framework if any" },
    "packageManager": { "type": "string", "description": "npm, yarn, pnpm, pip, cargo, etc." },
    "hasTests": { "type": "boolean" },
    "testCommand": { "type": "string", "description": "Detected test command" },
    "buildCommand": { "type": "string", "description": "Detected build command" },
    "lintCommand": { "type": "string", "description": "Detected lint command" }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes.

**Implementation Notes:**
Reads `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc., to detect language, framework, and commands. Checks for `scripts.test`, `scripts.build`, `scripts.lint` in `package.json`. Checks for `Makefile` targets. Returns best guesses.

---

## Category: Wotch

### Wotch.getStatus

Get the current Claude Code status from the status detector.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "tabId": {
      "type": "string",
      "description": "Tab ID. Defaults to aggregate status."
    }
  },
  "required": []
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "aggregate": {
      "type": "object",
      "properties": {
        "state": { "type": "string", "enum": ["idle", "thinking", "working", "waiting", "done", "error"] },
        "description": { "type": "string" },
        "tabId": { "type": "string" }
      }
    },
    "perTab": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "state": { "type": "string" },
          "description": { "type": "string" }
        }
      }
    }
  }
}
```

**Permission Requirements:**
- Read-only. Auto-approved in all modes.

**Implementation:** Calls `claudeStatus.getAggregateStatus()` and iterates `claudeStatus.tabs`.

### Wotch.showNotification

Show a desktop notification to the user.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "description": "Notification title. Max 100 chars."
    },
    "body": {
      "type": "string",
      "description": "Notification body. Max 500 chars."
    },
    "type": {
      "type": "string",
      "enum": ["info", "success", "warning", "error"],
      "description": "Notification type. Default: 'info'."
    }
  },
  "required": ["title", "body"]
}
```

**Output Schema:**
```json
{
  "type": "object",
  "properties": {
    "shown": { "type": "boolean" }
  }
}
```

**Permission Requirements:**
- Auto-approved in all modes (non-destructive).

**Implementation:** Uses Electron's `Notification` API. Also sends a toast to the renderer.

---

## Tool Registration Implementation

### ToolRegistry Class

```javascript
class ToolRegistry {
  constructor(context) {
    // context: { ptyProcesses, claudeStatus, settings, projectPath }
    this.tools = new Map();  // fullName → { handler, schema, permissions, category }
    this.context = context;
    this._registerAll();
  }

  registerTool(category, name, handler, schema, permissions) {
    const fullName = `${category}.${name}`;
    this.tools.set(fullName, {
      handler,
      schema,           // { input: JSONSchema, output: JSONSchema, description: string }
      permissions,       // { dangerLevel: 'safe'|'read'|'write'|'dangerous', autoApproveIn: string[] }
      category,
      name,
    });
  }

  async executeTool(fullName, input, agentContext) {
    const tool = this.tools.get(fullName);
    if (!tool) throw new Error(`Unknown tool: ${fullName}`);

    // Validate input against schema
    const errors = this._validateInput(input, tool.schema.input);
    if (errors.length > 0) {
      return { is_error: true, content: `Invalid input: ${errors.join(', ')}` };
    }

    try {
      const result = await tool.handler(input, { ...this.context, ...agentContext });
      return { is_error: false, content: JSON.stringify(result) };
    } catch (err) {
      return { is_error: true, content: `Tool error: ${err.message}` };
    }
  }

  getToolsForAgent(definition) {
    const requested = new Set();
    for (const toolSpec of definition.tools) {
      if (toolSpec.endsWith('.*')) {
        // Wildcard: add all tools in category
        const category = toolSpec.slice(0, -2);
        for (const [fullName, tool] of this.tools) {
          if (tool.category === category) requested.add(fullName);
        }
      } else {
        requested.add(toolSpec);
      }
    }
    return [...requested].filter(name => this.tools.has(name));
  }

  getAnthropicToolSchemas(toolNames) {
    // Convert to Anthropic API tool format
    return toolNames.map(name => {
      const tool = this.tools.get(name);
      return {
        name: name.replace('.', '_'),  // API doesn't allow dots in tool names
        description: tool.schema.description,
        input_schema: tool.schema.input,
      };
    });
  }

  // Maps API tool name (Shell_execute) back to registry name (Shell.execute)
  resolveToolName(apiName) {
    return apiName.replace('_', '.');
  }
}
```

### Danger Level Classification

| Level | Description | Auto-approve behavior |
|-------|-------------|----------------------|
| `safe` | No side effects, read-only | Auto-approved in all modes |
| `read` | Reads data, no mutations | Auto-approved in `ask-first` and `auto-execute` |
| `write` | Writes/modifies data | Auto-approved only in `auto-execute` |
| `dangerous` | Destructive or irreversible | Always requires approval, even in `auto-execute` |

### Tool Danger Classifications

| Tool | Danger Level |
|------|-------------|
| Shell.execute | `write` (elevated to `dangerous` for detected dangerous commands) |
| Shell.readVisibleTerminal | `read` |
| FileSystem.readFile | `read` |
| FileSystem.writeFile | `write` |
| FileSystem.listFiles | `safe` |
| FileSystem.searchFiles | `read` |
| FileSystem.deleteFile | `dangerous` |
| Git.status | `safe` |
| Git.diff | `safe` |
| Git.log | `safe` |
| Git.checkpoint | `write` |
| Git.branchInfo | `safe` |
| Terminal.readBuffer | `read` |
| Terminal.detectPattern | `read` |
| Project.list | `safe` |
| Project.getInfo | `safe` |
| Wotch.getStatus | `safe` |
| Wotch.showNotification | `safe` |
