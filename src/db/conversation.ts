import type {
  GroupParticipantInfo,
  SystemState,
  UserResearchContext,
} from "@/src/types/conversation";
import prisma from "@/src/db/client";
import { getUserConnections } from "@/src/db/connection";
import { getGroupChatCustomPrompt } from "@/src/db/groupChatSettings";
import { getUserContextByPhone, updateUserContext } from "@/src/db/userContext";
import type { Prisma } from "@/src/generated/prisma";
import { getUserTimezoneFromCalendar } from "@/src/lib/integrations/calendar";
import logger from "@/src/lib/logger";
import type { ModelMessage } from "ai";

/**
 * Get current time info for system state
 * TODO: Support user-specific timezone preferences
 */
function getCurrentTimeInfo(
  timezone: string = "America/Los_Angeles",
): SystemState["currentTime"] {
  const now = new Date();

  const formatted = now.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const dayOfWeek = now.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
  });

  return {
    iso: now.toISOString(),
    formatted,
    timezone,
    dayOfWeek,
  };
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sender?: string;
  messageId?: string;
  createdAt: Date;
}

export interface ConversationContext {
  conversationId: string; // Phone number or group_id
  isGroup: boolean;
  groupName?: string;
  participants: string[];
  summary?: string; // Optional: compressed context summary for future use
  sender?: string; // Phone number of the user who sent the last message (for tool auth)
  userContext?: UserResearchContext | null; // Research-based user context
  systemState?: SystemState | null; // Connection status and other system state
  groupParticipants?: GroupParticipantInfo[] | null; // Identity info for group participants
  recentAttachments?: string[]; // URLs of recent image attachments from the conversation (most recent first)
  groupChatCustomPrompt?: string | null; // Custom prompt for this group chat (injected into system prompt)
  currentApp?: string | null; // Active app ID (e.g., "negotiation"), null = default
}

/**
 * Get or create a conversation by conversationId (phone number or group_id)
 */
export async function getOrCreateConversation(
  conversationId: string,
  isGroup: boolean = false,
  groupName?: string,
  participants: string[] = [],
) {
  let conversation = await prisma.conversation.findUnique({
    where: { conversationId },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        conversationId,
        isGroup,
        groupName,
        participants,
      },
    });
  } else if (isGroup && participants.length > 0) {
    // Update participants if this is a group and we have new participant data
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        groupName,
        participants,
      },
    });
  }

  return conversation;
}

/**
 * Save a user message to the database
 */
export async function saveUserMessage(
  conversationId: string,
  content: string,
  sender: string,
  messageId?: string,
  isGroup: boolean = false,
  attachments: string[] = [],
  groupName?: string,
  participants: string[] = [],
) {
  logger.debug("Saving user message", {
    component: "saveUserMessage",
    conversationId,
    sender,
    messageId,
    isGroup,
  });

  const conversation = await getOrCreateConversation(
    conversationId,
    isGroup,
    groupName,
    participants,
  );

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: content as Prisma.InputJsonValue,
      sender,
      messageId,
      attachments,
    },
  });

  logger.debug("Message created", {
    component: "saveUserMessage",
    id: message.id,
    senderStored: message.sender,
  });

  // Update conversation's lastMessageAt
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  return message;
}

/**
 * Save an assistant message to the database
 * Content is always a plain string (the message text)
 */
export async function saveAssistantMessage(
  conversationId: string,
  content: string,
  messageId?: string,
  attachments?: string[],
) {
  const conversation = await getOrCreateConversation(conversationId);

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: content,
      messageId,
      attachments: attachments || [],
      // Set delivery status to pending if we have a messageId (means we're sending via LoopMessage)
      deliveryStatus: messageId ? "pending" : undefined,
    },
  });

  return message;
}

/**
 * Save a reaction message to the database
 * Reactions are stored as user messages with a special format that the AI can understand
 */
export async function saveReactionMessage(
  conversationId: string,
  reaction: string,
  targetMessageId: string,
  sender: string,
  isGroup: boolean = false,
  groupName?: string,
  participants: string[] = [],
) {
  logger.debug("Saving reaction message", {
    component: "saveReactionMessage",
    conversationId,
    reaction,
    targetMsgId: targetMessageId,
    sender,
  });

  const conversation = await getOrCreateConversation(
    conversationId,
    isGroup,
    groupName,
    participants,
  );

  // Format reaction as a special message that the AI can understand
  const reactionContent = `[REACTION: ${reaction} on msg_id: ${targetMessageId}]`;

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: reactionContent as Prisma.InputJsonValue,
      sender,
      messageId: null, // Reactions don't have their own message ID
      attachments: [],
    },
  });

  logger.debug("Reaction saved", {
    component: "saveReactionMessage",
    id: message.id,
    content: reactionContent,
  });

  // Update conversation's lastMessageAt
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  return message;
}

/**
 * Save a system message to the database (merchant/service messages to be delivered)
 */
export async function saveSystemMessage(
  conversationId: string,
  content: string,
  source: string,
  forwarded?: boolean,
  rejectionReason?: string,
) {
  const conversation = await getOrCreateConversation(conversationId);

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "system",
      content: content as Prisma.InputJsonValue,
      sender: source, // Track the merchant/service source
      attachments: [],
      forwarded,
      rejectionReason,
    },
  });

  // Update conversation's lastMessageAt
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  return message;
}

/**
 * Update system message forwarding status
 */
export async function updateSystemMessageStatus(
  messageId: string,
  forwarded: boolean,
  rejectionReason?: string,
) {
  await prisma.message.update({
    where: { id: messageId },
    data: {
      forwarded,
      rejectionReason,
    },
  });
}

/**
 * Update a message's messageId (for when we get the webhook confirmation)
 */
export async function updateMessageId(
  internalMessageId: string,
  loopMessageId: string,
) {
  await prisma.message.update({
    where: { id: internalMessageId },
    data: { messageId: loopMessageId },
  });
}

/**
 * Get the last N messages for a conversation in AI SDK format
 * Returns both messages and conversation context
 */
export async function getConversationMessages(
  conversationId: string,
  limit: number = 100,
): Promise<{ messages: ModelMessage[]; context: ConversationContext }> {
  const conversation = await prisma.conversation.findUnique({
    where: { conversationId },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: limit,
      },
    },
  });

  if (!conversation) {
    return {
      messages: [],
      context: {
        conversationId,
        isGroup: false,
        participants: [],
      },
    };
  }

  // Reverse to get chronological order (oldest first)
  const messages = conversation.messages.reverse();
  // Convert to AI SDK format with preprocessing
  const formattedMessages = messages
    .map((msg) => formatMessageForAI(msg, conversation.isGroup))
    .filter((msg) => !isEmptyMessage(msg))
    .filter((msg) => {
      // Filter out assistant messages with incomplete tool calls
      // These cause "tool_use without tool_result" errors in Claude API
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some(
          (block: { type?: string }) => block.type === "tool_use",
        );
        if (hasToolUse) {
          console.warn(
            `[getConversationMessages] Filtering out assistant message with tool_use blocks to prevent API errors`,
          );
          return false;
        }
      }
      return true;
    });

  // Get the sender of the last user message (for tool authentication)
  // This is critical for group messages where tools should auth as the sender
  const lastUserMessage = [...messages]
    .reverse()
    .find((msg) => msg.role === "user" && msg.sender);
  const sender = lastUserMessage?.sender ?? undefined;

  logger.debug("Retrieved conversation messages", {
    component: "getConversationMessages",
    conversationId,
    isGroup: conversation.isGroup,
    sender: sender || "NOT_FOUND",
  });
  if (conversation.isGroup && !sender) {
    logger.warn("Group chat but no sender found in messages", {
      component: "getConversationMessages",
      conversationId,
    });
  }

  // Fetch user research context and system state for direct messages
  let userContext: UserResearchContext | null = null;
  let systemState: SystemState | null = null;
  let groupParticipants: GroupParticipantInfo[] | null = null;
  let groupChatCustomPrompt: string | null = null;

  // For group chats, look up participant identities and custom prompt
  if (conversation.isGroup && conversation.participants.length > 0) {
    try {
      groupParticipants = await Promise.all(
        conversation.participants.map(async (phoneNumber) => {
          const participantContext = await getUserContextByPhone(phoneNumber);
          const user = await prisma.user.findUnique({
            where: { phoneNumber },
            select: { name: true },
          });

          // Extract first sentence of summary as brief description
          let brief: string | undefined;
          if (participantContext?.summary) {
            const firstSentence = participantContext.summary.split(/[.!?]/)[0];
            brief = firstSentence ? firstSentence.trim() : undefined;
          }

          return {
            phoneNumber,
            name: user?.name ?? undefined,
            brief,
          };
        }),
      );
    } catch (error) {
      console.warn(
        `[getConversationMessages] Failed to fetch group participant info:`,
        error,
      );
    }

    // Fetch group chat custom prompt
    try {
      groupChatCustomPrompt = await getGroupChatCustomPrompt(conversationId);
    } catch (error) {
      console.warn(
        `[getConversationMessages] Failed to fetch group chat custom prompt:`,
        error,
      );
    }
  }

  if (!conversation.isGroup && sender) {
    try {
      // Get user by phone number to fetch their connections and outbound opt-in
      const user = await prisma.user.findUnique({
        where: { phoneNumber: sender },
        select: { id: true, outboundOptIn: true, hasCompletedOnboarding: true },
      });

      if (user) {
        // Fetch research context
        const researchContext = await getUserContextByPhone(sender);
        if (researchContext) {
          userContext = {
            summary: researchContext.summary,
            interests: researchContext.interests,
            professional: researchContext.professional,
            facts: researchContext.facts,
            recentDocuments: researchContext.documents
              ?.slice(0, 5)
              .map((d) => ({
                title: d.title,
                source: d.source,
              })),
          };
        }

        // Fetch connection status
        const connections = await getUserConnections(user.id);
        const gmailConnected = connections.some(
          (c) => c.provider === "google_gmail" && c.status === "connected",
        );
        const githubConnected = connections.some(
          (c) => c.provider === "github" && c.status === "connected",
        );
        const calendarConnected = connections.some(
          (c) => c.provider === "google_calendar" && c.status === "connected",
        );

        // Get timezone: prefer stored, then try calendar, then null (will prompt user)
        let userTimezone = researchContext?.timezone || null;

        // If no stored timezone but calendar is connected, try to fetch it
        if (!userTimezone && calendarConnected) {
          try {
            const calendarTimezone = await getUserTimezoneFromCalendar(user.id);
            if (calendarTimezone) {
              userTimezone = calendarTimezone;
              // Save it for next time
              await updateUserContext(user.id, { timezone: calendarTimezone });
            }
          } catch {
            // Calendar API failed, ignore
          }
        }

        // Check if user already has a payout
        const existingPayout = await prisma.payout.findUnique({
          where: { userId: user.id },
          select: { id: true },
        });

        systemState = {
          currentTime: getCurrentTimeInfo(
            userTimezone || "America/Los_Angeles",
          ),
          connections: {
            gmail: gmailConnected,
            github: githubConnected,
            calendar: calendarConnected,
          },
          hasAnyConnection:
            gmailConnected || githubConnected || calendarConnected,
          researchStatus: researchContext ? "completed" : "none",
          outboundOptIn: user.outboundOptIn,
          timezoneSource: userTimezone ? "known" : "default",
          isOnboarding: !user.hasCompletedOnboarding,
          hasExistingPayout: !!existingPayout,
        };
      }
    } catch (error) {
      console.warn(
        `[getConversationMessages] Failed to fetch user context:`,
        error,
      );
    }
  }

  // Always provide at least time info, even if no user context
  if (!systemState) {
    systemState = {
      currentTime: getCurrentTimeInfo("America/Los_Angeles"),
      connections: { gmail: false, github: false, calendar: false },
      hasAnyConnection: false,
    };
  }

  // Collect recent image attachments from BOTH user messages AND assistant-generated images
  // This allows tools like createImage to access actual attachment URLs for editing
  // Most recent first, so the agent can reference "the image I just sent" easily
  const recentAttachments = [...messages]
    .reverse() // Most recent first
    .flatMap((msg) => {
      // User messages: get direct attachments
      if (msg.role === "user" && msg.attachments?.length > 0) {
        return msg.attachments;
      }
      // Assistant messages: extract attachments from actions in content
      if (msg.role === "assistant" && typeof msg.content === "object") {
        return extractAssistantAttachments(msg.content);
      }
      return [];
    })
    .filter(isSupportedImageFormat)
    .slice(0, 10); // Limit to 10 most recent

  return {
    messages: formattedMessages,
    context: {
      conversationId,
      isGroup: conversation.isGroup,
      groupName: conversation.groupName ?? undefined,
      participants: conversation.participants,
      summary: conversation.summary ?? undefined,
      sender,
      userContext,
      systemState,
      groupParticipants,
      recentAttachments:
        recentAttachments.length > 0 ? recentAttachments : undefined,
      groupChatCustomPrompt,
      currentApp: conversation.currentApp ?? null,
    },
  };
}

/**
 * Format a single message for AI consumption
 */
function formatMessageForAI(
  msg: {
    role: string;
    content: unknown; // JSON from database
    messageId: string | null;
    sender: string | null;
    attachments: string[];
  },
  isGroup: boolean,
): ModelMessage {
  // Assistant messages: content is ALWAYS a string (we only save strings via saveAssistantMessage)
  // If it's not a string, that's a data integrity issue - log and recover
  if (msg.role === "assistant") {
    if (typeof msg.content !== "string") {
      logger.error(
        "DATA INTEGRITY: Assistant message content is not a string",
        {
          component: "formatMessageForAI",
          contentType: typeof msg.content,
          content: JSON.stringify(msg.content)?.slice(0, 200),
        },
      );
      // Recovery: stringify whatever is there
      const recovered =
        msg.content === null || msg.content === undefined
          ? "[empty]"
          : JSON.stringify(msg.content);
      return { role: "assistant", content: recovered } as ModelMessage;
    }
    return { role: "assistant", content: msg.content } as ModelMessage;
  }

  // For user/system messages, apply formatting (may include images)
  const content = buildMessageContent(msg);

  // System messages (merchant/service messages to be delivered)
  if (msg.role === "system") {
    return {
      role: "user",
      content: `[SYSTEM: Deliver this message from ${msg.sender}]\n${content}`,
    } as ModelMessage;
  }

  // Group chat user messages include sender name
  if (msg.role === "user" && isGroup && msg.sender) {
    return { role: "user", content, name: msg.sender } as ModelMessage;
  }

  if (msg.role === "user") {
    return { role: "user", content } as ModelMessage;
  }

  return { role: "assistant", content } as ModelMessage;
}

/**
 * Extract attachment URLs from assistant message content
 * Assistant messages contain actions with attachments arrays
 */
function extractAssistantAttachments(content: unknown): string[] {
  try {
    // Content should be { actions: [...] } structure
    if (typeof content !== "object" || content === null) {
      return [];
    }

    const contentObj = content as { actions?: unknown[] };
    if (!Array.isArray(contentObj.actions)) {
      return [];
    }

    // Extract attachments from each action
    return contentObj.actions
      .filter(
        (action): action is { type: string; attachments?: string[] } =>
          typeof action === "object" &&
          action !== null &&
          (action as { type?: string }).type === "message",
      )
      .flatMap((action) => action.attachments || []);
  } catch {
    return [];
  }
}

/**
 * Supported image formats for Claude API
 * HEIC, TIFF, BMP, and other formats are NOT supported
 */
const SUPPORTED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

/**
 * Check if a URL points to a supported image format
 */
function isSupportedImageFormat(url: string): boolean {
  try {
    const urlLower = url.toLowerCase();
    // Check file extension
    const hasExtension = SUPPORTED_IMAGE_EXTENSIONS.some((ext) =>
      urlLower.includes(ext),
    );
    if (hasExtension) return true;

    // Check for common image MIME types in URL params (e.g., content-type)
    if (
      urlLower.includes("image/jpeg") ||
      urlLower.includes("image/png") ||
      urlLower.includes("image/gif") ||
      urlLower.includes("image/webp")
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Build message content with attachments and message ID
 */
function buildMessageContent(msg: {
  content: unknown; // Can be string or structured content
  messageId: string | null;
  attachments: string[];
}):
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; image: string }> {
  // If content is not a string (structured content), we can't format it further
  // This should only happen for assistant messages with tool calls which are handled separately
  if (typeof msg.content !== "string") {
    return msg.content as Array<
      { type: "text"; text: string } | { type: "image"; image: string }
    >;
  }

  const hasAttachments = msg.attachments && msg.attachments.length > 0;

  // Simple text-only message
  if (!hasAttachments) {
    return msg.messageId
      ? `[msg_id: ${msg.messageId}] ${msg.content}`
      : msg.content;
  }

  // Separate supported images from unsupported attachments
  const supportedImages = msg.attachments.filter(isSupportedImageFormat);
  const unsupportedAttachments = msg.attachments.filter(
    (url) => !isSupportedImageFormat(url),
  );

  // Multi-part message with attachments
  const parts: Array<
    { type: "text"; text: string } | { type: "image"; image: string }
  > = [];

  if (msg.messageId) {
    parts.push({ type: "text", text: `[msg_id: ${msg.messageId}]` });
  }

  if (msg.content?.trim()) {
    parts.push({ type: "text", text: msg.content });
  }

  // Add supported images as image parts
  for (const url of supportedImages) {
    parts.push({ type: "image", image: url });
  }

  // Mention unsupported attachments as text so the AI knows about them
  if (unsupportedAttachments.length > 0) {
    const attachmentNote =
      unsupportedAttachments.length === 1
        ? "[User also sent an attachment in an unsupported format (e.g., HEIC, video, audio)]"
        : `[User also sent ${unsupportedAttachments.length} attachments in unsupported formats (e.g., HEIC, video, audio)]`;
    parts.push({ type: "text", text: attachmentNote });
  }

  return parts;
}

/**
 * Check if a message is empty and should be filtered out
 */
function isEmptyMessage(msg: ModelMessage): boolean {
  if (typeof msg.content === "string") {
    return msg.content.trim().length === 0;
  }
  return msg.content.length === 0;
}

/**
 * Get the lastMessageAt timestamp for a conversation
 */
export async function getLastMessageTimestamp(
  conversationId: string,
): Promise<Date | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { conversationId },
    select: { lastMessageAt: true },
  });

  return conversation?.lastMessageAt ?? null;
}

/**
 * Check if a conversation has received new messages since a given timestamp
 */
export async function hasNewMessagesSince(
  conversationId: string,
  timestamp: Date,
): Promise<boolean> {
  const lastMessageAt = await getLastMessageTimestamp(conversationId);

  if (!lastMessageAt) {
    return false;
  }

  return lastMessageAt > timestamp;
}

type SenderLockInfo = { taskId: string; lockedAt: string };
type SenderLocks = Record<string, SenderLockInfo>;

/**
 * Acquire lock for sending messages in a conversation.
 * Always overwrites existing lock - previous task will abort via isCurrentGeneration().
 */
export async function acquireResponseLock(
  conversationId: string,
  taskId: string,
  sender?: string,
  isGroup?: boolean,
): Promise<boolean> {
  const conversation = await getOrCreateConversation(conversationId);
  const now = new Date();

  if (isGroup && sender) {
    const senderLocks = (conversation.senderLocks as SenderLocks) || {};
    const updatedLocks: SenderLocks = {
      ...senderLocks,
      [sender]: { taskId, lockedAt: now.toISOString() },
    };
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { senderLocks: updatedLocks },
    });
    return true;
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      activeResponseTaskId: taskId,
      lockAcquiredAt: now,
    },
  });

  return true;
}

export async function releaseResponseLock(
  conversationId: string,
  taskId: string,
  sender?: string,
  isGroup?: boolean,
): Promise<void> {
  const conversation = await getOrCreateConversation(conversationId);

  if (isGroup && sender) {
    const senderLocks = (conversation.senderLocks as SenderLocks) || {};
    const existingLock = senderLocks[sender];

    if (existingLock?.taskId === taskId) {
      const updatedLocks = { ...senderLocks };
      delete updatedLocks[sender];
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { senderLocks: updatedLocks },
      });
    }
    return;
  }

  if (conversation.activeResponseTaskId === taskId) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        activeResponseTaskId: null,
        lockAcquiredAt: null,
        interruptRequested: false,
      },
    });
  }
}

/**
 * Check if this task still owns the generation lock (not superseded by a newer task)
 */
export async function isCurrentGeneration(
  conversationId: string,
  taskId: string,
  sender?: string,
  isGroup?: boolean,
): Promise<boolean> {
  const conversation = await prisma.conversation.findUnique({
    where: { conversationId },
    select: { activeResponseTaskId: true, senderLocks: true },
  });

  if (!conversation) {
    return false;
  }

  if (isGroup && sender) {
    const senderLocks = (conversation.senderLocks as SenderLocks) || {};
    return senderLocks[sender]?.taskId === taskId;
  }

  return conversation.activeResponseTaskId === taskId;
}

/**
 * Update the delivery status of a message by its LoopMessage message_id
 */
export async function updateMessageDeliveryStatus(
  loopMessageId: string,
  status: "pending" | "scheduled" | "sent" | "failed" | "timeout",
  error?: string,
): Promise<boolean> {
  try {
    // Find messages with this LoopMessage ID (could be multiple if retried)
    const messages = await prisma.message.findMany({
      where: { messageId: loopMessageId },
    });

    if (messages.length === 0) {
      logger.warn("No message found for delivery status update", {
        component: "updateMessageDeliveryStatus",
        loopMessageId,
        status,
      });
      return false;
    }

    // Update all matching messages (usually just one)
    await prisma.message.updateMany({
      where: { messageId: loopMessageId },
      data: {
        deliveryStatus: status,
        deliveryError: error || null,
      },
    });

    logger.debug("Updated message delivery status", {
      component: "updateMessageDeliveryStatus",
      loopMessageId,
      status,
      messageCount: messages.length,
    });

    return true;
  } catch (err) {
    logger.error("Failed to update message delivery status", {
      component: "updateMessageDeliveryStatus",
      loopMessageId,
      status,
      error: err,
    });
    return false;
  }
}
