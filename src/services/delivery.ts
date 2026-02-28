import { mrWhiskersAgent } from "@/src/ai/agents/mrWhiskers";
import { respondToMessage } from "@/src/ai/respondToMessage";
import {
  getConversationMessages,
  saveSystemMessage,
  updateSystemMessageStatus,
} from "@/src/db/conversation";
import type { QueuedMessage } from "@/src/lib/message-queue/types";
import type { EvaluationResult } from "@/src/services/prioritization";
import type { handleMessageResponse } from "@/src/trigger/tasks/handleMessage";
import { tasks } from "@trigger.dev/sdk/v3";

export interface DeliveryResult {
  success: boolean;
  conversationId: string;
  messageStored: boolean;
  forwarded: boolean;
  responseTaskId?: string;
  error?: string;
  rejectionReason?: string;
}

/**
 * Deliver a message that passed prioritization to a recipient
 *
 * This function:
 * 1. Stores the raw message in the conversation as a "user" message
 * 2. Fetches full conversation context
 * 3. Calls Mr. Whiskers to format/deliver the message
 * 4. Executes the formatted response via handleMessageResponse task
 * 5. All messages are automatically persisted by the existing flow
 *
 * @param queuedMessage The original queued message
 * @param conversationId The conversation to deliver to (phone number)
 * @param evaluation The evaluation result (for context)
 * @returns Delivery result with success status and task ID
 */
export async function deliverMessage(
  queuedMessage: QueuedMessage,
  conversationId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  evaluation: EvaluationResult,
): Promise<DeliveryResult> {
  try {
    console.log(
      `[Delivery] Starting delivery for message ${queuedMessage.id} to ${conversationId}`,
    );

    // Step 1: Store raw message in conversation as a SYSTEM message (not from user)
    const messageContent = formatRawMessageForStorage(queuedMessage);

    const systemMessage = await saveSystemMessage(
      conversationId,
      messageContent,
      queuedMessage.source, // sender is the source/merchant
      undefined, // forwarded status will be updated later
      undefined, // rejection reason (if any)
    );

    console.log(
      `[Delivery] Stored raw message in conversation ${conversationId}`,
    );

    // Step 2: Get conversation history and context
    const { messages, context } = await getConversationMessages(conversationId, 20);

    console.log(
      `[Delivery] Loaded ${messages.length} messages for context in ${conversationId}`,
    );

    // Step 3: Generate Mr. Whiskers' formatted response
    const actions = await respondToMessage(mrWhiskersAgent, messages, context);

    console.log(
      `[Delivery] Mr. Whiskers generated ${actions.length} actions for ${conversationId}`,
    );

    // System messages MUST be forwarded - if agent returned no actions, create a default forward
    if (actions.length === 0) {
      console.warn(
        `[Delivery] WARNING: Mr. Whiskers returned 0 actions for System message. Creating default forward action.`,
      );

      // Extract the message content for fallback delivery
      const fallbackMessage = extractMessageFromPayload(queuedMessage.payload);

      // Create a simple forward action - just the raw message
      actions.push({
        type: "message",
        text: fallbackMessage || JSON.stringify(queuedMessage.payload, null, 2),
      });

      console.log(
        `[Delivery] Created fallback forward action for ${conversationId}`,
      );
    }

    // Mark system message as forwarded
    await updateSystemMessageStatus(systemMessage.id, true);

    // Step 4: Execute the response via handleMessageResponse task
    const taskId = `delivery-${queuedMessage.id}-${Date.now()}`;

    // Trigger the message response task
    const handle = await tasks.trigger<typeof handleMessageResponse>(
      "handle-message-response",
      {
        conversationId,
        recipient: conversationId, // For DMs, recipient is the phone number
        actions,
        taskId,
        sender: undefined, // For DMs, no sender needed
        isGroup: false, // delivery.ts only handles DMs
      },
    );

    console.log(
      `[Delivery] Triggered response task ${handle.id} for ${conversationId}`,
    );

    return {
      success: true,
      conversationId,
      messageStored: true,
      forwarded: true,
      responseTaskId: handle.id,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    console.error(
      `[Delivery] Failed to deliver message ${queuedMessage.id} to ${conversationId}:`,
      errorMessage,
    );

    // Try to mark the system message as rejected if we stored it
    try {
      // We need to get the system message ID - for now just log the failure
      // In a production system, you'd want to track the message ID from earlier
      console.error(
        `[Delivery] Message ${queuedMessage.id} rejected: ${errorMessage}`,
      );
    } catch (updateError) {
      console.error(
        `[Delivery] Failed to update rejection status:`,
        updateError,
      );
    }

    return {
      success: false,
      conversationId,
      messageStored: false,
      forwarded: false,
      error: errorMessage,
      rejectionReason: errorMessage,
    };
  }
}

/**
 * Format the raw message for storage in the conversation
 * Always include the full JSON payload - prioritization already approved it
 */
function formatRawMessageForStorage(queuedMessage: QueuedMessage): string {
  // Always store the full payload as JSON
  return JSON.stringify(queuedMessage.payload, null, 2);
}

/**
 * Extract the main message text from the payload for fallback forwarding
 * Tries common field names: message, text, content, body
 */
function extractMessageFromPayload(payload: Record<string, unknown>): string {
  // Try common message field names
  const messageFields = ["message", "text", "content", "body"];

  for (const field of messageFields) {
    const value = payload[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  // If no standard field found, return empty (will show full payload)
  return "";
}

/**
 * Batch deliver messages to multiple recipients
 * Only delivers to recipients who passed prioritization
 */
export async function batchDeliverMessages(
  queuedMessage: QueuedMessage,
  deliveries: Array<{
    conversationId: string;
    evaluation: EvaluationResult;
  }>,
): Promise<DeliveryResult[]> {
  console.log(
    `[Delivery] Starting batch delivery for message ${queuedMessage.id} to ${deliveries.length} recipients`,
  );

  // Filter to only deliver to those who passed
  const passing = deliveries.filter((d) => d.evaluation.passed);

  console.log(
    `[Delivery] ${passing.length}/${deliveries.length} recipients passed prioritization`,
  );

  // Deliver to all passing recipients in parallel
  const results = await Promise.all(
    passing.map(({ conversationId, evaluation }) =>
      deliverMessage(queuedMessage, conversationId, evaluation),
    ),
  );

  const successful = results.filter((r) => r.success).length;
  console.log(
    `[Delivery] Batch delivery complete: ${successful}/${passing.length} successful`,
  );

  return results;
}
