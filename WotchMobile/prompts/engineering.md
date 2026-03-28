# Engineering Prompt — Wotch Mobile

You are working on **Wotch Mobile**, an Expo/React Native companion app for the Wotch desktop terminal overlay. It connects to a VPS via WebSocket to monitor Claude Code sessions.

## Tech Stack

- **Runtime**: Expo SDK 52, React Native 0.76, TypeScript
- **Navigation**: Expo Router (file-based, in `app/` directory)
- **State**: React Context (in `app/_layout.tsx`), no external state library
- **Persistence**: AsyncStorage (profiles, settings), SecureStore (auth tokens)
- **Animations**: react-native-reanimated (status dot pulse)
- **Bridge Server**: Node.js, ws, node-pty (runs on Ubuntu VPS)

## Architecture

- `app/_layout.tsx` — Root layout, theme context, global state provider
- `app/(tabs)/` — Tab screens (connections list, settings)
- `app/terminal/[id].tsx` — Terminal screen per connection
- `app/profile/` — Profile editor and server setup modals
- `services/ClaudeStatusDetector.ts` — 6-state machine ported from desktop main.js
- `services/WebSocketTerminal.ts` — WebSocket connection to bridge server
- `services/SettingsService.ts` — Persistence layer
- `constants/themes.ts` — 4 themes ported from desktop renderer.js
- `constants/status.ts` — Status states, colors, priorities
- `server/index.js` — VPS bridge server (WebSocket ↔ node-pty)

## Before Making Changes

1. Read [docs/INVARIANTS.md](../docs/INVARIANTS.md) — non-negotiable rules
2. Read [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) — system design
3. Check [CHECKLIST.md](../CHECKLIST.md) — pre-merge validation

## Code Style

- TypeScript strict mode
- Functional components with hooks (no class components)
- Named exports (no default exports except Expo Router screens)
- `const` over `let`, never `var`
- Explicit return types on service functions
- Monospace font (`fontFamily: "monospace"`) for terminal-related text

## Common Pitfalls

- **SecureStore vs AsyncStorage**: Tokens go in SecureStore, everything else in AsyncStorage. Never mix them.
- **WebSocket in Expo Go**: Works natively. Do NOT import `ws` in the app — it's Node-only (server only).
- **Reanimated**: Must be last plugin in `babel.config.js`. Animations must use shared values, not state.
- **Theme colors**: Must match desktop exactly. Check `constants/themes.ts` against desktop `renderer.js`.
- **Status patterns**: Must match desktop exactly. Check `ClaudeStatusDetector.ts` against desktop `main.js`.
- **Buffer limits**: Terminal output max 50KB, status buffer max 2000 chars. Always truncate from front.

## Security Rules (Non-Negotiable)

- Never store auth tokens in AsyncStorage
- Never log tokens, passwords, or key material
- Bridge server must use `crypto.timingSafeEqual()` for token comparison
- Bridge server must timeout unauthenticated connections in 10s
- No `eval()`, `Function()`, or dynamic code execution
