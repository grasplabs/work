import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

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
