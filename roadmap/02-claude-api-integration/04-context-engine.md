# Context Injection Engine

## Overview

The context engine gathers relevant information from Wotch's existing subsystems and formats it into the system prompt sent to the Claude API. This gives Claude automatic awareness of what the user is working on without manual copy-pasting.

## Context Sources

### 1. Terminal Buffer
- **Source:** API server's rolling terminal buffer (50KB per tab, fed from PTY/SSH data handlers)
- **What it provides:** Recent terminal output, errors, command results
- **Typical size:** 500-2000 tokens
- **Toggle:** `ctx-terminal` checkbox

### 2. Git Status
- **Source:** Existing `git-status` handler
- **What it provides:** Branch name, changed files (staged/unstaged), checkpoint count
- **Typical size:** 50-200 tokens
- **Toggle:** `ctx-git` checkbox

### 3. Git Diff
- **Source:** Existing `git-diff` handler
- **What it provides:** Unified diff of uncommitted changes
- **Typical size:** 200-5000 tokens (truncated at 3000 tokens)
- **Toggle:** `ctx-diff` checkbox

### 4. File Tree
- **Source:** `fs.readdirSync` recursive scan
- **What it provides:** Project directory structure (3 levels deep, excludes node_modules/.git)
- **Typical size:** 100-500 tokens
- **Toggle:** `ctx-files` checkbox

## System Prompt Format

```
You are Claude, an AI assistant helping a developer working in Wotch (a floating terminal for Claude Code).

## Current Context

### Project: my-project (~/code/my-project)
Branch: feature/auth | 3 files changed | 2 checkpoints

### Recent Terminal Output
```
$ npm test
FAIL src/auth.test.ts
  Expected: true
  Received: false
```

### Git Diff (uncommitted changes)
```diff
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,6 +40,8 @@ function validateUser(user) {
+  if (!user.session) return null;
   return user.session.token;
```

### Project Structure
my-project/
  src/
    auth.ts
    index.ts
  tests/
    auth.test.ts
  package.json
```

## Token Budget Management

Total context budget: configurable, default 4000 tokens. Priority order when truncating:
1. Git status (always included, small)
2. Terminal buffer (truncate from the start, keep recent output)
3. File tree (reduce depth)
4. Git diff (truncate from the end, keep file headers)

## Gathering Function

```js
async function gatherContext(activeTabId, projectPath, enabledSources) {
  const context = {};

  if (enabledSources.terminal) {
    context.terminal = getTerminalBuffer(activeTabId);
  }
  if (enabledSources.git && projectPath) {
    context.gitStatus = getGitStatus(projectPath);
  }
  if (enabledSources.diff && projectPath) {
    context.gitDiff = getGitDiff(projectPath);
  }
  if (enabledSources.files && projectPath) {
    context.fileTree = buildFileTree(projectPath, 3);
  }

  return context;
}
```

## Context Freshness

Context is gathered at send time (not cached) to ensure it reflects the current state. Each send gathers fresh terminal output, git status, and diff.
