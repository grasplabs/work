import { resourceAliasPattern } from "@grasp-os/shared/operation-limits";

import type { FilesOperation } from "./references.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type {
  JsonValue,
  ValueDescriptor,
  ValueSchema,
} from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { descriptorOf, schemaOf } from "./value-schema.ts";
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

/**
 * A files requirement (spec 10.7.5, 32.3): what the App's screens may do
 * with files, through the host. Browser-facing: no function lists it.
 */
export interface FilesResource<
  Alias extends string = string,
  Operations extends readonly FilesOperation[] = readonly FilesOperation[],
> {
  readonly "~resource": "files";
  readonly alias: Alias;
  readonly operations: Operations;
}

/**
 * A links requirement (spec 10.7.7, 32.3): the exact HTTPS origins the
 * App's screens may link to. It grants no network access at all.
 */
export interface LinksResource<
  Alias extends string = string,
  Origins extends readonly string[] = readonly string[],
> {
  readonly "~resource": "links";
  readonly alias: Alias;
  readonly origins: Origins;
}

/** A requirement the App's screens use, never its functions. */
export type BrowserResource = FilesResource | LinksResource;

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
        /**
         * The best matches for `text` in the declared collections: 1 to
         * `knowledgeSearchMaxLength` (500) code units, Knowledge's own
         * limit; a longer text is refused as `contract.invalid_args`.
         */
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

/** Every browser-facing declaration `resource` made. */
const browserDeclarations = new WeakSet<object>();

/** Whether `value` is a declaration `resource` made for actions. */
export const isResource = (value: unknown): value is AnyResource =>
  typeof value === "object" && value !== null && declarations.has(value);

/** Whether `value` is a files or links declaration `resource` made. */
export const isBrowserResource = (value: unknown): value is BrowserResource =>
  typeof value === "object" && value !== null && browserDeclarations.has(value);

/** The operations a files resource may declare. */
const filesOperations: readonly FilesOperation[] = [
  "upload",
  "read",
  "attach",
  "delete",
];

/**
 * An HTTPS origin's form: lower-case host labels, an IPv4 address or a
 * bracketed IPv6 one as the URL standard serializes it, and an optional
 * port. What a URL parser lets through beyond it (a `*`, say) is
 * no origin a browser navigates to exactly.
 */
const originPattern =
  /^https:\/\/(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/u;

/** The most bytes of one link origin. */
const originMaxLength = 253 + "https://".length + ":65535".length;

/**
 * An exact HTTPS origin as the URL standard serializes it: scheme, host
 * and an optional port, nothing else (no path, query, credentials or
 * wildcard), lower case.
 */
const checkedOrigin = (origin: unknown): string => {
  if (typeof origin !== "string" || origin.length > originMaxLength) {
    return refuse(
      "A link origin is an HTTPS origin, e.g. `https://example.com`."
    );
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return refuse(
      "A link origin is an HTTPS origin, e.g. `https://example.com`."
    );
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    !originPattern.test(origin)
  ) {
    return refuse(
      `\`${origin}\` isn't an exact HTTPS origin: \`https://\`, a host and an optional port, in lower case, with nothing after it.`
    );
  }
  return origin;
};

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

/** `value` with every object and array in it frozen; data only. */
const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
  }
  return value;
};

/**
 * `declaration`, frozen all the way down (its lists and a model's output
 * descriptor included), so nothing changes what was checked before the App
 * registers it, and registered as genuine.
 */
const declared = (declaration: AnyResource): AnyResource => {
  const frozen = deepFreeze(declaration);
  declarations.add(frozen);
  return frozen;
};

/** A browser-facing declaration, frozen and registered as genuine. */
const declaredForBrowser = (declaration: BrowserResource): BrowserResource => {
  const frozen = deepFreeze(declaration);
  browserDeclarations.add(frozen);
  return frozen;
};

/** The origins a links declaration lists: 1 to 32 exact HTTPS origins. */
const checkedOrigins = (origins: unknown): readonly string[] => {
  if (
    !Array.isArray(origins) ||
    origins.length === 0 ||
    origins.length > listMax
  ) {
    return refuse(`A links resource lists between 1 and ${listMax} origins.`);
  }
  const listed: readonly unknown[] = origins;
  const checked: string[] = [];
  for (const origin of listed) {
    const exact = checkedOrigin(origin);
    if (checked.includes(exact)) {
      refuse(`A links resource lists \`${exact}\` twice.`);
    }
    checked.push(exact);
  }
  return Object.freeze(checked);
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
  /**
   * What the App's screens may do with files through the host: upload,
   * read, attach, delete. Listed in the App's `uses`, never a function's.
   */
  files: <
    const Alias extends string,
    const Operations extends readonly [FilesOperation, ...FilesOperation[]],
  >(
    alias: Alias,
    config: { readonly operations: Operations }
  ): FilesResource<Alias, Operations> => {
    const checked = checkedConfig(config, ["operations"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and the operations given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declaredForBrowser({
      "~resource": "files",
      alias: checkedAlias(alias),
      operations: checkedList(
        checked.operations,
        "operations",
        filesOperations
      ).filter((operation): operation is FilesOperation =>
        filesOperations.some((known) => known === operation)
      ),
    }) as FilesResource<Alias, Operations>;
  },
  /**
   * The exact HTTPS origins the App's screens may link to. It grants no
   * network access: a screen still has none.
   */
  links: <
    const Alias extends string,
    const Origins extends readonly [string, ...string[]],
  >(
    alias: Alias,
    config: { readonly origins: Origins }
  ): LinksResource<Alias, Origins> => {
    const checked = checkedConfig(config, ["origins"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and the origins given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declaredForBrowser({
      "~resource": "links",
      alias: checkedAlias(alias),
      origins: checkedOrigins(checked.origins),
    }) as LinksResource<Alias, Origins>;
  },
});

/**
 * The declaration `data` describes, as a manifest holds it, declared
 * again through `resource`: it passes exactly the checks a declaration in
 * code does, and anything else (an unknown kind or key, a value out of
 * bounds) throws `ResourceDefinitionError` or `ValueDefinitionError`.
 * Only the host reads declarations back (host.ts).
 */
export const readResourceDeclaration = (
  data: unknown
): AnyResource | BrowserResource => {
  if (!isPlainObject(data)) {
    return refuse("A resource declaration is an object.");
  }
  const { "~resource": kind, alias, ...config } = data;
  if (typeof alias !== "string") {
    return refuse("A resource declaration has an alias.");
  }
  // Each constructor refuses keys its kind hasn't; `~resource` and the
  // alias are read here, the rest is its config.
  // SAFETY: each constructor checks its config at run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const loose = config as never;
  if (kind === "model") {
    const { structuredOutput, ...rest } = config;
    // SAFETY: as above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const modelConfig = {
      ...rest,
      ...(structuredOutput === null
        ? {}
        : {
            structuredOutput: schemaOf(
              readDescriptor(structuredOutput, 1, { nodes: 0 })
            ),
          }),
    } as never;
    return resource.model(alias, modelConfig);
  }
  if (kind === "connector") {
    return resource.connector(alias, loose);
  }
  if (kind === "knowledge") {
    return resource.knowledge(alias, loose);
  }
  if (kind === "template") {
    return resource.template(alias, loose);
  }
  if (kind === "files") {
    return resource.files(alias, loose);
  }
  if (kind === "links") {
    return resource.links(alias, loose);
  }
  return refuse("A resource declaration's kind isn't one this SDK knows.");
};
