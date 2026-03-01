#!/usr/bin/env node
/**
 * Agent runner script — runs INSIDE the Cloudflare sandbox container.
 *
 * Usage: node agent-runner.mjs <task-file> [session-id]
 *
 * - Reads the task/prompt from <task-file>
 * - Runs the agent SDK query() with agentcash MCP
 * - Streams NDJSON events to stdout (same format as Claude CLI stream-json)
 * - Optionally resumes a session if session-id is provided
 *
 * Environment:
 *   ANTHROPIC_API_KEY — required
 *   SYSTEM_PROMPT — optional, defaults to brain mode prompt
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "fs";

const taskFile = process.argv[2];
const sessionId = process.argv[3] || undefined;

if (!taskFile) {
  console.error("Usage: node agent-runner.mjs <task-file> [session-id]");
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required");
  process.exit(1);
}

const task = readFileSync(taskFile, "utf-8");
const systemPrompt = process.env.SYSTEM_PROMPT || "";

const options = {
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "bypassPermissions",
  systemPrompt: systemPrompt || undefined,
  maxTurns: 5,
  tools: [],
  mcpServers: {
    agentcash: {
      command: "npx",
      args: ["-y", "agentcash@latest", "server", "--provider", "whiskers"],
    },
  },
};

// Resume existing session if provided
if (sessionId) {
  options.resume = sessionId;
}

try {
  for await (const message of query({ prompt: task, options })) {
    // Emit each message as NDJSON to stdout
    process.stdout.write(JSON.stringify(message) + "\n");
  }
} catch (err) {
  // Write error as a structured event so the worker can parse it
  process.stdout.write(
    JSON.stringify({
      type: "error",
      error: err.message || String(err),
    }) + "\n",
  );
  process.exit(1);
}
