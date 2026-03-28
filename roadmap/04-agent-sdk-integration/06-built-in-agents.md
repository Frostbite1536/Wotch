# 06 — Built-in Agents

## Overview

Wotch ships with four built-in agents installed to `~/.wotch/agents/` on first run. Users can edit or delete these files. If deleted, they are not re-created (the user intentionally removed them). A "Restore built-in agents" button in the settings panel re-copies them.

Built-in agent YAML files are bundled in `src/agents/` and included in the Electron build.

---

## Agent 1: Error Fixer

### Purpose

Automatically detects terminal errors and proposes code fixes. Triggers when the Claude Status Detector transitions to the `error` state.

### Definition File

**Path:** `src/agents/error-fixer.yaml` (bundled) / `~/.wotch/agents/error-fixer.yaml` (installed)

```yaml
name: error-fixer
displayName: Error Fixer
description: Detects terminal errors and suggests code fixes
version: "1.0.0"
model: claude-sonnet-4-20250514

systemPrompt: |
  You are an expert debugging assistant integrated into Wotch, a floating terminal overlay.
  The user is working on the project "{{projectName}}" at {{projectPath}} on {{platform}}.
  The current git branch is "{{branch}}".

  An error was detected in the terminal output. Your job is to:
  1. Analyze the error message and stack trace from the terminal buffer
  2. Identify the root cause
  3. Read the relevant source files to understand the context
  4. Propose a specific, minimal fix

  Rules:
  - Be concise. Explain the root cause in 1-2 sentences.
  - Show the exact code change needed (file path, before/after).
  - If you need to read files, read only the files referenced in the error.
  - Do NOT make speculative changes to unrelated files.
  - Do NOT run commands unless asked to verify a fix.
  - If the error is not a code issue (e.g., network timeout, missing dependency,
    missing environment variable), explain what the user should do manually.
  - If you cannot determine the cause, say so clearly.

tools:
  - FileSystem.readFile
  - FileSystem.listFiles
  - FileSystem.searchFiles
  - Terminal.readBuffer
  - Git.status
  - Git.diff

triggers:
  - type: onStatusChange
    to: error
    debounceMs: 10000

approvalMode: suggest-only

contextSources:
  - type: terminalBuffer
    lines: 300
  - type: gitStatus
  - type: projectInfo

maxTurns: 5
maxTokenBudget: 30000
temperature: 0

tags:
  - debugging
  - automatic
```

### Tool List

| Tool | Why |
|------|-----|
| `FileSystem.readFile` | Read source files referenced in error stack traces |
| `FileSystem.listFiles` | Discover project structure to find related files |
| `FileSystem.searchFiles` | Search for function/class definitions referenced in errors |
| `Terminal.readBuffer` | Read the full terminal buffer for error context |
| `Git.status` | Check what files have been recently modified |
| `Git.diff` | See recent changes that might have introduced the error |

### Example Interaction

**Trigger:** Terminal shows a test failure.

```
Terminal output (last 20 lines):
  FAIL src/utils.test.js
    ● add() should handle negative numbers
      expect(received).toBe(expected)
      Expected: -1
      Received: 1
      at Object.<anonymous> (src/utils.test.js:8:25)
```

**Agent reasoning (streamed to activity log):**

> The test `add() should handle negative numbers` is failing. It expects `add(-1, 0)` to return `-1` but received `1`. This suggests the `add` function might be wrapping the result in `Math.abs()` or similar. Let me read the source file.

**Tool call:** `FileSystem.readFile { path: "src/utils.js" }`

**Approval dialog shows in panel (suggest-only mode). User clicks Approve.**

**Tool result:** File contents showing `return Math.abs(a + b);`

**Agent reasoning:**

> Found it. The `add` function in `src/utils.js` wraps the result in `Math.abs()`, which converts negative results to positive. The fix is to remove `Math.abs()`.
>
> **Fix:**
> File: `src/utils.js`, line 2
> Before: `return Math.abs(a + b);`
> After: `return a + b;`

**Agent completes.** User reads the suggestion in the activity log and makes the fix manually (since the agent is in `suggest-only` mode, it doesn't write files).

### Expected Behavior

- Triggers within 1-2 seconds of error detection.
- Reads 1-3 files maximum per run.
- Completes within 3-5 turns.
- Does NOT write files or run commands (read-only tools only).
- If it cannot diagnose the issue, says so clearly in 1 turn.

---

## Agent 2: Code Reviewer

### Purpose

Reviews code changes after each git checkpoint, providing inline feedback with severity ratings.

### Definition File

**Path:** `src/agents/code-reviewer.yaml` (bundled) / `~/.wotch/agents/code-reviewer.yaml` (installed)

```yaml
name: code-reviewer
displayName: Code Reviewer
description: Reviews code changes after each checkpoint
version: "1.0.0"
model: claude-sonnet-4-20250514

systemPrompt: |
  You are a thorough code reviewer for the project "{{projectName}}".
  A git checkpoint was just created with new changes. Review the diff and provide
  actionable, specific feedback.

  Your review should focus on:
  1. Bugs and logic errors
  2. Security issues (injection, hardcoded secrets, unsafe operations)
  3. Performance problems (N+1 queries, unnecessary allocations, blocking calls)
  4. Error handling gaps (uncaught exceptions, missing validation)
  5. Code clarity (naming, comments, complexity)

  Format your review as a structured list. For each finding:
  - **File:** path/to/file.ext (line ~N)
  - **Severity:** CRITICAL / SUGGESTION / NITPICK
  - **Issue:** Clear description of the problem
  - **Fix:** Suggested resolution (with code snippet if helpful)

  Guidelines:
  - If you need to read the full file for context (not just the diff), do so.
  - Do not invent issues. If the code looks good, say "LGTM" with a brief note.
  - Limit to 10 findings maximum. Prioritize by severity.
  - Do not comment on formatting or style unless it affects readability significantly.

tools:
  - FileSystem.readFile
  - FileSystem.listFiles
  - FileSystem.searchFiles
  - Git.diff
  - Git.log
  - Git.status

triggers:
  - type: onCheckpoint
    debounceMs: 5000

approvalMode: auto-execute

contextSources:
  - type: gitDiff
    mode: all
  - type: gitLog
    count: 3
  - type: projectInfo

maxTurns: 8
maxTokenBudget: 50000
temperature: 0

tags:
  - review
  - automatic
```

### Tool List

| Tool | Why |
|------|-----|
| `FileSystem.readFile` | Read full file content for context beyond the diff |
| `FileSystem.listFiles` | Discover related files (e.g., tests for a changed module) |
| `FileSystem.searchFiles` | Find usages of changed functions/variables |
| `Git.diff` | Read the diff (also injected via contextSources, but may re-read for specific files) |
| `Git.log` | Check recent commit messages for context |
| `Git.status` | See overall change scope |

### Example Interaction

**Trigger:** User clicks checkpoint. Checkpoint creates commit `abc1234` with 3 files changed.

**Context injected (from contextSources):**

```
Git diff:
  src/api/handler.js: +15 -3
  src/utils/validate.js: +8 -0
  src/models/user.js: +2 -2

Recent commits:
  abc1234 wotch-checkpoint-2026-03-28T10-30-00
  def5678 Add user validation endpoint
  ghi9012 Refactor auth middleware
```

**Agent reasoning:**

> I'll review the diff. Let me start by examining the changes in each file.

**Tool call:** `Git.diff { mode: "commit" }` (auto-approved, read-only)

**Tool result:** Full diff content.

**Agent reasoning:**

> The diff shows changes to the API handler. Let me read the full file for context.

**Tool call:** `FileSystem.readFile { path: "src/api/handler.js" }` (auto-approved)

**Agent final output:**

> ## Code Review: Checkpoint abc1234
>
> **File:** src/api/handler.js (line ~42)
> **Severity:** CRITICAL
> **Issue:** SQL query uses string concatenation with user input: `` `SELECT * FROM users WHERE id = ${req.params.id}` ``. This is vulnerable to SQL injection.
> **Fix:** Use parameterized queries: `db.query('SELECT * FROM users WHERE id = $1', [req.params.id])`
>
> **File:** src/utils/validate.js (line ~15)
> **Severity:** SUGGESTION
> **Issue:** The email regex `/.+@.+/` is too permissive. It would accept `@x` as valid.
> **Fix:** Use a more specific pattern or a validation library like `validator.js`.
>
> **File:** src/models/user.js (line ~8)
> **Severity:** NITPICK
> **Issue:** Changed `updatedAt` assignment from `new Date()` to `Date.now()`, which stores a number instead of a Date object. Make sure the schema expects a number.
> **Fix:** Verify the database column type. If it expects a Date, revert to `new Date()`.

### Expected Behavior

- Triggers automatically after checkpoint with no user interaction (auto-execute mode for read-only operations).
- Reads 1-5 files depending on diff scope.
- Produces structured review within 30 seconds.
- All tools are read-only, so auto-execute mode is safe.
- Review appears in the agent activity log.
- Desktop notification when review is complete (if window not focused).

---

## Agent 3: Test Writer

### Purpose

Reads recently changed files and generates test files matching the project's test framework and conventions.

### Definition File

**Path:** `src/agents/test-writer.yaml` (bundled) / `~/.wotch/agents/test-writer.yaml` (installed)

```yaml
name: test-writer
displayName: Test Writer
description: Generates test files for recently changed code
version: "1.0.0"
model: claude-sonnet-4-20250514

systemPrompt: |
  You are a test-writing assistant for the project "{{projectName}}" at {{projectPath}}.
  Platform: {{platform}}. Shell: {{shell}}.

  Your task is to generate high-quality tests for recently changed files.

  Process:
  1. Check git status and diff to identify changed source files (ignore test files, configs)
  2. Read each changed source file to understand what needs testing
  3. Look for existing test files to match the testing framework and patterns
  4. For each changed source file, generate or update a test file
  5. After writing tests, run the test suite to verify they pass
  6. If tests fail, read the error output and fix the tests (up to 2 attempts)

  Rules:
  - Match the project's existing test framework. Look for:
    - package.json scripts.test → Jest, Mocha, Vitest, etc.
    - pytest.ini / pyproject.toml → pytest
    - Cargo.toml → cargo test
    - go.mod → go test
  - Follow the project's test file naming convention:
    - *.test.js / *.spec.js / __tests__/*.js (JavaScript)
    - test_*.py / *_test.py (Python)
    - *_test.go (Go)
  - Write focused unit tests covering:
    - Happy path
    - Edge cases (empty input, null, boundary values)
    - Error cases (invalid input, exceptions)
  - Do NOT modify source files — only create or update test files
  - If the project has no test framework, suggest one and write tests for it
  - Keep tests readable with descriptive names

tools:
  - FileSystem.readFile
  - FileSystem.writeFile
  - FileSystem.listFiles
  - FileSystem.searchFiles
  - Shell.execute
  - Git.status
  - Git.diff
  - Project.getInfo

triggers:
  - type: manual

approvalMode: ask-first

contextSources:
  - type: gitDiff
    mode: all
  - type: gitStatus
  - type: projectInfo

maxTurns: 15
maxTokenBudget: 80000
temperature: 0

tags:
  - testing
  - manual
```

### Tool List

| Tool | Why |
|------|-----|
| `FileSystem.readFile` | Read source files to understand what to test |
| `FileSystem.writeFile` | Write generated test files |
| `FileSystem.listFiles` | Find existing tests, discover project structure |
| `FileSystem.searchFiles` | Find imports, function references |
| `Shell.execute` | Run the test suite to verify generated tests pass |
| `Git.status` | Identify changed files |
| `Git.diff` | See what changed in detail |
| `Project.getInfo` | Detect test framework and test command |

### Example Interaction

**Trigger:** User opens command palette, selects "Run Agent: Test Writer".

**Context injected:**

```
Git status: 2 files changed
  src/utils/math.js (modified)
  src/services/calculator.js (new)

Project info:
  Framework: Node.js/Express
  Test command: jest
  Package manager: npm
```

**Agent turn 1:**

> I see 2 changed files. Let me read them to understand what needs testing.

**Tool calls:**
- `FileSystem.readFile { path: "src/utils/math.js" }` (auto-approved, read-only)
- `FileSystem.readFile { path: "src/services/calculator.js" }` (auto-approved, read-only)

**Agent turn 2:**

> Let me check if there are existing tests to match the style.

**Tool call:** `FileSystem.listFiles { path: "src", recursive: true, pattern: "*.test.js" }` (auto-approved)

**Agent turn 3:**

> I found existing tests using Jest with `describe`/`it` blocks. I'll generate tests for both files.

**Tool call:** `FileSystem.writeFile { path: "src/utils/__tests__/math.test.js", content: "..." }`

**Approval dialog appears (ask-first mode for write). User approves.**

**Tool call:** `FileSystem.writeFile { path: "src/services/__tests__/calculator.test.js", content: "..." }`

**Approval dialog appears. User approves.**

**Agent turn 4:**

> Tests written. Let me run the test suite to verify.

**Tool call:** `Shell.execute { command: "npx jest --no-coverage", timeoutMs: 60000 }`

**Approval dialog appears (shell execution requires approval in ask-first). User approves.**

**Tool result:** All tests pass.

**Agent completes:**

> All tests pass. Created 2 test files:
> - `src/utils/__tests__/math.test.js` — 4 test cases for math utilities
> - `src/services/__tests__/calculator.test.js` — 6 test cases for calculator service

### Expected Behavior

- Runs 5-15 turns depending on number of changed files.
- Writes 1-5 test files per run.
- Verifies tests pass by running the test suite.
- If tests fail on first run, reads the error and fixes (up to 2 retries).
- All file writes require approval (ask-first mode).
- Shell execution (running tests) requires approval.

---

## Agent 4: Deploy Assistant

### Purpose

Walks through a deployment readiness checklist, executing verification steps and reporting pass/fail for each.

### Definition File

**Path:** `src/agents/deploy-assistant.yaml` (bundled) / `~/.wotch/agents/deploy-assistant.yaml` (installed)

```yaml
name: deploy-assistant
displayName: Deploy Assistant
description: Walks through a deployment checklist with verification steps
version: "1.0.0"
model: claude-sonnet-4-20250514

systemPrompt: |
  You are a deployment readiness assistant for the project "{{projectName}}" at {{projectPath}}.
  Current branch: {{branch}}. Platform: {{platform}}.

  Walk through the following deployment checklist. Execute each step and report
  the result clearly. Stop and alert if any critical step fails.

  ## Checklist

  ### Step 1: Git Status Check
  - Verify no uncommitted changes
  - Verify current branch is appropriate for deployment (main, master, release/*)
  - If there are uncommitted changes, warn but continue

  ### Step 2: Lint Check
  - Detect the linter from project config (eslint, prettier, pylint, clippy, etc.)
  - Run the linter
  - Report any errors (warnings are OK)

  ### Step 3: Test Suite
  - Detect the test command from project config
  - Run the full test suite
  - Report pass/fail and any failing tests
  - This is a CRITICAL step — if tests fail, recommend aborting deployment

  ### Step 4: Upstream Sync Check
  - Check if the branch is up to date with its remote tracking branch
  - Report commits ahead/behind

  ### Step 5: Build Verification
  - Detect the build command from project config
  - Run the build
  - Report success/failure

  ### Step 6: Summary
  - Summarize all results in a clear table
  - Give a GO / NO-GO recommendation
  - If NO-GO, explain which steps failed and what to fix

  Rules:
  - Do NOT push to remote or deploy. Only verify readiness.
  - Do NOT modify any files.
  - If a command is not found (e.g., no linter configured), skip that step with a note.
  - Show the exact commands you're running.
  - Be explicit about pass/fail for each step.

tools:
  - Shell.execute
  - FileSystem.readFile
  - FileSystem.listFiles
  - Git.status
  - Git.diff
  - Git.log
  - Git.branchInfo
  - Project.getInfo
  - Wotch.showNotification

triggers:
  - type: manual

approvalMode: ask-first

contextSources:
  - type: gitStatus
  - type: projectInfo

maxTurns: 20
maxTokenBudget: 60000
temperature: 0

tags:
  - deployment
  - manual
```

### Tool List

| Tool | Why |
|------|-----|
| `Shell.execute` | Run linter, tests, build commands |
| `FileSystem.readFile` | Read config files to detect commands |
| `FileSystem.listFiles` | Discover project structure |
| `Git.status` | Check for uncommitted changes |
| `Git.diff` | See pending changes |
| `Git.log` | Check recent commits |
| `Git.branchInfo` | Check ahead/behind remote |
| `Project.getInfo` | Detect test/build/lint commands |
| `Wotch.showNotification` | Alert user when checklist is complete |

### Example Interaction

**Trigger:** User opens command palette, selects "Run Agent: Deploy Assistant".

**Agent turn 1:**

> Starting deployment readiness check for **myapp** on branch **main**.
>
> ### Step 1: Git Status Check

**Tool call:** `Git.status {}` (auto-approved, read-only)

**Result:** Clean, on branch main.

> Git status: Clean. Branch: main. PASS

**Agent turn 2:**

> ### Step 2: Lint Check
> Detecting linter...

**Tool call:** `Project.getInfo {}` (auto-approved, read-only)

**Result:** lintCommand: "eslint ."

**Tool call:** `Shell.execute { command: "npx eslint . --max-warnings=0", timeoutMs: 60000 }`

**Approval dialog (ask-first for shell). User approves.**

**Result:** Exit code 0, no errors.

> Lint check: 0 errors, 0 warnings. PASS

**Agent turn 3:**

> ### Step 3: Test Suite

**Tool call:** `Shell.execute { command: "npm test", timeoutMs: 120000 }`

**Approval dialog. User approves.**

**Result:** All 47 tests pass.

> Tests: 47 passed, 0 failed. PASS

**Agent turn 4:**

> ### Step 4: Upstream Sync

**Tool call:** `Git.branchInfo { includeRemote: true }` (auto-approved)

**Result:** 0 ahead, 0 behind.

> Branch main is up to date with origin/main. PASS

**Agent turn 5:**

> ### Step 5: Build Verification

**Tool call:** `Shell.execute { command: "npm run build", timeoutMs: 120000 }`

**Approval dialog. User approves.**

**Result:** Build succeeds.

> Build completed successfully. PASS

**Agent turn 6:**

> ### Step 6: Summary
>
> | Step | Result |
> |------|--------|
> | Git Status | PASS — Clean, branch main |
> | Lint Check | PASS — 0 errors |
> | Test Suite | PASS — 47/47 tests |
> | Upstream Sync | PASS — Up to date |
> | Build | PASS — Success |
>
> **Recommendation: GO**
>
> All checks passed. The project is ready for deployment.

**Tool call:** `Wotch.showNotification { title: "Deploy Check Complete", body: "All 5 checks passed. GO for deployment.", type: "success" }`

### Expected Behavior

- Runs 5-10 turns for a typical project.
- Each shell command requires user approval (ask-first mode).
- If any critical step (tests, build) fails, recommends NO-GO.
- Never pushes, deploys, or modifies files.
- Shows a desktop notification when complete.
- Clear, tabular summary at the end.

---

## Bundling Built-in Agents

### File Structure

```
src/
  agents/
    error-fixer.yaml
    code-reviewer.yaml
    test-writer.yaml
    deploy-assistant.yaml
```

### package.json Build Config Update

Add `src/agents/` to the `files` array:

```json
{
  "build": {
    "files": [
      "src/**/*",
      "assets/**/*"
    ]
  }
}
```

The existing glob `src/**/*` already covers `src/agents/`, so no change is needed. The `installBuiltinAgents()` function in `AgentManager` copies these files to `~/.wotch/agents/` on first run.

### Settings Panel Integration

Add a "Restore Built-in Agents" button in the settings panel under a new "Agents" section. This button calls `ipcRenderer.invoke("agent-restore-builtins")` which re-copies the bundled YAML files (overwriting any user edits).
