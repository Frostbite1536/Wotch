# Cost Tracking

## Overview

Track token usage and estimated cost per conversation, per session, and per month. Display in the chat status bar and settings panel. Optional budget alerts.

## Pricing Table (as of 2026)

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|----------------------|----------------------|
| Claude Opus 4.6 | $15.00 | $75.00 |
| Claude Sonnet 4.6 | $3.00 | $15.00 |
| Claude Haiku 4.5 | $0.80 | $4.00 |

## TokenTracker Class

```js
class TokenTracker {
  constructor() {
    this.sessionUsage = { inputTokens: 0, outputTokens: 0, cost: 0 };
    this.conversationUsage = new Map(); // conversationId -> usage
  }

  recordUsage(conversationId, model, inputTokens, outputTokens) {
    const cost = this.calculateCost(model, inputTokens, outputTokens);

    // Session totals
    this.sessionUsage.inputTokens += inputTokens;
    this.sessionUsage.outputTokens += outputTokens;
    this.sessionUsage.cost += cost;

    // Per-conversation
    const conv = this.conversationUsage.get(conversationId) || { inputTokens: 0, outputTokens: 0, cost: 0 };
    conv.inputTokens += inputTokens;
    conv.outputTokens += outputTokens;
    conv.cost += cost;
    this.conversationUsage.set(conversationId, conv);

    // Persist to monthly log
    this.appendToLog({ conversationId, model, inputTokens, outputTokens, cost, timestamp: Date.now() });

    return { inputTokens, outputTokens, cost, sessionTotal: this.sessionUsage };
  }

  calculateCost(model, inputTokens, outputTokens) {
    const pricing = {
      'claude-opus-4-6': { input: 15.0, output: 75.0 },
      'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
      'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
    };
    const p = pricing[model] || pricing['claude-sonnet-4-6'];
    return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  }

  appendToLog(entry) {
    const logPath = path.join(os.homedir(), '.wotch', 'usage.json');
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  }
}
```

## Monthly Usage Log

Stored as JSONL at `~/.wotch/usage.json`. Each line is a JSON object with conversation ID, model, token counts, cost, and timestamp.

## Budget System

Optional monthly budget (`settings.apiBudgetMonthly`, default 0 = unlimited).

Budget states:
- **Normal:** Under 80% of budget
- **Warning:** 80-100% of budget → yellow toast notification
- **Exceeded:** Over budget → red toast, send button shows warning but still allows sending

## Display

- Chat status bar: `128 in / 320 out` and `$0.02` after each message
- Settings panel: "This month's usage: $X.XX" with option to clear log
- Budget alert toast when threshold crossed
