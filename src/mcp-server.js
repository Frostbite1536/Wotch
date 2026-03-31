#!/usr/bin/env node
// src/mcp-server.js
// Standalone MCP server script launched by Claude Code via stdio transport.
// Connects back to Wotch main process via localhost TCP for data access.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const net = require("net");
const { z } = require("zod");

const IPC_PORT = parseInt(process.env.WOTCH_IPC_PORT || "19523", 10);
const IPC_TIMEOUT = 10000;

let ipcClient = null;
let requestCounter = 0;
const pendingRequests = new Map();

// ── IPC Communication ────────────────────────────────────────────────

function connectToWotch() {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ port: IPC_PORT, host: "127.0.0.1" }, () => {
      resolve(client);
    });
    client.on("error", (err) => {
      reject(new Error(`Cannot connect to Wotch (port ${IPC_PORT}): ${err.message}`));
    });

    let buffer = "";
    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          const pending = pendingRequests.get(response.id);
          if (pending) {
            pendingRequests.delete(response.id);
            clearTimeout(pending.timer);
            if (response.error) {
              pending.reject(new Error(response.error));
            } else {
              pending.resolve(response.result);
            }
          }
        } catch (e) {
          // Malformed response — ignore
        }
      }
    });

    client.on("close", () => {
      // Reject all pending requests
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Wotch connection closed"));
        pendingRequests.delete(id);
      }
    });
  });
}

function callWotch(method, params) {
  return new Promise((resolve, reject) => {
    if (!ipcClient || ipcClient.destroyed) {
      reject(new Error("Not connected to Wotch"));
      return;
    }

    const id = String(++requestCounter);
    const request = JSON.stringify({ id, method, params }) + "\n";

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Wotch IPC timeout"));
    }, IPC_TIMEOUT);

    pendingRequests.set(id, { resolve, reject, timer });
    ipcClient.write(request);
  });
}

// ── MCP Server Setup ─────────────────────────────────────────────────

async function main() {
  // Connect to Wotch main process
  try {
    ipcClient = await connectToWotch();
  } catch (err) {
    process.stderr.write(`Wotch MCP: ${err.message}\n`);
    process.exit(1);
  }

  const server = new McpServer({
    name: "wotch",
    version: "1.0.0",
  });

  // ── Tool: wotch_checkpoint ──────────────────────────────────────

  server.tool(
    "wotch_checkpoint",
    "Create a git checkpoint (snapshot commit) in the current project. Safe operation — creates a new commit without modifying the working tree.",
    { message: z.string().optional().describe("Optional checkpoint message. Defaults to timestamp.") },
    async ({ message }) => {
      const result = await callWotch("gitCheckpoint", { message });
      if (typeof result === "object") {
        return { content: [{ type: "text", text: result.message || JSON.stringify(result) }] };
      }
      return { content: [{ type: "text", text: String(result) }] };
    }
  );

  // ── Tool: wotch_git_status ──────────────────────────────────────

  server.tool(
    "wotch_git_status",
    "Get current git status: branch, changed files count, and checkpoint count.",
    {},
    async () => {
      const result = await callWotch("gitGetStatus", {});
      if (!result) {
        return { content: [{ type: "text", text: "Not a git repository or no project active" }] };
      }
      const text = `Branch: ${result.branch}\nChanged files: ${result.changedFiles}\nCheckpoints: ${result.checkpointCount}\nLast commit: ${result.lastCommit}`;
      return { content: [{ type: "text", text }] };
    }
  );

  // ── Tool: wotch_git_diff ────────────────────────────────────────

  server.tool(
    "wotch_git_diff",
    "Get git diff showing changes since the last checkpoint.",
    { context_lines: z.number().optional().describe("Context lines around changes. Default: 3.") },
    async ({ context_lines }) => {
      const result = await callWotch("gitGetDiff", { contextLines: context_lines || 3 });
      return { content: [{ type: "text", text: result || "No changes" }] };
    }
  );

  // ── Tool: wotch_project_info ────────────────────────────────────

  server.tool(
    "wotch_project_info",
    "Get information about the currently active project in Wotch.",
    {},
    async () => {
      const result = await callWotch("getProjectInfo", {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: wotch_terminal_buffer ─────────────────────────────────

  server.tool(
    "wotch_terminal_buffer",
    "Read recent terminal output from a Wotch tab. Warning: output may contain sensitive data.",
    {
      lines: z.number().optional().describe("Lines to read from end of buffer. Default: 50. Max: 500."),
      tab_id: z.string().optional().describe("Tab ID to read. Defaults to active tab."),
    },
    async ({ lines, tab_id }) => {
      const result = await callWotch("terminalBuffer", {
        lines: Math.min(lines || 50, 500),
        tabId: tab_id,
      });
      return { content: [{ type: "text", text: result || "(empty)" }] };
    }
  );

  // ── Tool: wotch_notify ──────────────────────────────────────────

  server.tool(
    "wotch_notify",
    "Send a desktop notification to the user via Wotch.",
    {
      title: z.string().describe("Notification title"),
      body: z.string().describe("Notification body text"),
    },
    async ({ title, body }) => {
      await callWotch("notify", { title, body });
      return { content: [{ type: "text", text: "Notification sent" }] };
    }
  );

  // ── Tool: wotch_list_tabs ───────────────────────────────────────

  server.tool(
    "wotch_list_tabs",
    "List all open terminal tabs in Wotch with their IDs and status.",
    {},
    async () => {
      const result = await callWotch("listTabs", {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: wotch_tab_status ──────────────────────────────────────

  server.tool(
    "wotch_tab_status",
    "Get the Claude Code status for a specific terminal tab.",
    { tab_id: z.string().describe("The tab ID to query") },
    async ({ tab_id }) => {
      const result = await callWotch("tabStatus", { tabId: tab_id });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Start server ────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Clean exit when stdin closes
  process.stdin.on("end", () => {
    if (ipcClient && !ipcClient.destroyed) ipcClient.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`Wotch MCP server fatal error: ${err.message}\n`);
  process.exit(1);
});
