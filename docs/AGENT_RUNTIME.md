# Agent Runtime v2

Wotch's agent runtime is local-first and provider-neutral at its core. Agent definitions, policy evaluation, tools, durable state, memory, and automation live in `src/agent/`; Electron's main process supplies lifecycle services and registers validated preload IPC. Anthropic is the only shipped harness adapter in v2.

## Security boundary

The local PTY backend is **not an OS sandbox**. It constrains commands to a canonical project working directory, enforces cancellation plus time/output limits, and passes a reduced environment, but commands still execute with the desktop user's operating-system permissions. Anthropic, OpenRouter, and other credential-shaped environment variables are excluded unless the project owner explicitly approves the exact variable name.

Every command passes through an immutable built-in floor that understands POSIX shells, `cmd.exe`, and PowerShell, including nested shell payloads and PowerShell encoded commands. The result is `allow`, `require_approval`, or `deny`, with a rule id, source, dialect, reason, and redacted match. Repository `.wotch/agent-policy.json` rules may only add denials or approval requirements. User-global and user-owned project rules are layered above project-agent trust; an explicit user allow can bypass only a generic write approval, never the immutable floor, an approval rule, a denial, or an inherently dangerous tool.

Project file tools use `realpath` plus `path.relative` containment. New paths validate their nearest existing parent, which prevents traversal, sibling-prefix, and symlink escapes.

The central redactor masks known credential values and their URL/base64 forms, secret-shaped flags and assignments, authorization values, and oversized strings before data reaches renderer events, approvals, notifications, logs, persisted errors, or memory extraction. Audit events persist only structured tool metadata such as relative paths, byte counts/hashes, exit status, duration, and redacted command previews. File bodies and command output are available only inside the active model continuation and are not written to audit logs.

## Durable runs

Each project is assigned a scope id: SHA-256 of its canonical platform-normalized path. User-owned state is stored outside the repository under:

```text
~/.wotch/projects/<scopeId>/
  trust.json
  policy.json
  memory.json
  memory-revisions/
  automation.json
  runs/<runId>/
    state.json
    events.jsonl
    checkpoint.enc
```

`state.json` is an atomic redacted snapshot, `events.jsonl` is append-only and redacted, and `checkpoint.enc` contains sensitive continuation state encrypted with Electron `safeStorage` or AES-256-GCM using a random per-installation key stored at `~/.wotch/agent-checkpoint.key`. The fallback key is created with owner-only permissions and is never derived from discoverable machine metadata. Runs move through `queued`, `running`, `waiting_approval`, `completed`, `failed`, `stopped`, `interrupted`.

Concurrency pressure queues work in FIFO order. Automated starts carry durable dedupe keys; manual starts always create a new run. Wotch never automatically retries a run that may have produced side effects. After restart, running work becomes `interrupted` and offers Retry as a new run. Pending approvals remain recoverable and are evaluated against current policy before continuation. Cancellation uses `AbortController` through the harness and PTY backend, cascades to child runs, and an emergency stop demotes trust for the affected project-agent pairs.

The harness contract covers identity/capabilities, turns, session reset, history compaction, memory extraction, context budget, usage, and cancellation. Normal, compaction, and extraction calls count toward both the run's model-call and token budgets. History compacts at 80% of the adapter context budget while preserving the two newest tool exchanges.

## Trust, memory, and automation defaults

New project-agent pairs start in `ask-first`. The legacy global trust file is retained and marked migrated, but its modes apply only to no-project runs after migration.

Project memory is disabled by default. When explicitly enabled, deterministic token-overlap recall supplies at most 20 facts and 8,000 characters as provenance-labelled, untrusted data. Successful top-level runs may extract facts from the redacted task, redacted final response, and structured tool summaries. Facts are at most 500 characters, secret-scanned, deduplicated, capped at 300, and stored with project/agent/run provenance. Up to 50 complete atomic revisions support inspection, search, deletion, and concurrency-safe restoration.

Cron, file-watch, and command-watch triggers are proposals until individually enabled for a project. They run only while Wotch is open and do not catch up after downtime. File watches debounce bursts and ignore `.git`, `node_modules`, `dist`, and `build` by default. Command watches require a standing enable-time approval tied to the exact trigger, command, scope, and policy revision. They establish a baseline without firing, pass at most 16 KB of redacted labelled change data, and disable with a notification after three consecutive failures.

## Migration

On first v2 startup, legacy `~/.wotch/agent-logs` JSONL files are atomically rewritten in place. Raw task inputs, tool inputs, outputs, and file bodies are discarded; timestamps, action metadata, hashes/counts, redacted command previews, and redacted errors are retained. No unsafe backup is created. Existing definitions remain valid and default to `harness: anthropic` when omitted. Memory and every automation trigger remain opt-in.
