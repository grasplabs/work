import type { WorkflowDraft } from "@grasp-os/shared/workflow-resources";
import { useEffect, useEffectEvent } from "react";

import { answeredAfterBuild } from "../chat/build-answered.ts";
import { slotOf, useChatSubject } from "../chat/chat-subject.ts";
import { useGlobalChat } from "../chat/global-chat.tsx";
import { useCore } from "../use-core.ts";

// A workflow drawn with Grasp: its builders' chat about it
// (chat/chat-subject.ts) is docked beside its Flow, and every question
// asked there names the workflow to the chat's agent, which edits its
// draft (`env.workflowBuild`). The Flow follows the draft as anyone
// writes it, as an App's preview does: the shared draft's revision
// (drafts/use-draft.ts, which core tells of each write) says when to read
// the editor's draft again.

/**
 * Has Grasp's chat be its builders' chat about `workflow` while its page
 * is open, docked beside it, for one who builds it (`builds`): its ID once
 * found, whether its agent works
 * on it (`running`), or checks it too (`busy`), whether Grasp answered
 * after the Build it that made it (`built`), and how often it wrote
 * drafts (`worked`), which reads the draft again.
 */
export const useWorkflowChat = (
  workflow: { id: string; name: string },
  builds: boolean
) => {
  useChatSubject(
    builds ? { kind: "workflow", id: workflow.id } : undefined,
    workflow.name
  );
  const chat = useGlobalChat();
  const ours =
    builds && chat.slot === slotOf({ kind: "workflow", id: workflow.id });
  const running = ours && chat.view.running;
  return {
    chatId: ours ? chat.chatId : undefined,
    running,
    busy: running || (ours && chat.view.checking),
    built:
      ours &&
      answeredAfterBuild(chat.view.messages, {
        kind: "workflow",
        id: workflow.id,
      }),
    worked: chat.view.worked,
    /** What the person calls it: its chat's title, which the plan named. */
    title: ours ? chat.summary?.title : undefined,
  };
};

/**
 * Reads `workflow`'s draft for its editor again each time the shared
 * draft moves past the one the page holds (`held`): `onDraft` takes it,
 * so the Flow draws the latest revision.
 */
export const useFollowedDraft = (
  workflow: string,
  revision: number | undefined,
  held: number | undefined,
  onDraft: (draft: WorkflowDraft) => void
): void => {
  const core = useCore();
  const took = useEffectEvent(onDraft);
  useEffect(() => {
    if (revision === undefined || (held !== undefined && revision <= held)) {
      return () => {
        // Nothing to read: the page holds this revision already.
      };
    }
    let left = false;
    const read = async (): Promise<void> => {
      try {
        const draft = await core.withSession(
          async (session) => await session.workflowResources.draft(workflow)
        );
        if (!left) {
          took(draft);
        }
      } catch {
        // Out of reach for a moment: the next write, or the page's own
        // read, brings it.
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, workflow, revision, held]);
};
