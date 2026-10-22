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
// it declares in `uses`: other bindings of the same workflow, by alias,
// of a connector only the operations it names (GRA-704), of a model only
// the shape it declared its answers take, of a knowledge binding (one
// collection) only the operations it names, of a template binding its
// one pinned version (GRA-700), and of a files binding the run's own
// files, with only the operations it names (GRA-724).
//
// ```ts
// import { action, resource, v } from "@grasp-os/sdk/action";
//
// const mail = resource.connector("mail", { operations: ["mail.send"] });
// const writer = resource.model("writer", {
//   output: v.object({ subject: v.string().max(200) }),
// });
//
// export const notify = action({
//   args: { to: v.string().email(), topic: v.string().max(200) },
//   returns: v.object({ sent: v.boolean() }),
//   uses: [mail, writer],
//   handler: async (ctx, args) => {
//     const { subject } = await ctx.resources.writer.generate({
//       instructions: "Write a short subject line for this topic.",
//       input: { topic: args.topic },
//     });
//     await ctx.resources.mail.call("mail.send", { to: args.to, subject });
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
export type UseKind =
  | "connector"
  | "operation"
  | "model"
  | "knowledge"
  | "template"
  | "files";

/** What an action may do with its run's own files (GRA-724). */
export type FilesOperation = "write" | "read" | "list" | "delete";

/** The operations of a Knowledge collection an action may declare. */
export type KnowledgeOperation = "search" | "read";

/**
 * A binding an action declares it uses: its alias and kind, and of a
 * connector the operations it calls.
 */
export interface Use<
  Alias extends string,
  Kind extends UseKind,
  Operation extends string = never,
  Output extends AnySchema = AnySchema,
> {
  readonly "~use": {
    readonly alias: Alias;
    readonly kind: Kind;
    readonly operations: readonly string[];
    /** A model use's: the descriptor of what its calls answer. */
    readonly output?: ValueDescriptor;
  };
  /** Types only: the operations a connector use declared, by name. */
  readonly "~operation"?: Operation;
  /** Types only: the schema a model use's answers take. */
  readonly "~output"?: Output;
}

/** Any declared use. */
export type AnyUse = Use<string, UseKind, string>;

/** How a connector call's answer comes back. */
export interface ConnectorCallOptions {
  /**
   * For a read that answers a file (`mail.readAttachment`, say): the alias
   * of the action's own files use, declared with `write`, to keep it in as
   * a file of the run. The answer then names the file (`file`) in place of
   * its content, so a file larger than a step holds can be read.
   */
  readonly into?: string;
}

/** A connector binding, as an action calls it. */
export interface ConnectorResource<Operation extends string = string> {
  /**
   * Calls `operation` of the connector the binding serves, with `args`:
   * one the use declared, or the host refuses it.
   */
  readonly call: (
    operation: Operation,
    args: JsonValue,
    options?: ConnectorCallOptions
  ) => Promise<JsonValue>;
}

/** An operation binding (an approved App export), as an action calls it. */
export interface OperationResource {
  /** Calls the operation the binding serves, with `args`. */
  readonly call: (args: JsonValue) => Promise<JsonValue>;
}

/** What one call of a model binding sends. */
export interface ModelRequest {
  /** What the model is asked to do, as text. */
  readonly instructions: string;
  /** What it works on: any JSON value. */
  readonly input: JsonValue;
}

/**
 * A model binding, as an action calls it: the binding's own model, each
 * answer of the shape the use declared, checked by the host.
 */
export interface ModelResource<Output extends AnySchema = AnySchema> {
  /** Asks the binding's model, once: its answer, of the declared shape. */
  readonly generate: (request: ModelRequest) => Promise<Infer<Output>>;
}

/**
 * One search hit of a Knowledge collection: its document's ID, which a
 * `read` takes, a title and an excerpt.
 */
export interface KnowledgeHit {
  readonly id: string;
  readonly title: string;
  readonly excerpt: string;
}

/** A document of a Knowledge collection: its title and text. */
export interface KnowledgeDocument {
  readonly title: string;
  readonly text: string;
}

/**
 * A knowledge binding (one collection), as an action calls it: only the
 * operations its use declared, each reading what the run's person may
 * read of the collection, checked by the host.
 */
export type KnowledgeResource<Operation extends KnowledgeOperation> =
  ("search" extends Operation
    ? {
        /** The best matches for `text`: 1 to 500 characters, up to `limit` (1 to 20). */
        readonly search: (request: {
          readonly text: string;
          readonly limit?: number;
        }) => Promise<KnowledgeHit[]>;
      }
    : unknown) &
    ("read" extends Operation
      ? {
          /** One document of the collection, by its ID. */
          readonly read: (request: {
            readonly id: string;
          }) => Promise<KnowledgeDocument>;
        }
      : unknown);

/** A template version, as its binding pins it: data, never code. */
export interface TemplateContent {
  readonly contract: string;
  readonly version: number;
  readonly content: JsonValue;
}

/** A template binding, as an action calls it: its pinned version. */
export interface TemplateResource {
  /** The pinned version's content, as approved. */
  readonly read: () => Promise<TemplateContent>;
}

/**
 * The types a run's file may be: each is checked against its bytes when
 * it is finished.
 */
export type RunFileType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "text/plain"
  | "text/csv"
  | "text/markdown"
  | "application/json"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * A finished file of the run, as its actions hand it on, in a task's
 * answer or arguments: holding one grants nothing outside the run.
 */
export interface RunFile {
  readonly file: string;
  readonly name: string;
  readonly type: RunFileType;
  readonly size: number;
  readonly sha256: string;
}

/**
 * A files binding (the run's own files), as an action calls it: only the
 * operations its use declared. Each call moves at most 512 KiB, so a
 * large file takes several of an attempt's 32 calls; a file is at most
 * 15 MiB, and only a text file may be empty.
 */
export type FilesResource<Operation extends FilesOperation> =
  ("write" extends Operation
    ? {
        /**
         * Writes a file of the run: its name, its type (checked against its
         * bytes) and its content, text or bytes.
         */
        readonly write: (request: {
          readonly name: string;
          readonly type: RunFileType;
          readonly content: string | Uint8Array;
        }) => Promise<RunFile>;
      }
    : unknown) &
    ("read" extends Operation
      ? {
          /** A finished file of the run, as text or as bytes. */
          readonly read: {
            (request: {
              readonly file: string;
              readonly as: "bytes";
            }): Promise<Uint8Array>;
            (request: {
              readonly file: string;
              readonly as?: "text";
            }): Promise<string>;
          };
        }
      : unknown) &
    ("list" extends Operation
      ? {
          /** The run's finished files. */
          readonly list: () => Promise<RunFile[]>;
        }
      : unknown) &
    ("delete" extends Operation
      ? {
          /** Deletes one of the run's files. */
          readonly delete: (request: {
            readonly file: string;
          }) => Promise<void>;
        }
      : unknown);

/** What a use gives an action. */
type ResourceOf<U extends AnyUse> = U["~use"]["kind"] extends "connector"
  ? ConnectorResource<Exclude<U["~operation"], undefined>>
  : U["~use"]["kind"] extends "model"
    ? ModelResource<Exclude<U["~output"], undefined>>
    : U["~use"]["kind"] extends "knowledge"
      ? KnowledgeResource<
          Extract<Exclude<U["~operation"], undefined>, KnowledgeOperation>
        >
      : U["~use"]["kind"] extends "template"
        ? TemplateResource
        : U["~use"]["kind"] extends "files"
          ? FilesResource<
              Extract<Exclude<U["~operation"], undefined>, FilesOperation>
            >
          : OperationResource;

/** What an action's handler gets besides its arguments. */
export interface ActionCtx<Uses extends readonly AnyUse[]> {
  /** Exactly the bindings `uses` declares, by alias. */
  readonly resources: {
    readonly [U in Uses[number] as U["~use"]["alias"]]: ResourceOf<U>;
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

/** A use as `resource` recorded it, out of module code's reach. */
interface DeclaredUse {
  readonly alias: string;
  readonly kind: UseKind;
  readonly operations: readonly string[];
  readonly output?: ValueDescriptor;
}

/** The uses `resource` declared: what makes a value one. */
const declaredUses = new WeakMap<object, DeclaredUse>();

/** The knowledge operations, as `resource.knowledge` takes them. */
const knowledgeOperations: ReadonlySet<string> = new Set(["search", "read"]);

/** The files operations, as `resource.files` takes them. */
const filesOperations: ReadonlySet<string> = new Set([
  "write",
  "read",
  "list",
  "delete",
]);

/** The most operations one connector use declares. */
const maxOperations = 64;
/** The longest operation name. */
const maxOperationChars = 256;

/**
 * `value`'s operations, copied: a non-empty list of distinct names, so
 * nothing the module keeps can change what was declared. Read by index,
 * each item once: no iterator module code could replace.
 */
const operationsOf = (
  value: unknown,
  /** Whose operations, as an error names the use. */
  kind: "connector" | "knowledge" | "files"
): readonly string[] => {
  let most = maxOperations;
  if (kind === "knowledge") {
    most = knowledgeOperations.size;
  } else if (kind === "files") {
    most = filesOperations.size;
  }
  const listed = `A ${kind} use's \`operations\` list the 1 to ${most} operations the action calls.`;
  if (!Array.isArray(value)) {
    return refuse(listed);
  }
  const { length } = value;
  if (length === 0 || length > most) {
    return refuse(listed);
  }
  const copy: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const name: unknown = value[index];
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > maxOperationChars ||
      seen.has(name)
    ) {
      return refuse(
        `Name each operation of a ${kind} use's \`operations\` once, exactly.`
      );
    }
    seen.add(name);
    copy.push(name);
  }
  return freeze(copy);
};

/** Whether `value` is a record `declareUse` kept. */
const isDeclaredUse = (value: unknown): value is DeclaredUse =>
  typeof value === "object" &&
  value !== null &&
  "alias" in value &&
  typeof value.alias === "string" &&
  "kind" in value &&
  (value.kind === "connector" ||
    value.kind === "operation" ||
    value.kind === "model" ||
    value.kind === "knowledge" ||
    value.kind === "template" ||
    value.kind === "files") &&
  "operations" in value &&
  Array.isArray(value.operations);

const declareUse = <
  Alias extends string,
  Kind extends UseKind,
  Output extends AnySchema = AnySchema,
  Operation extends string = never,
>(
  kind: Kind,
  alias: Alias,
  operations: readonly string[],
  output?: ValueDescriptor
): Use<Alias, Kind, Operation, Output> => {
  if (typeof alias !== "string" || !aliasPattern.test(alias)) {
    return refuse(
      "A resource's alias is a binding alias: letters, digits and _."
    );
  }
  const declared = freeze(
    output === undefined
      ? { alias, kind, operations }
      : { alias, kind, operations, output }
  );
  const use: Use<Alias, Kind, Operation, Output> = freeze({
    "~use": declared,
  });
  if (typeof weakSet === "function") {
    apply(weakSet, declaredUses, [use, declared]);
  }
  return use;
};

/** What a connector use declares besides its alias. */
export interface ConnectorUseOptions<Operation extends string> {
  /** The exact operations of the connector the action calls. */
  readonly operations: readonly Operation[];
}

/** What a knowledge use declares besides its alias. */
export interface KnowledgeUseOptions<Operation extends KnowledgeOperation> {
  /** The operations of the binding's collection the action calls. */
  readonly operations: readonly Operation[];
}

/** What a files use declares besides its alias. */
export interface FilesUseOptions<Operation extends FilesOperation> {
  /** What the action does with its run's own files. */
  readonly operations: readonly Operation[];
}

/** What a model use declares besides its alias. */
export interface ModelUseOptions<Output extends AnySchema> {
  /** The shape every answer of the binding's model takes for this action. */
  readonly output: Output;
}

/** The workflow's own bindings an action may declare it uses, by kind. */
export const resource = freeze({
  connector: <const Alias extends string, const Operation extends string>(
    alias: Alias,
    options: ConnectorUseOptions<Operation>
  ): Use<Alias, "connector", Operation> => {
    const property =
      typeof options === "object" && options !== null
        ? getOwnPropertyDescriptor(options, "operations")
        : undefined;
    // A value, read once: never a getter that answers differently later.
    if (property === undefined || !("value" in property)) {
      return refuse(
        "Declare the operations a connector's action calls: `{ operations: [...] }`."
      );
    }
    return declareUse(
      "connector",
      alias,
      operationsOf(property.value, "connector")
    );
  },
  // An App export is one operation: nothing more to declare.
  operation: <const Alias extends string>(alias: Alias) =>
    declareUse("operation", alias, []),
  model: <const Alias extends string, const Output extends AnySchema>(
    alias: Alias,
    options: ModelUseOptions<Output>
  ): Use<Alias, "model", never, Output> => {
    const property =
      typeof options === "object" && options !== null
        ? getOwnPropertyDescriptor(options, "output")
        : undefined;
    // A value, read once: never a getter that answers differently later.
    if (property === undefined || !("value" in property)) {
      return refuse(
        "Declare the shape a model's answers take: `{ output: v.object(...) }`."
      );
    }
    // Throws for anything but a `v` schema. Its type is the declared one.
    return declareUse<Alias, "model", Output>(
      "model",
      alias,
      [],
      descriptorOf(property.value)
    );
  },
  knowledge: <
    const Alias extends string,
    const Operation extends KnowledgeOperation,
  >(
    alias: Alias,
    options: KnowledgeUseOptions<Operation>
  ): Use<Alias, "knowledge", Operation> => {
    const property =
      typeof options === "object" && options !== null
        ? getOwnPropertyDescriptor(options, "operations")
        : undefined;
    if (property === undefined || !("value" in property)) {
      return refuse(
        'Declare the operations a knowledge use calls: `{ operations: ["search", "read"] }`.'
      );
    }
    const operations = operationsOf(property.value, "knowledge");
    if (operations.some((operation) => !knowledgeOperations.has(operation))) {
      return refuse('A knowledge use calls "search", "read" or both.');
    }
    return declareUse<Alias, "knowledge", AnySchema, Operation>(
      "knowledge",
      alias,
      operations
    );
  },
  // One pinned version: nothing more to declare.
  template: <const Alias extends string>(alias: Alias) =>
    declareUse("template", alias, []),
  files: <const Alias extends string, const Operation extends FilesOperation>(
    alias: Alias,
    options: FilesUseOptions<Operation>
  ): Use<Alias, "files", Operation> => {
    const property =
      typeof options === "object" && options !== null
        ? getOwnPropertyDescriptor(options, "operations")
        : undefined;
    if (property === undefined || !("value" in property)) {
      return refuse(
        'Declare what a files use does: `{ operations: ["write", "read", "list", "delete"] }`.'
      );
    }
    const operations = operationsOf(property.value, "files");
    if (operations.some((operation) => !filesOperations.has(operation))) {
      return refuse(
        'A files use calls "write", "read", "list", "delete" or some of them.'
      );
    }
    return declareUse<Alias, "files", AnySchema, Operation>(
      "files",
      alias,
      operations
    );
  },
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

/** A use, as an action's contract records it. */
export type ContractUse =
  | {
      readonly alias: string;
      readonly kind: "connector";
      readonly operations: readonly string[];
    }
  | { readonly alias: string; readonly kind: "operation" }
  | {
      readonly alias: string;
      readonly kind: "model";
      readonly output: ValueDescriptor;
    }
  | {
      readonly alias: string;
      readonly kind: "knowledge";
      readonly operations: readonly string[];
    }
  | { readonly alias: string; readonly kind: "template" }
  | {
      readonly alias: string;
      readonly kind: "files";
      readonly operations: readonly string[];
    };

/** An action's contract, as the host's manifest records it. */
export interface ActionContract {
  readonly input: ValueDescriptor;
  readonly output: ValueDescriptor;
  readonly uses: readonly ContractUse[];
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
      // The brand's record, never the object: a lookalike or a use
      // changed since `resource` made it reads as nothing.
      const use: unknown =
        typeof item === "object" &&
        item !== null &&
        typeof weakGet === "function"
          ? apply(weakGet, declaredUses, [item])
          : undefined;
      if (!isDeclaredUse(use)) {
        return refuse("Declare each resource an action uses with `resource`.");
      }
      if (seen.has(use.alias)) {
        return refuse(`An action uses \`${use.alias}\` once.`);
      }
      seen.add(use.alias);
      if (use.kind === "connector") {
        return freeze({
          alias: use.alias,
          kind: use.kind,
          // Frozen as `resource` copied it.
          operations: use.operations,
        });
      }
      if (use.kind === "knowledge" || use.kind === "files") {
        return freeze({
          alias: use.alias,
          kind: use.kind,
          operations: use.operations,
        });
      }
      if (use.kind === "model") {
        return use.output === undefined
          ? refuse("Declare the shape a model's answers take.")
          : freeze({ alias: use.alias, kind: use.kind, output: use.output });
      }
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
