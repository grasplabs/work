import { isPlainObject } from "@grasp-os/shared/json";

import type { Grant } from "./ctx-workflows.ts";
import { refuser } from "./declaration.ts";
import { serverFunctions } from "./handlers.ts";
import type { SchemaDefinition } from "./schema-types.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
import type {
  ActionCtx,
  MutationCtx,
  QueryCtx,
  StreamActionCtx,
} from "./server-ctx.ts";
import type {
  AnyFunction,
  AnyTables,
  FunctionKind,
  Visibility,
} from "./server-function.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer, ObjectOutput, ValueShape } from "./value-types.ts";
import { v } from "./values.ts";

/** A query's declaration. */
export interface QueryDefinition<
  Tables extends AnyTables,
  Shape extends ValueShape,
  Returns extends AnySchema | undefined,
  Result,
> {
  readonly args: Shape;
  /** What it answers; without it, what its handler answers. */
  readonly returns?: Returns;
  readonly handler: (
    ctx: QueryCtx<Tables>,
    args: ObjectOutput<Shape>
  ) => Result | Promise<Result>;
}

/** A mutation's declaration. */
export interface MutationDefinition<
  Tables extends AnyTables,
  Shape extends ValueShape,
  Returns extends AnySchema | undefined,
  Result,
  Grants extends Grant,
> {
  readonly args: Shape;
  /** What it answers; without it, what its handler answers. */
  readonly returns?: Returns;
  readonly handler: (
    ctx: MutationCtx<Tables, Grants>,
    args: ObjectOutput<Shape>
  ) => Result | Promise<Result>;
}

/** An action's declaration. */
export interface ActionDefinition<
  Shape extends ValueShape,
  Returns extends AnySchema | undefined,
  Result,
  Grants extends Grant,
> {
  readonly args: Shape;
  /** What it answers; without it, what its handler answers. */
  readonly returns?: Returns;
  /** Declared only by a streaming action (`StreamActionDefinition`). */
  readonly stream?: undefined;
  readonly handler: (
    ctx: ActionCtx<Grants>,
    args: ObjectOutput<Shape>
  ) => Result | Promise<Result>;
}

/**
 * A streaming action's declaration: an action's, and the
 * schema of the progress snapshots its handler emits (`ctx.emit`). It
 * runs only in the foreground, for a page following it (`useStream`).
 */
export interface StreamActionDefinition<
  Shape extends ValueShape,
  Returns extends AnySchema | undefined,
  Result,
  Grants extends Grant,
  Stream extends AnySchema,
> {
  readonly args: Shape;
  /** What it answers; without it, what its handler answers. */
  readonly returns?: Returns;
  /** Its progress snapshots: each one whole, bounded like a result. */
  readonly stream: Stream;
  readonly handler: (
    ctx: StreamActionCtx<Grants, Infer<Stream>>,
    args: ObjectOutput<Shape>
  ) => Result | Promise<Result>;
}

/** Why a server function's declaration was refused. */
class FunctionDefinitionError extends Error {
  readonly code = "function.invalid_definition";

  constructor(message: string) {
    super(message);
    this.name = "FunctionDefinitionError";
  }
}

export const refuse: (message: string) => never = refuser(
  FunctionDefinitionError
);

/** The keys each kind's declaration has; any other is refused. */
const declarationKeys: Readonly<Record<FunctionKind, readonly string[]>> = {
  query: ["args", "returns", "handler"],
  mutation: ["args", "returns", "handler"],
  action: ["args", "returns", "stream", "handler"],
};

/** A definition of `kind` and `visibility` from `declaration`, checked. */
export const defineFunction = (
  schema: SchemaDefinition,
  kind: FunctionKind,
  visibility: Visibility,
  declaration: unknown
): AnyFunction => {
  if (!isPlainObject(declaration)) {
    return refuse(`A ${kind} is declared with an object.`);
  }
  for (const key of Object.keys(declaration)) {
    if (!declarationKeys[kind].includes(key)) {
      const article = kind === "action" ? "An" : "A";
      refuse(`${article} ${kind}'s declaration has no \`${key}\`.`);
    }
  }
  const { args, returns, handler, stream } = declaration;
  if (!isPlainObject(args)) {
    refuse(`A ${kind}'s \`args\` is a map of field names to schemas.`);
  }
  // Optional: without it, the handler's answer is its return.
  // Throws for anything but a `v` schema.
  if (returns !== undefined) {
    descriptorOf(returns);
  }
  if (stream !== undefined) {
    descriptorOf(stream);
  }
  if (typeof handler !== "function") {
    refuse(`A ${kind}'s \`handler\` is a function of \`(ctx, args)\`.`);
  }
  // SAFETY: `args` was checked to be a plain object; `v.object` checks
  // each of its fields is a `v` schema, and refuses the shape otherwise.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const argsSchema = v.object(args as ValueShape);
  const definition = Object.freeze({
    kind,
    visibility,
    args: argsSchema,
    // SAFETY: `descriptorOf` above accepted it, so it is a `v` schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    returns: (returns ?? null) as AnySchema | null,
    // SAFETY: as `returns`, when given.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    stream: (stream ?? null) as AnySchema | null,
    // SAFETY: checked to be a function; the host calls it with the
    // context of its kind and the validated arguments.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    handler: handler as AnyFunction["handler"],
  });
  serverFunctions.add(definition, Object.freeze({ schema }));
  return definition;
};
