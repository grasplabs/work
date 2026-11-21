import type { DecisionView } from "@grasp-os/shared/decisions";

import { readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { useFrameRead } from "../frame/frame-read.ts";

// How many workflows need the person, beside the sidebar's Workflows
// (grasp/frame/grasp-sidebar.tsx): each workflow once, however many of its
// runs ask.
// What needs them today is a decision of a run waiting for their answer;
// a change waiting for its test and approval, and a workflow in testing,
// join it with the workflow lifecycle (GRA-512). Read again as the
// Dashboard's count is (frame/frame-read.ts): after every change on a page,
// and on the way to another once the count is older than half a minute.

/** The workflow a decision's run belongs to. */
const workflowOf = (decision: DecisionView): string =>
  decision.workflowResource.id;

/**
 * How many workflows need the person; `undefined` when core couldn't say.
 * Outside the component, as the React Compiler can't compile `try`.
 */
const readCount = async (core: CoreConnection): Promise<number | undefined> => {
  try {
    const waiting = await readWithin(
      core,
      async (session) => await session.decisions.waiting()
    );
    return new Set(waiting.map(workflowOf)).size;
  } catch {
    return undefined;
  }
};

/** How many workflows need the person; `undefined` until core says. */
export const useWorkflowsWaiting = (): number | undefined =>
  useFrameRead(readCount).value;
