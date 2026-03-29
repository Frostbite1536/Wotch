# Wotch Mobile

iOS companion app for [Wotch](https://github.com/Frostbite1536/Wotch) — monitor Claude Code sessions on your VPS from your iPhone.

## Features

- **Real-time status monitoring** — see Claude's state (idle, thinking, working, waiting, done, error) with animated status dots matching the desktop app
- **Live terminal output** — view what Claude is doing on your VPS
- **Interactive terminal** — type commands with quick-action keys (^C, Tab, arrows)
- **4 themes** — Dark, Light, Purple, Green (matching desktop exactly)
- **Connection profiles** — save multiple VPS connections
- **Secure authentication** — tokens stored in iOS Keychain via SecureStore
- **Auto-reconnect** — reconnects automatically when connection drops
- **Works on Windows** — develop on Windows PC, test on iPhone via Expo Go

## How It Works

```
iPhone (Expo Go)  ←──WebSocket──→  Bridge Server (VPS)  ←──PTY──→  Claude Code
```

The bridge server is a tiny Node.js process that runs on your VPS alongside Claude Code. It creates a WebSocket endpoint that your phone connects to, and pipes terminal data bidirectionally.

## Quick Start

### 1. On your Windows PC

```bash
cd WotchMobile
npm install
npx expo start
```

Scan the QR code with your iPhone camera (opens in Expo Go).

### 2. On your Ubuntu VPS

```bash
cd WotchMobile/server
npm install
WOTCH_TOKEN=pick-a-secret-token node index.js
```

The server prints its port (3456) and token on startup.

### 3. In the app

1. Tap **Add Connection** → enter your VPS host + username
2. Long-press the connection → **Server Setup** → enter bridge server host, port, and token
3. Tap the connection to open the terminal

## Project Structure

```
WotchMobile/
├── app/                          # Expo Router screens
│   ├── (tabs)/index.tsx          #   Connections list
│   ├── (tabs)/settings.tsx       #   Settings & themes
│   ├── terminal/[id].tsx         #   Terminal + status monitoring
│   └── profile/                  #   Profile editor + server setup
├── components/                   # Reusable UI components
│   ├── StatusDot.tsx             #   Animated status indicator
│   ├── TerminalOutput.tsx        #   Scrollable terminal display
│   ├── QuickKeys.tsx             #   ^C, Tab, arrow buttons
│   └── ProfileRow.tsx            #   Connection list row
├── services/                     # Business logic
│   ├── ClaudeStatusDetector.ts   #   6-state machine (ported from desktop)
│   ├── WebSocketTerminal.ts      #   WebSocket connection service
│   └── SettingsService.ts        #   AsyncStorage + SecureStore
├── constants/                    # Shared definitions
│   ├── themes.ts                 #   4 themes (from desktop)
│   ├── status.ts                 #   Status states, colors, priorities
│   └── types.ts                  #   TypeScript interfaces
├── server/                       # Bridge server (runs on VPS)
│   ├── index.js                  #   WebSocket + node-pty
│   └── package.json
├── docs/                         # Project documentation
│   ├── ARCHITECTURE.md
│   ├── INVARIANTS.md
│   ├── ROADMAP.md
│   ├── DECISIONS.md
│   └── THREAT_MODEL.md
├── prompts/
│   └── engineering.md            # AI development prompt
└── CHECKLIST.md                  # Pre-merge validation
```

## Claude Status Detection

The status detector is ported directly from the desktop app's `main.js`, using the same patterns and priority order:

| State | Color | Animation | Detected By |
|-------|-------|-----------|-------------|
| Idle | Green `#34d399` | None | Shell prompt characters |
| Thinking | Purple `#a78bfa` | Pulse 1.5s | Spinner chars, "thinking"/"analyzing" |
| Working | Blue `#60a5fa` | Pulse 2s | "Reading/Writing/Editing..." + file paths |
| Waiting | Yellow `#fbbf24` | Pulse 3s | Questions, "would you like", y/n prompts |
| Done | Green `#34d399` | None | ✓/✔, "Done"/"Complete"/"Success" |
| Error | Red `#f87171` | None | ✗/✘, "Error"/"Failed" |

## Bridge Server

The bridge server (`server/index.js`) is ~150 lines of Node.js:
- Token-based auth with constant-time comparison
- Spawns PTY sessions via `node-pty` (same library as desktop Wotch)
- Max 3 concurrent connections (configurable)
- Auto-cleanup on disconnect
- Graceful shutdown on SIGINT/SIGTERM

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WOTCH_TOKEN` | Random (printed) | Auth token |
| `WOTCH_PORT` | `3456` | WebSocket port |
| `WOTCH_SHELL` | `$SHELL` or `/bin/bash` | Shell to spawn |
| `WOTCH_MAX_CONNECTIONS` | `3` | Max simultaneous connections |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design, components, data flow
- [Invariants](docs/INVARIANTS.md) — non-negotiable rules
- [Roadmap](docs/ROADMAP.md) — phased development plan
- [Decisions](docs/DECISIONS.md) — architectural choices and trade-offs
- [Threat Model](docs/THREAT_MODEL.md) — security analysis
- [Checklist](CHECKLIST.md) — pre-merge validation

## License

Same as [Wotch desktop](https://github.com/Frostbite1536/Wotch).
