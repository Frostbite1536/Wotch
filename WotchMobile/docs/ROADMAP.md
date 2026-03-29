# Project Roadmap — Wotch Mobile

## Overview

**Project**: Wotch Mobile — iOS companion app for Wotch desktop

**Vision**: Monitor and interact with Claude Code sessions on a remote VPS from an iPhone, with at-a-glance status via home screen widgets.

**Current Phase**: Phase 1

---

## Phase 1: Core App Scaffold

**Status**: ✅ Complete

**Goal**: Buildable Expo project with all screens, navigation, services, and bridge server.

### Included Features

- [x] Expo Router with tab navigation (Connections, Settings)
- [x] ClaudeStatusDetector ported from desktop main.js
- [x] All 4 themes ported from desktop renderer.js
- [x] StatusDot with Reanimated pulse animations
- [x] Terminal screen with text output, quick keys, input bar
- [x] Profile editor (add/edit VPS connections)
- [x] Server setup screen (bridge server URL + token config)
- [x] Settings persistence (AsyncStorage + SecureStore)
- [x] WebSocket terminal service with auth and reconnect
- [x] VPS bridge server (WebSocket + node-pty + token auth)

### Explicit Exclusions

- Native iOS widget (requires EAS Build)
- ANSI color rendering in terminal output
- SSH direct from phone (uses WebSocket bridge instead)
- Android-specific testing

### Success Criteria

- [x] Project structure matches safe-vibe-coding guide
- [x] All docs created (ARCHITECTURE, INVARIANTS, ROADMAP, DECISIONS, THREAT_MODEL, CHECKLIST)
- [x] Code compiles and runs in Expo Go
- [x] Bridge server starts and accepts connections

---

## Phase 2: End-to-End Connection

**Status**: 📋 Planned

**Goal**: Working phone-to-VPS terminal connection with live Claude status.

### Included Features

- [ ] Install bridge server on VPS, verify WebSocket connectivity
- [ ] Test full data path: phone → WebSocket → bridge → PTY → shell
- [ ] Verify ClaudeStatusDetector produces correct states from live Claude output
- [ ] Add connection state persistence (reconnect to last server on app launch)
- [ ] Add haptic feedback on status transitions (thinking → done)
- [ ] Add notification support (alert when Claude finishes while app is backgrounded)

### Explicit Exclusions

- Widget extension
- TLS/certificate setup
- Multiple simultaneous connections

### Success Criteria

- [ ] Can type commands and see output from VPS shell
- [ ] Status dot changes correctly when Claude Code runs
- [ ] Reconnects automatically when connection drops

### Dependencies

- Phase 1 complete
- Ubuntu VPS with Node.js and Claude Code installed

---

## Phase 3: Polish & Security Hardening

**Status**: 📋 Planned

**Goal**: Production-quality security and UX.

### Included Features

- [ ] TLS support for WebSocket (wss://) with Let's Encrypt
- [ ] Bridge server systemd service file for auto-start
- [ ] ANSI color rendering in terminal output (basic color support)
- [ ] Terminal search (Ctrl+F equivalent)
- [ ] Connection health indicator (latency, last ping time)
- [ ] Clipboard support (copy terminal output)
- [ ] Landscape orientation support for terminal

### Explicit Exclusions

- iOS widget (Phase 4)
- Multi-tab terminal sessions

### Success Criteria

- [ ] All connections use TLS
- [ ] Bridge server survives VPS reboots
- [ ] Terminal output shows colors

---

## Phase 4: iOS Widget

**Status**: 📋 Planned

**Goal**: Home screen and lock screen widgets showing Claude status at a glance.

### Included Features

- [ ] EAS Build setup (cloud build, no Mac needed)
- [ ] Native iOS widget extension (SwiftUI + WidgetKit)
- [ ] Small widget: status dot + state label
- [ ] Medium widget: dot + state + description + connection name
- [ ] Lock screen widgets (circular, inline, rectangular)
- [ ] App Group shared data between app and widget
- [ ] Background fetch to update widget status periodically

### Explicit Exclusions

- Android widget
- Interactive widget actions

### Success Criteria

- [ ] Widget shows correct Claude status on home screen
- [ ] Widget updates within 5 minutes of status change
- [ ] Works on iOS 17+

### Dependencies

- Phase 2 complete (working connection)
- Apple Developer account for TestFlight distribution

---

## Future Considerations (Beyond Current Roadmap)

- **Multi-tab sessions**: Multiple terminal tabs like the desktop app
- **Android support**: The Expo app already runs on Android; needs testing
- **Direct SSH**: Replace bridge server with in-app SSH (requires custom dev client)
- **Git checkpoint UI**: Trigger and view git checkpoints from phone
- **Push notifications**: Server-sent push when Claude finishes (via APNs)
- **Shared sessions**: View the same terminal session from desktop and mobile simultaneously

---

## Decision Log

| Date | Decision | Rationale | Impact |
|------|----------|-----------|--------|
| 2026-03-28 | Use Expo/React Native instead of Swift | Developer has Windows PC, no Mac available | All phases |
| 2026-03-28 | WebSocket bridge instead of direct SSH | Expo Go compatibility, no native modules needed | Phase 1-3 |
| 2026-03-28 | Text-based terminal instead of xterm.js WebView | Simpler, faster, sufficient for status monitoring | Phase 1-2 |
| 2026-03-28 | Status detection on phone, not VPS | Matches desktop architecture, keeps bridge server stateless | Phase 1+ |

---

**Last Updated**: 2026-03-28
**Next Review**: End of Phase 2
