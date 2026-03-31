# Chat Panel UI Specification

## Layout

The chat panel sits as a toggleable overlay alongside the terminal, sharing the expanded panel space. Users switch between terminal view and chat view via a tab-like toggle in the tab bar area.

```
+---------------------------------------------------------+
|  Tab bar area                    [Terminal] [Chat]       |
+---------------------------------------------------------+
|  Context: project-name  branch  3 files changed     [s] |
+---------------------------------------------------------+
|                                                         |
|  Claude:                                                |
|  The error in auth.ts:42 is a null reference...         |
|  ```typescript                                          |
|  if (user?.session) { ... }                             |
|  ```                                                    |
|                                                         |
|  You:                                                   |
|  Can you also check the login handler?                  |
|                                                         |
|  Claude:                                                |
|  [streaming cursor]                                     |
|                                                         |
+---------------------------------------------------------+
|  [Sonnet v]  [ctx: term git diff]  128 tok / $0.02     |
+---------------------------------------------------------+
|  Ask Claude about your code...                    [Enter]|
+---------------------------------------------------------+
```

## HTML Structure

- View toggle buttons (Terminal / Chat) in tab bar area
- Chat panel container (hidden by default) with:
  - Context badges bar (project, branch, changes)
  - Scrollable message list
  - Status bar (model selector, context toggles, token count, cost)
  - Input area (textarea + send button)

## CSS

All colors use CSS custom properties for theme compatibility. Message bubbles: user messages right-aligned with accent color, assistant messages left-aligned with secondary bg. Code blocks in messages use monospace font with tertiary bg.

## Markdown Rendering

Lightweight inline renderer (no external dependency) supporting:
- Bold, italic, inline code
- Code blocks with language hints
- Lists (ordered/unordered)
- Links (open in external browser)
- Line breaks

## Streaming Response Display

1. Create message bubble immediately with `streaming` class
2. Append text chunks as they arrive via IPC (throttled to every 50ms)
3. Re-render markdown on each chunk
4. Show blinking cursor at end during streaming
5. Remove cursor and finalize when stream completes
6. Auto-scroll to bottom during streaming (unless user scrolled up)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |
| `Ctrl+Shift+L` / `Cmd+Shift+L` | Toggle chat view |
| `Escape` | Switch back to terminal |

## Conversation History

Per-project conversations stored in `~/.wotch/conversations/<project-hash>/`. JSON format with messages, model, timestamps, and token usage. "New conversation" button starts fresh thread. Dropdown shows recent conversations for current project.

## Position Adaptations

When pill is in left/right position: chat panel uses full height, input stays at bottom, message bubbles use full width.
