# System Invariants & Contracts — Wotch Mobile

## Purpose

This document defines the **non-negotiable truths** of Wotch Mobile: rules that must always hold, regardless of UI flow, connection state, or future feature additions. These invariants are the foundation for correctness, trust, and long-term maintainability.

**If a change violates an invariant, it is a bug or a product decision — never an implementation detail.**

---

## How to Use This Document

1. **Before implementing any feature**: Review this document to ensure compliance
2. **During code review**: Check that changes respect all invariants
3. **When debugging**: Verify that invariants still hold
4. **When changing an invariant**: Document why in the Change Log below

---

## Security Invariants

### INV-SEC-001: Auth Token Encryption at Rest

**Rule**: The bridge server auth token must always be stored in Expo SecureStore (hardware-backed encryption), never in AsyncStorage, state, or logs.

**Rationale**: AsyncStorage is plaintext on disk. SecureStore uses the iOS Keychain, which is hardware-encrypted.

**Examples**:
- ✅ Valid: `SecureStore.setItemAsync("wotch.token.profileId", token)`
- ❌ Invalid: `AsyncStorage.setItem("token", token)` or `console.log(token)`

**Enforcement**: All token read/write goes through `SettingsService.loadServerConfig()` / `saveServerConfig()` which route tokens to SecureStore.

### INV-SEC-002: Constant-Time Token Validation

**Rule**: The bridge server must use constant-time comparison for token validation. Never use `===` for token comparison.

**Rationale**: String equality short-circuits on the first different byte, enabling timing attacks.

**Examples**:
- ✅ Valid: `crypto.timingSafeEqual(provided, expected)`
- ❌ Invalid: `if (msg.token === TOKEN)`

**Enforcement**: `server/index.js` auth handler uses `crypto.timingSafeEqual()`.

### INV-SEC-003: Auth Timeout on Bridge Server

**Rule**: Unauthenticated WebSocket connections must be closed within 10 seconds.

**Rationale**: Prevents connection exhaustion attacks where clients connect but never authenticate.

**Enforcement**: `authTimeout` in `server/index.js` fires after 10s.

### INV-SEC-004: No Credentials in Logs or Error Messages

**Rule**: Auth tokens, passwords, and key material must never appear in console output, error messages, or crash reports.

**Rationale**: Log files are often broadly accessible and may be transmitted to crash reporting services.

**Enforcement**: Server logs show `token.slice(0, 8) + "***"` only. App never logs SecureStore contents.

---

## Data Integrity Invariants

### INV-DATA-001: Profile Persistence Consistency

**Rule**: `SSHProfile` objects stored in AsyncStorage must always round-trip correctly. All fields must survive save → load.

**Rationale**: Silent field loss during JSON serialization corrupts connection profiles.

**Examples**:
- ✅ Valid: Save profile with all fields → load returns identical object
- ❌ Invalid: Save profile → load loses `port` field because it was `undefined`

**Enforcement**: `SettingsService.saveProfiles()` uses `JSON.stringify()`, `loadProfiles()` uses `JSON.parse()` with fallback to empty array.

### INV-DATA-002: Terminal Buffer Bounded

**Rule**: Terminal output buffer must never exceed 50KB. Status detector buffer must never exceed 2000 characters.

**Rationale**: Unbounded buffers cause memory pressure and eventual crashes on mobile devices.

**Enforcement**: Both truncate from the front when limit is exceeded. See `terminal/[id].tsx` and `ClaudeStatusDetector.ts`.

### INV-DATA-003: Server Config Split Storage

**Rule**: Non-sensitive server config (host, port, useTLS) goes in AsyncStorage. The auth token goes in SecureStore. They are never stored together.

**Rationale**: Defense in depth — even if AsyncStorage is compromised, the token remains protected.

**Enforcement**: `SettingsService.saveServerConfig()` explicitly splits the object.

---

## Connection Invariants

### INV-CONN-001: WebSocket Lifecycle Cleanup

**Rule**: When a WebSocket connection is closed (by user, error, or server), all timers (ping, reconnect) must be cleaned up immediately.

**Rationale**: Leaked timers cause phantom reconnects, duplicate connections, and stale state.

**Enforcement**: `WebSocketTerminal.cleanup()` is called on every close path.

### INV-CONN-002: Single Connection Per Profile

**Rule**: At most one active WebSocket connection may exist per profile ID at any time.

**Rationale**: Multiple connections to the same server spawn multiple PTY sessions, wasting resources and creating confusion.

**Enforcement**: `connect()` is guarded by connection state; `disconnect()` must be called before re-connecting.

### INV-CONN-003: Auto-Reconnect Bounded

**Rule**: Auto-reconnect uses a fixed 3-second delay (matching desktop behavior). It does not use exponential backoff or unlimited retries.

**Rationale**: Matches the desktop app's behavior. The user can manually reconnect from the UI if auto-reconnect fails.

**Enforcement**: `WebSocketTerminal.scheduleReconnect()` uses `setTimeout(3000)`.

---

## UX Invariants

### INV-UX-001: Status Dot Always Reflects Current State

**Rule**: The status dot color and animation must always match the current `ClaudeState`. There must be no stale or cached display.

**Rationale**: The status dot is the primary reason for this app. If it's wrong, the app is useless.

**Enforcement**: Status dot reads directly from state updated by `ClaudeStatusDetector`. Debounce is 150ms max.

### INV-UX-002: Theme Colors Match Desktop Exactly

**Rule**: All four themes (dark, light, purple, green) must use identical hex values as the desktop app.

**Rationale**: Visual consistency between desktop and mobile is expected.

**Enforcement**: `constants/themes.ts` values are copied verbatim from `renderer.js` THEMES object.

### INV-UX-003: Quick Keys Send Exact Control Sequences

**Rule**: Quick key buttons (^C, ^D, Tab, arrows) must send the exact byte sequences expected by the shell, not approximations.

**Rationale**: Wrong control sequences cause unexpected behavior (e.g., `^C` must send `\x03`, not the string "^C").

**Examples**:
- ✅ Valid: `^C → \x03`, `↑ → \x1b[A`
- ❌ Invalid: `^C → "^C"` (literal string)

**Enforcement**: `QuickKeys.tsx` KEYS array defines exact byte sequences.

---

## Cross-Component Contract Invariants

### INV-XCOMP-001: Bridge Message Format

**Rule**: All messages between the app and bridge server must be valid JSON matching the `BridgeMessage` type: `{ type, payload?, cols?, rows?, token? }`.

**Rationale**: Malformed messages cause silent failures or crashes on either end.

**Enforcement**: Both sides parse with try/catch and ignore malformed messages.

### INV-XCOMP-002: Status Detector Pattern Parity

**Rule**: The `ClaudeStatusDetector` must use the same regex patterns, priority order, and timeout values as the desktop `main.js` implementation.

**Rationale**: Status detection divergence means the mobile and desktop apps show different states for the same session.

**Enforcement**: Patterns are copied verbatim with comments referencing the desktop source lines.

---

## Invariant Change Log

| Date | Invariant ID | Change | Reason |
|------|-------------|--------|--------|
| 2026-03-28 | All | Initial creation | Project scaffold |

---

**Last Updated**: 2026-03-28
