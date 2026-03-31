# Wotch API & SDK Roadmap — Phase 2

## Vision

Phase 1 of Wotch delivered a complete floating terminal experience: hover-to-reveal, Claude Code status detection, git checkpoints, themes, multi-monitor support, SSH, and cross-platform distribution. Phase 2 extends Wotch from a terminal overlay into a programmable platform — exposing its capabilities to external tools, integrating directly with the Claude API, enabling third-party extensions, and embedding autonomous AI agents.

---

## Plan 0: Claude Code Deep Integration (NEW — Prerequisite)

**Directory:** `00-claude-code-deep-integration/`

Replace Wotch's heuristic regex-based Claude Code detection with structured, first-party integration using two channels: **hooks** (24 lifecycle events delivered via `type: http` hooks configured in `~/.claude/settings.json`) and **MCP** (Wotch as a tool server registered in `~/.claude.json`). This provides the reliable data foundation that all subsequent plans build upon.

**Key deliverables:**
- Hook receiver (HTTP server) for structured Claude Code lifecycle events (24 event types)
- MCP server exposing Wotch tools (checkpoints, git status, notifications) to Claude Code
- Enhanced multi-source status detector with hook priority and regex fallback
- Auto-configuration of `~/.claude/settings.json` (hooks) and `~/.claude.json` (MCP)
- IDE Bridge adapter: WebSocket MCP server with lockfile discovery at `~/.claude/ide/`
- Three-channel architecture: hooks (events) + MCP (tools) + bridge (bidirectional)
- Settings UI for per-channel enable/disable and health monitoring

---

## Plan 1: Wotch Local API

**Directory:** `01-local-api/`

Expose Wotch's internal capabilities through a localhost HTTP + WebSocket API. External tools (VS Code extensions, shell scripts, dashboards) can query Claude status, trigger checkpoints, manage tabs, and subscribe to real-time events — all without touching the UI.

**Key deliverables:**
- Localhost HTTP server with bearer token auth (`~/.wotch/api-token`)
- REST endpoints for status, tabs, checkpoints, projects, settings
- WebSocket event stream for real-time status changes, terminal output, git updates
- DNS rebinding protection via Host header validation
- API versioning (`/v1/`)

---

## Plan 2: Direct Claude API Integration

**Directory:** `02-claude-api-integration/`

Connect directly to the Anthropic API from within Wotch, adding a chat panel alongside the terminal. Wotch's existing context awareness (project directory, git status, terminal output, checkpoint diffs) feeds into API calls automatically, enabling quick questions and context-aware assistance without leaving the app.

**Key deliverables:**
- API key management UI (encrypted storage in `~/.wotch/credentials`)
- Chat panel in the renderer with streaming response display
- Context injection (terminal buffer, git diff, project info) into API calls
- Token usage tracking and cost estimation display
- Model selector (Opus, Sonnet, Haiku)
- Conversation history persistence per project

---

## Plan 3: Wotch Plugin/Extension SDK

**Directory:** `03-plugin-sdk/`

A plugin system that lets third-party developers extend Wotch with new command palette actions, custom status detectors, panel views, and service integrations. Plugins run in sandboxed environments with declared permissions.

**Key deliverables:**
- Plugin manifest format (`manifest.json`) and lifecycle hooks
- Renderer-side plugin API (`wotch.commands`, `wotch.status`, `wotch.ui`)
- Main-process plugin host with permission-gated system access
- `~/.wotch/plugins/` directory-based distribution
- Plugin settings registration and UI integration
- Developer tools: TypeScript types, hot-reload dev server, test harness

---

## Plan 4: Claude Agent SDK Integration

**Directory:** `04-agent-sdk-integration/`

Embed the Claude Agent SDK to run custom AI agents natively inside Wotch. Agents observe terminal output, react to build failures and test results, and execute multi-step tasks with configurable autonomy levels.

**Key deliverables:**
- Agent SDK embedded in main process
- Agent definition format (tools, triggers, approval modes)
- Per-project agent configurations (`.wotch/agents/`)
- Agent activity panel with tool-specific rich rendering (diffs, search results, shell output)
- Graduated trust model (suggest-only → ask-first → auto-execute)
- Sub-agent spawning via `Agent.spawn` tool with depth limits and cascading stop
- Agent tree visualization showing parent-child hierarchies with per-node controls
- Built-in agents: code reviewer, test writer, error fixer, deploy assistant

---

## Implementation Order

The five plans have natural dependencies. Plan 0 is the new prerequisite that provides structured Claude Code communication for all subsequent plans:

```
Plan 0 (Deep Integration) ─────────────────────────────────┐
   ↓                                                        │
   ├── hooks → structured status for Plan 1 API             │
   ├── MCP → tool access for Plans 2, 4                     │
   └── bridge → bidirectional IDE integration               │
                                                            │
Plan 1 (Local API)  ── exposes hook-sourced data ──────────┤
   ↓                                                        │
Plan 2 (Claude API) ── shares context via MCP ─────────────┤
   ↓                                                        │
Plan 3 (Plugin SDK) ── plugins subscribe to hook events ───┤
   ↓                                                        │
Plan 4 (Agent SDK)  ── coordinates via bridge + MCP ───────┘
```

**Recommended sequence:** 0 → 1 → 2 → 3 → 4. Plan 0 is the highest priority — it replaces regex heuristics with structured data, benefiting every subsequent plan. Each plan is self-contained and can be merged independently, but later plans benefit from earlier infrastructure.

---

## Constraints

All plans must respect the existing invariants in `docs/INVARIANTS.md`:
- **INV-SEC-001**: Context isolation — no Node.js in the renderer
- **INV-SEC-002**: No remote content loaded in the main window
- **INV-SEC-003**: Preload bridge scoping — only named IPC channels
- **INV-SEC-004**: No command injection in shell operations
- **INV-DATA-001**: Settings file resilience — graceful fallback on corruption
- **INV-UX-001/002**: Always-on-top and pill visibility must not be broken

New invariants will be introduced per plan (API auth, credential encryption, plugin sandboxing, agent trust boundaries).
