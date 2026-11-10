import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

// References: how code names one of an App's functions or
// a browser-facing resource, without holding any of them. A
// function's reference is its name and kind, nothing more: core resolves
// the name in the release that answers the call (the App's current one,
// for a page) and checks the call's arguments with that function's own
// validator. It holds no handler and grants nothing, so a forged one
// reaches only what its name does: a public function of the App, with
// arguments its validator accepts.
//
// The generated modules hold them: `@server/_generated/api` the public
// `api` and the browser resources;
// `@server/_generated/internal` the `internal` tree, for the App's own
// server code. Their types come from the functions' descriptors, through
// the phantom members below, which exist in types only: they are keyed by
// symbols that are declared, never created, so no reference carries them
// at run time, JSON never holds them and an editor never offers them.

/** The kinds of server function. */
export type ReferenceKind = "query" | "mutation" | "action";

/** Who may call a function directly. */
export type ReferenceVisibility = "public" | "internal";

declare const kindType: unique symbol;
declare const visibilityType: unique symbol;
export declare const argsType: unique symbol;
export declare const returnType: unique symbol;
declare const progressType: unique symbol;

/**
 * What every callable reference has, the definitions App code declares
 * and the references generated for them alike, as types only: its kind,
 * its visibility, its arguments (as a caller passes them), its return and
 * what it streams. A reference holds none of them at run time: a page's
 * hook says which kind of call it makes, as Convex's do, and core refuses
 * a call of a function of another kind.
 */
export interface Callable<
  Kind extends ReferenceKind = ReferenceKind,
  Vis extends ReferenceVisibility = ReferenceVisibility,
  Args = unknown,
  Return = unknown,
  Progress = never,
> {
  /** Types only: never set. */
  readonly [kindType]?: Kind;
  /** Types only: never set. */
  readonly [visibilityType]?: Vis;
  /** Types only: never set. */
  readonly [argsType]?: Args;
  /** Types only: never set. */
  readonly [returnType]?: Return;
  /** Types only: never set. What a streaming action streams; never otherwise. */
  readonly [progressType]?: Progress;
}

/**
 * A generated reference to one of an App's functions: its
 * name, its path (`tasks.list`), and what the page needs of it, built with
 * the App's server code (`_generated`): a mutation's or an action's kind
 * and argument descriptor, which `useForm` sends and checks a form with,
 * or a query's declared return, which a grid reads its columns from. Core
 * still checks every call with the function's own validator: a page of an
 * older release whose descriptor is stale is at most told something
 * slightly off before core answers with its issues. Its visibility, what
 * it takes, answers and streams are its types.
 */
export type FunctionReference<
  Kind extends ReferenceKind,
  Vis extends ReferenceVisibility = "public",
  Args = unknown,
  Return = unknown,
  Progress = never,
> = Callable<Kind, Vis, Args, Return, Progress> &
  (Kind extends "query" ? QueryFields : SubmissionFields<Kind>);

/** What a query's reference holds. */
interface QueryFields {
  /** Its name, as `api.tasks.list` names it: `tasks.list`. */
  readonly name: string;
  /** Its declared return, where it declares one. */
  readonly returns?: ValueDescriptor;
}

/** What a mutation's or an action's reference holds. */
interface SubmissionFields<Kind extends ReferenceKind> {
  /** Its name, as `api.tasks.create` names it: `tasks.create`. */
  readonly name: string;
  /** What `useForm` sends a submission as. */
  readonly kind: Kind;
  /** Its arguments, as `useForm` checks them. */
  readonly args: ValueDescriptor;
}

/**
 * A streaming action, as App code declares it (its
 * progress schema in `stream`). It runs only for a page following it
 * (`useStream`, `client.stream`): wherever a call answers once
 * (`client.action`, `ctx.runAction`, a test's `action`), its type is
 * refused, as the host refuses the call (`function.mode_mismatch`). A
 * definition is told by its `stream`, a reference by what it streams.
 */
interface StreamingFunction {
  readonly stream: object;
}

/** Whether `Reference`, a definition or a reference, streams its progress. */
type IsStreaming<Reference> = Reference extends StreamingFunction
  ? true
  : [ProgressOf<Reference>] extends [never]
    ? false
    : true;

/**
 * `Reference`, only if it streams: compared through its type parameters
 * alone, a reference that answers once (its progress `never`) would pass
 * for one that streams.
 */
export type Streaming<Reference> = Reference &
  (true extends IsStreaming<Reference> ? unknown : never);

/**
 * `Reference`, only if it answers once: a union any member of which
 * streams is refused too (not distributed).
 */
export type SingleAnswer<Reference> = Reference &
  (true extends IsStreaming<Reference> ? never : unknown);

/** Any generated function reference: a single answer's or a stream's. */
export type AnyFunctionReference = FunctionReference<
  ReferenceKind,
  ReferenceVisibility,
  unknown,
  unknown,
  unknown
>;

/** The arguments a caller passes to `Reference`. */
export type FunctionArgs<Reference> =
  Reference extends Callable<
    ReferenceKind,
    ReferenceVisibility,
    infer Args,
    unknown,
    unknown
  >
    ? Args
    : never;

/** What `Reference` returns. */
export type FunctionReturn<Reference> =
  Reference extends Callable<
    ReferenceKind,
    ReferenceVisibility,
    unknown,
    infer Return,
    unknown
  >
    ? Return
    : never;

/**
 * The progress `Reference` streams; never for a single answer. Read in
 * two steps: inferring from a progress of `never` finds nothing, which
 * would answer `unknown`. A progress of `any` (a draft's stand-in
 * references, save-builds.ts) stays `any`, though it also passes for
 * `never`: a stand-in is any kind of call, a stream's too.
 */
export type ProgressOf<Reference> =
  Reference extends Callable<
    ReferenceKind,
    ReferenceVisibility,
    unknown,
    unknown,
    infer Progress
  >
    ? 0 extends 1 & Progress
      ? Progress
      : Reference extends Callable
        ? never
        : Progress
    : never;

/**
 * The name of the function `value` refers to, as App code calls it
 * through its context (generated or symbolic), read once; undefined when
 * it isn't a plain object with a string `name`. Nothing about it is
 * trusted: the host resolves the name against what the App registers.
 */
export const referenceName = (value: unknown): string | undefined => {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const { name } = value;
  return typeof name === "string" ? name : undefined;
};
