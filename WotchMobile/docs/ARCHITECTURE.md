# Architecture — Wotch Mobile

## Overview

**Purpose**: iOS companion app for the Wotch desktop terminal overlay. Monitors Claude Code sessions running on a remote Ubuntu VPS in real-time from an iPhone.

**Type**: Mobile app (Expo / React Native) + VPS bridge server (Node.js)

**Target Users**: Developers running Claude Code on a VPS who want to monitor session status from their phone.

**Runtime Environment**: iPhone (Expo Go or standalone build) + Ubuntu VPS (Node.js server)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────┐
│                   iPhone (Expo Go)                   │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Terminal     │  │ Claude Status│  │ Settings   │ │
│  │ View        │  │ Detector     │  │ Service    │ │
│  │ (text-based)│  │ (6-state)    │  │ (AsyncStore│ │
│  └──────┬──────┘  └──────┬───────┘  │ +SecureStr)│ │
│         │                │           └────────────┘ │
│         ▼                ▼                           │
│  ┌─────────────────────────────────────────────────┐│
│  │         WebSocket Terminal Service               ││
│  │  (auth → send/receive → keepalive → reconnect)  ││
│  └──────────────────┬──────────────────────────────┘│
└─────────────────────┼───────────────────────────────┘
                      │ WebSocket (ws:// or wss://)
                      │
┌─────────────────────┼───────────────────────────────┐
│          Ubuntu VPS │                                │
���  ┌──────────────────┴──────────────────────────────┐│
│  │           Bridge Server (Node.js)                ││
│  │  (token auth → spawn PTY → pipe data)            ││
│  └──────────────────┬──────────────────────────────┘│
│                     │ node-pty                        │
│                     ▼                                │
│  ┌─────────────────────────────────────────────────┐│
│  │             bash / zsh shell                     ││
│  │                    ↕                             ││
│  │              claude (Claude Code CLI)            ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

---

## Components

| Component | File(s) | Responsibility |
|-----------|---------|----------------|
| **App Shell** | `app/_layout.tsx` | Root layout, theme context, navigation, global state |
| **Connections Tab** | `app/(tabs)/index.tsx` | Lists VPS profiles, shows aggregate status |
| **Settings Tab** | `app/(tabs)/settings.tsx` | Theme picker, bridge server setup guide |
| **Terminal Screen** | `app/terminal/[id].tsx` | Live terminal output, status bar, input |
| **Profile Editor** | `app/profile/editor.tsx` | Create/edit VPS connection profiles |
| **Server Setup** | `app/profile/server-setup.tsx` | Configure bridge server URL + auth token |
| **ClaudeStatusDetector** | `services/ClaudeStatusDetector.ts` | 6-state machine, ANSI stripping, pattern matching |
| **WebSocketTerminal** | `services/WebSocketTerminal.ts` | WebSocket connection, auth, reconnect |
| **SettingsService** | `services/SettingsService.ts` | AsyncStorage + SecureStore persistence |
| **StatusDot** | `components/StatusDot.tsx` | Animated status indicator (Reanimated) |
| **TerminalOutput** | `components/TerminalOutput.tsx` | Scrollable terminal text display |
| **QuickKeys** | `components/QuickKeys.tsx` | ^C, Tab, arrow key buttons |
| **ProfileRow** | `components/ProfileRow.tsx` | Connection list row with status |
| **Bridge Server** | `server/index.js` | WebSocket + node-pty on VPS |

---

## Data Flow

### Terminal Data Path

```
Claude Code → shell → node-pty → Bridge Server → WebSocket → App
                                                       │
                                                       ├→ TerminalOutput (display)
                                                       └→ ClaudeStatusDetector (analyze)
                                                              │
                                                              └→ StatusDot (animate)
```

### User Input Path

```
TextInput/QuickKeys → WebSocketTerminal.write() → WebSocket → Bridge Server → node-pty → shell
```

### Authentication Flow

```
1. App reads token from SecureStore (encrypted on device)
2. App opens WebSocket to bridge server
3. App sends { type: "auth", token: "..." } within 10s
4. Server validates token (constant-time comparison)
5. Server spawns PTY, begins data relay
6. App receives { type: "connected" }
```

---

## External Dependencies

| Dependency | Purpose | Failure Mode |
|------------|---------|--------------|
| `expo` | App framework, managed workflow | App won't build |
| `expo-router` | File-based navigation | Screens won't route |
| `expo-secure-store` | Encrypted token storage | Tokens stored in plain AsyncStorage (degraded) |
| `react-native-reanimated` | Status dot pulse animations | Dots render without animation |
| `@react-native-async-storage/async-storage` | Profile/settings persistence | Settings lost on reinstall |
| `ws` (server) | WebSocket server | Bridge server won't start |
| `node-pty` (server) | PTY spawning on VPS | No terminal sessions |

---

## Key Design Decisions

### 1. WebSocket Bridge Instead of Direct SSH

**Context**: React Native doesn't have native TCP socket support in Expo Go. SSH libraries require native modules.

**Decision**: Run a lightweight bridge server on the VPS that translates WebSocket ↔ PTY.

**Trade-offs**: Requires installing the bridge server on VPS, but enables Expo Go development without native builds.

### 2. Status Detection on the Phone

**Context**: Could detect Claude status on the VPS or the phone.

**Decision**: Detect on the phone, same as the desktop app.

**Trade-offs**: Slightly more phone CPU usage, but matches the desktop architecture and keeps the bridge server simple/stateless.

### 3. Text-Based Terminal (Not xterm.js WebView)

**Context**: Could embed xterm.js in a WebView for full terminal emulation.

**Decision**: Use a plain ScrollView + Text for now.

**Trade-offs**: No ANSI color rendering, but much simpler, faster, and sufficient for monitoring Claude status. Can upgrade later.

---

## Security Considerations

- Auth tokens stored in Expo SecureStore (hardware-backed encryption on iOS)
- Bridge server uses constant-time token comparison (prevents timing attacks)
- 10-second auth timeout prevents connection exhaustion
- Max connection limit on bridge server
- No credentials stored in AsyncStorage or transmitted after initial auth
- Bridge server binds to 0.0.0.0 by default — firewall configuration recommended

---

## Performance Considerations

- Terminal output buffer capped at 50KB (trimmed from front)
- Status detector rolling buffer capped at 2000 chars
- Status broadcasts debounced at 150ms
- WebSocket keepalive pings every 30s
- Auto-reconnect with 3s delay on disconnect

---

## Deployment

**Phone App**: `npx expo start` → scan QR with Expo Go on iPhone

**Bridge Server**: `WOTCH_TOKEN=secret node server/index.js` on Ubuntu VPS

**Production Build**: `npx eas-cli build --platform ios` (cloud build, no Mac needed)

---

**Last Updated**: 2026-03-28
