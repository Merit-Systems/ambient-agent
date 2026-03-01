import { mrWhiskersAgent } from "@/src/ai/agents/mrWhiskers";
import { respondToMessage } from "@/src/ai/respondToMessage";
import {
  acquireResponseLock,
  getConversationMessages,
  isCurrentGeneration,
  releaseResponseLock,
} from "@/src/db/conversation";
import { createContextLogger } from "@/src/lib/logger";
import { task, wait } from "@trigger.dev/sdk/v3";
import { logTaskCompleted, logTaskFailed, logTaskStarted } from "../taskEvents";
import { handleMessageResponse } from "./handleMessage";

type DebouncedResponsePayload = {
  conversationId: string;
  recipient?: string;
  group?: string;
  timestampWhenTriggered: string;
  isNewUser?: boolean;
};

export const debouncedResponse = task({
  id: "debounced-response",
  machine: {
    preset: "medium-1x",
  },
  run: async (payload: DebouncedResponsePayload, { ctx }) => {
    const taskId = ctx.run.id;
    const isGroup = !!payload.group;
    const sender = isGroup ? payload.recipient : undefined;
    const startTime = performance.now();

    const taskCtx = {
      taskId,
      taskName: "debounced-response",
      conversationId: payload.conversationId,
      userId: sender,
    };

    const log = createContextLogger({
      component: "debouncedResponse",
      conversationId: payload.conversationId,
      groupId: payload.group,
      sender,
    });

    await logTaskStarted(taskCtx, { isGroup, isNewUser: payload.isNewUser });

    await wait.for({ seconds: 1 });

    await acquireResponseLock(payload.conversationId, taskId, sender, isGroup);
    log.info("Lock acquired, starting generation");

    const { messages, context } = await getConversationMessages(
      payload.conversationId,
      20,
    );

    if (messages.length === 0) {
      log.info("No messages found");
      const result = { skipped: true, reason: "no_messages" };
      await logTaskCompleted(taskCtx, result, performance.now() - startTime);
      return result;
    }

    if (isGroup && sender) {
      context.sender = sender;
    }

    log.info("Processing conversation", {
      type: context.isGroup ? "GROUP_CHAT" : "DIRECT_MESSAGE",
      sender: context.sender || "NOT_FOUND",
      messageCount: messages.length,
    });

    const abortController = new AbortController();
    const checkShouldAbort = async () => {
      const isCurrent = await isCurrentGeneration(
        payload.conversationId,
        taskId,
        sender,
        isGroup,
      );
      return !isCurrent;
    };

    try {
      const actions = await respondToMessage(
        mrWhiskersAgent,
        messages,
        context,
        { abortController, checkShouldAbort },
      );

      if (abortController.signal.aborted) {
        log.info("Generation aborted (superseded)");
        const result = { skipped: true, reason: "superseded" };
        await logTaskCompleted(taskCtx, result, performance.now() - startTime);
        return result;
      }

      if (actions.length === 0) {
        const lastMsg = messages[messages.length - 1];
        const lastMsgPreview =
          typeof lastMsg?.content === "string"
            ? lastMsg.content.slice(0, 100)
            : JSON.stringify(lastMsg?.content)?.slice(0, 100);
        log.warn("AI decided not to respond", {
          isGroup,
          sender: context.sender,
          messageCount: messages.length,
          lastMessage: lastMsgPreview,
        });
        await releaseResponseLock(payload.conversationId, taskId, sender, isGroup);
        const result = { success: true, actionsExecuted: 0, noResponseNeeded: true };
        await logTaskCompleted(taskCtx, result, performance.now() - startTime);
        return result;
      }

      await handleMessageResponse.triggerAndWait({
        conversationId: payload.conversationId,
        recipient: payload.recipient,
        group: payload.group,
        actions,
        taskId,
        sender,
        isGroup,
      });

      const result = { success: true, actionsExecuted: actions.length };
      await logTaskCompleted(taskCtx, result, performance.now() - startTime);
      return result;
    } catch (error) {
      await releaseResponseLock(payload.conversationId, taskId, sender, isGroup);
      await logTaskFailed(
        taskCtx,
        error instanceof Error ? error : String(error),
        performance.now() - startTime,
      );
      throw error;
    }
  },
});
