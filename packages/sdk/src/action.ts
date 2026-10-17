import type { JsonValue, ValueDescriptor } from "./value-descriptor.ts";
import { isPlainObject } from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";
import { v } from "./values.ts";
import type { Infer, InferInput, ObjectSchema, ValueShape } from "./values.ts";

// `action`: a workflow's own action (platform specification 13.6), which a
// JSON workflow calls through a `grasp.operation` binding to
// `local:code/<file>.ts#<export>`. It lives in the workflow's own `code/`
// modules, beside its calculations, and reaches nothing but the bindings
// it declares in `uses`: other bindings of the same workflow, by alias.
//
// ```ts
// import { action, resource, v } from "@grasp-os/sdk/action";
//
// const mail = resource.connector("mail");
//
// export const notify = action({
//   args: { to: v.string().email(), subject: v.string().max(200) },
//   returns: v.object({ sent: v.boolean() }),
//   uses: [mail],
//   handler: async (ctx, args) => {
//     await ctx.resources.mail.call("send", { to: args.to, subject: args.subject });
//     return { sent: true };
//   },
// });
// ```
//
// A definition is a value: it runs nothing. The host reads its contract
// (its arguments, its answer and what it uses) once, as the version is
// published, checks every alias it uses against the workflow's own
// bindings, and seals it. A run's call runs the handler in an isolate of
// its own, with no env, no network, no clock and no randomness
// (compute-runner.ts); `ctx.resources` holds exactly the declared
// bindings, each call of one made by the host, through the binding the
// run's start froze, with its authority decided again and a receipt of
// its own. `ctx` holds nothing else: no database, no workflow step, no
// way to start a workflow.

export { v } from "./values.ts";
export type { Infer, InferInput } from "./values.ts";

/** The kinds of binding an action may use in this release. */
export type UseKind = "connector" | "operation";

/** A binding an action declares it uses: its alias and kind. */
export interface Use<Alias extends string, Kind extends UseKind> {
  readonly "~use": { readonly alias: Alias; readonly kind: Kind };
}

/** Any declared use. */
export type AnyUse = Use<string, UseKind>;

/** A connector binding, as an action calls it. */
export interface ConnectorResource {
  /** Calls `operation` of the connector the binding serves, with `args`. */
  readonly call: (operation: string, args: JsonValue) => Promise<JsonValue>;
}

/** An operation binding (an approved App export), as an action calls it. */
export interface OperationResource {
  /** Calls the operation the binding serves, with `args`. */
  readonly call: (args: JsonValue) => Promise<JsonValue>;
}

/** What each kind of use gives an action. */
interface ResourceOfKind {
  readonly connector: ConnectorResource;
  readonly operation: OperationResource;
}

/** What an action's handler gets besides its arguments. */
export interface ActionCtx<Uses extends readonly AnyUse[]> {
  /** Exactly the bindings `uses` declares, by alias. */
  readonly resources: {
    readonly [
      U in Uses[number] as U["~use"]["alias"]
    ]: ResourceOfKind[U["~use"]["kind"]];
  };
}

/** The pattern a binding alias has, as the profile names bindings. */
const aliasPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** Why an action's declaration was refused. */
export class ActionDefinitionError extends Error {
  readonly code = "action.invalid_definition";

  constructor(message: string) {
    super(message);
    this.name = "ActionDefinitionError";
  }
}

const refuse = (message: string): never => {
  throw new ActionDefinitionError(message);
};

/**
 * The intrinsics this module calls, taken as it loads, before any of the
 * workflow's modules (compute-runner.ts loads it first).
 */
const { apply } = Reflect;
const { freeze, getOwnPropertyDescriptor, keys } = Object;
const weakGet: unknown = Reflect.getOwnPropertyDescriptor(
  WeakMap.prototype,
  "get"
)?.value;
const weakSet: unknown = Reflect.getOwnPropertyDescriptor(
  WeakMap.prototype,
  "set"
)?.value;

/** The uses `resource` declared: what makes a value one. */
const declaredUses = new WeakMap<object, { alias: string; kind: UseKind }>();

const declareUse = <Alias extends string, Kind extends UseKind>(
  kind: Kind,
  alias: Alias
): Use<Alias, Kind> => {
  if (typeof alias !== "string" || !aliasPattern.test(alias)) {
    return refuse(
      "A resource's alias is a binding alias: letters, digits and _."
    );
  }
  const use = freeze({ "~use": freeze({ alias, kind }) });
  if (typeof weakSet === "function") {
    apply(weakSet, declaredUses, [use, { alias, kind }]);
  }
  return use;
};

/** The workflow's own bindings an action may declare it uses, by kind. */
export const resource = freeze({
  connector: <const Alias extends string>(alias: Alias) =>
    declareUse("connector", alias),
  operation: <const Alias extends string>(alias: Alias) =>
    declareUse("operation", alias),
});

/** What `action` is declared with. */
export interface ActionDefinition<
  Args extends ValueShape,
  Returns extends AnySchema,
  Uses extends readonly AnyUse[],
> {
  /** Its arguments' fields: the host checks each call's against them. */
  readonly args: Args;
  /** What it answers: the host checks each answer against it. */
  readonly returns: Returns;
  /** The workflow's bindings it reaches, and nothing else. */
  readonly uses: Uses;
  readonly handler: (
    ctx: ActionCtx<Uses>,
    args: Infer<ObjectSchema<Args>>
  ) => Promise<InferInput<Returns>> | InferInput<Returns>;
}

/** An action's contract, as the host's manifest records it. */
export interface ActionContract {
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
  readonly uses: readonly { readonly alias: string; readonly kind: UseKind }[];
}

/** A declared action, as `action` answers it. */
export interface Action {
  readonly "~action": ActionContract;
}

/** A handler as the runner calls it. */
export type AnyActionHandler = (ctx: unknown, args: unknown) => unknown;

const isHandler = (value: unknown): value is AnyActionHandler =>
  typeof value === "function";

/** The handler of each action `action` declared, by its value. */
const handlers = new WeakMap<object, AnyActionHandler>();

const definitionKeys: ReadonlySet<string> = new Set([
  "args",
  "returns",
  "uses",
  "handler",
]);

/** The most bindings one action uses. */
const maxUses = 32;

/** Reads `key` of `definition` as a data property: never a getter. */
const dataOf = (definition: object, key: string): unknown => {
  const property = getOwnPropertyDescriptor(definition, key);
  if (property !== undefined && !("value" in property)) {
    return refuse(`An action's \`${key}\` is a value, not a getter.`);
  }
  return property?.value;
};

/** The uses `value` lists, each declared by `resource`, each alias once. */
const usesOf = (value: unknown): ActionContract["uses"] => {
  if (!Array.isArray(value) || value.length > maxUses) {
    return refuse(
      `An action's \`uses\` lists at most ${maxUses} resources declared with \`resource\`.`
    );
  }
  const seen = new Set<string>();
  return freeze(
    Array.from(value, (item: unknown) => {
      const use: unknown =
        typeof item === "object" &&
        item !== null &&
        typeof weakGet === "function"
          ? apply(weakGet, declaredUses, [item])
          : undefined;
      if (
        typeof use !== "object" ||
        use === null ||
        !("alias" in use) ||
        typeof use.alias !== "string" ||
        !("kind" in use) ||
        (use.kind !== "connector" && use.kind !== "operation")
      ) {
        return refuse("Declare each resource an action uses with `resource`.");
      }
      if (seen.has(use.alias)) {
        return refuse(`An action uses \`${use.alias}\` once.`);
      }
      seen.add(use.alias);
      return freeze({ alias: use.alias, kind: use.kind });
    })
  );
};

/**
 * Declares an action (see the header): throws `ActionDefinitionError` for
 * a declaration that isn't one.
 */
export const action = <
  const Args extends ValueShape,
  const Returns extends AnySchema,
  const Uses extends readonly AnyUse[],
>(
  definition: ActionDefinition<Args, Returns, Uses>
): Action => {
  if (!isPlainObject(definition)) {
    return refuse("Declare an action as `{ args, returns, uses, handler }`.");
  }
  for (const key of keys(definition)) {
    if (!definitionKeys.has(key)) {
      refuse(`An action has no \`${key}\`.`);
    }
  }
  const handler = dataOf(definition, "handler");
  if (!isHandler(handler)) {
    return refuse("An action's `handler` is a function.");
  }
  if (!isPlainObject(dataOf(definition, "args"))) {
    return refuse(
      "An action's `args` are its fields, as `v.object` takes them."
    );
  }
  const contract: ActionContract = freeze({
    // Each throws for anything but `v` schemas.
    input: descriptorOf(v.object(definition.args)),
    output: descriptorOf(dataOf(definition, "returns")),
    uses: usesOf(dataOf(definition, "uses")),
  });
  const declared: Action = freeze({ "~action": contract });
  if (typeof weakSet === "function") {
    apply(weakSet, handlers, [declared, handler]);
  }
  return declared;
};

/**
 * The handler of `value` if `action` declared it; undefined for anything
 * else, a lookalike included. For the runner (compute-runner.ts) only.
 */
export const actionHandler = (value: unknown): AnyActionHandler | undefined => {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    typeof weakGet !== "function"
  ) {
    return undefined;
  }
  const found: unknown = apply(weakGet, handlers, [value]);
  return isHandler(found) ? found : undefined;
};
