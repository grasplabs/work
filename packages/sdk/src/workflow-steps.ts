import type { Json } from "@grasp-os/shared/json";
import { z } from "zod";

// What a workflow's `ctx` calls take and answer: their options and
// results, as generated code and its types see them.

/**
 * A value generated code reads: any. Code generated from an expression
 * must type-check whatever its data (`args.count + 1`,
 * `(line) => line.length > 3`); what an expression reads is type-checked
 * against the workflow's schemas where it is written, never in the
 * generated code, where its data is only JSON.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- see above
export type Read = any;

/**
 * A time span: e.g. `"30 minutes"` or `"3 days"`; at most 365 days.
 */
export type Duration =
  `${number} ${"second" | "minute" | "hour" | "day" | "week"}${"" | "s"}`;

/**
 * A failure a workflow's catch takes, as `AppError` has one: its code (a
 * platform's, such as `connect.rate_limited`, or one the workflow
 * raised), its message, its details where it has them, and the step whose
 * call failed, where a call failed. Frozen data, with no prototype.
 */
export interface CaughtError {
  readonly code: string;
  readonly message: string;
  readonly details?: Read;
  readonly step?: string;
}

/** What every `ctx` call takes besides its own arguments: its step. */
export interface StepOptions {
  /**
   * The workflow's step this call is, by its ID: its journal's name, and
   * what its run host holds the call to (the build's sealed table).
   */
  readonly step: string;
}

/** A call's options: its step, and what it does once it answered or failed. */
export interface CallOptions extends StepOptions {
  /**
   * Whether a failure of it is tried again by the retry of the `try`
   * around it: `true`, or as its `when` says. Its run host holds the
   * answer to the sealed policy and computes the backoff itself.
   */
  readonly retry?: true | ((error: CaughtError) => boolean);
  /**
   * What the step keeps in its workflow's state from its result, by key:
   * each value held to the key's declared schema as the step records it.
   */
  readonly state?: (output: Read) => Readonly<Record<string, unknown>>;
}

/**
 * A connection call's options: besides a call's, where a read that
 * answers a file keeps it (`into`, a files permission, its answer naming
 * the kept file instead of its content) and where a write's attachments
 * come from (`from`, a files permission, its `attachments` naming run
 * files by ID). The build seals both; its run host refuses a call that
 * names others.
 */
export interface ConnectionCallOptions extends CallOptions {
  readonly into?: string;
  readonly from?: string;
}

/**
 * One of the run's own files, as a files call answers it: its ID, which
 * reaches it only in this run, its name, type, size and SHA-256.
 */
export interface RunFile {
  readonly file: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly sha256: string;
}

/** What each action on the run's own files takes and answers. */
export interface FilesActions {
  /** A text, CSV, Markdown or JSON file of the run, read whole. */
  readonly read: (
    args: { readonly file: string },
    options: CallOptions
  ) => Promise<{ readonly file: RunFile; readonly text: string }>;
  /** A text file of the run, written whole: its name, type and text. */
  readonly write: (
    args: {
      readonly name: string;
      readonly type: string;
      readonly text: string;
    },
    options: CallOptions
  ) => Promise<RunFile>;
  /** The run's finished files, oldest first. */
  readonly list: (
    args: Readonly<Record<string, never>>,
    options: CallOptions
  ) => Promise<readonly RunFile[]>;
  /** Deletes a file of the run. */
  readonly delete: (
    args: { readonly file: string },
    options: CallOptions
  ) => Promise<null>;
}

/** A document a Brain search found: its ID, its title, a snippet. */
export interface BrainHit {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
}

/**
 * What each action on a Brain collection takes and answers: what the run's
 * person may read of it, as the Brain answers it. A recall answers the
 * Brain's memory pack: its `items` the evidence that applies, each with
 * what it cites.
 */
export interface BrainActions {
  readonly search: (
    args: { readonly text: string; readonly limit?: number },
    options: CallOptions
  ) => Promise<readonly BrainHit[]>;
  readonly read: (
    args: { readonly id: string },
    options: CallOptions
  ) => Promise<{ readonly title: string; readonly text: string }>;
  readonly recall: (
    args: { readonly query: string; readonly [field: string]: unknown },
    options: CallOptions
  ) => Promise<{
    readonly items: readonly Readonly<Record<string, Read>>[];
    readonly [field: string]: Read;
  }>;
}

/**
 * How a decision ended: answered, by whom (their user ID) and with what
 * `payload` they sent (untrusted input, e.g. `{ comment }`), or timed out.
 * A timeout never means approval.
 */
export type Decision =
  | {
      readonly timedOut: false;
      readonly approved: boolean;
      readonly by: string;
      readonly payload: Read;
    }
  | { readonly timedOut: true };

/**
 * An event a workflow's wait took, as its run host admitted it to the
 * run: its ID, its type, who sent it (`source`, which the host names,
 * never the sender), what it is about, if the sender said, when the run
 * accepted it (ISO 8601) and its data, as its contract takes it.
 */
export interface WorkflowEvent<Type extends string = string> {
  readonly id: string;
  readonly type: Type;
  readonly source: string;
  readonly subject?: string;
  readonly time: string;
  readonly data: Read;
}

/**
 * How an event wait ended: the event it took, or nothing by its timeout.
 * A timeout is an outcome, not a failure.
 */
export type EventWait<Type extends string = string> =
  | { readonly timedOut: false; readonly event: WorkflowEvent<Type> }
  | { readonly timedOut: true };

export const eventWaitSchema = z.union([
  z.strictObject({
    timedOut: z.literal(false),
    event: z.strictObject({
      id: z.string(),
      type: z.string(),
      source: z.string(),
      subject: z.string().optional(),
      time: z.string(),
      data: z.json(),
    }),
  }),
  z.strictObject({ timedOut: z.literal(true) }),
]);

/** A decision's request: whom it asks, what, and on what. */
export interface DecisionRequest {
  /** 1 to 16 of `person:<user ID>`, `team:<team ID>` and `role:<role>`. */
  readonly recipients: readonly string[];
  readonly prompt: string;
  readonly input: unknown;
  /** How long it waits for an answer: as long as the run may when not given. */
  readonly timeout?: Duration;
}

/** An event wait's request: what it takes, and for how long. */
export interface EventWaitRequest<Type extends string> {
  readonly type: Type | readonly Type[];
  /** Only the event whose data has, at JSON Pointer `field`, `equals`. */
  readonly match?: { readonly field: string; readonly equals: unknown };
  readonly timeout: Duration;
}

/** What a model is asked: its instructions, and what it works on. */
export interface GenerateRequest {
  readonly instructions: unknown;
  readonly input: unknown;
}

/** A recorded value as JSON, for what a step's record holds. */
export type Recorded = Json;
