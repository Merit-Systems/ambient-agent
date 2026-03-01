import type { Agent } from "@/src/ai/agents/types";
import type { ConversationContext } from "@/src/db/conversation";
import logger from "@/src/lib/logger";
import type { MessageAction } from "@/src/lib/loopmessage-sdk/message-actions";
import type {
  GroupParticipantInfo,
  SystemState,
  UserResearchContext,
} from "@/src/types/conversation";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

export type { MessageAction } from "@/src/lib/loopmessage-sdk/message-actions";

type ModelMessage = {
  role: string;
  content: string | unknown[];
};

export interface RespondToMessageOptions {
  abortController?: AbortController;
  checkShouldAbort?: () => Promise<boolean>;
}

/**
 * Build a short context block (time, conversation type, participants).
 */
function buildContextBlock(context: {
  conversationId: string;
  isGroup: boolean;
  summary?: string;
  userContext?: UserResearchContext | null;
  systemState?: SystemState | null;
  groupParticipants?: GroupParticipantInfo[] | null;
  sender?: string;
  groupChatCustomPrompt?: string | null;
}): string {
  const parts: string[] = [];

  if (context.systemState?.currentTime) {
    const { formatted, timezone, dayOfWeek } = context.systemState.currentTime;
    parts.push(`CURRENT TIME: ${formatted} (${timezone})`);
    parts.push(`Today is ${dayOfWeek}`);
    parts.push("");
  }

  parts.push(`CONVERSATION ID: ${context.conversationId}`);
  parts.push("");

  if (context.isGroup) {
    parts.push("CONVERSATION TYPE: GROUP CHAT");
    if (context.groupChatCustomPrompt) {
      parts.push(`GROUP BEHAVIOR: ${context.groupChatCustomPrompt}`);
    }
    if (context.groupParticipants && context.groupParticipants.length > 0) {
      parts.push("PARTICIPANTS:");
      for (const p of context.groupParticipants) {
        const name = p.name || "Unknown";
        const brief = p.brief ? ` - ${p.brief}` : "";
        parts.push(`• ${p.phoneNumber}: ${name}${brief}`);
      }
    }
    if (context.sender) {
      const senderInfo = context.groupParticipants?.find(
        (p) => p.phoneNumber === context.sender,
      );
      parts.push(
        `CURRENT SENDER: ${senderInfo?.name || "Unknown"} (${context.sender})`,
      );
    }
  } else {
    parts.push("CONVERSATION TYPE: DIRECT MESSAGE (1-on-1)");
  }

  if (context.summary) {
    parts.push(`\nSUMMARY: ${context.summary}`);
  }

  if (context.userContext?.summary) {
    parts.push(`\nUSER CONTEXT: ${context.userContext.summary}`);
  }

  if (context.systemState) {
    const connected: string[] = [];
    if (context.systemState.connections?.gmail) connected.push("Gmail");
    if (context.systemState.connections?.github) connected.push("GitHub");
    if (context.systemState.connections?.calendar) connected.push("Calendar");
    if (connected.length > 0) {
      parts.push(`Connected: ${connected.join(", ")}`);
    }
  }

  return parts.join("\n");
}

/**
 * Extract only the new user messages since the last assistant response.
 * Claude agent SDK sessions are stateful — we only need to send what's new.
 */
function getNewUserMessages(messages: ModelMessage[]): string {
  const newMessages: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") break;
    newMessages.unshift(
      typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content),
    );
  }

  return newMessages.join("\n\n");
}

/**
 * Parse the Claude response into MessageAction[].
 * Tries JSON.parse directly first, then regex extraction.
 */
function parseActions(text: string): MessageAction[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try direct parse (cleanest path)
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as MessageAction[];
  } catch {
    // not clean JSON
  }

  // Fall back: extract JSON array from surrounding text
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn("Could not find JSON array in agent SDK response", {
      text: trimmed.slice(0, 500),
    });
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed as MessageAction[];
  } catch (err) {
    logger.error("Failed to parse actions from agent SDK response", {
      error: err,
      text: trimmed.slice(0, 500),
    });
    return [];
  }
}

/**
 * Session store — maps conversationId to the session UUID from the agent SDK.
 * This allows us to resume conversations across requests.
 */
const sessionStore = new Map<string, string>();

export async function respondToMessage(
  _agent: Agent,
  messages: ModelMessage[],
  context: ConversationContext,
  options?: RespondToMessageOptions,
): Promise<MessageAction[]> {
  const before = performance.now();
  const log = logger.child({
    component: "respondToMessage",
    conversationId: context.conversationId,
    isGroup: context.isGroup,
    sender: context.sender,
  });

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY must be set");
  }

  // Build prompt: context metadata + only new user messages
  const contextBlock = buildContextBlock({
    conversationId: context.conversationId,
    isGroup: context.isGroup,
    summary: context.summary,
    userContext: context.userContext,
    systemState: context.systemState,
    groupParticipants: context.groupParticipants,
    sender: context.sender,
    groupChatCustomPrompt: context.groupChatCustomPrompt,
  });

  const newMessages = getNewUserMessages(messages);
  const prompt = `${contextBlock}\n\n${newMessages}`;

  log.info("Sending to agent SDK", {
    conversationId: context.conversationId,
    promptLength: prompt.length,
    hasExistingSession: sessionStore.has(context.conversationId),
  });

  // Build agent SDK options
  const existingSessionId = sessionStore.get(context.conversationId);

  const sdkOptions: Options = {
    model: "claude-sonnet-4-5-20250929",
    permissionMode: "bypassPermissions",
    systemPrompt: _agent.personality.prompt,
    maxTurns: 3,
    env: {
      ...process.env as Record<string, string>,
      ANTHROPIC_API_KEY: anthropicApiKey,
    },
    // Resume existing session if we have one
    ...(existingSessionId && { resume: existingSessionId }),
    // Disable built-in tools — Mr. Whiskers just generates JSON actions
    tools: [],
    // Configure agentcash MCP for x402 tool access
    mcpServers: {
      agentcash: {
        command: "npx",
        args: ["-y", "agentcash@latest", "server", "--provider", "whiskers"],
      },
    },
  };

  if (options?.abortController) {
    sdkOptions.abortController = options.abortController;
  }

  try {
    let resultText = "";
    let sessionId: string | undefined;

    for await (const message of query({ prompt, options: sdkOptions })) {
      // Check for abort between messages
      if (options?.checkShouldAbort) {
        const shouldAbort = await options.checkShouldAbort();
        if (shouldAbort) {
          options.abortController?.abort();
          return [];
        }
      }

      if (message.type === "result") {
        if ("result" in message && typeof message.result === "string") {
          resultText = message.result;
        }
        if ("session_id" in message && message.session_id) {
          sessionId = message.session_id;
        }
      }

      // Also capture assistant text as fallback
      if (
        message.type === "assistant" &&
        "message" in message &&
        message.message?.content
      ) {
        for (const block of message.message.content) {
          if (
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string"
          ) {
            resultText = block.text;
          }
        }
      }
    }

    // Store session ID for future resumption
    if (sessionId) {
      sessionStore.set(context.conversationId, sessionId);
      log.info("Session stored", { conversationId: context.conversationId, sessionId });
    }

    const after = performance.now();
    log.info("Agent SDK response received", {
      timeMs: Math.round(after - before),
      responseLength: resultText.length,
      preview: resultText.slice(0, 200),
    });

    if (!resultText) {
      log.warn("Empty response from agent SDK");
      return [];
    }

    return parseActions(resultText);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error("Agent SDK query failed", { error: errorMsg });
    throw error;
  }
}
