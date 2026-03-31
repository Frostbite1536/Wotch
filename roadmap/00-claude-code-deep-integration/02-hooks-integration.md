# Plan 0: Hooks Integration

## Overview

Claude Code's hook system allows external tools to register shell commands that execute at specific points in Claude Code's lifecycle. Wotch uses this to receive structured event data instead of parsing terminal output with regex.

---

## Claude Code Hook System

### Configuration Location

Hooks are configured in Claude Code's settings file:

- **Global**: `~/.claude/settings.json`
- **Project-level**: `.claude/settings.json` (in project root)

Project-level hooks are merged with global hooks. Wotch configures hooks at the global level so they apply to all Claude Code sessions.

### Hook Events

Claude Code fires hooks at these lifecycle points:

| Event | When it fires | Data available |
|-------|--------------|----------------|
| `PreToolUse` | Before a tool executes | Tool name, tool input, session ID |
| `PostToolUse` | After a tool completes | Tool name, tool input, tool output, session ID |
| `Notification` | When Claude wants to notify the user | Title, body, session ID |
| `Stop` | When Claude finishes a turn | Reason (end_turn, max_tokens, stop_sequence), session ID |

### Hook Configuration Format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:19520/hook -H 'Content-Type: application/json' -d \"$(jq -n --arg event PreToolUse --arg tool \\\"$CLAUDE_TOOL_NAME\\\" --arg session \\\"$CLAUDE_SESSION_ID\\\" '{event: $event, tool: $tool, session: $session}')\""
          }
        ]
      }
    ]
  }
}
```

### Environment Variables in Hooks

Claude Code sets environment variables before executing hook commands:

| Variable | Available in | Description |
|----------|-------------|-------------|
| `CLAUDE_TOOL_NAME` | PreToolUse, PostToolUse | Name of the tool being used |
| `CLAUDE_TOOL_INPUT` | PreToolUse, PostToolUse | JSON string of tool input parameters |
| `CLAUDE_TOOL_OUTPUT` | PostToolUse | Tool execution result |
| `CLAUDE_SESSION_ID` | All events | Unique session identifier |
| `CLAUDE_NOTIFICATION_TITLE` | Notification | Notification title text |
| `CLAUDE_NOTIFICATION_BODY` | Notification | Notification body text |
| `CLAUDE_STOP_REASON` | Stop | Why Claude stopped (end_turn, max_tokens, etc.) |

---

## Wotch Hook Receiver

### Server Design

A minimal HTTP server in the Wotch main process that accepts POST requests from hook commands.

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
    this.rateLimitWindow = new Map(); // IP -> timestamps
  }

  start() {
    this.server = http.createServer((req, res) => {
      // Only accept POST to /hook
      if (req.method !== 'POST' || req.url !== '/hook') {
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

      let body = '';
      req.on('data', chunk => {
        // Cap body size at 64KB to prevent memory abuse
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
          const event = JSON.parse(body);
          if (!this._validateEvent(event)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid event schema' }));
            return;
          }

          this.eventCount++;
          this.emit('hook-event', event);
          res.writeHead(200);
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
        // Try next port
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

  _validateEvent(event) {
    const validEvents = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'];
    return (
      event &&
      typeof event.event === 'string' &&
      validEvents.includes(event.event) &&
      typeof event.session === 'string'
    );
  }

  _isRateLimited() {
    const now = Date.now();
    const windowStart = now - 1000;
    const key = 'localhost'; // single source
    const timestamps = this.rateLimitWindow.get(key) || [];
    const recent = timestamps.filter(t => t > windowStart);
    recent.push(now);
    this.rateLimitWindow.set(key, recent);
    return recent.length > 100;
  }
}

module.exports = { HookReceiver };
```

### Event Schema

Each hook event POSTed to the receiver has this shape:

```typescript
interface HookEvent {
  event: 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop';
  session: string;        // Claude Code session ID
  tool?: string;          // Tool name (PreToolUse, PostToolUse)
  toolInput?: object;     // Tool input parameters (PreToolUse, PostToolUse)
  toolOutput?: string;    // Tool result (PostToolUse only)
  title?: string;         // Notification title
  body?: string;          // Notification body
  reason?: string;        // Stop reason
  timestamp?: number;     // Unix ms (added by Wotch if missing)
}
```

---

## Hook-to-Status Mapping

The enhanced status detector translates hook events into the existing status states:

| Hook Event | Tool/Reason | Wotch Status | Description |
|------------|-------------|--------------|-------------|
| `PreToolUse` | `BashTool` | `working` | Claude is executing a command |
| `PreToolUse` | `FileEditTool` | `working` | Claude is editing a file |
| `PreToolUse` | `FileReadTool` | `thinking` | Claude is reading context |
| `PreToolUse` | `GrepTool` / `GlobTool` | `thinking` | Claude is searching |
| `PreToolUse` | `AgentTool` | `working` | Claude spawned a sub-agent |
| `PreToolUse` | `AskUserQuestion` | `waiting` | Claude is waiting for input |
| `PostToolUse` | any | (maintain current) | Tool completed, still in turn |
| `Notification` | — | (forward to UI) | Show notification to user |
| `Stop` | `end_turn` | `done` | Claude finished |
| `Stop` | `max_tokens` | `error` | Context limit hit |

### State Machine

```
                PreToolUse(Read/Search)
    ┌──────────────────────────────────┐
    │                                  ▼
  idle ──PreToolUse(Edit/Bash)──► working
    │                                  │
    │    PreToolUse(AskUser)           │ PostToolUse
    └────────────────────┐             │
                         ▼             ▼
                      waiting      (maintain)
                         │             │
                         │ Stop        │ Stop
                         ▼             ▼
                        done ◄─────── done
                         │
                         │ (5s timeout)
                         ▼
                        idle
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

  // Read existing settings
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    // File doesn't exist or is malformed; start fresh
  }

  // Preserve existing hooks, add Wotch hooks
  if (!settings.hooks) settings.hooks = {};

  const wotchHookCommand = (event) =>
    `curl -s -X POST http://localhost:${wotchPort}/hook ` +
    `-H 'Content-Type: application/json' ` +
    `-d "$(cat <<HOOKEOF\n${hookPayload(event)}\nHOOKEOF\n)"`;

  const hookEvents = ['PreToolUse', 'PostToolUse', 'Notification', 'Stop'];

  for (const event of hookEvents) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Check if Wotch hook already exists
    const existing = settings.hooks[event].find(h =>
      h.hooks?.some(cmd => cmd.command?.includes('localhost:' + wotchPort + '/hook'))
    );

    if (!existing) {
      settings.hooks[event].push({
        matcher: '',
        hooks: [{
          type: 'command',
          command: wotchHookCommand(event)
        }]
      });
    }
  }

  // Write back
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
```

### Safety Rules

- **Never overwrite existing hooks**: Wotch appends its hooks alongside any user-configured hooks
- **Idempotent**: Running auto-configure multiple times produces the same result (checks for existing Wotch hooks before adding)
- **Reversible**: Wotch hooks are identifiable by the `localhost:<port>/hook` pattern and can be removed cleanly
- **User consent**: Auto-configuration is gated behind the `integration.autoConfigureHooks` setting (default: `true`, but first-run prompts the user)

---

## Tab-to-Session Mapping

Claude Code sessions must be mapped to Wotch terminal tabs so that hook events update the correct tab's status.

### Strategy

When a PTY is created in Wotch and Claude Code starts in that tab:

1. Wotch watches the terminal output for Claude Code's session initialization (a one-time regex match on startup, much simpler than continuous parsing)
2. Alternatively, Wotch sets a `WOTCH_TAB_ID` environment variable in the PTY, which hook commands can include in their payload
3. The hook receiver maps `session` → `tabId` using a lookup table

### Environment Variable Approach (Preferred)

```javascript
// In main.js, when creating a PTY:
const pty = nodePty.spawn(shell, args, {
  env: {
    ...process.env,
    WOTCH_TAB_ID: tabId  // Pass tab ID to the shell environment
  }
});
```

Hook commands then include `$WOTCH_TAB_ID` in their payload:

```json
{
  "command": "curl -s -X POST http://localhost:19520/hook -d '{\"event\":\"PreToolUse\",\"tool\":\"'$CLAUDE_TOOL_NAME'\",\"session\":\"'$CLAUDE_SESSION_ID'\",\"tabId\":\"'$WOTCH_TAB_ID'\"}'"
}
```

This creates a direct mapping without any output parsing.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Hook receiver port in use | Try ports 19520–19529; if all taken, disable hooks and log warning |
| Claude Code not installed | Skip auto-configuration; hooks channel inactive; no error shown |
| Malformed hook event | Return 400; log warning; do not crash |
| Hook command fails (curl not available) | Claude Code logs hook failure; Wotch doesn't receive event; regex fallback handles status |
| Claude Code settings.json is malformed | Do not auto-configure; warn user in settings UI |
| Rate limit exceeded | Return 429; drop events; resume when rate normalizes |
| Hook receiver crashes | Restart automatically; emit error event for logging |

---

## Testing

### Unit Tests

1. `HookReceiver` correctly parses valid events
2. `HookReceiver` rejects invalid JSON (400)
3. `HookReceiver` rejects unknown event types (400)
4. `HookReceiver` enforces rate limiting (429)
5. `HookReceiver` enforces body size limit (413)
6. Status mapping produces correct states for all tool/event combinations
7. Auto-configuration preserves existing hooks
8. Auto-configuration is idempotent

### Integration Tests

1. Start hook receiver → send curl POST → verify event emitted
2. Configure hooks in test settings file → verify Wotch hooks present → verify existing hooks preserved
3. Kill hook receiver → verify regex fallback activates within 5 seconds
4. Send 200 events in 1 second → verify rate limiting kicks in at 101
