import type { WorkflowRunStatus } from "./workflow-resources.ts";
// A workflow's diagram (platform specification 13.10 and 22.7): drawn
// only from a definition that passed the profile, never a second model of
// it. Every declared path is in it, each task by its stable ID; showing it
// runs nothing. What a run did is laid over it from the run's own journal
// (`WorkflowRunTrace`), never guessed from the diagram.

/** Where a task goes once it is done: its `then`. */
export type DiagramNext =
  | { kind: "continue" }
  | { kind: "exit" }
  | { kind: "end" }
  | { kind: "task"; task: string };

/** One task, as declared, with the scopes it holds. */
export interface DiagramTask {
  /** Its stable ID: the key of its single-key object. */
  id: string;
  /** JSON Pointer to it in the definition. */
  pointer: string;
  /** Its task kind (`call`, `set`, `switch`, `for`, `fork`, `try`, …). */
  kind: string;
  /** Its `metadata.grasp.label`, if any: display text only. */
  label: string | null;
  /**
   * What it does, as literal source says it: the named call and binding,
   * the child workflow, the error raised, the event binding. Null when the
   * source says it through an expression or doesn't say.
   */
  detail: string | null;
  /** Whether an `if` decides at run time whether it runs. */
  guarded: boolean;
  next: DiagramNext;
  scopes: DiagramScope[];
}

/** A list of tasks a task holds, or a case of a switch. */
export interface DiagramScope {
  kind: "do" | "each" | "branch" | "try" | "catch" | "case";
  /** A case's or branch's name, a loop's item variable. */
  name: string | null;
  /** Whether a case's `when`, or a loop's `while`, decides at run time. */
  guarded: boolean;
  /** Where a case goes when it is chosen. */
  next: DiagramNext | null;
  tasks: DiagramTask[];
}

export interface WorkflowDiagram {
  tasks: DiagramTask[];
}

/** Where a run stands at one task, as its journal records the task's steps. */
export type TraceState = "reached" | "running" | "waiting" | "failed";

/**
 * One durable step of a task, as the run's journal records it, in the
 * order the run reached it: what a run's step detail shows. Metadata only,
 * as the rest of a trace: no value the step read or made, and a failure
 * only by a code the platform defines (any other reads
 * `workflow.step_failed`), never its message.
 */
export interface TraceStep {
  /** Its place in the run, never another step's: tells two steps apart. */
  ordinal: number;
  /** The task it is a step of, by ID. */
  task: string;
  /**
   * The loop item it ran in, as its step's name places it
   * (`<for>.<index>`, nested loops joined by `/`); null outside a loop.
   */
  item: string | null;
  state: TraceState;
  /** How many attempts it made, as far as the journal tells. */
  attempts: number;
  /** When the journal first recorded it. */
  startedAt: string;
  /** When it completed or failed for good; null while it hasn't. */
  endedAt: string | null;
  /** Why it failed for good, once it did. */
  errorCode: string | null;
}

/**
 * What a run did, laid over its own version's diagram: each task its
 * journal reached, by ID, and how that stands. Only what the engine
 * journaled, as metadata: never a value the run read or made, and never
 * which way a decision went beyond the tasks it then reached. A task
 * whose `if` was false still reaches its step, which says so only by
 * what follows.
 */
export interface WorkflowRunTrace {
  runId: string;
  version: number;
  status: WorkflowRunStatus;
  /** The diagram of the run's own version, as it was published. */
  diagram: WorkflowDiagram;
  tasks: { task: string; state: TraceState; attempts: number }[];
  /** Each of its tasks' steps, in the order the run reached them. */
  steps: TraceStep[];
  /** False when the journal held more than one read takes. */
  complete: boolean;
  /**
   * The run's retention, as the deployment has it now, is over, or its
   * details were swept: nothing of what it reached is shown.
   */
  detailsRemoved: boolean;
}

/**
 * What a test run of a draft's checkpoint did, step by step: its steps
 * name tasks of the checkpoint it ran (`WorkflowCandidateRun`), whose
 * diagram the draft shows.
 */
export interface WorkflowCandidateTrace {
  runId: string;
  draftRevision: number;
  status: WorkflowRunStatus;
  steps: TraceStep[];
  /** False when the journal held more than one read takes. */
  complete: boolean;
}
