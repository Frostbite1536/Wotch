# Pre-Merge Checklist — Wotch Mobile

Use this checklist before merging any changes. Reference [docs/INVARIANTS.md](docs/INVARIANTS.md) for non-negotiable rules.

---

## Security

- [ ] Auth tokens are never stored in AsyncStorage (must use SecureStore) — **INV-SEC-001**
- [ ] Bridge server token comparison uses `crypto.timingSafeEqual()` — **INV-SEC-002**
- [ ] No tokens, passwords, or key material in logs or error messages — **INV-SEC-004**
- [ ] No hardcoded secrets in source code
- [ ] No `console.log()` of sensitive data in production paths

## Invariants

- [ ] All invariants in [docs/INVARIANTS.md](docs/INVARIANTS.md) still hold
- [ ] Status detector patterns match desktop main.js — **INV-XCOMP-002**
- [ ] Theme hex values match desktop renderer.js — **INV-UX-002**
- [ ] Quick key byte sequences are correct — **INV-UX-003**
- [ ] Terminal buffer is bounded — **INV-DATA-002**
- [ ] Bridge message format matches `BridgeMessage` type — **INV-XCOMP-001**

## Cross-Boundary Integrity

- [ ] Adding a field to `SSHProfile`? Check `SettingsService`, `ProfileEditor`, `ProfileRow`, and `ConnectionListView`
- [ ] Adding a field to `BridgeMessage`? Check both `WebSocketTerminal.ts` and `server/index.js`
- [ ] Data round-trips (save/load profiles) preserve all fields
- [ ] Status state names match between `ClaudeStatusDetector`, `StatusDot`, and `constants/status.ts`

## Functional

- [ ] App launches without errors in Expo Go
- [ ] Navigation works: tabs, push to terminal, modal to editor
- [ ] Profile CRUD: create, edit, delete all work
- [ ] Theme switching updates all screens
- [ ] Bridge server starts with `node index.js`
- [ ] Bridge server rejects invalid tokens
- [ ] Bridge server cleans up PTY on disconnect

## Code Quality

- [ ] No `any` types unless unavoidable
- [ ] No unused imports or variables
- [ ] Components are focused and under ~300 lines
- [ ] Service files are under ~500 lines
- [ ] New files match existing naming conventions

## Documentation

- [ ] Architecture doc updated if components changed
- [ ] Invariants doc updated if new rules introduced
- [ ] Roadmap updated if features completed or scope changed
- [ ] Decisions doc updated if architectural choices made

---

**Remember**: If a change violates an invariant, it's a bug — not a shortcut.
