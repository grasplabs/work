// Compile-time guarantees of `useWorkflow` (spec 10.4.1, 10.4.4, 10.4.7,
// 10.7.2, 10.7.3), against workflow references as the generator writes
// them: a run's input and output are inferred from the reference without
// a cast or generic argument; a wrong table's ID, an unknown field, an
// operation's reference, an internal or string one are refused; output
// exists only once completed and an error only once failed, each read off
// the narrowed view itself; the compensating variant carries its cause;
// the pending control and the waits narrow by kind. Type-checked by
// `vp check`, never run: every `@ts-expect-error` must stay an error.
import { expectTypeOf } from "vite-plus/test";

import type { Id, RunHandle, WorkflowReference } from "../src/index.ts";
import { useWorkflow } from "../src/react.ts";
import type { AppErrorPayload, PendingControl } from "../src/react.ts";
import { api } from "./notes/.grasp/references.ts";
import { workflows } from "./workflow-refs.ts";

declare const noteId: Id<"notes">;
declare const taskId: Id<"tasks">;
declare const runId: string;

export const useRunChecks = (): void => {
  const summary = useWorkflow(workflows.summarizeNote);
  expectTypeOf(summary.run({ noteId })).toEqualTypeOf<Promise<RunHandle>>();
  // A defaulted field may be left out, or given.
  void summary.run({ noteId, style: "long" });
  expectTypeOf(summary.pause()).toEqualTypeOf<Promise<void>>();
  expectTypeOf(summary.resume()).toEqualTypeOf<Promise<void>>();
  expectTypeOf(summary.cancel()).toEqualTypeOf<Promise<void>>();
  expectTypeOf(summary.canRun).toEqualTypeOf<boolean>();
  expectTypeOf(summary.isStarting).toEqualTypeOf<boolean>();
  // @ts-expect-error -- a note's ID, not a task's
  void summary.run({ noteId: taskId });
  // @ts-expect-error -- a field the workflow doesn't take
  void summary.run({ noteId, priority: 1 });
  // @ts-expect-error -- its required field left out
  void summary.run({});
  // @ts-expect-error -- a value outside the enum
  void summary.run({ noteId, style: "medium" });
  // @ts-expect-error -- `run` takes the input itself, not a string
  void summary.run("summarize");

  const archive = useWorkflow(workflows.archiveNotes);
  void archive.run({});
  if (archive.status === "completed") {
    expectTypeOf(archive.output).toEqualTypeOf<null>();
  }
};

export const useViewChecks = (): void => {
  const summary = useWorkflow(workflows.summarizeNote, { runId });
  if (summary.status === "completed") {
    expectTypeOf(summary.output).toEqualTypeOf<{
      summary: string;
      words: number;
    }>();
    expectTypeOf(summary.finishedAt).toEqualTypeOf<number>();
    expectTypeOf(summary.runId).toEqualTypeOf<string>();
    // @ts-expect-error -- a completed run has no execution error
    void summary.error;
  }
  if (summary.status === "failed") {
    expectTypeOf(summary.error).toEqualTypeOf<Readonly<AppErrorPayload>>();
    // @ts-expect-error -- a failed run has no output
    void summary.output;
  }
  if (summary.status === "cancelled") {
    // @ts-expect-error -- a cancelled run has neither output nor error
    void summary.output;
    // @ts-expect-error -- as above
    void summary.error;
  }
  if (
    summary.status === "queued" ||
    summary.status === "running" ||
    summary.status === "waiting" ||
    summary.status === "paused"
  ) {
    expectTypeOf(summary.finishedAt).toEqualTypeOf<null>();
    expectTypeOf(summary.startedAt).toEqualTypeOf<number | null>();
    // @ts-expect-error -- no output before it completed
    void summary.output;
  }
  if (summary.status === "compensating") {
    expectTypeOf(summary.activity).toEqualTypeOf<
      "running" | "waiting" | "paused"
    >();
    if (summary.cause === "failure") {
      expectTypeOf(summary.originalError).toEqualTypeOf<
        Readonly<AppErrorPayload>
      >();
    } else {
      // @ts-expect-error -- a cancellation's cleanup has no original error
      void summary.originalError;
    }
    // @ts-expect-error -- cleanup is not a terminal outcome
    void summary.output;
  }
  if (summary.status === "loading") {
    expectTypeOf(summary.runId).toEqualTypeOf<string>();
    // @ts-expect-error -- nothing of the run is known while loading
    void summary.workflowVersion;
  }
  if (summary.status === "idle") {
    // @ts-expect-error -- no run is selected while idle
    void summary.runId;
  }
  // @ts-expect-error -- no output before narrowing to completed
  void summary.output;
  // @ts-expect-error -- no error before narrowing to failed
  void summary.error;
  // @ts-expect-error -- the status is a literal union, not any string
  expectTypeOf(summary.status).toEqualTypeOf<string>();
};

export const usePendingChecks = (): void => {
  const workflow = useWorkflow(workflows.summarizeNote, { runId });
  expectTypeOf(workflow.pendingControl).toEqualTypeOf<PendingControl | null>();
  if (workflow.pendingControl?.kind === "pause") {
    expectTypeOf(workflow.pendingControl.stage).toEqualTypeOf<
      "submitting" | "applying" | "recovering"
    >();
  }
  if (workflow.pendingControl !== null) {
    expectTypeOf(workflow.pendingControl.kind).toEqualTypeOf<
      "pause" | "resume" | "cancel"
    >();
    // @ts-expect-error -- progress of a request, not an engine status
    void workflow.pendingControl.status;
  }
  // @ts-expect-error -- no redundant alias beside pendingControl
  void workflow.isPausing;
  // @ts-expect-error -- no `current` wrapper
  void workflow.current;
  // @ts-expect-error -- no `data` or `result` beside the narrowed view
  void workflow.data;
};

export const useWaitChecks = (): void => {
  const workflow = useWorkflow(workflows.summarizeNote, { runId });
  for (const wait of workflow.waits) {
    expectTypeOf(wait.id).toEqualTypeOf<string>();
    expectTypeOf(wait.deadline).toEqualTypeOf<number | null>();
    if (wait.kind === "timer") {
      expectTypeOf(wait.purpose).toEqualTypeOf<"sleep" | "retry">();
      expectTypeOf(wait.deadline).toEqualTypeOf<number>();
    }
    if (wait.kind === "decision") {
      expectTypeOf(wait.canRespond).toEqualTypeOf<boolean>();
    }
    if (wait.kind === "child") {
      expectTypeOf(wait.child).toEqualTypeOf<RunHandle>();
    }
    if (wait.kind === "blocked") {
      expectTypeOf(wait.reason).toEqualTypeOf<
        "policy" | "quota" | "uncertain"
      >();
      // @ts-expect-error -- a hold is never answerable
      void wait.canRespond;
    }
  }
};

declare const internal: Omit<
  WorkflowReference<"summarizeNote", { noteId: Id<"notes"> }>,
  "visibility"
> & { readonly visibility: "internal" };

export const useRefusedReferences = (): void => {
  // @ts-expect-error -- a hand-written workflow name
  void useWorkflow("summarizeNote");
  // @ts-expect-error -- an operation's reference, not a workflow's
  void useWorkflow(api.notes.create);
  // @ts-expect-error -- an internal reference is no browser's
  void useWorkflow(internal);
  // @ts-expect-error -- options are exactly { runId }
  void useWorkflow(workflows.summarizeNote, { runId: null });
  // @ts-expect-error -- no skip or initial ID beside { runId }
  void useWorkflow(workflows.summarizeNote, { runId, skip: true });
  // @ts-expect-error -- no hidden generic arguments
  void useWorkflow<typeof workflows.summarizeNote, string>(
    workflows.summarizeNote
  );
};
