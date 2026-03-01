import type { Agent } from "@/src/ai/agents/types";
import type { ConversationContext } from "@/src/db/conversation";
import logger from "@/src/lib/logger";
import type { MessageAction } from "@/src/lib/loopmessage-sdk/message-actions";
import type {
  GroupParticipantInfo,
  SystemState,
  UserResearchContext,
} from "@/src/types/conversation";

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
 * This is passed as metadata alongside the new message — NOT the full history.
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
 * Claude Code sessions are stateful — we only need to send what's new.
 */
function getNewUserMessages(messages: ModelMessage[]): string {
  const newMessages: string[] = [];

  // Walk backwards to find messages since last assistant response
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
 * Consume Claude Code stream-json output.
 *
 * Returns the `result` string from the final result event.
 * Falls back to the last assistant text block if no result event.
 */
async function consumeClaudeStream(response: Response): Promise<string> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claudflare error ${response.status}: ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body from claudflare");

  const decoder = new TextDecoder();
  let buffer = "";
  let resultText = "";
  let lastAssistantText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              lastAssistantText = block.text;
            }
          }
        }

        if (event.type === "result" && typeof event.result === "string") {
          resultText = event.result;
        }
      } catch {
        // not JSON, skip
      }
    }
  }

  // Handle any remaining buffer
  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer);
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            lastAssistantText = block.text;
          }
        }
      }
      if (event.type === "result" && typeof event.result === "string") {
        resultText = event.result;
      }
    } catch {
      // ignore
    }
  }

  // Prefer the result event, fall back to last assistant text
  return resultText || lastAssistantText;
}

/**
 * Parse the Claude response into MessageAction[].
 *
 * Tries JSON.parse directly first (ideal case — Claude returns clean JSON).
 * Falls back to regex extraction if there's surrounding text.
 */
function parseActions(text: string): MessageAction[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try direct parse first (cleanest path)
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed as MessageAction[];
  } catch {
    // not clean JSON, try extraction
  }

  // Fall back: extract JSON array from surrounding text
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn("Could not find JSON array in claudflare response", {
      text: trimmed.slice(0, 500),
    });
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed as MessageAction[];
  } catch (err) {
    logger.error("Failed to parse actions from claudflare response", {
      error: err,
      text: trimmed.slice(0, 500),
    });
    return [];
  }
}

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

  const claudflareUrl = process.env.CLAUDFLARE_URL;
  const claudflareSecret = process.env.CLAUDFLARE_API_KEY;

  if (!claudflareUrl || !claudflareSecret) {
    throw new Error("CLAUDFLARE_URL and CLAUDFLARE_API_KEY must be set");
  }

  // Build the prompt: context metadata + only new user messages
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

  const requestId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  log.info("Sending to claudflare", {
    requestId,
    conversationId: context.conversationId,
    promptLength: prompt.length,
    newMessageLength: newMessages.length,
  });

  const response = await fetch(`${claudflareUrl}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${claudflareSecret}`,
      "X-Request-ID": requestId,
    },
    body: JSON.stringify({
      task: prompt,
      sessionId: context.conversationId,
    }),
    signal: options?.abortController?.signal,
  });

  const finalText = await consumeClaudeStream(response);
  const after = performance.now();

  log.info("Claudflare response received", {
    requestId,
    timeMs: Math.round(after - before),
    responseLength: finalText.length,
    preview: finalText.slice(0, 200),
  });

  if (!finalText) {
    log.warn("Empty response from claudflare");
    return [];
  }

  return parseActions(finalText);
}
