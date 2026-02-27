import { getSandbox } from "@cloudflare/sandbox";
import { WORKSPACE_SYSTEM } from "../constants/prompts";
import { Env } from "../types";
import { runCmd, SandboxType } from "../utils/sandbox";
import { escapeShell } from "../utils/strings";

const REPO_BASE = "/home/claudeuser/repo";
const WORKTREES_BASE = "/home/claudeuser/worktrees";

const COMMIT_AGENT_PROMPT = `You are a commit agent. Your ONLY job is to commit and push any uncommitted changes.

1. Check for uncommitted changes: git status
2. If there are changes:
   - git add -A
   - git commit -m "auto-commit: work from previous session"
   - git push origin HEAD:master
3. If push fails, rebase and retry: git fetch origin master && git rebase origin/master && git push origin HEAD:master

Do nothing else. Just commit and push, then stop.`;

/**
 * Consumes the stream fully, runs commit agent, then cleans up.
 * This runs via waitUntil() so it completes regardless of HTTP connection.
 */
async function consumeAndCleanup(
  stream: ReadableStream<Uint8Array>,
  sandbox: SandboxType,
  worktreePath: string,
  requestId: string,
  task: string,
  anthropicKey: string,
): Promise<void> {
  const reader = stream.getReader();
  const events: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Accumulate and split by newlines to get individual events
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last incomplete line in buffer
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          // Redact secrets and store each event as a line
          const redacted = line.replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]");
          events.push(redacted);
        }
      }
    }

    // Don't forget any remaining buffer content
    if (buffer.trim()) {
      const redacted = buffer.replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]");
      events.push(redacted);
    }

    console.log(`[consumeAndCleanup] Stream complete, ${events.length} events`);
    const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;

    // Write log file to main repo (not worktree) so it persists
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logDir = `${REPO_BASE}/.logs`;
    const logPath = `${logDir}/${requestId}-${timestamp}.jsonl`;

    // Create JSONL content: metadata line + each event on its own line
    const logLines = [
      JSON.stringify({ type: "metadata", task, requestId, timestamp }),
      ...events,
    ].join("\n");
    const b64 = btoa(unescape(encodeURIComponent(logLines)));

    await runCmd(sandbox, run(`mkdir -p ${logDir}`), "mkdir-logs");
    await runCmd(
      sandbox,
      run(`bash -c 'echo "${b64}" | base64 -d > ${logPath}'`),
      "write-log",
    );

    // Run commit agent to ensure all work is pushed
    console.log("[consumeAndCleanup] Running commit agent...");
    const commitPrompt = escapeShell(COMMIT_AGENT_PROMPT);
    const commitCmd = [
      `cd ${worktreePath}`,
      "&&",
      "runuser -u claudeuser -- env HOME=/home/claudeuser",
      `ANTHROPIC_API_KEY="${anthropicKey}"`,
      "claude",
      `-p "${commitPrompt}"`,
      "--dangerously-skip-permissions",
      "--max-turns 5",
    ].join(" ");

    const commitAgentResult = await runCmd(sandbox, commitCmd, "commit-agent");
    console.log(
      "[consumeAndCleanup] Commit agent done:",
      commitAgentResult.success ? "success" : "failed",
    );

    // Commit and push logs to repo
    console.log("[consumeAndCleanup] Committing logs...");
    await runCmd(
      sandbox,
      run(`git -C ${REPO_BASE} add .logs/`),
      "git-add-logs",
    );
    const logsStaged = await runCmd(
      sandbox,
      run(`git -C ${REPO_BASE} diff --cached --quiet; echo $?`),
      "git-check-staged",
    );
    if (logsStaged.stdout.trim() !== "0") {
      await runCmd(
        sandbox,
        run(`git -C ${REPO_BASE} commit -m "logs: ${requestId}"`),
        "git-commit-logs",
      );
      await runCmd(
        sandbox,
        run(`git -C ${REPO_BASE} pull --rebase origin HEAD || true`),
        "git-pull-logs",
      );
      await runCmd(
        sandbox,
        run(`git -C ${REPO_BASE} push origin HEAD`),
        "git-push-logs",
      );
    }

    // Cleanup: remove worktree after task completes
    console.log("[consumeAndCleanup] Removing worktree...");
    await runCmd(
      sandbox,
      run(`git -C ${REPO_BASE} worktree remove --force ${worktreePath}`),
      "worktree-remove",
    );

    console.log("[consumeAndCleanup] Done");
  } catch (error) {
    console.error("[consumeAndCleanup] Error:", error);
  }
}

async function ensureUser(sandbox: SandboxType) {
  const check = await runCmd(sandbox, "id claudeuser", "user-check");
  if (!check.success) {
    await runCmd(sandbox, "useradd -m -s /bin/bash claudeuser", "create-user");
  }
}

/**
 * Ensures the main repo is cloned and up to date.
 * This is the "bare" repo that worktrees are created from.
 */
async function setupMainRepo(
  sandbox: SandboxType,
  token: string,
  repo: string,
) {
  const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;

  const check = await runCmd(
    sandbox,
    `test -d ${REPO_BASE}/.git && echo exists || echo missing`,
    "repo-check",
  );

  if (check.stdout.trim() === "missing") {
    // Clone for the first time
    const clone = await runCmd(
      sandbox,
      run(
        `git clone https://x-access-token:${token}@github.com/${repo}.git ${REPO_BASE}`,
      ),
      "clone",
    );
    if (!clone.success) throw new Error(`Clone failed: ${clone.stderr}`);
  } else {
    // Fetch latest from remote
    await runCmd(sandbox, run(`git -C ${REPO_BASE} fetch --all`), "fetch");
  }

  // Configure git user
  await runCmd(
    sandbox,
    run(`git -C ${REPO_BASE} config user.email "merit-bot@merit.systems"`),
    "config-email",
  );
  await runCmd(
    sandbox,
    run(`git -C ${REPO_BASE} config user.name "Merit Bot"`),
    "config-name",
  );

  // Ensure worktrees directory exists
  await runCmd(sandbox, run(`mkdir -p ${WORKTREES_BASE}`), "mkdir-worktrees");
}

/**
 * Creates a worktree for this request based on latest master.
 * Claude works here and then merges changes back to master.
 */
async function createWorktree(
  sandbox: SandboxType,
  requestId: string,
): Promise<string> {
  const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;
  const worktreePath = `${WORKTREES_BASE}/${requestId}`;
  const localBranch = `worktree-${requestId}`;

  // Always base worktree on latest origin/master
  await runCmd(
    sandbox,
    run(
      `git -C ${REPO_BASE} worktree add -b ${localBranch} ${worktreePath} origin/master`,
    ),
    "worktree-add",
  );

  return worktreePath;
}

export async function handleExecuteTask(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.API_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { ANTHROPIC_API_KEY, GITHUB_TOKEN, MERIT_API_URL = "" } = env;
  if (!ANTHROPIC_API_KEY)
    return new Response("ANTHROPIC_API_KEY not set", { status: 500 });
  if (!GITHUB_TOKEN)
    return new Response("GITHUB_TOKEN not set", { status: 500 });

  try {
    const body = (await request.json()) as {
      task?: string;
      repo?: string;
    };
    const { task, repo } = body;
    if (!task) return new Response("task required", { status: 400 });
    if (!repo)
      return new Response("repo required (format: owner/name)", {
        status: 400,
      });

    // Extract username from repo (e.g., "MeritSpace/rsproule" -> "rsproule")
    const username = repo.split("/")[1];
    if (!username)
      return new Response("invalid repo format (expected: owner/name)", {
        status: 400,
      });

    // Request ID from caller - used for worktree and sandbox auth back to API
    const requestId = request.headers.get("X-Request-ID");
    if (!requestId) {
      return new Response("X-Request-ID header required", { status: 400 });
    }

    // Use requestId for sandbox to allow parallel requests (each gets own sandbox)
    const sandbox = getSandbox(env.Sandbox, requestId);

    await sandbox.setEnvVars({
      ANTHROPIC_API_KEY,
      GITHUB_TOKEN,
      MERIT_REQUEST_ID: requestId,
      MERIT_API_URL,
    });
    await ensureUser(sandbox);
    await setupMainRepo(sandbox, GITHUB_TOKEN, repo);
    const worktreePath = await createWorktree(sandbox, requestId);

    const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;

    // Create ~/workspace symlink pointing to this worktree for convenience
    await runCmd(
      sandbox,
      run(`ln -sfn ${worktreePath} /home/claudeuser/workspace`),
      "symlink-workspace",
    );

    // Write .claude/settings.json with agentcash MCP
    const claudeSettingsJson = JSON.stringify({
      mcpServers: {
        agentcash: {
          command: "npx",
          args: ["-y", "agentcash@latest", "server", "--provider", "whiskers"],
        },
      },
    });
    const settingsB64 = btoa(claudeSettingsJson);
    await runCmd(
      sandbox,
      run(`mkdir -p ${worktreePath}/.claude`),
      "mkdir-claude-settings",
    );
    await runCmd(
      sandbox,
      run(`bash -c 'echo "${settingsB64}" | base64 -d > ${worktreePath}/.claude/settings.json'`),
      "write-claude-settings",
    );

    const systemPrompt = escapeShell(WORKSPACE_SYSTEM(username));
    const taskPrompt = escapeShell(task);
    const claudeCommand = [
      `cd ${worktreePath}`,
      "&&",
      "runuser -u claudeuser -- env HOME=/home/claudeuser",
      `ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"`,
      "claude",
      `--append-system-prompt "${systemPrompt}"`,
      "--model opus",
      `-p "${taskPrompt}"`,
      "--dangerously-skip-permissions",
      "--output-format stream-json",
      "--verbose",
    ].join(" ");

    const stream = await sandbox.execStream(claudeCommand);

    // Tee the stream: one branch for background processing, one for HTTP response
    const [backgroundStream, responseStream] = stream.tee();

    // Background: consume stream and cleanup worktree when done
    ctx.waitUntil(
      consumeAndCleanup(
        backgroundStream,
        sandbox,
        worktreePath,
        requestId,
        task,
        ANTHROPIC_API_KEY,
      ),
    );

    // HTTP response: optional observer, can disconnect without affecting the task
    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(`Error: ${msg}`, { status: 500 });
  }
}
