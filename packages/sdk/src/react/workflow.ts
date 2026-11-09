import { useState, useSyncExternalStore } from "react";

import { WorkflowCalls } from "../workflow-calls.ts";
import { readWorkflowReference } from "../workflow-reference-read.ts";
import type {
  AnyWorkflowReference,
  WorkflowEventsOf,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowWaitOf,
} from "../workflow-references.ts";
import { workflowView } from "../workflow-view.ts";
import type { WorkflowView } from "../workflow-view.ts";
import { useClient } from "./provider.ts";
import { useQuery } from "./queries.ts";

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
 * One workflow the App binds and one run of it, on the workflow
 * reference's own queries and mutations: the run's view, narrowed by
 * `status`, and `run`, `pause`, `resume`, `cancel`, `send` and `respond`,
 * with what may be done now (`canRun`, `canPause`, `canResume`,
 * `canCancel`), whether a start is under way (`isStarting`) and a control
 * still settling (`pendingControl`).
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
 * until the first; with one, exactly that run, whatever it starts. The
 * run is the live `queries.run`, `canRun` the live `queries.canStart`; a
 * start is `mutations.start`, a control `mutations.pause`, `.resume` or
 * `.cancel`, an event `mutations.send` (workflow-calls.ts). Nothing runs
 * or is controlled but by those calls: never on render, remount or
 * reconnect. Unmounting stops following; the run goes on. A run the
 * person may not see is `unavailable`; a failure to read it is thrown to
 * the page's error boundary, as a query's is. A command's failure rejects
 * its own promise and is never the run's `error`.
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
  // One hook's calls per client and workflow contract: another of either
  // starts afresh, and the last one's starts and controls show nothing
  // here (its admitted starts still answer their callers).
  const [bound, setBound] = useState(() => ({
    client,
    key: read.key,
    calls: new WorkflowCalls(client, read),
  }));
  let current = bound;
  if (bound.client !== client || bound.key !== read.key) {
    current = { client, key: read.key, calls: new WorkflowCalls(client, read) };
    setBound(current);
  }
  const { calls } = current;
  const local = useSyncExternalStore(calls.subscribe, calls.local);
  const runId = options?.runId ?? local.startedRunId;
  const snapshot = useQuery(
    read.functions.run,
    runId === undefined ? "skip" : { runId }
  );
  const canStart = useQuery(read.functions.canStart);
  const view = workflowView({
    read,
    runId,
    snapshot,
    canStart,
    starting: local.starting > 0,
    submitting: local.submitting,
    commands: calls.commandsFor(runId, snapshot),
  });
  // SAFETY: the view holds what the host sent, checked against the
  // reference's own descriptors, which `Reference` carries as its types.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return view as WorkflowViewOf<Reference>;
};
