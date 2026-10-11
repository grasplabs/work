import { resourceAliasPattern } from "@grasp-os/shared/operation-limits";

import { isPlainObject } from "./value-descriptor.ts";
import type {
  JsonValue,
  ValueDescriptor,
  ValueSchema,
} from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";
import type { Infer } from "./values.ts";

// `resource`: how an App says which outside capabilities its actions need
// (spec 12, 32.3): a model, a connector's actions, knowledge collections,
// a template. A declaration is a requirement, never a grant: it names an
// adapter contract and an alias, and the host binds it to an approved
// resource, under the App's grants, or refuses. It holds no ID, key or
// token, and building one reaches nothing.
//
// Only an action can use one, through `ctx.resources.<alias>`, and only
// one it lists in its `uses`; queries and mutations never reach the
// network (inspection refuses a resource in their `uses`, app.ts).

/** The kinds of resource an action can use. */
export type ResourceKind = "model" | "connector" | "knowledge" | "template";

/** What a declaration's config may say about a model. */
export interface ModelConfig<Output extends AnySchema | undefined> {
  /** The value every answer must be: text when not set. */
  readonly structuredOutput?: Output;
  /** The most tokens one answer may take: a whole number, 1 to 100 000. */
  readonly maxOutputTokens: number;
}

/** What a declaration's config may say about a connector. */
export interface ConnectorConfig<Actions extends readonly string[]> {
  /** The adapter contract and its major version, e.g. `grasp.mail@1`. */
  readonly contract: string;
  /** The contract's actions the App needs, each once. */
  readonly actions: Actions;
}

/** The knowledge operations an action may ask for. */
export type KnowledgeOperation = "search" | "read";

/** What a declaration's config may say about knowledge. */
export interface KnowledgeConfig<
  Operations extends readonly KnowledgeOperation[],
> {
  readonly operations: Operations;
  /**
   * The collections the App needs, by the names its builders gave them:
   * requirements the host resolves, never a way to list others.
   */
  readonly collections: readonly string[];
}

/** What a declaration's config may say about a template. */
export interface TemplateConfig {
  /** The template's contract and its major version. */
  readonly contract: string;
}

interface DeclarationBase<Kind extends ResourceKind, Alias extends string> {
  readonly "~resource": Kind;
  readonly alias: Alias;
}

/** A model requirement. */
export interface ModelResource<
  Alias extends string = string,
  Output = string,
> extends DeclarationBase<"model", Alias> {
  /** The descriptor every answer must fit, or null for text. */
  readonly structuredOutput: ValueDescriptor | null;
  readonly maxOutputTokens: number;
  /** The answer's type, for types only: never set. */
  readonly "~output"?: Output;
}

/** A connector requirement. */
export interface ConnectorResource<
  Alias extends string = string,
  Actions extends readonly string[] = readonly string[],
> extends DeclarationBase<"connector", Alias> {
  readonly contract: string;
  readonly actions: Actions;
}

/** A knowledge requirement. */
export interface KnowledgeResource<
  Alias extends string = string,
  Operations extends readonly KnowledgeOperation[] =
    readonly KnowledgeOperation[],
> extends DeclarationBase<"knowledge", Alias> {
  readonly operations: Operations;
  readonly collections: readonly string[];
}

/** A template requirement. */
export interface TemplateResource<
  Alias extends string = string,
> extends DeclarationBase<"template", Alias> {
  readonly contract: string;
}

/** Any resource requirement. */
export type AnyResource =
  | ModelResource<string, unknown>
  | ConnectorResource
  | KnowledgeResource
  | TemplateResource;

/** One search result from knowledge: a title and an excerpt of it. */
export interface KnowledgeHit {
  title: string;
  excerpt: string;
}

/** A document read from knowledge. */
export interface KnowledgeDocument {
  title: string;
  text: string;
}

/** A template as its pinned version holds it: data, never code. */
export interface TemplateContent {
  contract: string;
  version: number;
  content: JsonValue;
}

/** What `ctx.resources.<alias>` is for a model. */
export interface ModelClient<Output> {
  /** One answer to `prompt`, within the declared token bound and budget. */
  readonly generate: (request: {
    readonly prompt: string;
    readonly instructions?: string;
  }) => Promise<Output>;
}

/** What `ctx.resources.<alias>` is for a connector. */
export interface ConnectorClient<Actions extends readonly string[]> {
  /** One of the declared actions, with its arguments, through connect. */
  readonly call: (
    action: Actions[number],
    args: Readonly<Record<string, JsonValue>>
  ) => Promise<JsonValue>;
}

/** What `ctx.resources.<alias>` is for knowledge, by its operations. */
export type KnowledgeClient<Operations extends readonly KnowledgeOperation[]> =
  ("search" extends Operations[number]
    ? {
        /** The best matches for `text` in the declared collections. */
        readonly search: (request: {
          readonly text: string;
          readonly limit?: number;
        }) => Promise<KnowledgeHit[]>;
      }
    : unknown) &
    ("read" extends Operations[number]
      ? {
          /** One document of the declared collections, by its ID. */
          readonly read: (request: {
            readonly id: string;
          }) => Promise<KnowledgeDocument>;
        }
      : unknown);

/** What `ctx.resources.<alias>` is for a template. */
export interface TemplateClient {
  /** The template's pinned version. */
  readonly read: () => Promise<TemplateContent>;
}

/** What `ctx.resources.<alias>` is for `Resource`. */
export type ResourceClient<Resource> =
  Resource extends ModelResource<string, infer Output>
    ? ModelClient<Output>
    : Resource extends ConnectorResource<string, infer Actions>
      ? ConnectorClient<Actions>
      : Resource extends KnowledgeResource<string, infer Operations>
        ? KnowledgeClient<Operations>
        : Resource extends TemplateResource
          ? TemplateClient
          : never;

/** Why a resource's declaration was refused. */
export class ResourceDefinitionError extends Error {
  readonly code = "resource.invalid_declaration";

  constructor(message: string) {
    super(message);
    this.name = "ResourceDefinitionError";
  }
}

const refuse = (message: string): never => {
  throw new ResourceDefinitionError(message);
};

/** A contract and its major version, e.g. `grasp.mail@1`. */
const contractPattern =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*@[1-9]\d{0,5}$/u;

/** An action, operation or collection name a declaration lists. */
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** The most entries one declaration lists. */
const listMax = 32;

/** Every declaration `resource` made; nothing else counts as one. */
const declarations = new WeakSet<object>();

/** Whether `value` is a declaration `resource` made. */
export const isResource = (value: unknown): value is AnyResource =>
  typeof value === "object" && value !== null && declarations.has(value);

const checkedAlias = (alias: unknown): string =>
  typeof alias === "string" && resourceAliasPattern.test(alias)
    ? alias
    : refuse(
        "A resource's alias is a letter, then letters, digits or underscores, at most 64."
      );

const checkedConfig = (
  config: unknown,
  keys: readonly string[]
): Record<string, unknown> => {
  if (!isPlainObject(config)) {
    return refuse("A resource's config is an object.");
  }
  for (const key of Object.keys(config)) {
    if (!keys.includes(key)) {
      refuse(`A resource's config has no \`${key}\`.`);
    }
  }
  return config;
};

const checkedContract = (contract: unknown): string =>
  typeof contract === "string" && contractPattern.test(contract)
    ? contract
    : refuse(
        "A contract is a dotted name and its major version, e.g. `grasp.mail@1`."
      );

const checkedList = (
  list: unknown,
  what: string,
  allowed?: readonly string[]
): readonly string[] => {
  if (!Array.isArray(list) || list.length === 0 || list.length > listMax) {
    return refuse(`A resource lists between 1 and ${listMax} ${what}.`);
  }
  const items: readonly unknown[] = list;
  const names: string[] = [];
  for (const name of items) {
    if (
      typeof name !== "string" ||
      !namePattern.test(name) ||
      (allowed !== undefined && !allowed.includes(name))
    ) {
      return refuse(`A resource lists ${what} it can't have.`);
    }
    if (names.includes(name)) {
      refuse(`A resource lists \`${name}\` twice.`);
    }
    names.push(name);
  }
  return Object.freeze(names);
};

/** `declaration`, frozen and registered as genuine. */
const declared = (declaration: AnyResource): AnyResource => {
  const frozen = Object.freeze(declaration);
  declarations.add(frozen);
  return frozen;
};

/**
 * Resource requirements (spec 32.3). Each answers a frozen declaration to
 * list in an action's `uses` and the App's `uses`; the host binds it.
 */
export const resource = Object.freeze({
  /** A model, answering text or `structuredOutput`. */
  model: <
    const Alias extends string,
    Output extends AnySchema | undefined = undefined,
  >(
    alias: Alias,
    config: ModelConfig<Output>
  ): ModelResource<
    Alias,
    Output extends ValueSchema<unknown, unknown> ? Infer<Output> : string
  > => {
    const checked = checkedConfig(config, [
      "structuredOutput",
      "maxOutputTokens",
    ]);
    const { maxOutputTokens, structuredOutput } = checked;
    if (
      typeof maxOutputTokens !== "number" ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 100_000
    ) {
      return refuse("`maxOutputTokens` is a whole number, 1 to 100 000.");
    }
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and lists holding exactly the names
    // given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~resource": "model",
      alias: checkedAlias(alias),
      maxOutputTokens,
      // The descriptor, as data: what the host checks answers against.
      structuredOutput:
        structuredOutput === undefined
          ? null
          : structuredClone(descriptorOf(structuredOutput)),
    }) as ModelResource<
      Alias,
      Output extends ValueSchema<unknown, unknown> ? Infer<Output> : string
    >;
  },
  /** Some of a connector contract's actions. */
  connector: <
    const Alias extends string,
    const Actions extends readonly [string, ...string[]],
  >(
    alias: Alias,
    config: ConnectorConfig<Actions>
  ): ConnectorResource<Alias, Actions> => {
    const checked = checkedConfig(config, ["contract", "actions"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and lists holding exactly the names
    // given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~resource": "connector",
      alias: checkedAlias(alias),
      contract: checkedContract(checked.contract),
      actions: checkedList(checked.actions, "actions"),
    }) as ConnectorResource<Alias, Actions>;
  },
  /** Search and reading of some knowledge collections. */
  knowledge: <
    const Alias extends string,
    const Operations extends readonly [
      KnowledgeOperation,
      ...KnowledgeOperation[],
    ],
  >(
    alias: Alias,
    config: KnowledgeConfig<Operations>
  ): KnowledgeResource<Alias, Operations> => {
    const checked = checkedConfig(config, ["operations", "collections"]);
    const operations = checkedList(checked.operations, "operations", [
      "search",
      "read",
    ]).filter(
      (operation): operation is KnowledgeOperation =>
        operation === "search" || operation === "read"
    );
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and lists holding exactly the names
    // given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~resource": "knowledge",
      alias: checkedAlias(alias),
      operations,
      collections: checkedList(checked.collections, "collections"),
    }) as KnowledgeResource<Alias, Operations>;
  },
  /** An immutable template, pinned by its contract. */
  template: <const Alias extends string>(
    alias: Alias,
    config: TemplateConfig
  ): TemplateResource<Alias> => {
    const checked = checkedConfig(config, ["contract"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and lists holding exactly the names
    // given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~resource": "template",
      alias: checkedAlias(alias),
      contract: checkedContract(checked.contract),
    }) as TemplateResource<Alias>;
  },
});
