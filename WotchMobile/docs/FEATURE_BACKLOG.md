# Wotch Mobile — Feature Backlog

_Authored: 2026-04-02. Prioritized based on gap analysis and user impact._

Items are ordered within each priority tier by estimated value-to-effort ratio.
"Effort" is relative to the existing mobile codebase.

---

## Priority 1 — High Impact, Achievable Now

These items require no architectural changes to the desktop. They can be done
entirely in the mobile codebase (or with trivial bridge server additions).

### 1.1 Sync Status Detection Patterns from Desktop

**Gap:** `ClaudeStatusDetector.ts` has not received the Gemini CLI fixes applied
to `main.js` in the recent session.

**Changes needed (mobile only):**
- Replace `/gemini/i` (if present) with `/Gemini CLI/i`.
- Remove `/google.*ai/i`.
- Add Gemini activation: `/Gemini CLI/i` and `/gemini\.google\.com/i`.
- Add `aiType` field (`"claude" | "gemini" | null`) to the per-connection state.
- Add `◆` done pattern as `/^◆\s+(.{0,60})/m` (line-anchored).
- Add tool-verb mapping for richer descriptions (copy from `enhanced-status-detector.js`
  `TOOL_VERB_MAP`).

**Effort:** Small (1–2 hours). Mechanical port of already-written logic.

---

### 1.2 Background Push Notifications

**Gap:** App cannot alert users when Claude finishes while backgrounded.
This is the primary mobile use-case and is listed as Phase 2 in the roadmap.

**Changes needed:**
- Add `expo-notifications` (already in Expo SDK, no native module needed).
- In `WebSocketTerminal.ts`/`ClaudeStatusDetector.ts`: on state transition to
  `done` or `error` when app is backgrounded, schedule a local notification.
- Notification body: `"${aiType === 'gemini' ? 'Gemini' : 'Claude'} finished: ${description}"`.
- Settings screen: notification opt-in toggle (iOS requires explicit permission).
- `expo-haptics` is already imported but unused — fire a haptic on transition
  even when foregrounded.

**Effort:** Medium (half day). Expo Notifications is well-documented; the trigger
logic is already in the status detector.

---

### 1.3 Direct Wotch Desktop API Connection

**Gap:** Mobile never connects to the desktop Wotch API server (port 19519),
which provides hook-quality status, tab listing, git data, and more.

See [`DESKTOP_API_INTEGRATION.md`](./DESKTOP_API_INTEGRATION.md) for full design.

**Phase A (read-only, high value):**
- New profile type: `WotchDesktopProfile` (host, port, token, useTLS).
- New service: `WotchApiClient.ts` consuming `GET /v1/status`, `GET /v1/tabs`,
  `GET /v1/git/status`, `GET /v1/tabs/:tabId/buffer`, WebSocket `/v1/ws`.
- Status data comes pre-parsed from the API; `ClaudeStatusDetector.ts` regex
  is not used for this connection type.
- Profile editor: add "Connection type" toggle.
- Terminal screen: tab switcher from `GET /v1/tabs`.
- Git bar: branch + changed file count from `GET /v1/git/status`.

**Effort:** Large (2–3 days). New service layer and some new UI, but the desktop
API is already built and documented.

---

### 1.4 Git Status Bar

**Gap:** Desktop shows branch, changed file count, and checkpoint count in a
persistent bar. Mobile shows nothing.

**For Desktop API connections:** free — data comes from `GET /v1/git/status`.

**For Bridge connections:** requires bridge server to call `git` locally and
return status as a structured message type. Add a `git-status` message type to
the bridge protocol.

**Changes needed:**
- Add `git-status` message to bridge server (run `git status --porcelain` and
  `git branch --show-current` on the VPS).
- Mobile: render a compact bar below the status dot in the terminal view showing
  branch name and changed file count.

**Effort:** Medium (half day for bridge change + UI).

---

## Priority 2 — Meaningful Improvements, Moderate Effort

### 2.1 ANSI Color Rendering

**Gap:** All color and formatting is stripped from terminal output. Claude Code's
color-coded output (tool names, file paths, error text) renders as monochrome.

**Options:**
- **Option A (recommended):** Embed a minimal ANSI-to-React-Native renderer. A
  small number of sequences cover 90 % of Claude Code output: 30–37 (foreground
  colors), 1 (bold), 0 (reset). Implement as a `parseAnsi(text)` function that
  returns an array of `{text, color, bold}` spans. Render with `<Text>` components.
  No WebView needed; no external library required.
- **Option B:** Embed xterm.js in a `<WebView>`. More complete but heavier; adds
  a native module dependency and increases bundle size significantly.

**Effort (Option A):** Medium (1 day). The parser is ~100 lines; the render
component replaces `TerminalOutput.tsx`.

---

### 2.2 Reconnect Backoff + Attempt Limit

**Gap:** Bridge server reconnects on a fixed 3 s delay with no attempt limit.
Desktop SSH uses exponential backoff (3 → 6 → 12 → 24 → 30 s, max 5 attempts).

**Changes needed (`WebSocketTerminal.ts`):**
```typescript
private reconnectDelay = 3000;
private reconnectAttempt = 0;
private readonly MAX_RECONNECT_ATTEMPTS = 5;

// On disconnect:
if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
  this.setState("failed");
  return;
}
const delay = Math.min(3000 * Math.pow(2, this.reconnectAttempt), 30000);
this.reconnectAttempt++;
setTimeout(() => this.connect(), delay);

// On successful connect:
this.reconnectAttempt = 0;
this.reconnectDelay = 3000;
```

**Effort:** Small (30 minutes).

---

### 2.3 Terminal Search

**Gap:** Desktop has xterm.js search addon. Mobile has no way to search the
visible terminal buffer.

**Changes needed:**
- Add a search bar (toggle with a toolbar button) to the terminal screen.
- On query change, highlight matching spans in `TerminalOutput` using the
  existing text render layer.
- "Next / Previous" buttons scroll to matches.

**Effort:** Medium (1 day). Works with Option A's span-based renderer from 2.1;
does not require a full xterm implementation.

---

### 2.4 Checkpoint Creation from Mobile

**Gap:** Desktop can create named git snapshots. Mobile cannot.

**For Desktop API connections:** `POST /v1/checkpoints` is already implemented.
A single "Checkpoint" button in the terminal toolbar is the entire UI change.

**For Bridge connections:** add a `checkpoint` message type to the bridge protocol.
The bridge server runs `git add -A && git commit -m "…"` on receiving it.

**Effort:** Small for Desktop API path (1 hour); Medium for bridge path (half day).

---

### 2.5 Configurable Settings

**Gap:** All mobile behaviour is hardcoded. Power users cannot tune reconnect
timings, buffer sizes, notification preferences, etc.

**Proposed settings to expose (start small):**

| Setting | Default | Type |
|---|---|---|
| Reconnect max attempts | 5 | Number |
| Notification on complete | true | Toggle |
| Notification on error | true | Toggle |
| Haptic on status change | true | Toggle |
| Terminal buffer size (lines) | 500 | Number |
| Theme | dark | Enum |

**Effort:** Small (half day to wire up the settings screen that already exists).

---

## Priority 3 — Polish, Later

### 3.1 Multi-Tab View for Desktop API Connections

When connected to the Wotch desktop API, `GET /v1/tabs` returns all open tabs.
Display a tab switcher within the terminal screen (horizontal scroll bar or bottom
sheet). Each tab shows its own status dot. Tapping a tab switches the terminal
buffer and live stream to that tab.

**Effort:** Medium (1 day). Requires `WotchApiClient` from item 1.3.

---

### 3.2 Diff Viewer

Show a simple unified diff of the last checkpoint vs current working tree.
For Desktop API connections: `GET /v1/git/diff` is already available.
Render as a `ScrollView` with red/green line coloring (builds on 2.1).

**Effort:** Small once 1.3 and 2.1 are done.

---

### 3.3 iOS Lock Screen / Dynamic Island Widget

Display the current aggregate Claude status (state + description) on the iOS Lock
Screen or in the Dynamic Island (iOS 16.1+, Live Activities API). Polls via the
Wotch desktop API or bridge server.

This was Phase 4 in the original mobile roadmap.

**Effort:** Large (2–3 days). Requires a native module or a React Native Live
Activities library. EAS Build required (cannot use Expo Go).

---

### 3.4 Direct SSH (No Bridge)

Replace the bridge server dependency with a direct SSH connection from the phone
using a React Native SSH library (e.g., `react-native-ssh-sftp`).

**Effort:** Large (2–3 days). Adds a native module dependency; requires EAS Build.
The bridge server remains the simpler path for most users.

---

### 3.5 Android Support

Current codebase is iOS-only (portrait lock, iOS Keychain). Expo's cross-platform
nature means most code would work, but:
- Replace `expo-secure-store` usage with the cross-platform API (already
  cross-platform in Expo SDK 52).
- Remove iOS-specific portrait lock from `app.json`.
- Test on Android emulator.

**Effort:** Small-Medium (1 day of testing + minor fixes).

---

## Items Explicitly Out of Scope for Mobile

| Feature | Reason |
|---|---|
| MCP Server | Claude Code runs on the remote machine; MCP is a local stdio transport. N/A to mobile. |
| Hook Receiver | Same — hooks are local to where Claude Code runs. Mobile consumes the *result* of hooks via the desktop API. |
| Plugin System | Too complex for mobile; desktop-specific architecture. |
| Agent Execution | Agents run on the desktop/VPS; mobile can monitor agent status via API events but should not run agents. |
| IDE Bridge | VS Code / JetBrains integration is desktop-only by nature. |
| Multi-monitor Management | Hardware feature; N/A to mobile. |
