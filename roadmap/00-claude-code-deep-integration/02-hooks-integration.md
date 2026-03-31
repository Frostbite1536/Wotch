# Plan 0: Hooks Integration

## Overview

Claude Code's hook system allows external tools to register callbacks that execute at specific points in Claude Code's lifecycle. Wotch registers `http` type hooks pointing at a local HTTP receiver, giving it structured JSON event data for every lifecycle transition — replacing fragile regex terminal parsing.

---

## Claude Code Hook System

### Configuration Location

Hooks are configured in Claude Code's settings files (separate from MCP configuration):

- **Global**: `~/.claude/settings.json` (applies to all projects)
- **Project-level**: `.claude/settings.json` (shareable via git)
- **Project-local**: `.claude/settings.local.json` (gitignored, highest priority)

Settings precedence (highest to lowest): `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`. Identical hook commands are automatically deduplicated across scopes.

Wotch configures hooks at the **global** level so they apply to all Claude Code sessions.

### Hook Events

Claude Code fires **24 hook events** across 8 categories:

#### Session Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `SessionStart` | Session begins or resumes | Session source (`startup`, `resume`, `clear`, `compact`) |
| `SessionEnd` | Session terminates | Exit reason (`clear`, `resume`, `logout`, `prompt_input_exit`) |
| `InstructionsLoaded` | CLAUDE.md or rules files loaded | Load reason (`session_start`, `nested_traversal`, `compact`) |

#### Tool Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `PreToolUse` | Before a tool executes (can **block**) | Tool name (`Bash`, `Edit`, `Read`, `Write`, etc.) |
| `PostToolUse` | After a tool succeeds | Tool name |
| `PostToolUseFailure` | After a tool fails | Tool name |
| `PermissionRequest` | Permission dialog appears | Tool name |

#### User Input Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `UserPromptSubmit` | User submits a prompt | (no matcher) |

#### Notification Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `Notification` | Claude sends a notification | Notification type (`permission_prompt`, `idle_prompt`, `auth_success`) |

#### Agent/Team Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `SubagentStart` | Sub-agent spawned | Agent type (`Explore`, `Plan`, custom) |
| `SubagentStop` | Sub-agent finished | Agent type |
| `TeammateIdle` | Agent teammate about to go idle | (no matcher) |
| `Stop` | Claude finishes responding (can **block** to force continuation) | (no matcher) |
| `StopFailure` | Turn ends due to API error | Error type (`rate_limit`, `authentication_failed`, `billing_error`) |

#### Task Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `TaskCreated` | Task created via TaskCreate | (no matcher) |
| `TaskCompleted` | Task marked as completed | (no matcher) |

#### File/Directory Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `CwdChanged` | Working directory changes | (no matcher) |
| `FileChanged` | Watched file changes on disk | Filename (basename only) |
| `ConfigChange` | Configuration file changes | Config source |

#### Context Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `PreCompact` | Before context compaction | Trigger (`manual`, `auto`) |
| `PostCompact` | After context compaction completes | Trigger |

#### Git/Worktree Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `WorktreeCreate` | Worktree being created | (no matcher) |
| `WorktreeRemove` | Worktree being removed | (no matcher) |

#### MCP Events
| Event | When it fires | Matcher filters on |
|-------|--------------|-------------------|
| `Elicitation` | MCP server requests user input | MCP server name |
| `ElicitationResult` | User responds to MCP elicitation | MCP server name |

### Hook Input: stdin JSON

Every hook receives a JSON object on **stdin** (NOT via environment variables). The JSON has common fields plus event-specific fields:

#### Common Fields (all events)

```json
{
  "session_id": "unique-session-id",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "agent_id": "optional-for-subagents",
  "agent_type": "optional-for-subagents",
  "stop_hook_active": false
}
```

#### Tool Event Fields (PreToolUse, PostToolUse, PostToolUseFailure)

```json
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test"
  }
}
```

For `PostToolUse`, the tool output is also included.

#### Other Event-Specific Fields

| Event | Additional fields |
|-------|------------------|
| `SessionStart` | `source` (startup/resume/clear/compact) |
| `SessionEnd` | `reason` (clear/resume/logout/prompt_input_exit) |
| `UserPromptSubmit` | `prompt` (user's input text) |
| `Notification` | `notification_type` |
| `FileChanged` | `file_path`, `file_name` |
| `CwdChanged` | `old_cwd`, `new_cwd` |
| `ConfigChange` | `source`, `file_path` |

### Hook Output: Blocking & Control

Hooks can influence Claude Code's behavior through exit codes and stdout JSON:

| Exit Code | Effect |
|-----------|--------|
| **0** | Action proceeds; JSON on stdout is processed |
| **2** | Action is **blocked**; stderr becomes error message shown to Claude |
| Other | Action proceeds; stderr shown in verbose mode only |

#### PreToolUse Output (can block or modify tool input)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "Reason for decision",
    "updatedInput": {
      "command": "modified_command"
    },
    "additionalContext": "Text added to Claude's context"
  }
}
```

#### Stop Output (can force Claude to continue)

```json
{
  "decision": "block",
  "reason": "Explanation shown to Claude"
}
```

This blocking capability is relevant for Wotch — e.g., requiring checkpoint creation before destructive git operations.

### Hook Types

Claude Code supports **4 hook types**:

| Type | Description | Use case |
|------|-------------|----------|
| `command` | Runs a shell command | Scripts, piping to other tools |
| **`http`** | **Sends HTTP POST to a URL** | **Wotch's primary integration method** |
| `prompt` | Runs a Claude prompt | AI-powered hook logic |
| `agent` | Runs a Claude agent | Complex multi-step hook logic |

The `http` type is ideal for Wotch — it sends the hook's stdin JSON directly as the HTTP request body, no curl or shell commands needed.

### Matcher Format

Matchers are **regex patterns** (case-sensitive). An empty string `""` matches everything. Examples:

```json
{ "matcher": "Bash" }           // Only Bash tool events
{ "matcher": "Edit|Write" }     // Edit or Write tool events
{ "matcher": "mcp__wotch__.*" } // Any Wotch MCP tool event
{ "matcher": "" }               // All events (match everything)
```

Advanced filtering with `if` field (permission rule syntax):
```json
{
  "matcher": "Bash",
  "if": "Bash(git push *)",
  "hooks": [...]
}
```

### Environment Variables

Only a few actual environment variables are available in hooks:

| Variable | Available in | Description |
|----------|-------------|-------------|
| `CLAUDE_PROJECT_DIR` | All events | Project root directory |
| `CLAUDE_ENV_FILE` | SessionStart, CwdChanged, FileChanged | File to append env vars to |

All other data comes via **stdin JSON**, not environment variables.

---

## Hook Configuration for Wotch

### Using `type: http` (Recommended)

Wotch registers `http` type hooks that point at its local receiver. Claude Code POSTs the stdin JSON directly as the request body — no shell commands, no curl, no env var interpolation.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/PreToolUse",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/PostToolUse",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/Stop",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/SubagentStart",
            "timeout": 5
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/SubagentStop",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/SessionStart",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/SessionEnd",
            "timeout": 5
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/PreCompact",
            "timeout": 5
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/PostCompact",
            "timeout": 5
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/Notification",
            "timeout": 5
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:19520/hook/StopFailure",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### Events Wotch Subscribes To

Not all 24 events are useful for Wotch. These are the priority events:

| Event | Why Wotch needs it |
|-------|-------------------|
| `PreToolUse` | Status: detect tool usage, show tool-specific descriptions |
| `PostToolUse` | Status: tool completed, may transition state |
| `Stop` | Status: Claude finished turn → transition to "done" |
| `StopFailure` | Status: API error → transition to "error" |
| `SubagentStart` | Status: sub-agent spawned → show "Running agent" |
| `SubagentStop` | Status: sub-agent finished |
| `SessionStart` | Status: session began → transition to "idle" |
| `SessionEnd` | Status: session ended → clean up tab state |
| `PreCompact` | Status: context compacting → show "Compacting..." |
| `PostCompact` | Status: compaction done |
| `Notification` | Forward notifications to Wotch's notification system |
| `PostToolUseFailure` | Status: tool failed → may show error state |

Events **not subscribed** (low value for status detection): `UserPromptSubmit`, `PermissionRequest`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `ConfigChange`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `WorktreeCreate`, `WorktreeRemove`, `Elicitation`, `ElicitationResult`.

---

## Wotch Hook Receiver

### Server Design

A minimal HTTP server in the Wotch main process. Because Wotch uses `type: http` hooks, Claude Code POSTs the hook's stdin JSON directly as the HTTP request body.

```javascript
// src/hook-receiver.js

const http = require('http');
const { EventEmitter } = require('events');

class HookReceiver extends EventEmitter {
  constructor(port = 19520) {
    super();
    this.port = port;
    this.server = null;
    this.active = false;
    this.eventCount = 0;
    this.rateLimitWindow = [];
  }

  start() {
    this.server = http.createServer((req, res) => {
      // Only accept POST to /hook/*
      if (req.method !== 'POST' || !req.url.startsWith('/hook/')) {
        res.writeHead(404);
        res.end();
        return;
      }

      // Rate limiting: 100 events/second
      if (this._isRateLimited()) {
        res.writeHead(429);
        res.end();
        return;
      }

      // Extract event type from URL path
      const eventType = req.url.replace('/hook/', '');

      let body = '';
      req.on('data', chunk => {
        if (body.length + chunk.length > 65536) {
          res.writeHead(413);
          res.end();
          req.destroy();
          return;
        }
        body += chunk;
      });

      req.on('end', () => {
        try {
          const payload = JSON.parse(body);

          // Validate: must have session_id (all hook events include this)
          if (!payload || typeof payload.session_id !== 'string') {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing session_id' }));
            return;
          }

          this.eventCount++;
          this.emit('hook-event', {
            eventType,
            ...payload
          });

          // Return empty 200 — Wotch hooks are fire-and-forget
          // (no blocking, no modified input)
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      this.active = true;
      this.emit('started', this.port);
    });

    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        this.port++;
        if (this.port < 19530) {
          this.server.listen(this.port, '127.0.0.1');
        } else {
          this.active = false;
          this.emit('error', new Error('No available port for hook receiver'));
        }
      }
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.active = false;
    }
  }

  isActive() {
    return this.active;
  }

  _isRateLimited() {
    const now = Date.now();
    this.rateLimitWindow = this.rateLimitWindow.filter(t => t > now - 1000);
    this.rateLimitWindow.push(now);
    return this.rateLimitWindow.length > 100;
  }
}

module.exports = { HookReceiver };
```

### Received Payload Shape

Each HTTP POST body contains the hook's stdin JSON, which varies by event. Common shape:

```typescript
interface HookPayload {
  // Common fields (all events)
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  agent_id?: string;
  agent_type?: string;
  stop_hook_active: boolean;

  // Tool events (PreToolUse, PostToolUse, PostToolUseFailure)
  tool_name?: string;
  tool_input?: Record<string, any>;

  // Session events
  source?: string;  // SessionStart
  reason?: string;  // SessionEnd

  // Notification events
  notification_type?: string;

  // Added by HookReceiver (from URL path)
  eventType: string;
}
```

---

## Hook-to-Status Mapping

The enhanced status detector translates hook events into Wotch's existing status states:

| Hook Event | tool_name / condition | Wotch Status | Description |
|------------|----------------------|--------------|-------------|
| `PreToolUse` | `Bash` | `working` | Running command |
| `PreToolUse` | `Edit` / `Write` | `working` | Editing file |
| `PreToolUse` | `Read` | `thinking` | Reading file |
| `PreToolUse` | `Grep` / `Glob` | `thinking` | Searching |
| `PreToolUse` | `Agent` | `working` | Running sub-agent |
| `PreToolUse` | `AskUserQuestion` | `waiting` | Waiting for input |
| `PreToolUse` | `WebFetch` / `WebSearch` | `working` | Fetching/searching web |
| `PostToolUse` | any | (maintain current) | Tool completed, still in turn |
| `PostToolUseFailure` | any | (maintain current) | Tool failed, Claude may retry |
| `SubagentStart` | — | `working` | Sub-agent spawned |
| `SubagentStop` | — | (maintain current) | Sub-agent finished |
| `PreCompact` | — | `thinking` | Context compacting |
| `PostCompact` | — | (maintain current) | Compaction done |
| `Stop` | — | `done` | Claude finished |
| `StopFailure` | — | `error` | API error ended turn |
| `SessionStart` | — | `idle` | Session started |
| `SessionEnd` | — | `idle` | Session ended |
| `Notification` | — | (forward to UI) | Show notification |

### State Machine

```
SessionStart
    │
    ▼
  idle ──PreToolUse(Edit/Bash/Write)──► working
    │                                      │
    │    PreToolUse(Read/Grep/Glob)        │
    │    PreCompact                        │
    ├────────────────────────► thinking    │
    │                              │       │
    │    PreToolUse(AskUser)       │       │ PostToolUse
    └──────────────┐               │       │
                   ▼               ▼       ▼
                waiting        (maintain) (maintain)
                   │                       │
                   │ Stop                  │ Stop
                   ▼                       ▼
                  done ◄──────────────── done
                   │
                   │ (5s timeout)
                   ▼
                  idle

StopFailure from any state ──► error ──(5s)──► idle
SessionEnd from any state ──► idle (cleanup)
```

---

## Auto-Configuration

Wotch automatically configures Claude Code's hooks when it detects a Claude Code installation.

### Detection

1. Check if `~/.claude/` directory exists
2. Check if `claude` command is available in PATH
3. Read `~/.claude/settings.json` if it exists

### Configuration Strategy

```javascript
function configureHooks(wotchPort) {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings = {};

  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    // File doesn't exist or is malformed; start fresh
  }

  if (!settings.hooks) settings.hooks = {};

  // Events Wotch subscribes to
  const wotchEvents = [
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
    'Stop', 'StopFailure',
    'SubagentStart', 'SubagentStop',
    'SessionStart', 'SessionEnd',
    'PreCompact', 'PostCompact',
    'Notification'
  ];

  for (const event of wotchEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Check if Wotch hook already exists (idempotent)
    const wotchUrl = `http://localhost:${wotchPort}/hook/${event}`;
    const existing = settings.hooks[event].find(h =>
      h.hooks?.some(hook => hook.type === 'http' && hook.url === wotchUrl)
    );

    if (!existing) {
      settings.hooks[event].push({
        matcher: '',
        hooks: [{
          type: 'http',
          url: wotchUrl,
          timeout: 5
        }]
      });
    }
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
```

### Safety Rules

- **Never overwrite existing hooks**: Wotch appends alongside user-configured hooks
- **Idempotent**: Checks for existing Wotch hooks by URL before adding
- **Reversible**: Wotch hooks are identifiable by the `localhost:<port>/hook/` URL pattern
- **User consent**: Gated behind `integration.autoConfigureHooks` setting; first-run prompts the user

---

## Tab-to-Session Mapping

Claude Code sessions must be mapped to Wotch terminal tabs so that hook events update the correct tab's status.

### Strategy

Hook payloads include `session_id`. Wotch maps `session_id` → `tabId` using:

1. **PTY environment variable**: Wotch sets `WOTCH_TAB_ID` in the PTY environment when creating a tab. Claude Code inherits this in its process environment.
2. **Session registration**: On `SessionStart` events, Wotch reads the `cwd` field and matches it against known tab working directories. Combined with the `WOTCH_TAB_ID` env var (if the hook command is `type: command` and can access it), this provides reliable mapping.
3. **Fallback**: If no tab mapping is found, the event is attributed to the most recently active tab with a matching `cwd`.

```javascript
// In main.js, when creating a PTY:
const pty = nodePty.spawn(shell, args, {
  env: {
    ...process.env,
    WOTCH_TAB_ID: tabId
  }
});
```

Note: With `type: http` hooks, the `WOTCH_TAB_ID` env var is NOT available in the HTTP body (only stdin JSON fields are sent). Tab mapping primarily relies on `session_id` tracking: the first `SessionStart` event for a new `session_id` is matched to a tab by `cwd`, and subsequent events for that `session_id` reuse the mapping.

---

## Advanced: Hook Blocking for Safety

Wotch can optionally use `PreToolUse` hooks with `type: command` to **block** dangerous operations. For example, requiring a checkpoint before `git push`:

```json
{
  "matcher": "Bash",
  "if": "Bash(git push *)",
  "hooks": [
    {
      "type": "command",
      "command": "curl -s http://localhost:19520/gate/pre-push | jq -r '.decision'"
    }
  ]
}
```

The Wotch receiver at `/gate/pre-push` checks if a recent checkpoint exists. If not, the command hook exits with code 2, blocking the push and showing a message to Claude.

This is **optional** and separate from the core status detection hooks. It demonstrates the power of the hook system beyond passive event reception.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Hook receiver port in use | Try ports 19520–19529; if all taken, disable hooks and log warning |
| Claude Code not installed | Skip auto-configuration; hooks channel inactive; no error shown |
| Malformed hook payload | Return 400; log warning; do not crash |
| Hook receiver not running when Claude fires | Claude Code logs hook timeout; no Wotch event; regex fallback handles status |
| `~/.claude/settings.json` is malformed | Do not auto-configure; warn user in settings UI |
| Rate limit exceeded | Return 429; drop events; resume when rate normalizes |
| Hook receiver crashes | Restart automatically; emit error event for logging |

---

## Testing

### Unit Tests

1. `HookReceiver` correctly parses valid `PreToolUse` payload with `tool_name` and `tool_input`
2. `HookReceiver` correctly parses `SessionStart` payload with `source` field
3. `HookReceiver` rejects missing `session_id` (400)
4. `HookReceiver` rejects invalid JSON (400)
5. `HookReceiver` enforces rate limiting (429)
6. `HookReceiver` enforces body size limit (413)
7. Status mapping produces correct states for all tool/event combinations
8. Auto-configuration uses `type: http` hooks (not `type: command`)
9. Auto-configuration preserves existing hooks
10. Auto-configuration is idempotent
11. Tab-to-session mapping correctly associates `session_id` with `tabId` via `cwd`

### Integration Tests

1. Start hook receiver → POST a `PreToolUse` payload → verify event emitted with correct `tool_name`
2. Configure hooks in test `~/.claude/settings.json` → verify Wotch hooks present with `type: http`
3. Kill hook receiver → verify regex fallback activates within 5 seconds
4. Send 200 events in 1 second → verify rate limiting kicks in at 101
5. POST `SessionStart` with `cwd` matching a tab → verify session-to-tab mapping created
