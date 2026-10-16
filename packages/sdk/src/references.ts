import { isPlainObject } from "./value-descriptor.ts";
import type { JsonValue, ValueDescriptor } from "./value-descriptor.ts";

// References (spec 8, 32.1): how code names one of an App's functions, a
// browser-facing resource, a screen or its preferences, without holding
// any of them. A reference is data: the App and version it belongs to,
// the contract it pins (its ID and exact fingerprint), its kind and
// visibility and the descriptors of its arguments and return. It holds no
// handler and grants nothing: the host resolves every reference against
// the sealed release it runs, and refuses one that doesn't match exactly,
// however it was made.
//
// The generated modules hold them: `#grasp` the public `api`, the
// browser resources, the screens and the preferences; `#grasp/server-
// references` the `internal` tree, for the App's own server code. Their
// types come from the descriptors, through the phantom members below,
// which exist in types only: they are keyed by symbols that are declared,
// never created, so no reference carries them at run time, JSON never
// holds them and an editor never offers them.

/** The kinds of server function. */
export type ReferenceKind = "query" | "mutation" | "action";

/** Who may call a function directly. */
export type ReferenceVisibility = "public" | "internal";

declare const argsType: unique symbol;
declare const returnType: unique symbol;
declare const progressType: unique symbol;

/**
 * What every callable reference has, the definitions App code declares
 * and the references generated for them alike: its kind, its visibility,
 * and the phantom types of its arguments (as a caller passes them) and
 * return.
 */
export interface Callable<
  Kind extends ReferenceKind = ReferenceKind,
  Vis extends ReferenceVisibility = ReferenceVisibility,
  Args = unknown,
  Return = unknown,
> {
  readonly kind: Kind;
  readonly visibility: Vis;
  /** Types only: never set. */
  readonly [argsType]?: Args;
  /** Types only: never set. */
  readonly [returnType]?: Return;
}

/**
 * A generated reference to one of an App's functions (spec 32.1). `mode`
 * follows `Progress`: a function that streams progress is `"stream"` and
 * carries the progress descriptor in `stream`; any other is `"single"`
 * and has no `stream`.
 */
export interface OperationReference<
  Args,
  Return,
  Kind extends ReferenceKind,
  Vis extends ReferenceVisibility = "public",
  Progress = never,
> extends Callable<Kind, Vis, Args, Return> {
  readonly resourceId: string;
  readonly resourceVersion: number;
  /** Its registered path, which a compatible revision keeps. */
  readonly contractId: string;
  /** The SHA-256 of its exact contract, in hex. */
  readonly fingerprint: string;
  readonly mode: [Progress] extends [never] ? "single" : "stream";
  readonly stream?: ValueDescriptor;
  readonly args: ValueDescriptor;
  readonly returns: ValueDescriptor;
  /** Types only: never set. */
  readonly [progressType]?: Progress;
}

/** Any generated function reference: a single answer's or a stream's. */
export type AnyOperationReference =
  | OperationReference<unknown, unknown, ReferenceKind, ReferenceVisibility>
  | OperationReference<
      unknown,
      unknown,
      ReferenceKind,
      ReferenceVisibility,
      unknown
    >;

/** The arguments a caller passes to `Reference`. */
export type ArgsOf<Reference> =
  Reference extends Callable<ReferenceKind, ReferenceVisibility, infer Args>
    ? Args
    : never;

/** What `Reference` returns. */
export type ReturnOf<Reference> =
  Reference extends Callable<
    ReferenceKind,
    ReferenceVisibility,
    unknown,
    infer Return
  >
    ? Return
    : never;

/** The progress `Reference` streams; never for a single answer. */
export type ProgressOf<Reference> =
  Reference extends OperationReference<
    unknown,
    unknown,
    ReferenceKind,
    ReferenceVisibility,
    infer Progress
  >
    ? Progress
    : never;

/** The operations a files resource declares. */
export type FilesOperation = "upload" | "read" | "attach" | "delete";

/** A generated reference to a files resource: its alias and operations. */
export interface FilesReference<
  Alias extends string = string,
  Operations extends readonly FilesOperation[] = readonly FilesOperation[],
> {
  readonly kind: "files";
  readonly alias: Alias;
  readonly operations: Operations;
}

/** A generated reference to a links resource: its exact HTTPS origins. */
export interface LinksReference<
  Alias extends string = string,
  Origins extends readonly string[] = readonly string[],
> {
  readonly kind: "links";
  readonly alias: Alias;
  readonly origins: Origins;
}

/** A generated reference to one of the App's screens. */
export interface ScreenReference<
  Name extends string = string,
  Input = unknown,
> {
  readonly name: Name;
  /** Its route, e.g. `/notes/:id`. */
  readonly path: string;
  /** The descriptor its route input is validated with. */
  readonly input: ValueDescriptor;
  /** Types only: never set. */
  readonly [argsType]?: Input;
}

/** The route input of `Screen`, as a caller passes it. */
export type ScreenInputOf<Screen> =
  Screen extends ScreenReference<string, infer Input> ? Input : never;

declare const waitType: unique symbol;

/**
 * What a run of a workflow is, once the host admitted its start: its ID,
 * its workflow and that workflow's exact version and manifest. Holding
 * one grants nothing: the host checks every watch and control again.
 */
export interface RunHandle {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly manifestHash: string;
}

/** Who classifies a failure as what (spec 32.1). */
export type AppErrorCategory =
  | "source"
  | "contract"
  | "domain"
  | "authorization"
  | "operational"
  | "uncertain"
  | "safety";

/**
 * A failure as the host answers it, sanitized: its code to branch on, its
 * message for people, its category, whether trying again may help, the
 * request to quote (null for a run's own failure, which no request made)
 * and, when the failing code gave them, its details.
 */
export interface AppErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly category: AppErrorCategory;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details?: JsonValue;
}

/** What every wait a run is held at has (spec 10.7.2). */
interface WaitFields<Key extends string> {
  /** This exact wait: its run, step, branch, iteration and generation. */
  readonly id: string;
  /** The source task it waits in, by its canonical path. */
  readonly taskId: string;
  /**
   * A decision's binding alias; the task path for any other kind; `$run`
   * for a hold on the whole run.
   */
  readonly key: Key;
  /** Plain text, bounded: never HTML. */
  readonly title: string;
  /** When it opened, in Unix milliseconds. */
  readonly openedAt: number;
  /** When it closes on its own, in Unix milliseconds; null if never. */
  readonly deadline: number | null;
}

/**
 * A generated reference to one event a workflow the App binds declares
 * (spec 10.4.6): `workflows.<workflow>.events.<alias>`. It names the
 * workflow binding it belongs to (its App release, contract ID and
 * pinned fingerprint), the event binding's alias and the exact event type
 * it admits, with the descriptor of its data and that data's type in a
 * phantom member. It grants nothing: the host checks every send against
 * the run, the binding and the person, and validates the data again.
 */
export interface WorkflowEventReference<
  Workflow extends string = string,
  Alias extends string = string,
  Type extends string = string,
  Data = unknown,
> {
  readonly kind: "workflowEvent";
  readonly resourceId: string;
  readonly resourceVersion: number;
  /** The workflow binding's contract ID, e.g. `workflows.reviewInvoice`. */
  readonly workflow: Workflow;
  /** The fingerprint of the workflow contract it belongs to. */
  readonly workflowFingerprint: string;
  /** The event binding's alias in the workflow. */
  readonly alias: Alias;
  /** The CloudEvents type it admits. */
  readonly type: Type;
  /** The SHA-256 of its type and data contract, in hex. */
  readonly fingerprint: string;
  readonly data: ValueDescriptor;
  /** Types only: never set. */
  readonly [argsType]?: Data;
}

/** The data an event of `Reference` carries, as a sender passes it. */
export type EventDataOf<Reference> =
  Reference extends WorkflowEventReference<string, string, string, infer Data>
    ? Data
    : never;

/**
 * A wait the engine holds a run at on its own (spec 10.4.5, 10.7.2): a
 * timer, a child run, or a hold of the platform's that no one answers
 * from an App. Each grants nothing of what it names.
 */
export type WorkflowEngineWait<Key extends string = string> =
  | (WaitFields<Key> & {
      readonly kind: "timer";
      /** A sleep the workflow asked for, or a retry's backoff. */
      readonly purpose: "sleep" | "retry";
      readonly deadline: number;
    })
  | (WaitFields<Key> & {
      readonly kind: "child";
      /** The child run: no watch, control or output of it comes with it. */
      readonly child: RunHandle;
    })
  | (WaitFields<Key> & {
      readonly kind: "blocked";
      /**
       * Held by policy, a quota, or an outcome no one knows yet: only the
       * platform's own remediation releases it, never a decision.
       */
      readonly reason: "policy" | "quota" | "uncertain";
      readonly message: string;
    });

/**
 * A run listening for an event (spec 10.4.6, 10.7.2): `Key` is the listen
 * task's path, `Event` the generated references of the events it listens
 * for. Its `event` is the very reference the App was generated with.
 */
export type WorkflowEventWait<
  Key extends string = string,
  Event = WorkflowEventReference,
> = WaitFields<Key> & {
  readonly kind: "event";
  readonly event: Event;
  /** Whether the person may send it now; false when unknown. */
  readonly canSend: boolean;
};

/** A run held for a person's decision (spec 10.4.5, 10.7.2). */
export type WorkflowDecisionWait<Key extends string = string> =
  WaitFields<Key> & {
    readonly kind: "decision";
    /** Whether the person may answer it now; false when unknown or stale. */
    readonly canRespond: boolean;
  };

/**
 * A wait a run is held at now (spec 10.4.5, 10.7.2): a timer, an event,
 * a person's decision, a child run, or a hold of the platform's. A
 * generated workflow reference narrows it to the waits that workflow
 * declares (`WorkflowWaitOf`).
 */
export type WorkflowWait<Key extends string = string> =
  | WorkflowEngineWait<Key>
  | WorkflowEventWait<Key>
  | WorkflowDecisionWait<Key>;

/**
 * A generated reference to one of the workflows an App binds (spec 10.4.1,
 * 10.4.6): the App and release it belongs to, the binding's alias, the
 * contract it pins (its ID and fingerprint, over its input and output;
 * each event has its own), the descriptors of its input and output, and
 * its event references under `events`. Its types, the input a run takes,
 * the output a completed run has and the waits it can be held at, live
 * in phantom members only. It holds no binding and grants nothing: the
 * host resolves it against the release and binding in force, and refuses
 * a run whose pinned contract isn't this one. It has no `.start`, `.get`
 * or `.cancel`: runs go through `useWorkflow`.
 */
export interface WorkflowReference<
  Alias extends string = string,
  Input = unknown,
  Output = unknown,
  Wait = WorkflowWait,
  Events = Readonly<Record<string, WorkflowEventReference>>,
> {
  readonly kind: "workflow";
  readonly visibility: "public";
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly alias: Alias;
  /** Its registered path, e.g. `workflows.summarizeNote`. */
  readonly contractId: string;
  /** The SHA-256 of its exact input and output contract, in hex. */
  readonly fingerprint: string;
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
  /** Its events, by their binding's alias in the workflow. */
  readonly events: Events;
  /**
   * Its listen tasks, by path, with the aliases of the events each listens
   * for: what an event wait's key may name, and with which event.
   */
  readonly listens: Readonly<Record<string, readonly string[]>>;
  /** Types only: never set. */
  readonly [argsType]?: Input;
  /** Types only: never set. */
  readonly [returnType]?: Output;
  /** Types only: never set. */
  readonly [waitType]?: Wait;
}

/** Any generated workflow reference, whatever it takes and gives. */
export type AnyWorkflowReference = WorkflowReference<
  string,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowInputOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowOutputOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowWaitOf`
  any,
  // oxlint-disable-next-line typescript/no-explicit-any -- only read, by `WorkflowEventsOf`
  any
>;

/** The input a run of `Reference` takes, as a caller passes it. */
export type WorkflowInputOf<Reference> =
  Reference extends WorkflowReference<string, infer Input> ? Input : never;

/** The output a completed run of `Reference` has. */
export type WorkflowOutputOf<Reference> =
  Reference extends WorkflowReference<string, unknown, infer Output>
    ? Output
    : never;

/** The waits a run of `Reference` can be held at. */
export type WorkflowWaitOf<Reference> =
  Reference extends WorkflowReference<string, unknown, unknown, infer Wait>
    ? Wait
    : never;

/**
 * The most a generated workflow reference declares: events, listen tasks
 * and decisions, and the longest listen task's path. The generator refuses
 * more, and the client reads no more, so what one makes the other reads.
 */
export const workflowReferenceLimits = {
  events: 64,
  listens: 256,
  decisions: 64,
  taskPathLength: 1024,
} as const;

/** The event references of `Reference`, by alias. */
export type WorkflowEventsOf<Reference> =
  Reference extends WorkflowReference<
    string,
    unknown,
    unknown,
    unknown,
    infer Events
  >
    ? Events
    : never;

/** A generated reference to the App's preferences, when it declares them. */
export interface PreferencesReference<Input = unknown, Value = unknown> {
  readonly resourceId: string;
  readonly descriptor: ValueDescriptor;
  /** Types only: never set. */
  readonly [argsType]?: Input;
  /** Types only: never set. */
  readonly [returnType]?: Value;
}

const kinds: ReadonlySet<unknown> = new Set(["query", "mutation", "action"]);
const visibilities: ReadonlySet<unknown> = new Set(["public", "internal"]);

/**
 * A reference to a function as App code may list it in `uses` or call it
 * through its context: a generated one, by its registered path, or a
 * symbolic one the host lends inspection, whose kind is resolved from the
 * registration. Read once, as data: the path, the visibility and the kind
 * when it has one.
 */
export interface ReferenceData {
  readonly path: string;
  readonly visibility: ReferenceVisibility;
  /** Unknown for a symbolic reference, until the registration resolves it. */
  readonly kind: ReferenceKind | undefined;
}

/**
 * The function reference `value` is, read as data, or undefined when it
 * isn't one: a plain object with a string `contractId` and a visibility,
 * and, unless it is symbolic, a kind. Nothing about it is trusted: the
 * registration resolves it by its path, and refuses one whose visibility
 * or kind doesn't match.
 */
export const referenceData = (value: unknown): ReferenceData | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const { contractId, visibility, kind } = value;
  if (
    typeof contractId !== "string" ||
    !visibilities.has(visibility) ||
    (kind !== undefined && !kinds.has(kind))
  ) {
    return undefined;
  }
  // SAFETY: each was checked against its set just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const read = { visibility, kind } as Pick<
    ReferenceData,
    "visibility" | "kind"
  >;
  return { path: contractId, ...read };
};
