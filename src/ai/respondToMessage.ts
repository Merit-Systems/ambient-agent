import type { Agent } from "@/src/ai/agents/types";
import type { ConversationContext } from "@/src/db/conversation";
import logger from "@/src/lib/logger";
import type { MessageAction } from "@/src/lib/loopmessage-sdk/message-actions";
import type { ModelMessage } from "ai";

export type { MessageAction } from "@/src/lib/loopmessage-sdk/message-actions";

export interface RespondToMessageOptions {
  onToolsInvoked?: (toolNames: string[]) => Promise<void>;
  abortController?: AbortController;
  checkShouldAbort?: () => Promise<boolean>;
}

function buildClaudePrompt(
  agent: Agent,
  messages: ModelMessage[],
  context: ConversationContext,
): string {
  const parts: string[] = [];

  parts.push("You are responding to an iMessage conversation.");
  parts.push("");
  parts.push("=== PERSONALITY ===");
  parts.push(agent.personality.prompt);
  parts.push("");
  parts.push("=== CONVERSATION INFO ===");
  parts.push(`Conversation ID: ${context.conversationId}`);
  parts.push(`Type: ${context.isGroup ? "GROUP CHAT" : "DIRECT MESSAGE"}`);

  if (context.isGroup && context.sender) {
    parts.push(`Current sender: ${context.sender}`);
  }

  if (context.summary) {
    parts.push(`Summary: ${context.summary}`);
  }

  if (context.systemState?.currentTime) {
    const { formatted, timezone } = context.systemState.currentTime;
    parts.push(`Current time: ${formatted} (${timezone})`);
  }

  if (context.groupParticipants && context.groupParticipants.length > 0) {
    parts.push("");
    parts.push("Group participants:");
    for (const p of context.groupParticipants) {
      const name = p.name || "Unknown";
      const brief = p.brief ? ` - ${p.brief}` : "";
      parts.push(`  ${p.phoneNumber}: ${name}${brief}`);
    }
  }

  if (context.userContext) {
    parts.push("");
    parts.push("User context:");
    if (context.userContext.summary) parts.push(`  ${context.userContext.summary}`);
    if (context.userContext.interests?.length) {
      parts.push(`  Interests: ${context.userContext.interests.join(", ")}`);
    }
  }

  if (context.systemState) {
    const connected: string[] = [];
    if (context.systemState.connections.gmail) connected.push("Gmail");
    if (context.systemState.connections.github) connected.push("GitHub");
    if (context.systemState.connections.calendar) connected.push("Calendar");
    if (connected.length > 0) {
      parts.push(`Connected accounts: ${connected.join(", ")}`);
    }
  }

  parts.push("");
  parts.push("=== OUTPUT FORMAT ===");
  parts.push("You MUST output ONLY a valid JSON array of MessageAction objects. No markdown, no explanation, just the JSON array.");
  parts.push("Each action: { type: \"message\"|\"reaction\", text?, attachments?, effect?, delay?, message_id?, reaction? }");
  parts.push("Effects: slam, loud, gentle, invisible-ink, confetti, fireworks, lasers, love, balloons, spotlight, echo");
  parts.push("Reactions: love, like, dislike, laugh, exclaim, question (prefix with - to remove)");
  parts.push("Return [] if no response needed (especially in group chats).");
  parts.push("");
  parts.push("=== IMESSAGE RULES ===");
  parts.push("Message IDs: User messages include [msg_id: ABC123]. Extract message_id from brackets for reactions.");
  parts.push("");
  if (context.isGroup) {
    parts.push("GROUP CHAT: Respond in 1 message max (2 if absolutely necessary). Often a reaction is better. You do NOT need to respond to everything.");
  } else {
    parts.push("DM: Use multiple messages for fragmented thoughts (max 3-4). Add delays (500-8000ms) between messages.");
  }
  parts.push("");
  parts.push("Reactions: Incoming reactions appear as [REACTION: {type} on msg_id: {id}]. Usually return [] for incoming reactions.");
  parts.push("System messages: [SYSTEM: Deliver this message from X] MUST be delivered - you are a delivery service.");
  parts.push("");

  if (context.recentAttachments && context.recentAttachments.length > 0) {
    parts.push("=== RECENT IMAGES ===");
    context.recentAttachments.slice(0, 3).forEach((url, i) => {
      parts.push(`Image ${i}: ${url}`);
    });
    parts.push("");
  }

  parts.push("=== CONVERSATION HISTORY ===");
  for (const msg of messages) {
    const role = msg.role === "user" ? "USER" : "ASSISTANT";
    const content = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
    parts.push(`[${role}] ${content}`);
  }

  return parts.join("\n");
}

async function consumeClaudeStream(response: Response): Promise<string> {
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claudflare error ${response.status}: ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body from claudflare");

  const decoder = new TextDecoder();
  let buffer = "";
  let lastResultText = "";

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
        if (event.type === "result" && event.result) {
          lastResultText = event.result;
        } else if (event.type === "content" && event.content) {
          lastResultText = event.content;
        }
      } catch {
        // not JSON, skip
      }
    }
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer);
      if (event.type === "result" && event.result) {
        lastResultText = event.result;
      } else if (event.type === "content" && event.content) {
        lastResultText = event.content;
      }
    } catch {
      if (!lastResultText) lastResultText = buffer;
    }
  }

  return lastResultText;
}

function parseActions(text: string): MessageAction[] {
  const trimmed = text.trim();

  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn("Could not find JSON array in claudflare response", { text: trimmed.slice(0, 500) });
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed as MessageAction[];
  } catch (err) {
    logger.error("Failed to parse actions from claudflare response", { error: err, text: trimmed.slice(0, 500) });
    return [];
  }
}

async function getWorkspaceForConversation(context: ConversationContext): Promise<string> {
  if (context.userContext?.professional) {
    const prof = context.userContext.professional as Record<string, Record<string, string>>;
    if (prof.github?.username) return prof.github.username;
  }
  return "default";
}

export async function respondToMessage(
  agent: Agent,
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

  const prompt = buildClaudePrompt(agent, messages, context);
  const workspaceUsername = await getWorkspaceForConversation(context);
  const requestId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  log.info("Sending to claudflare", { requestId, workspaceUsername });

  if (options?.onToolsInvoked) {
    options.onToolsInvoked(["claudflare"]).catch((err) => {
      log.error("Error in onToolsInvoked callback", { error: err });
    });
  }

  const response = await fetch(`${claudflareUrl}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${claudflareSecret}`,
      "X-Request-ID": requestId,
    },
    body: JSON.stringify({
      task: prompt,
      repo: `MeritSpace/${workspaceUsername}`,
    }),
    signal: options?.abortController?.signal,
  });

  const finalText = await consumeClaudeStream(response);
  const actions = parseActions(finalText);

  const after = performance.now();
  log.info("Claudflare response", {
    timeMs: Math.round(after - before),
    actionCount: actions.length,
  });

  return actions;
}
