import type { WorkflowDraft } from "@grasp-os/shared/workflow-resources";
import { useEffect } from "react";

import { useActiveChat } from "../chat/active-chat.ts";
import { useChatSubject } from "../chat/chat-subject.ts";
import { useFollowedChat } from "../chat/chat-watch.ts";
import { useCore } from "../use-core.ts";

// A workflow drawn with Grasp: its builders' chat about it
// (chat/chat-subject.ts) is docked beside its Flow, and every question
// asked there names the workflow to the chat's agent, which edits its
// draft (`env.workflowBuild`). The Flow follows the draft as it does.

/** How often the page reads the draft again while the chat's agent works, in milliseconds. */
const whileWorking = 2000;

/**
 * Follows `workflow`'s draft as the chat docked beside it may
 * change it: while the chat's agent works, the draft is read again every
 * {@link whileWorking} milliseconds, and again as each of its steps lands
 * and as it stops; `onDraft` takes each read, so the Flow draws the latest
 * revision that passes. Core tells the page nothing of a draft's edits,
 * and the chat says only that its agent works, so the page reads.
 */
export const useDraftFromChat = (
  workflow: string,
  onDraft: (draft: WorkflowDraft) => void
): void => {
  const core = useCore();
  const chatId = useActiveChat();
  const { view } = useFollowedChat(chatId);
  const { running } = view;
  const steps = view.messages.length;
  const followed = chatId !== undefined;
  useEffect(() => {
    // Nothing said in it yet: nothing changed the draft. Each step that
    // lands (`steps`) is read after.
    const said = followed && steps > 0;
    let left = false;
    const read = async (): Promise<void> => {
      try {
        const draft = await core.withSession(
          async (session) => await session.workflowResources.draft(workflow)
        );
        if (!left) {
          onDraft(draft);
        }
      } catch {
        // Out of reach for a moment: the next read, or the page's own,
        // brings it.
      }
    };
    if (said) {
      void read();
    }
    const timer =
      said && running
        ? setInterval(() => {
            void read();
          }, whileWorking)
        : undefined;
    return () => {
      left = true;
      clearInterval(timer);
    };
  }, [core, followed, onDraft, running, steps, workflow]);
};

/**
 * Has Grasp's chat be its builders' chat about `workflow` while its page
 * is open, docked beside it, and its Flow follow the draft as that chat
 * changes it (`onDraft`).
 */
export const useWorkflowChat = (
  workflow: { id: string; name: string },
  onDraft: (draft: WorkflowDraft) => void
): void => {
  useChatSubject({ kind: "workflow", id: workflow.id }, workflow.name);
  useDraftFromChat(workflow.id, onDraft);
};
