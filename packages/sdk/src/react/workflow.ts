import { useState, useSyncExternalStore } from "react";

import { workflowChannel } from "../client-workflow.ts";
import { readWorkflowReference } from "../workflow-reference-read.ts";
import type {
  AnyWorkflowReference,
  WorkflowEventsOf,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowWaitOf,
} from "../workflow-references.ts";
import { WorkflowStore } from "../workflow-store.ts";
import type { WorkflowView } from "../workflow-view.ts";
import { useClient } from "./provider.ts";

/** The view `useWorkflow` answers for `Reference`. */
export type WorkflowViewOf<Reference> = WorkflowView<
  WorkflowInputOf<Reference>,
  WorkflowOutputOf<Reference>,
  WorkflowWaitOf<Reference>,
  WorkflowEventsOf<Reference>[keyof WorkflowEventsOf<Reference>]
>;

/** The longest run ID a selection takes, as the host's IDs are. */
const maxRunIdLength = 256;

/**
 * One workflow the App binds and one run of it (spec 10.4): the run's
 * view, narrowed by `status`, and stable `run`, `pause`, `resume`,
 * `cancel` and `send`, with what may be done now (`canRun`, `canPause`,
 * `canResume`, `canCancel`), whether a start is under way (`isStarting`)
 * and a control still settling (`pendingControl`).
 *
 * ```tsx
 * const summary = useWorkflow(workflows.summarizeNote);
 * // In a handler: await summary.run({ noteId });
 * if (summary.status === "completed") summary.output.summary;
 * if (summary.status === "failed") summary.error.message;
 *
 * const existing = useWorkflow(workflows.summarizeNote, { runId });
 * // In a handler: await existing.cancel();
 * // Or send it an event its workflow declares, typed by that event:
 * // await existing.send(workflows.summarizeNote.events.styleChosen, { style: "short" });
 * ```
 *
 * Without `runId` it shows the run of its latest admitted start, idle
 * until the first; with one, exactly that run, whatever it starts.
 * Nothing runs or is controlled but by those calls: never on render,
 * remount or reconnect. Unmounting stops following; the run goes on. A
 * run the person may not see as it is first followed, or one of another
 * contract, is thrown while rendering, as a query's failure is; one shown
 * that they may see no more (a decision that asked them was answered)
 * shows as `unavailable`, never thrown. A command's failure rejects its
 * own promise and is never the run's `error`.
 */
export const useWorkflow = <Reference extends AnyWorkflowReference>(
  reference: Reference,
  options?: { readonly runId: string }
): WorkflowViewOf<Reference> => {
  const client = useClient();
  const read = readWorkflowReference(reference);
  if (
    options !== undefined &&
    (typeof options.runId !== "string" ||
      options.runId.length === 0 ||
      options.runId.length > maxRunIdLength)
  ) {
    throw new TypeError("useWorkflow takes { runId }, a run's ID.");
  }
  // One store per client and workflow contract: another of either starts
  // afresh, and the last one's selection, starts and controls show nothing
  // here (its admitted starts still answer their callers).
  const [bound, setBound] = useState(() => ({
    client,
    key: read.key,
    store: new WorkflowStore(workflowChannel(client), read),
  }));
  let current = bound;
  if (bound.client !== client || bound.key !== read.key) {
    current = {
      client,
      key: read.key,
      store: new WorkflowStore(workflowChannel(client), read),
    };
    setBound(current);
  }
  const { store } = current;
  const selection = options === undefined ? null : options.runId;
  const view = useSyncExternalStore(
    (onChange) => store.subscribe(selection, onChange),
    () => store.view(selection)
  );
  const error = store.error(selection);
  if (error !== undefined) {
    throw error;
  }
  // SAFETY: the view holds what the host sent, validated against the
  // reference's own input and output descriptors, which `Reference`
  // carries as its types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return view as WorkflowViewOf<Reference>;
};
