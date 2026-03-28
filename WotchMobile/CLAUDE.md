# CLAUDE.md — Wotch Mobile

## Project Overview

Wotch Mobile is an Expo/React Native iOS companion app for the [Wotch](../README.md) desktop terminal overlay. It connects to a VPS via WebSocket to monitor and interact with Claude Code sessions remotely.

**Developer setup**: Windows 10 PC + iPhone + Ubuntu VPS running Claude Code.

## Tech Stack

- **App**: Expo SDK 52, React Native 0.76, TypeScript strict mode
- **Navigation**: Expo Router (file-based routing in `app/`)
- **State**: React Context in `app/_layout.tsx` — no Redux, no Zustand
- **Persistence**: AsyncStorage (profiles, settings), SecureStore (auth tokens)
- **Animations**: react-native-reanimated (status dot pulse)
- **Bridge Server**: Node.js, `ws`, `node-pty` (runs on Ubuntu VPS, not on the phone)

## Architecture

```
Phone (Expo Go) ←──WebSocket──→ Bridge Server (VPS) ←──node-pty──→ shell/claude
```

Key files:
- `app/_layout.tsx` — Root layout, theme context, global state
- `app/(tabs)/` — Tab screens (connections list, settings)
- `app/terminal/[id].tsx` — Terminal screen with live output + status
- `services/ClaudeStatusDetector.ts` — 6-state machine (ported from desktop `main.js`)
- `services/WebSocketTerminal.ts` — WebSocket connection to bridge server
- `services/SettingsService.ts` — AsyncStorage + SecureStore persistence
- `constants/themes.ts` — 4 themes (verbatim from desktop `renderer.js`)
- `constants/status.ts` — Status states, colors, priorities
- `server/index.js` — VPS bridge server

## Before Making Any Changes

1. Read `docs/INVARIANTS.md` — the non-negotiable rules
2. Read `docs/ARCHITECTURE.md` — system design and data flow
3. Review `CHECKLIST.md` before merging

## Code Conventions

- TypeScript strict mode, no `any` unless unavoidable
- Functional components with hooks — no class components
- Named exports everywhere except Expo Router screen defaults
- `const` over `let`, never `var`
- Explicit return types on all service/utility functions
- `fontFamily: "monospace"` for all terminal-related text
- Components under ~300 lines, services under ~500 lines

## Non-Negotiable Rules

These are the most critical invariants. Violating any of these is always a bug.

### Security
- **Auth tokens go in SecureStore, never AsyncStorage** (INV-SEC-001)
- **Bridge server uses `crypto.timingSafeEqual()` for token comparison** (INV-SEC-002)
- **No tokens, passwords, or secrets in logs or error messages** (INV-SEC-004)
- **No `eval()`, `Function()`, or dynamic code execution**

### Data Integrity
- **Terminal output buffer max 50KB, status buffer max 2000 chars** (INV-DATA-002) — always truncate from front
- **Server config splits storage**: host/port in AsyncStorage, token in SecureStore (INV-DATA-003)

### Parity with Desktop
- **Theme hex values must match desktop `renderer.js` exactly** (INV-UX-002)
- **Status detector patterns must match desktop `main.js` exactly** (INV-XCOMP-002) — same regexes, same priority order, same timeouts
- **Quick key byte sequences must be exact** (INV-UX-003) — `^C` is `\x03`, not the string `"^C"`

### Connection
- **One WebSocket connection per profile at any time** (INV-CONN-002)
- **All timers cleaned up on disconnect** (INV-CONN-001)

## Common Pitfalls

- **`ws` is server-only**: Do NOT import the `ws` package in app code. React Native has WebSocket built in.
- **Reanimated plugin order**: Must be the last plugin in `babel.config.js`.
- **Reanimated animations**: Use shared values (`useSharedValue`), not React state.
- **SecureStore limitations**: Values must be strings, max 2048 bytes. Always `JSON.stringify` if needed.
- **Expo Go constraints**: No native modules. Everything must work without `npx expo prebuild`. The WebSocket bridge architecture exists specifically for this reason.

## Bridge Message Protocol

All messages between app and server are JSON with this shape:
```typescript
{ type: "auth" | "data" | "resize" | "ping" | "pong" | "error" | "connected" | "closed",
  payload?: string, cols?: number, rows?: number, token?: string }
```
Both sides must handle malformed messages gracefully (try/catch, ignore).

## Testing Changes

- **App**: `npx expo start` → scan QR with Expo Go on iPhone
- **Bridge server**: `WOTCH_TOKEN=test node server/index.js` → verify with `wscat -c ws://localhost:3456`
- **Status detector**: Feed sample terminal output strings through `ClaudeStatusDetector.feed()` and verify state transitions

## Project Documentation

- `docs/ARCHITECTURE.md` — system design, components, data flow diagrams
- `docs/INVARIANTS.md` — 12 non-negotiable rules with IDs, rationale, enforcement
- `docs/ROADMAP.md` — 4-phase plan (scaffold → e2e → polish → widget)
- `docs/DECISIONS.md` — architectural choices with context and trade-offs
- `docs/THREAT_MODEL.md` — STRIDE analysis, open security issues
- `CHECKLIST.md` — pre-merge validation checklist
- `prompts/engineering.md` — AI development prompt
