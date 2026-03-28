# Threat Model

## System Description

Wotch is an Electron desktop app that spawns real shell processes (via node-pty) in a floating overlay window. It has full access to the user's shell, filesystem, and any credentials available in the terminal environment. It also reads configuration from IDE installations (VS Code, JetBrains, etc.) and executes git commands on behalf of the user.

## Trust Boundaries

```
┌─────────────────────────────────────────────┐
│              User's Machine                 │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │         Electron Main Process         │  │
│  │  (full Node.js access, PTY, fs, git)  │  │
│  │                                       │  │
│  │  TRUST BOUNDARY ═══════════════════   │  │
│  │                                       │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │      Renderer Process           │  │  │
│  │  │  (sandboxed, no Node.js)        │  │  │
│  │  │  Only accesses main via IPC     │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  TRUST BOUNDARY ════════════════════════    │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  External: Terminal output, IDE       │  │
│  │  configs, git repos, network          │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

## Threat Actors

| Actor | Capability | Motivation |
|-------|-----------|------------|
| Malicious terminal output | Crafted ANSI sequences or text patterns from a command's stdout/stderr | Exploit terminal emulator bugs, inject UI content, trigger false status |
| Malicious project | A cloned repo with crafted file names, .git/config hooks, or symlinks | Execute code when Wotch auto-discovers or checkpoints the project |
| Local attacker | Another process on the same machine | Read settings file, inject into IPC, tamper with PTY |
| Supply chain | Compromised npm dependency | Arbitrary code execution in main process |

## STRIDE Analysis

### Spoofing

| Threat | Risk | Mitigation |
|--------|------|------------|
| Malicious terminal output spoofs Claude Code status (e.g., prints "Done" to trigger green dot) | Low | Status detection is best-effort UX, not a security control. False status has no security impact. |
| Malicious .gitconfig or hook spoofs git status | Medium | Wotch runs `git status` and `git commit` — a malicious post-commit hook could execute arbitrary code. **Mitigation:** Document that Wotch trusts the user's git configuration, same as any terminal. |

### Tampering

| Threat | Risk | Mitigation |
|--------|------|------------|
| Settings file tampered with to change shell path | Medium | A modified `defaultShell` could point to a malicious binary. **Mitigation:** Settings file lives in user home with user-only permissions. Same trust model as `.bashrc`. |
| PTY data injection via IPC | Low | Requires local code execution to send IPC messages. Context isolation prevents renderer from sending arbitrary IPC. |

### Repudiation

Not applicable — Wotch is a single-user desktop app with no authentication or audit log requirements.

### Information Disclosure

| Threat | Risk | Mitigation |
|--------|------|------------|
| Terminal output visible to screen capture / screen sharing | Medium | Wotch is always-on-top, so terminal content (potentially containing secrets) is visible during screen shares. **Mitigation:** Users should collapse Wotch when sharing screens. Consider adding a "screen share mode" in the future. |
| Settings file readable by other local users | Low | Standard file permissions. `~/.wotch/settings.json` contains no secrets (just UI preferences and shell path). |
| IDE config scanning reads potentially sensitive paths | Low | Project detection reads VS Code's `storage.json` and JetBrains' `recentProjects.xml` — these contain project paths but no credentials. |

### Denial of Service

| Threat | Risk | Mitigation |
|--------|------|------------|
| Runaway PTY process consumes CPU/memory | Medium | A terminal command that produces massive output could strain xterm.js rendering. **Mitigation:** xterm.js has built-in scrollback limits. PTY processes are killed on tab close. |
| Mouse polling loop blocks main process | Low | Polling is lightweight (`getCursorScreenPoint` is fast). Interval is configurable. Auto-disabled on Wayland if cursor is unavailable. |

### Elevation of Privilege

| Threat | Risk | Mitigation |
|--------|------|------------|
| Renderer escapes sandbox to access Node.js | High (if violated) | **Mitigation:** `contextIsolation: true`, `nodeIntegration: false`. This is INV-SEC-001. The preload bridge only exposes specific channels. |
| Malicious npm dependency in main process | High | Main process has full system access. **Mitigation:** Minimal dependency tree (4 runtime deps). Pin versions. Review updates. Use `npm audit`. |

## Attack Surface

### External Inputs
- **Terminal output** (ANSI sequences, arbitrary text from commands)
- **IDE configuration files** (JSON/XML read from known paths)
- **Git repository state** (branch names, file paths, hook scripts)
- **User settings file** (~/.wotch/settings.json)
- **Keyboard input** (global hotkey registration)
- **Mouse position** (screen.getCursorScreenPoint)

### Internal Inputs
- **IPC messages** between renderer and main (constrained by preload bridge)

## Risk Assessment

| Risk | Likelihood | Impact | Priority |
|------|-----------|--------|----------|
| npm supply chain attack | Low | Critical | High — keep deps minimal, audit regularly |
| Context isolation bypass (Electron CVE) | Low | Critical | High — keep Electron updated |
| Git hook execution during checkpoint | Low | High | Medium — document trust model |
| Terminal output exploiting xterm.js | Very Low | Medium | Low — xterm.js is well-maintained |
| Settings file tampering | Very Low | Medium | Low — standard file permission model |

## Security Controls

### Preventive
- Context isolation and disabled nodeIntegration (INV-SEC-001)
- No remote content loading (INV-SEC-002)
- Scoped preload bridge (INV-SEC-003)
- Fixed git command templates, no shell interpolation of user input (INV-SEC-004)
- Minimal runtime dependency count (4 packages)

### Detective
- `npm audit` in CI pipeline
- Dependabot alerts enabled on GitHub

### Corrective
- Git checkpoints allow rollback of unwanted changes
- Settings reset to defaults if corrupted (INV-DATA-001)

## Open Issues

1. **No code signing yet** — unsigned builds will trigger OS warnings (Windows SmartScreen, macOS Gatekeeper). Phase 5 goal.
2. **No screen share protection** — terminal content is visible during screen shares. Consider a blur/hide mode.
3. **Git hooks are trusted** — Wotch executes git commands that may trigger hooks in the repo. This matches normal terminal behavior but is worth documenting.
