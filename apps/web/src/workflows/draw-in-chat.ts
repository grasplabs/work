import { businessProcesses } from "@grasp-os/shared/business-processes";
import type { ChatAsked } from "@grasp-os/shared/chat";
import type {
  WorkflowDraft,
  WorkflowResource,
} from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { useActiveChat } from "../chat/active-chat.ts";
import { useFollowedChat } from "../chat/chat-watch.ts";
import { useCore } from "../use-core.ts";
import { processNames } from "./business-process.tsx";

// An independent workflow drawn with Grasp (GRA-1402), as the prototype's
// new workflow starts: Grasp's chat, docked beside its Flow, opens on how
// Grasp works here and its first question, which business process the
// workflow is for, with each process to choose. The chat is an ordinary
// one, the person's like any other in Chat: a chat is never part of a
// workflow. The question is the page's own, asked before the chat has
// anything in it, so it costs no model call; choosing a process sets it on
// the workflow (`workflowResources.setProcess`), and the answer is the
// person's first message, which names the workflow and its ID, so the
// chat's agent knows which draft to edit (`env.workflowBuild`).

/** What the dock asks first in a new chat, and what follows an answer. */
export interface DockStart {
  asked: ChatAsked;
  /**
   * Takes the person's answer: the text their first message says, once
   * what it chose is set.
   */
  answered: (answer: string) => Promise<string>;
}

/** The ID the opening question goes by, apart from any the agent asks. */
const openingCall = "workflow-process";

/**
 * The opening question of a new chat beside `workflow`, for its builders
 * while it serves no business process; none for anyone else, or once it
 * serves one.
 */
export const useWorkflowStart = (
  workflow: WorkflowResource | undefined
): DockStart | undefined => {
  const { t, i18n } = useLingui();
  const core = useCore();
  const router = useRouter();
  if (
    workflow === undefined ||
    workflow.role !== "builder" ||
    workflow.process !== null
  ) {
    return undefined;
  }
  const { id, name } = workflow;
  const question = t`Which business process is this workflow for?`;
  const named = businessProcesses.map((each) => ({
    process: each,
    name: i18n._(processNames[each]),
  }));
  return {
    asked: {
      callId: openingCall,
      questions: [{ question, choices: named.map((each) => each.name) }],
    },
    answered: async (answer) => {
      const chosen = named.find((each) => each.name === answer)?.process;
      if (chosen !== undefined) {
        // Set before the agent reads it, as the person chose it; the
        // page shows it once read again. Refused or out of reach, the
        // answer still goes to Grasp, and the process stays to set in the
        // workflow's settings.
        try {
          await core.withSession(
            async (session) =>
              await session.workflowResources.setProcess(id, chosen)
          );
          void router.invalidate();
        } catch {
          // See above: nothing is lost but the setting.
        }
      }
      const beside = t`Workflow ${name} (ID ${id}) is open beside this chat.`;
      return `${question} ${answer}\n\n${beside}`;
    },
  };
};

/** How often the page reads the draft again while the chat's agent works, in milliseconds. */
const whileWorking = 2000;

/**
 * Follows `workflow`'s draft as the chat open in the dock beside it may
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
