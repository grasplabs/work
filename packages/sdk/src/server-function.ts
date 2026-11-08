import type {
  Callable,
  ReferenceKind,
  ReferenceVisibility,
} from "./function-references.ts";
import type { AnyTable } from "./schema-types.ts";
import type { AnySchema } from "./value-schema.ts";
import type {
  Infer,
  ObjectInput,
  ObjectOutput,
  ObjectSchema,
  ValueShape,
} from "./value-types.ts";

/** The three kinds of server function. */
export type FunctionKind = ReferenceKind;

/** Who may call a function directly: anyone allowed, or the App's own code. */
export type Visibility = ReferenceVisibility;

/** A schema's tables, by name. */
export type AnyTables = Readonly<Record<string, AnyTable>>;

/**
 * A function as callers type it: its kind, visibility, arguments (as a
 * caller passes them and as the handler gets them) and return. A
 * definition is one, and so is the reference generated for it:
 * the phantom members carry inference only and are never set.
 */
export type FunctionReference<
  Kind extends FunctionKind = FunctionKind,
  Vis extends Visibility = Visibility,
  ArgsIn = unknown,
  Return = unknown,
  Progress = unknown,
> = Callable<Kind, Vis, ArgsIn, Return, Progress>;

/**
 * What a handler may answer, `Returns` the schema its declaration gives
 * (`undefined` where it gives none): what the schema infers, or anything,
 * which the host checks as JSON only. One signature for both,
 * as Convex's: a wrong answer is then reported where it is, not as no
 * overload matching.
 */
export type ResultFor<Returns extends AnySchema | undefined> =
  Returns extends AnySchema ? Infer<Returns> : unknown;

/** What a function answers: its `returns` schema's, or its handler's. */
export type Declared<
  Returns extends AnySchema | undefined,
  Result,
> = Returns extends AnySchema ? Infer<Returns> : Result;

/**
 * A declared server function, as the App registers it. `Return` is what
 * it answers: what its `returns` schema infers, or, where it declares
 * none, what its handler answers.
 */
export interface ServerFunction<
  Kind extends FunctionKind,
  Vis extends Visibility,
  Shape extends ValueShape,
  Return,
  Ctx,
  Stream extends AnySchema | null = null,
> extends Callable<
  Kind,
  Vis,
  ObjectInput<Shape>,
  Return,
  Stream extends AnySchema ? Infer<Stream> : never
> {
  readonly kind: Kind;
  readonly visibility: Vis;
  readonly args: ObjectSchema<Shape>;
  /** Its `returns` schema, which the host checks its answers against; null where it declares none. */
  readonly returns: AnySchema | null;
  /** An action's progress snapshots, or null. */
  readonly stream: Stream;
  readonly handler: (ctx: Ctx, args: ObjectOutput<Shape>) => unknown;
}

/**
 * Any declared server function. Its handler takes nothing it could be
 * called with: only the runner calls it, with the context of its kind.
 */
export interface AnyFunction extends FunctionReference {
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
  readonly args: AnySchema;
  readonly returns: AnySchema | null;
  readonly stream: AnySchema | null;
  readonly handler: (ctx: never, args: never) => unknown;
}
