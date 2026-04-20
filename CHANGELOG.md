# Changelog

All notable changes to Wotch are documented here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-04-20

### Added
- **Ask StudyBuddy** command palette entry (`Ctrl+Shift+P` → "Ask StudyBuddy: …").
  Selecting it switches the palette into an ask prompt; pressing Enter sends the
  question to StudyBuddy's local `/ask` endpoint along with the last 4 KB of the
  active tab's terminal buffer as context. Pairs with **StudyBuddy v0.3**.
- Settings section "StudyBuddy" with a toggle to enable/disable the integration
  (default on) and a live status line indicating whether StudyBuddy is reachable.
- `src/studybuddy-integration.js` — token + port reader (platform-aware config
  dir on Linux / macOS / Windows) and `/ask` HTTP client with Bearer auth,
  configurable timeout, and mapped error codes (`ENOCONFIG`, `EAUTH`,
  `ECONNREFUSED`, `ENET`).
- Unit tests covering the `/ask` client: success, 401, `ECONNREFUSED`, timeout,
  4 KB question cap, 4 KB context tailing, and missing-config handling. Run
  with `npm test`.

### Notes
- The "Ask StudyBuddy" entry silently hides itself when the integration is
  disabled in Settings or StudyBuddy's config files (`extension-token`,
  `extension-port`) are absent.
- No new runtime dependencies — the `/ask` client uses Node's built-in `http`.

## [1.0.0] — prior

Initial public release. See git history for details.

[1.1.0]: https://github.com/Frostbite1536/Wotch/releases/tag/v1.1.0
