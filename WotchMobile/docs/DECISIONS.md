# Architectural Decisions — Wotch Mobile

## 2026-03-28: Expo/React Native Over Native Swift

**Decision**: Build the iOS app using Expo and React Native instead of native Swift/SwiftUI.

**Context**: The developer uses a Windows 10 PC and an iPhone. Swift/Xcode requires a Mac to compile. An initial Swift scaffold was built but could not be tested or deployed.

**Trade-off**: Lose native performance and seamless WidgetKit integration, but gain:
- Development on Windows
- Instant testing via Expo Go on iPhone (no build step)
- Cloud builds via EAS when ready for production
- JavaScript codebase matches the desktop Electron app, enabling direct code port

---

## 2026-03-28: WebSocket Bridge Server Over Direct SSH

**Decision**: Run a lightweight Node.js bridge server on the VPS that translates WebSocket to PTY, instead of implementing SSH directly from the phone.

**Context**: SSH from React Native requires native TCP socket modules (`react-native-tcp-socket`) plus an SSH library, which breaks Expo Go compatibility. The VPS already has Node.js installed for the desktop app.

**Trade-off**: Requires installing and running the bridge server on the VPS (one extra process). But:
- Works in Expo Go immediately (WebSocket is built into React Native)
- Bridge server is ~150 lines and uses the same `node-pty` as the desktop app
- Simpler than managing SSH key exchange, host verification, and encrypted channels on mobile
- Bridge server is stateless (no sessions stored) — easy to restart

---

## 2026-03-28: Status Detection on Phone, Not VPS

**Decision**: The `ClaudeStatusDetector` runs on the phone, analyzing terminal data as it arrives over WebSocket.

**Context**: Could alternatively run detection on the VPS and send only status updates to the phone (less data, less phone CPU). Or could run on both.

**Trade-off**: More data flows to the phone (full terminal output, not just status), but:
- Matches the desktop app architecture exactly (detection runs in the UI process)
- Keeps the bridge server dead simple (no Claude-specific logic)
- Phone gets full terminal output for display, not just status
- Status patterns can be updated by updating the app, no VPS changes needed

---

## 2026-03-28: Text-Based Terminal Instead of xterm.js WebView

**Decision**: Use a plain `ScrollView` + `Text` to display terminal output, stripping ANSI codes, instead of embedding xterm.js in a WebView.

**Context**: The desktop app uses xterm.js for full terminal emulation with colors, cursor positioning, and scrollback. This could be replicated in a WebView on mobile.

**Trade-off**: No color rendering or cursor positioning. But:
- Much simpler implementation (no WebView bridge complexity)
- Faster rendering and lower memory usage
- Sufficient for the primary use case (monitoring Claude status)
- Can upgrade to WebView + xterm.js in Phase 3 if needed

---

## 2026-03-28: Token Auth Over SSH Key Auth for Bridge

**Decision**: The bridge server uses a shared secret token for authentication, not SSH keys or certificates.

**Context**: Need to authenticate the phone to the bridge server. Options: shared token, SSH keys, mutual TLS, OAuth.

**Trade-off**: Simpler than certificate management. Token stored in SecureStore on phone (hardware-encrypted). Server uses constant-time comparison. TLS planned for Phase 3 to encrypt the WebSocket transport.

---

## 2026-03-28: Replace Swift Scaffold with Expo

**Decision**: Deleted the entire Swift/Xcode scaffold (31 files, 3,417 lines) and replaced with Expo React Native project.

**Context**: The Swift scaffold was architecturally sound but completely unusable without a Mac for compilation. The developer's setup is Windows + iPhone.

**Trade-off**: Lost the native WidgetKit implementation (will be added back via EAS Build in Phase 4). Gained a project that can be developed and tested today.

---

**Last Updated**: 2026-03-28
