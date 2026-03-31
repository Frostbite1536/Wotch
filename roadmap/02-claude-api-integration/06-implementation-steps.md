# Implementation Steps — Claude API Integration

## Step 1: Install Anthropic SDK

**Files:** `package.json`

```bash
npm install @anthropic-ai/sdk
```

**Testing:** `npm install` succeeds; `require('@anthropic-ai/sdk')` doesn't throw.

---

## Step 2: Credential Manager

**Files:** `src/main.js`

Implement encrypted API key storage using Electron's `safeStorage` API. Store encrypted key at `~/.wotch/credentials` with mode `0600`. Fallback to AES-256-GCM with machine-derived key when safeStorage is unavailable.

**IPC handlers:** `claude-set-api-key`, `claude-has-key`, `claude-delete-key`, `claude-validate-key`

**Testing:**
1. Save a key → file created with mode 0600
2. Load key → returns preview with `hasKey: true`
3. Test with valid key → `{ valid: true }`
4. Test with invalid key → `{ valid: false }`

---

## Step 3: Conversation State Manager

**Files:** `src/main.js`

`ConversationManager` class handling conversation history, persistence, and streaming API calls.

- Creates conversations per project
- Gathers context via the context engine before each API call
- Streams responses via `client.messages.stream()`
- Sends chunks to renderer via `chat-stream-chunk` IPC
- Tracks tokens via `TokenTracker`
- Persists conversations to `~/.wotch/conversations/<project-hash>/`
- Supports stream cancellation

**IPC handlers:** `claude-send-message`, `claude-stop-stream`, `claude-get-conversations`, `claude-new-conversation`

**Testing:**
1. Send message → streaming response arrives
2. Cancel during stream → stops cleanly
3. Conversations persist and can be listed

---

## Step 4: Chat Panel HTML & CSS

**Files:** `src/index.html`

Add the complete chat panel HTML as specified in `03-chat-ui.md`: view toggle buttons, chat panel container, context bar, message list, status bar, input area. Add CSS for all 4 themes.

**Testing:** View toggle works, panel appears/hides, themes apply correctly.

---

## Step 5: Chat Panel JavaScript

**Files:** `src/renderer.js`

Implement chat panel logic: view toggling, message sending, markdown rendering, stream handling, auto-scroll, token display.

**Testing:**
1. Enter → send message → user bubble appears → Claude streams response
2. Shift+Enter → newline
3. Code blocks render with styling
4. Token count and cost update after each response

---

## Step 6: Context Engine Integration

**Files:** `src/main.js`

Implement `gatherContext()` and `formatContextAsSystemPrompt()` as specified in `04-context-engine.md`.

**Testing:** Context toggles (terminal, git, diff, files) correctly include/exclude data from system prompt.

---

## Step 7: Cost Tracking

**Files:** `src/main.js`

Implement `TokenTracker` and pricing as specified in `05-cost-tracking.md`. Budget checking with toast alerts.

**IPC handlers:** `claude-get-usage`, `claude-set-budget`

**Testing:** Token counts accumulate, usage log written, budget alerts fire.

---

## Step 8: API Key Settings UI

**Files:** `src/index.html`, `src/renderer.js`

Add "Claude API" section to settings: API key configure/test/delete, default model selector, monthly budget input, usage display.

**Testing:** Configure → save → test → works. Remove → cleared.

---

## Step 9: Keyboard Shortcuts

**Files:** `src/renderer.js`

- `Ctrl+Shift+C` / `Cmd+Shift+C` — toggle chat view
- `Escape` in chat → back to terminal
- Command palette: "Toggle Chat Panel", "New Chat Conversation"

---

## Step 10: New Invariants

**Files:** `docs/INVARIANTS.md`

- **INV-SEC-014:** API Key Encryption — use safeStorage, mode 0600, never in logs/settings/renderer
- **INV-SEC-015:** API Key Never in Renderer — only in Anthropic SDK client, no IPC handler for getKey()
- **INV-DATA-006:** Conversation Persistence — per-project dirs, resilient to corrupted JSON

---

## Summary of Changes by File

| File | Changes |
|------|---------|
| `package.json` | Add `@anthropic-ai/sdk` |
| `src/main.js` | Credential manager, ConversationManager, TokenTracker, context engine, budget checking, 10+ new IPC handlers |
| `src/preload.js` | ~12 new IPC bridge methods for chat |
| `src/index.html` | Chat panel HTML, view toggle, API settings section, CSS for all themes |
| `src/renderer.js` | Chat panel logic, message rendering, markdown, streaming, token display, settings wiring, keyboard shortcuts |
| `docs/INVARIANTS.md` | Add INV-SEC-010, INV-SEC-011, INV-DATA-006 |

## New IPC Channels (14)

`claude-set-api-key`, `claude-validate-key`, `claude-has-key`, `claude-delete-key`, `claude-get-models`, `claude-send-message`, `claude-stop-stream`, `claude-stream-chunk` (main→renderer), `claude-stream-end` (main→renderer), `claude-stream-error` (main→renderer), `claude-get-context`, `claude-get-conversations`, `claude-load-conversation`, `claude-delete-conversation`, `claude-new-conversation`, `claude-get-usage`, `claude-set-budget`
