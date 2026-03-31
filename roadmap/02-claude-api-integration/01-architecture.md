# Architecture: Claude API Integration

## System Overview

The Claude API integration follows Wotch's existing architecture: all business logic and I/O live in the **main process**, the **preload** exposes named IPC channels, and the **renderer** handles only UI. The Anthropic SDK runs exclusively in the main process (it requires Node.js `fetch`). The renderer never sees the API key or raw API responses — it receives processed message objects via IPC.

```
┌─────────────────────────────────────────────────────────────────┐
│                        MAIN PROCESS                             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Credential   │  │ Context      │  │ ClaudeAPIManager      │  │
│  │ Manager      │  │ Engine       │  │                       │  │
│  │              │  │              │  │  - Anthropic SDK      │  │
│  │  encrypt()   │  │  gather()    │  │  - messages.create()  │  │
│  │  decrypt()   │  │  format()    │  │  - streaming handler  │  │
│  │  validate()  │  │  truncate()  │  │  - conversation state │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬────────────┘  │
│         │                 │                      │               │
│         │     ┌───────────┴──────────┐           │               │
│         │     │ Existing Managers    │           │               │
│         │     │  - PTY Manager       │           │               │
│         │     │  - Git Operations    │           │               │
│         │     │  - Project Detection │           │               │
│         │     │  - Settings Manager  │           │               │
│         │     └──────────────────────┘           │               │
│         │                                        │               │
│  ┌──────┴────────────────────────────────────────┴────────────┐  │
│  │                    IPC Handlers                             │  │
│  │  claude-set-api-key    claude-send-message                 │  │
│  │  claude-validate-key   claude-stop-stream                  │  │
│  │  claude-has-key        claude-get-conversations             │  │
│  │  claude-delete-key     claude-load-conversation             │  │
│  │  claude-get-models     claude-delete-conversation           │  │
│  │  claude-get-context    claude-new-conversation              │  │
│  │  claude-get-usage      claude-set-budget                   │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                      │
└───────────────────────────┼──────────────────────────────────────┘
                            │ IPC (contextBridge)
┌───────────────────────────┼──────────────────────────────────────┐
│                    PRELOAD (preload.js)                           │
│                                                                  │
│  window.wotch.claude = {                                         │
│    setApiKey(key)          → ipcRenderer.invoke("claude-set-…")  │
│    validateKey()           → ipcRenderer.invoke("claude-val-…")  │
│    hasKey()                → ipcRenderer.invoke("claude-has-…")  │
│    deleteKey()             → ipcRenderer.invoke("claude-del-…")  │
│    getModels()             → ipcRenderer.invoke("claude-get-…")  │
│    sendMessage(msg, opts)  → ipcRenderer.invoke("claude-send…")  │
│    stopStream()            → ipcRenderer.send("claude-stop-…")   │
│    onStreamChunk(cb)       → ipcRenderer.on("claude-stream-…")   │
│    onStreamEnd(cb)         → ipcRenderer.on("claude-stream-…")   │
│    onStreamError(cb)       → ipcRenderer.on("claude-stream-…")   │
│    getContext(tabId)        → ipcRenderer.invoke("claude-get-…") │
│    getConversations(proj)  → ipcRenderer.invoke(…)               │
│    loadConversation(id)    → ipcRenderer.invoke(…)               │
│    deleteConversation(id)  → ipcRenderer.invoke(…)               │
│    newConversation()       → ipcRenderer.invoke(…)               │
│    getUsage()              → ipcRenderer.invoke(…)               │
│    setBudget(limit)        → ipcRenderer.invoke(…)               │
│  }                                                               │
└───────────────────────────┼──────────────────────────────────────┘
                            │
┌───────────────────────────┼──────────────────────────────────────┐
│                     RENDERER (renderer.js)                       │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Chat Panel UI                             │ │
│  │  - Message list (user + assistant bubbles)                  │ │
│  │  - Input textarea with send button                          │ │
│  │  - Model selector dropdown                                  │ │
│  │  - Context badges (terminal, git, project)                  │ │
│  │  - Token/cost counter                                       │ │
│  │  - Conversation history sidebar                             │ │
│  │  - Streaming response animation                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              Existing Terminal UI (unchanged)                │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. CredentialManager (main process)

Lives in `src/main.js`. Manages encrypted API key storage.

```
Location:      ~/.wotch/credentials
Encryption:    electron.safeStorage.encryptString() → Base64
Fallback:      AES-256-GCM with machine-derived key (see 02-credential-management.md)
```

**Class outline:**

```javascript
class CredentialManager {
  constructor(credentialsPath)  // ~/.wotch/credentials
  hasKey()                      // → boolean
  setKey(apiKey)                // encrypt and write to disk
  getKey()                      // decrypt and return (main process only)
  deleteKey()                   // remove credentials file
  async validateKey(apiKey)     // call API with minimal request to verify key works
}
```

**Critical invariant:** `getKey()` is never exposed via IPC. The renderer can only call `hasKey()`, `setKey()`, `validateKey()`, and `deleteKey()`. The actual key string stays in the main process.

---

### 2. ContextEngine (main process)

Gathers, formats, and truncates context from multiple sources.

```javascript
class ContextEngine {
  constructor(ptyProcesses, settings)

  // Gather all context for a given tab/project
  async gather(tabId, projectPath, options) → ContextBundle

  // Format a ContextBundle into a system prompt string
  format(bundle, tokenBudget) → string

  // Get context metadata for UI badges (no content, just sizes)
  async getMetadata(tabId, projectPath) → ContextMetadata
}
```

**ContextBundle shape:**

```javascript
{
  terminal: {
    lines: string[],       // last N lines from PTY buffer
    lineCount: number,
    source: "terminal"
  },
  git: {
    status: { branch, changedFiles, staged, unstaged },
    diff: string,          // git diff output (truncated)
    source: "git"
  },
  project: {
    name: string,
    path: string,
    files: string[],       // top-level directory listing
    source: "project"
  },
  cwd: {
    path: string,          // current working directory of active terminal
    files: string[],       // listing of CWD if different from project root
    source: "cwd"
  }
}
```

**ContextMetadata shape (sent to renderer for badges):**

```javascript
{
  terminal: { lineCount: 45, estimatedTokens: 820, enabled: true },
  git:      { changedFiles: 3, diffLines: 120, estimatedTokens: 1500, enabled: true },
  project:  { name: "my-app", fileCount: 24, estimatedTokens: 200, enabled: true },
  cwd:      { path: "/home/user/my-app/src", enabled: true },
  totalEstimatedTokens: 2520
}
```

---

### 3. ClaudeAPIManager (main process)

Manages conversations and API communication.

```javascript
class ClaudeAPIManager {
  constructor(credentialManager, contextEngine, usageTracker)

  // Active state
  activeConversationId   // string | null
  conversations          // Map<id, Conversation>
  currentStream          // AbortController | null

  // API methods
  async sendMessage(tabId, projectPath, userMessage, options) → void
    // 1. Gather context via ContextEngine
    // 2. Build messages array (conversation history + new user message)
    // 3. Call Anthropic SDK with streaming
    // 4. Emit chunks via mainWindow.webContents.send("claude-stream-chunk", ...)
    // 5. On completion, emit "claude-stream-end" with full message + usage
    // 6. Save conversation to disk
    // 7. Update UsageTracker

  stopStream() → void
    // Abort the current stream via AbortController

  // Conversation management
  newConversation(projectPath) → conversationId
  loadConversation(conversationId) → Conversation
  getConversations(projectPath) → ConversationSummary[]
  deleteConversation(conversationId) → void
}
```

**Conversation shape (on disk as JSON):**

```javascript
{
  id: "conv-1711234567890",
  projectPath: "/home/user/my-app",
  projectName: "my-app",
  model: "claude-sonnet-4-6-20250514",
  createdAt: "2026-03-28T10:00:00Z",
  updatedAt: "2026-03-28T10:05:00Z",
  messages: [
    { role: "user", content: "What does this error mean?", timestamp: "..." },
    { role: "assistant", content: "The error indicates...", timestamp: "...",
      usage: { input_tokens: 1200, output_tokens: 450 } }
  ],
  contextSnapshot: { /* ContextMetadata from first message */ }
}
```

**Storage layout:**

```
~/.wotch/conversations/
  <project-hash>/          # SHA-256 of projectPath, first 12 chars
    conv-1711234567890.json
    conv-1711234599999.json
```

---

### 4. UsageTracker (main process)

```javascript
class UsageTracker {
  constructor(usagePath)  // ~/.wotch/usage.json

  record(model, inputTokens, outputTokens, conversationId)
  getSessionTotals() → { inputTokens, outputTokens, cost, byModel }
  getDailyTotals(date) → { inputTokens, outputTokens, cost, byModel }
  getConversationTotals(conversationId) → { inputTokens, outputTokens, cost }
  setBudget(dailyLimitCents) → void
  checkBudget() → { remaining, exceeded, limit }
}
```

---

## Data Flow: Sending a Message

```
User types message in chat input, presses Enter
          │
          ▼
Renderer: window.wotch.claude.sendMessage(userMessage, {
            tabId: activeTabId,
            projectPath: currentProject?.path,
            model: selectedModel,
            contextSources: { terminal: true, git: true, project: true }
          })
          │
          ▼ ipcRenderer.invoke("claude-send-message", ...)
          │
    ┌─────┴─────────────────────────────────────────────────────┐
    │                    MAIN PROCESS                            │
    │                                                            │
    │  1. CredentialManager.getKey() → apiKey                    │
    │     (fails fast if no key set)                             │
    │                                                            │
    │  2. ContextEngine.gather(tabId, projectPath, sources)      │
    │     ├─ Read PTY buffer (last 200 lines from terminal)      │
    │     ├─ execFileSync("git", ["status"]) on projectPath      │
    │     ├─ execFileSync("git", ["diff"]) on projectPath        │
    │     ├─ fs.readdirSync(projectPath) for file listing        │
    │     └─ Read CWD from PTY process                           │
    │                                                            │
    │  3. ContextEngine.format(bundle, tokenBudget)              │
    │     └─ Builds system prompt with XML-tagged sections       │
    │                                                            │
    │  4. Build messages array:                                  │
    │     [                                                      │
    │       ...previousMessages (from conversation history),     │
    │       { role: "user", content: userMessage }               │
    │     ]                                                      │
    │                                                            │
    │  5. anthropic.messages.create({                             │
    │       model: selectedModel,                                │
    │       max_tokens: 4096,                                    │
    │       system: systemPrompt,                                │
    │       messages: messages,                                  │
    │       stream: true                                         │
    │     })                                                     │
    │                                                            │
    │  6. For each stream event:                                 │
    │     ├─ content_block_delta → send "claude-stream-chunk"    │
    │     └─ message_stop → send "claude-stream-end"             │
    │                                                            │
    │  7. UsageTracker.record(model, input, output, convId)      │
    │                                                            │
    │  8. Save conversation to disk                              │
    └───────────────────────────────────────────────────────────┘
          │
          ▼ ipcRenderer.on("claude-stream-chunk", ...)
          │
Renderer: Append text chunk to assistant message bubble
          Re-render markdown incrementally
          Update token counter
          │
          ▼ ipcRenderer.on("claude-stream-end", ...)
          │
Renderer: Finalize message rendering
          Update cost display
          Scroll to bottom
          Re-enable input
```

---

## Data Flow: Context Gathering

```
               ContextEngine.gather(tabId, projectPath)
                              │
          ┌───────────────────┼───────────────────────┐
          │                   │                       │
          ▼                   ▼                       ▼
   Terminal Buffer      Git Operations          File System
          │                   │                       │
  ptyProcesses.get(tabId)     │                  fs.readdirSync()
  Read circular buffer    ┌───┴───┐                   │
  Last 200 lines          │       │                   │
          │          git status  git diff              │
          │               │       │                   │
          ▼               ▼       ▼                   ▼
   ┌──────────────────────────────────────────────────────┐
   │              ContextBundle (raw data)                 │
   └──────────────────┬───────────────────────────────────┘
                      │
                      ▼
              format(bundle, tokenBudget)
                      │
          ┌───────────┼───────────────┐
          │           │               │
          ▼           ▼               ▼
   Estimate tokens  Prioritize   Truncate to fit
   per section      sections     token budget
          │           │               │
          │    Priority order:        │
          │    1. Git status (low)    │
          │    2. Project info (low)  │
          │    3. Terminal (medium)   │
          │    4. Git diff (high)     │
          │                           │
          └───────────┬───────────────┘
                      │
                      ▼
              System Prompt String
              (XML-tagged sections)
```

**System prompt format:**

```xml
You are an AI assistant integrated into Wotch, a floating terminal overlay for Claude Code.
The user is working in their terminal and may ask about errors, code, or their project.
Answer concisely. When referencing files, use the exact paths shown in context.

<terminal-output lines="45">
$ npm test
FAIL src/utils.test.js
  TypeError: Cannot read properties of undefined (reading 'map')
    at processItems (src/utils.js:42)
</terminal-output>

<git-status branch="main" changed="3">
M  src/utils.js
M  src/utils.test.js
A  src/helpers.js
</git-status>

<git-diff truncated="false">
diff --git a/src/utils.js b/src/utils.js
--- a/src/utils.js
+++ b/src/utils.js
@@ -40,7 +40,7 @@
...
</git-diff>

<project name="my-app" path="/home/user/my-app">
Files: package.json, src/, tests/, README.md, .gitignore
</project>
```

---

## Chat Panel Coexistence with Terminal

The chat panel shares the expanded panel space with the terminal. Two layout modes:

### Mode 1: Toggle (default, for small panels)
The `#terminals` area and `#chat-panel` area occupy the same space. A toggle button switches between them. The terminal continues running in the background — PTY data still flows, status detection continues.

```
┌─────────────────────────────────────┐
│ [Tab1] [Tab2] [+]     [●] Thinking │  ← tab bar (unchanged)
├─────────────────────────────────────┤
│ [Project: my-app ▾]                 │  ← project bar (unchanged)
├─────────────────────────────────────┤
│ [main] [3 changes] [2 checkpoints] │  ← git bar (unchanged)
├────────┬────────────────────────────┤
│ [Term] │ [Chat]          [⚙ Model] │  ← view toggle bar (NEW)
├────────┴────────────────────────────┤
│                                     │
│   (Terminal OR Chat content here)   │  ← switched content area
│                                     │
├─────────────────────────────────────┤
│ Ctrl+` Toggle  Ctrl+T Tab  v1.0.0  │  ← bottom bar (unchanged)
└─────────────────────────────────────┘
```

### Mode 2: Split (for wide panels, expandedWidth >= 900px)
Terminal and chat side by side, 60/40 split with a draggable divider.

```
┌──────────────────────────────────────────────────────┐
│ [Tab1] [Tab2] [+]                      [●] Thinking │
├──────────────────────────────────────────────────────┤
│ [Project: my-app ▾]                                  │
├──────────────────────────────────────────────────────┤
│ [main] [3 changes]                                   │
├──────────────────────────┬───────────────────────────┤
│                          │ ┌─────────────────────┐   │
│  Terminal output         │ │ What does this       │   │
│  $ npm test              │ │ error mean?          │   │
│  FAIL src/utils.test.js  │ ├─────────────────────┤   │
│  TypeError: Cannot read  │ │ The TypeError at     │   │
│  ...                     │ │ line 42 indicates... │   │
│                          │ │                      │   │
│                          │ ├─────────────────────┤   │
│                          │ │ [Terminal:45] [Git:3]│   │
│                          │ │ [Ask Claude...]      │   │
├──────────────────────────┴───────────────────────────┤
│ Ctrl+` Toggle  Ctrl+Shift+C Chat            v1.0.0  │
└──────────────────────────────────────────────────────┘
```

The mode is determined automatically based on `settings.expandedWidth`:
- `< 900px` → toggle mode
- `>= 900px` → split mode

Users can also force a mode via a setting or the command palette.

---

## IPC Channel Reference

All new channels follow the `claude-*` prefix convention.

| Channel | Direction | Type | Purpose |
|---------|-----------|------|---------|
| `claude-set-api-key` | renderer→main | `invoke` | Store encrypted API key |
| `claude-validate-key` | renderer→main | `invoke` | Verify key works (makes test API call) |
| `claude-has-key` | renderer→main | `invoke` | Check if key is configured (boolean) |
| `claude-delete-key` | renderer→main | `invoke` | Remove stored API key |
| `claude-get-models` | renderer→main | `invoke` | List available models with pricing |
| `claude-send-message` | renderer→main | `invoke` | Send user message, starts stream |
| `claude-stop-stream` | renderer→main | `send` | Abort current streaming response |
| `claude-stream-chunk` | main→renderer | `send` | Streaming text chunk |
| `claude-stream-end` | main→renderer | `send` | Stream complete with usage data |
| `claude-stream-error` | main→renderer | `send` | Stream error occurred |
| `claude-get-context` | renderer→main | `invoke` | Get context metadata for badges |
| `claude-get-conversations` | renderer→main | `invoke` | List conversations for a project |
| `claude-load-conversation` | renderer→main | `invoke` | Load full conversation by ID |
| `claude-delete-conversation` | renderer→main | `invoke` | Delete a conversation |
| `claude-new-conversation` | renderer→main | `invoke` | Start a new conversation |
| `claude-get-usage` | renderer→main | `invoke` | Get usage/cost statistics |
| `claude-set-budget` | renderer→main | `invoke` | Set monthly spending limit |

---

## Streaming Architecture

The Anthropic SDK supports streaming via async iterators. The main process handles the stream and relays chunks to the renderer:

```javascript
// In ClaudeAPIManager.sendMessage():
this.currentAbortController = new AbortController();

const stream = this.anthropic.messages.stream({
  model, system, messages, max_tokens: 4096,
}, { signal: this.currentAbortController.signal });

let fullText = "";

stream.on("text", (text) => {
  fullText += text;
  mainWindow.webContents.send("claude-stream-chunk", {
    conversationId: this.activeConversationId,
    chunk: text,
    accumulated: fullText
  });
});

stream.on("finalMessage", (message) => {
  mainWindow.webContents.send("claude-stream-end", {
    conversationId: this.activeConversationId,
    content: fullText,
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens
    },
    model
  });
});
```

The renderer batches DOM updates using `requestAnimationFrame` to prevent jank during fast streaming:

```javascript
let pendingChunks = "";
let rafScheduled = false;

window.wotch.claude.onStreamChunk(({ chunk }) => {
  pendingChunks += chunk;
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(() => {
      appendToCurrentMessage(pendingChunks);
      pendingChunks = "";
      rafScheduled = false;
    });
  }
});
```

---

## Error Handling

| Error | Detection | Response |
|-------|-----------|----------|
| No API key set | `CredentialManager.hasKey()` returns false | Show "Set up API key" prompt in chat panel |
| Invalid API key | 401 response from API | Show error in chat, prompt to re-enter key in settings |
| Rate limited | 429 response | Show "Rate limited, retry in Xs" with countdown |
| Network error | Fetch failure | Show "Network error" with retry button |
| Context too large | Token count exceeds model limit | Truncate context automatically, show warning badge |
| Stream interrupted | AbortError or network drop | Show partial response with "Interrupted" label |
| Budget exceeded | UsageTracker.checkBudget() | Show warning before sending, block if hard limit set |

All errors are caught in the main process and sent to the renderer via `claude-stream-error`. The renderer displays them inline in the chat panel. No errors propagate as unhandled rejections or crash the app.

---

## Security Considerations

1. **API key isolation**: The key never leaves the main process. `getKey()` has no IPC handler. The renderer only knows whether a key exists (`hasKey()` → boolean).

2. **No raw API responses in renderer**: The main process extracts only the text content and usage metadata. Raw response headers, request IDs, and other metadata stay in the main process.

3. **Context sanitization**: Terminal buffer content is passed as-is (it may contain ANSI codes, which are stripped before inclusion in the prompt). Git diff output is truncated, not executed.

4. **No dynamic IPC**: All IPC channels are statically defined in `preload.js`. The chat feature adds named channels only — no catch-all forwarding (per INV-SEC-003).

5. **Credentials file permissions**: Written with `mode: 0o600` (owner read/write only), matching the existing `settings.json` pattern.
