# Plan 2: Direct Claude API Integration

## Overview

This plan adds a built-in chat panel to Wotch that connects directly to the Anthropic Messages API. Users enter their API key once, and Wotch injects rich context (terminal buffer, git status, project info) into every request automatically. The chat panel lives alongside the terminal inside the existing expanded panel, accessible via a tab-like toggle.

---

## Goals

1. **API Key Management** — Securely store an Anthropic API key in `~/.wotch/credentials` using Electron's `safeStorage` API (AES-256-GCM OS-keychain-backed encryption). Provide a UI for entering, validating, rotating, and deleting the key.

2. **Chat Panel** — A side-by-side or toggle-based chat UI within the expanded panel. Supports streaming responses rendered as markdown, conversation threading, and a model selector (Claude Opus, Sonnet, Haiku).

3. **Context Injection** — Automatically gather context from terminal buffer (last N lines), git diff/status, project directory listing, and active CWD. Inject as a structured system prompt so Claude understands the user's current state.

4. **Token & Cost Tracking** — Display input/output token counts per message and running cost estimates. Persist usage history to `~/.wotch/usage.json`. Support budget alerts.

5. **Conversation Persistence** — Save conversation history per project in `~/.wotch/conversations/`. Allow users to start new conversations or continue previous ones.

---

## Non-Goals

- **Tool use / function calling** — Plan 4 (Agent SDK) handles autonomous tool execution. This plan is chat-only.
- **File editing** — Claude's responses are read-only text. No applying code diffs or writing files.
- **Multi-provider support** — Only the Anthropic API is supported. No OpenAI, Gemini, or other providers.
- **Custom system prompts** — The system prompt is auto-generated from context. User-editable system prompts are out of scope (may come in Plan 3 as a plugin).
- **Image/vision input** — Text-only for this plan.
- **MCP server connections** — Out of scope; Plan 4 territory.

---

## Scope

### Files Modified

| File | Changes |
|------|---------|
| `package.json` | Add `@anthropic-ai/sdk` dependency |
| `src/main.js` | Add: `ClaudeAPIManager` class, `CredentialManager` class, `ContextEngine` class, `UsageTracker` class, ~12 new IPC handlers |
| `src/preload.js` | Add ~15 new IPC bridge methods under `window.wotch.claude.*` |
| `src/renderer.js` | Add: chat panel state, message rendering, streaming display, model selector, context badges, cost counter, conversation list |
| `src/index.html` | Add: chat panel HTML structure, CSS for chat UI (all 4 themes), markdown rendering styles |
| `docs/INVARIANTS.md` | Add: INV-SEC-006 (credential encryption), INV-SEC-007 (API key never in renderer), INV-DATA-006 (usage file resilience) |

### Files Created

| File | Purpose |
|------|---------|
| `~/.wotch/credentials` | Encrypted API key storage (created at runtime) |
| `~/.wotch/usage.json` | Token usage log (created at runtime) |
| `~/.wotch/conversations/<project-hash>/*.json` | Conversation history (created at runtime) |

---

## Success Criteria

1. User can enter an Anthropic API key in settings; key is encrypted on disk and never exposed to the renderer process.
2. User can open the chat panel, type a question, and receive a streaming response from Claude.
3. Context (terminal buffer, git diff, project info) is automatically included in requests. User can see badges showing what context was attached.
4. Token count and estimated cost are displayed per message and as a session total.
5. Conversations persist across app restarts and can be resumed per project.
6. All 4 themes render the chat panel correctly.
7. All existing functionality (terminal, SSH, git checkpoints, hover-to-reveal, settings) is unaffected.
8. No security invariant is violated. API key is never readable from the renderer, never logged, never included in settings.json.

---

## User Stories

### US-01: First-Time API Key Setup
> As a user, I open Wotch settings and see a new "Claude API" section. I paste my `sk-ant-...` key, click "Save", and see a green checkmark indicating the key is valid. The key is stored encrypted and I never need to enter it again.

### US-02: Ask a Quick Question
> As a user, I press `Ctrl+Shift+C` (or click the chat toggle) to open the chat panel next to my terminal. I type "what does this error mean?" and Claude responds with context from my terminal output, showing it understood the error I just saw.

### US-03: See What Context Was Sent
> As a user, before sending a message I see badges showing "Terminal: 45 lines", "Git: 3 changed files", "Project: my-app". I can click a badge to preview or exclude that context source.

### US-04: Choose a Model
> As a user, I click the model selector dropdown and switch from Sonnet to Haiku for a quick question, reducing cost. The selector shows the per-token price for each model.

### US-05: Track Spending
> As a user, I see a running cost counter in the chat panel footer. I click it to see a breakdown: today's total, this conversation's total, and per-model usage. I can set a daily budget alert.

### US-06: Resume a Conversation
> As a user, I click the conversation history button and see my past conversations for this project, listed by date and first message. I select one and the chat loads with full history.

### US-07: Context-Aware Follow-Up
> As a user, I ask Claude to explain a git diff. Then I make changes in my terminal, and when I ask a follow-up question, the updated terminal buffer and git diff are automatically included.

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@anthropic-ai/sdk` | `^0.39.0` | Anthropic Messages API client |

No other new dependencies. Markdown rendering is implemented with a lightweight custom parser (no heavy library) to keep the bundle small. The `crypto` module (built into Node.js) handles key derivation when `safeStorage` is unavailable.

---

## Dependency: Plan 0 (Claude Code Deep Integration)

Plan 2 benefits from Plan 0's MCP and bridge channels:

- **Context sharing with running Claude Code sessions**: When a Claude Code instance is running in a Wotch terminal, the MCP channel already provides bidirectional data flow. The chat panel can access the same context that Claude Code sees (and vice versa), avoiding redundant API calls.
- **Conversation awareness**: The bridge adapter receives `conversation_update` events from Claude Code, allowing the chat panel to show when Claude Code is already handling a task — preventing the user from asking the same question twice.
- **Shared credential management**: Plan 0's MCP server configuration already handles `~/.claude/settings.json` writes. Plan 2's credential manager can extend the same config management patterns.

If Plan 0 is not yet implemented, Plan 2 operates as a standalone API client with no awareness of running Claude Code sessions. All features work — context injection just comes from Wotch's own terminal/git state rather than from Claude Code's bridge.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `safeStorage` unavailable on some Linux (no keychain) | Fall back to `crypto.createCipheriv` with a machine-derived key (see credential management doc) |
| Large context exceeds model token limits | Token budget manager truncates context sources by priority (see context engine doc) |
| Streaming responses cause UI jank | Use `requestAnimationFrame` batching for DOM updates; append text in chunks |
| API errors (rate limits, invalid key, network) | Graceful error display in chat panel with retry button; never crash |
| Conversation files grow unbounded | Cap at 100 messages per conversation; older messages are summarized or trimmed |
