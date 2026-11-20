import type { WorkflowDraft } from "@grasp-os/shared/workflow-resources";
import { useEffect, useState } from "react";

import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// A workflow's draft as its editor shows it, for its builders
// (`workflowResources.draft`: its text, what keeps it from publishing, its
// diagram): one copy, at the latest revision any read brought. The page's
// own read, each save the editor made, and a read again each time the
// shared draft moves past it (drafts/use-draft.ts, which core tells of
// each write), whoever wrote it, so the Flow draws the latest.

/** Of `held` and `next`, the one at the later revision. */
const later = (
  held: WorkflowDraft | undefined,
  next: WorkflowDraft
): WorkflowDraft =>
  held !== undefined && held.revision > next.revision ? held : next;

/**
 * Workflow `workflow`'s draft: the page's read (`loaded`), or a later one,
 * read again once the shared draft is at `revision` past it. `onDraft`
 * takes a draft the editor saved or read.
 */
export const useWorkflowDraft = (
  workflow: string,
  loaded: Loaded<WorkflowDraft> | undefined,
  revision: number | undefined
): {
  draft: WorkflowDraft | undefined;
  onDraft: (draft: WorkflowDraft) => void;
} => {
  const core = useCore();
  const [held, setHeld] = useState<WorkflowDraft>();
  const read = loaded?.state === "ready" ? loaded.data : undefined;
  const draft = read === undefined ? held : later(held, read);
  const at = draft?.revision;
  useEffect(() => {
    if (revision === undefined || (at !== undefined && revision <= at)) {
      return () => {
        // Nothing to read: the page holds this revision already.
      };
    }
    let left = false;
    const reread = async (): Promise<void> => {
      try {
        const next = await core.withSession(
          async (session) => await session.workflowResources.draft(workflow)
        );
        if (!left) {
          setHeld((before) => later(before, next));
        }
      } catch {
        // Out of reach for a moment: the next write, or the page's own
        // read, brings it.
      }
    };
    void reread();
    return () => {
      left = true;
    };
  }, [core, workflow, revision, at]);
  return {
    draft,
    onDraft: (next) => {
      setHeld((before) => later(before, next));
    },
  };
};
