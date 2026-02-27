import { getSandbox } from "@cloudflare/sandbox";
import { BRAIN_SYSTEM, WORKSPACE_SYSTEM } from "../constants/prompts";
import { Env } from "../types";
import { runCmd, SandboxType } from "../utils/sandbox";
import { escapeShell } from "../utils/strings";

const REPO_BASE = "/home/claudeuser/repo";
const WORKTREES_BASE = "/home/claudeuser/worktrees";
const SCRATCH_BASE = "/home/claudeuser/scratch";

const COMMIT_AGENT_PROMPT = `You are a commit agent. Your ONLY job is to commit and push any uncommitted changes.

1. Check for uncommitted changes: git status
2. If there are changes:
   - git add -A
   - git commit -m "auto-commit: work from previous session"
   - git push origin HEAD:master
3. If push fails, rebase and retry: git fetch origin master && git rebase origin/master && git push origin HEAD:master

Do nothing else. Just commit and push, then stop.`;

async function consumeAndCleanup(
  stream: ReadableStream<Uint8Array>,
  sandbox: SandboxType,
  workDir: string,
  requestId: string,
  task: string,
  anthropicKey: string,
  hasRepo: boolean,
): Promise<void> {
  const reader = stream.getReader();
  const events: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          const redacted = line.replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]");
          events.push(redacted);
        }
      }
    }

    if (buffer.trim()) {
      const redacted = buffer.replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]");
      events.push(redacted);
    }

    console.log(`[consumeAndCleanup] Stream complete, ${events.length} events`);
    const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;

    if (hasRepo) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logDir = `${REPO_BASE}/.logs`;
      const logPath = `${logDir}/${requestId}-${timestamp}.jsonl`;

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

      console.log("[consumeAndCleanup] Running commit agent...");
      const commitPrompt = escapeShell(COMMIT_AGENT_PROMPT);
      const commitCmd = [
        `cd ${workDir}`,
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

      console.log("[consumeAndCleanup] Committing logs...");
      await runCmd(sandbox, run(`git -C ${REPO_BASE} add .logs/`), "git-add-logs");
      const logsStaged = await runCmd(
        sandbox,
        run(`git -C ${REPO_BASE} diff --cached --quiet; echo $?`),
        "git-check-staged",
      );
      if (logsStaged.stdout.trim() !== "0") {
        await runCmd(sandbox, run(`git -C ${REPO_BASE} commit -m "logs: ${requestId}"`), "git-commit-logs");
        await runCmd(sandbox, run(`git -C ${REPO_BASE} pull --rebase origin HEAD || true`), "git-pull-logs");
        await runCmd(sandbox, run(`git -C ${REPO_BASE} push origin HEAD`), "git-push-logs");
      }

      console.log("[consumeAndCleanup] Removing worktree...");
      await runCmd(sandbox, run(`git -C ${REPO_BASE} worktree remove --force ${workDir}`), "worktree-remove");
    } else {
      await runCmd(sandbox, `rm -rf ${workDir}`, "cleanup-scratch");
    }

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

async function setupMainRepo(sandbox: SandboxType, token: string, repo: string) {
  const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;

  const check = await runCmd(
    sandbox,
    `test -d ${REPO_BASE}/.git && echo exists || echo missing`,
    "repo-check",
  );

  if (check.stdout.trim() === "missing") {
    const clone = await runCmd(
      sandbox,
      run(`git clone https://x-access-token:${token}@github.com/${repo}.git ${REPO_BASE}`),
      "clone",
    );
    if (!clone.success) throw new Error(`Clone failed: ${clone.stderr}`);
  } else {
    await runCmd(sandbox, run(`git -C ${REPO_BASE} fetch --all`), "fetch");
  }

  await runCmd(sandbox, run(`git -C ${REPO_BASE} config user.email "merit-bot@merit.systems"`), "config-email");
  await runCmd(sandbox, run(`git -C ${REPO_BASE} config user.name "Merit Bot"`), "config-name");
  await runCmd(sandbox, run(`mkdir -p ${WORKTREES_BASE}`), "mkdir-worktrees");
}

async function createWorktree(sandbox: SandboxType, requestId: string): Promise<string> {
  const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;
  const worktreePath = `${WORKTREES_BASE}/${requestId}`;
  const localBranch = `worktree-${requestId}`;

  await runCmd(
    sandbox,
    run(`git -C ${REPO_BASE} worktree add -b ${localBranch} ${worktreePath} origin/master`),
    "worktree-add",
  );

  return worktreePath;
}

async function createScratchDir(sandbox: SandboxType, requestId: string): Promise<string> {
  const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;
  const scratchPath = `${SCRATCH_BASE}/${requestId}`;
  await runCmd(sandbox, run(`mkdir -p ${scratchPath}`), "mkdir-scratch");
  return scratchPath;
}

async function writeMcpSettings(sandbox: SandboxType, workDir: string) {
  const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;
  const settings = JSON.stringify({
    mcpServers: {
      agentcash: {
        command: "npx",
        args: ["-y", "agentcash@latest", "server", "--provider", "whiskers"],
      },
    },
  });
  const b64 = btoa(settings);
  await runCmd(sandbox, run(`mkdir -p ${workDir}/.claude`), "mkdir-claude-settings");
  await runCmd(
    sandbox,
    run(`bash -c 'echo "${b64}" | base64 -d > ${workDir}/.claude/settings.json'`),
    "write-claude-settings",
  );
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

  try {
    const body = (await request.json()) as {
      task?: string;
      repo?: string;
    };
    const { task, repo } = body;
    if (!task) return new Response("task required", { status: 400 });

    const hasRepo = !!repo;
    const username = repo?.split("/")[1];

    if (hasRepo && !username)
      return new Response("invalid repo format (expected: owner/name)", { status: 400 });
    if (hasRepo && !GITHUB_TOKEN)
      return new Response("GITHUB_TOKEN not set (required when repo is provided)", { status: 500 });

    const requestId = request.headers.get("X-Request-ID");
    if (!requestId) {
      return new Response("X-Request-ID header required", { status: 400 });
    }

    const sandbox = getSandbox(env.Sandbox, requestId);

    await sandbox.setEnvVars({
      ANTHROPIC_API_KEY,
      ...(GITHUB_TOKEN && { GITHUB_TOKEN }),
      MERIT_REQUEST_ID: requestId,
      MERIT_API_URL,
    });
    await ensureUser(sandbox);

    let workDir: string;
    let systemPrompt: string;

    if (hasRepo) {
      await setupMainRepo(sandbox, GITHUB_TOKEN, repo!);
      workDir = await createWorktree(sandbox, requestId);
      systemPrompt = WORKSPACE_SYSTEM(username!);
    } else {
      workDir = await createScratchDir(sandbox, requestId);
      systemPrompt = BRAIN_SYSTEM;
    }

    const run = (cmd: string) => `runuser -u claudeuser -- ${cmd}`;

    await runCmd(sandbox, run(`ln -sfn ${workDir} /home/claudeuser/workspace`), "symlink-workspace");
    await writeMcpSettings(sandbox, workDir);

    const escapedSystem = escapeShell(systemPrompt);
    const escapedTask = escapeShell(task);
    const claudeCommand = [
      `cd ${workDir}`,
      "&&",
      "runuser -u claudeuser -- env HOME=/home/claudeuser",
      `ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}"`,
      "claude",
      `--append-system-prompt "${escapedSystem}"`,
      "--model opus",
      `-p "${escapedTask}"`,
      "--dangerously-skip-permissions",
      "--output-format stream-json",
      "--verbose",
    ].join(" ");

    const stream = await sandbox.execStream(claudeCommand);
    const [backgroundStream, responseStream] = stream.tee();

    ctx.waitUntil(
      consumeAndCleanup(backgroundStream, sandbox, workDir, requestId, task, ANTHROPIC_API_KEY, hasRepo),
    );

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
