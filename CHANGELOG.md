# Changelog

All notable changes to Wotch are documented here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Per-tab AI profiles.** A profile pairs a launch command with the environment
  it runs under, so one tab can hold Claude Code while another runs Kimi K3,
  Qwen, or any other CLI. Configure in **Settings > AI Profiles**; open a tab
  with a specific profile from the command palette ("New Tab: \<profile\>").
  Split panes inherit their tab's profile.
- Env values support `$NAME` / `${NAME}` references expanded from Wotch's own
  environment at spawn time, keeping API keys out of `~/.wotch/settings.json`
  (new invariant **INV-SEC-020**). `$$` escapes a literal `$`; expansion is
  single-pass so a variable's value is never re-expanded.
- `POST /v1/tabs` accepts an optional `profileId`, rejecting unknown ids with
  422 rather than silently falling back to the default profile.
- `src/launch-profiles.js` plus 41 unit tests covering reference expansion,
  legacy migration, profile normalization, and API redaction.

### Changed
- The single "Launch command" setting is now the "Default" profile. Existing
  `launchCommand` values migrate automatically on first load; the legacy key is
  retained in settings for that migration.
- `GET /v1/settings` and `POST /v1/settings/reset` redact non-reference profile
  env values under secret-shaped key names; `PATCH /v1/settings` rejects
  `launchProfiles` outright (editable only from the settings UI).

### Fixed
- Corrected invalid Claude model IDs in the chat panel and agent runtime —
  `claude-opus-4-6-20250514` and `claude-sonnet-4-6-20250514` carried date
  suffixes those aliases do not take, which the API rejects. Refreshed the
  `MODEL_PRICING` table, whose Opus and Haiku rows were also stale.

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
