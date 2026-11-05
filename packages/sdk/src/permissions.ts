import type {
  MemoryPack,
  SkillRead,
  SkillSelection,
  SkillsReadInput,
  SkillsSelectInput,
} from "@grasp-os/brain/contract";
import { originRefusal } from "@grasp-os/shared/app-link-limits";
import type {
  GuestChat,
  GuestInvitation,
  GuestInvite,
  GuestTranscript,
} from "@grasp-os/shared/guests";
import { identifierMaxLength } from "@grasp-os/shared/identifier";
import { canonicalText } from "@grasp-os/shared/json";
import type { ResourceRecallInput } from "@grasp-os/shared/knowledge";
import {
  resourceAliasPattern,
  storeOperationPathMaxLength,
  storeOperationPathPattern,
} from "@grasp-os/shared/operation-limits";
import type {
  PlatformMeasure,
  platformMeasures,
} from "@grasp-os/shared/platform-measures";

import type { ConnectorCatalog } from "./connector-catalog.gen.ts";
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
import { v } from "./values.ts";
import type { Infer, InferInput, ObjectInput, ValueShape } from "./values.ts";

// `permission`: how an App says what it can reach outside itself (spec 12,
// 32.3), as an admin thinks of it. Eight permissions, each listed under
// its own key of the App's `permissions` (app.ts):
//
// - `ai`: answers from the workspace's model (`ctx.ai.generate`);
// - `connections`: some actions of a connection, through connect
//   (`ctx.connections.<alias>`);
// - `brain`: searching and reading some of the Brain's collections
//   (`ctx.brain`);
// - `workflows`: independent workflows the App starts
//   (`ctx.workflows.<alias>.start`);
// - `apps`: another App's public functions (`ctx.apps.<alias>`), and the
//   platform's own read-only ones (`permission.grasp`, `ctx.apps.grasp`);
// - `people`: the organization's members (`ctx.people`), a flag on the
//   App's `permissions`, never a declaration;
// - `files`: what the App's screens may do with files;
// - `guests`: guest chats (`ctx.guests`).
//
// and `links`, the exact origins the App's screens may link to, which
// grants no network access at all.
//
// A declaration is a requirement, never a grant: it names an adapter
// contract and an alias, and the host binds it to an approved target,
// under the App's grants, or refuses. It holds no ID, key or token, and
// building one reaches nothing. Only an action reaches one, and only one
// it lists in its `uses`; queries and mutations never reach the network
// (inspection refuses a permission in their `uses`, app.ts). A mutation
// lists the workflows it starts after it commits.
//
// Another App's functions are its public queries, mutations and actions,
// each named by its path with the exact arguments and return the App
// declares for it, so the binding resolves only where that App serves
// exactly that. Its tables and schema stay its own: the declaration
// copies none of them, and the host runs each call as that App's own code.

/** The kinds of permission an action reaches through `ctx`. */
export type PermissionKind = "ai" | "connections" | "brain" | "apps" | "guests";

/**
 * The fixed alias of each permission an App holds at most once: what the
 * host binds it under, never chosen by the App.
 */
export const permissionAliases = Object.freeze({
  ai: "ai",
  brain: "brain",
  guests: "guests",
  files: "files",
  links: "links",
} as const);

/**
 * The alias of the platform's own read-only functions among an App's
 * `apps` (`permission.grasp`): never another App's.
 */
export const graspAlias = "grasp";

/** What an `ai` permission may say. */
export interface AiConfig {
  /**
   * The most tokens one answer may take, all its asks together: a whole
   * number, 1 to 100 000.
   */
  readonly maxOutputTokens: number;
}

/**
 * A Composio connection's generated contract, `composio.<toolkit>@1`: the
 * tools its admin allowed, each an action named by its tool, such as
 * `HUBSPOT_LIST_CONTACTS`. Composio changes its toolkits without a release
 * of Grasp, so they aren't in the release's catalog and their calls aren't
 * typed (`ComposioCall`): the host checks each one, both ways, against the
 * contract the binding pinned when an admin approved it.
 */
export type ComposioContract = `composio.${string}@1`;

/**
 * An outside API an admin approved as an HTTP connection (GRA-1478): its
 * one origin, the paths and methods it allows, and its credential, which
 * connect adds and nobody else sees. Its actions are `get` (a read: GET or
 * HEAD) and `send` (POST, PUT, PATCH or DELETE, a change a person confirms
 * where they are there); its client also has `fetch`, which picks the
 * action by the method. The same as `httpContract` in
 * `@grasp-os/shared/http-connections`.
 */
export type HttpContract = "http.request@1";

/** An HTTP connection's contract, for `permission.connection`. */
export const httpContract: HttpContract = "http.request@1";

/** The headers a request sets: never its credential, which connect adds. */
type HttpHeaders = Readonly<Record<string, string>>;

/** What an HTTP connection's request answers: never redirected off it. */
export interface HttpAnswer {
  readonly status: number;
  readonly headers: HttpHeaders;
  /** The response's text: at most 512 KiB. */
  readonly body: string;
}

/** An HTTP connection's actions, as `call` takes them. */
interface HttpActions {
  readonly get: {
    readonly input: {
      readonly method?: "GET" | "HEAD";
      /** The path and query, starting with `/`, under an allowed prefix. */
      readonly path: string;
      readonly headers?: HttpHeaders;
    };
    readonly output: HttpAnswer;
  };
  readonly send: {
    readonly input: {
      readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly headers?: HttpHeaders;
      /** At most 48 KiB of text, such as `JSON.stringify(value)`. */
      readonly body?: string;
    };
    readonly output: HttpAnswer;
  };
}

/** What `fetch` of an HTTP connection's client takes besides its path. */
export interface HttpRequestInit {
  readonly method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly headers?: HttpHeaders;
  readonly body?: string;
}

/**
 * A generated connector contract (spec 12): a native connector's tools of
 * one family, such as `microsoft-365.mail@1`, from this release's catalog;
 * a Composio toolkit's (`ComposioContract`); or an HTTP connection's
 * (`HttpContract`).
 */
export type ConnectorContract =
  | Extract<keyof ConnectorCatalog, string>
  | ComposioContract
  | HttpContract;

/**
 * The actions of connector contract `Contract`, by name: any name for a
 * Composio contract, whose tools only its binding knows.
 */
export type ConnectorAction<Contract extends ConnectorContract> =
  Contract extends keyof ConnectorCatalog
    ? Extract<keyof ConnectorCatalog[Contract], string>
    : Contract extends HttpContract
      ? keyof HttpActions
      : string;

/**
 * A Composio action's arguments and answer: any JSON object in, any JSON
 * value back, both checked by the host against the pinned contract. A tool
 * that declares no output schema answers its text, as a string.
 */
export interface ComposioCall {
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly output: JsonValue;
}

/**
 * Action `Action` of contract `Contract`: its `input`, the arguments a
 * call passes, and its `output`, the answer it gets back.
 */
type ContractAction<Contract, Action> = Contract extends keyof ConnectorCatalog
  ? Action extends keyof ConnectorCatalog[Contract]
    ? ConnectorCatalog[Contract][Action]
    : never
  : Contract extends HttpContract
    ? Action extends keyof HttpActions
      ? HttpActions[Action]
      : never
    : Contract extends ComposioContract
      ? ComposioCall
      : never;

/** What a connection permission may say. */
export interface ConnectionConfig<
  Contract extends ConnectorContract,
  Actions extends readonly ConnectorAction<Contract>[],
> {
  /**
   * The generated contract and its major version: one the release's
   * connectors serve, e.g. `microsoft-365.mail@1`, or a Composio toolkit's,
   * e.g. `composio.hubspot@1`.
   */
  readonly contract: Contract;
  /** The contract's actions the App needs, each once. */
  readonly actions: Actions;
}

/**
 * The Brain's operations an action may ask for. `recall`, `skillsSelect`
 * and `skillsRead` answer only once an admin also grants the App the
 * Brain's permission (`brain.ts`).
 */
export type BrainOperation =
  | "search"
  | "read"
  | "recall"
  | "skillsSelect"
  | "skillsRead";

/** Every Brain operation, as a declaration names it. */
const brainOperations: readonly BrainOperation[] = [
  "search",
  "read",
  "recall",
  "skillsSelect",
  "skillsRead",
];

/** What a `brain` permission may say. */
export interface BrainConfig<Operations extends readonly BrainOperation[]> {
  readonly operations: Operations;
  /**
   * The collections the App needs, by the names its builders gave them:
   * requirements the host resolves, never a way to list others.
   */
  readonly collections: readonly string[];
}

/** What a `guests` permission may do with the App's guest chats. */
export type GuestsOperation = "invite" | "list" | "read" | "revoke";

/** The kinds of another App's public function an `apps` permission calls. */
export type AppFunctionKind = "query" | "mutation" | "action";

/**
 * One of another App's public functions, as an `apps` permission declares
 * it: its kind, its arguments (a map of field schemas, as that App
 * declares the function's `args`) and its return, exactly as that App
 * declares them.
 */
export interface AppFunctionConfig<
  Shape extends ValueShape = ValueShape,
  Returns extends AnySchema = AnySchema,
> {
  readonly kind: AppFunctionKind;
  readonly args: Shape;
  readonly returns: Returns;
}

/** What an `apps` permission may say about another App. */
export interface AppConfig<
  Functions extends Readonly<Record<string, AppFunctionConfig>>,
> {
  /** The App's public functions this App calls, by path, e.g. `contacts.find`. */
  readonly functions: Functions;
}

/** One of another App's functions as a declaration holds it: data only. */
export interface AppFunctionShape {
  readonly kind: AppFunctionKind;
  /** The object descriptor of its arguments. */
  readonly args: ValueDescriptor;
  readonly returns: ValueDescriptor;
}

interface DeclarationBase<Kind extends string, Alias extends string> {
  readonly "~permission": Kind;
  readonly alias: Alias;
}

/** An `ai` permission: answers from the workspace's model. */
export interface AiPermission extends DeclarationBase<"ai", "ai"> {
  readonly maxOutputTokens: number;
}

/** A connection permission: some of a connector contract's actions. */
export interface ConnectionPermission<
  Alias extends string = string,
  Contract extends string = string,
  Actions extends readonly string[] = readonly string[],
> extends DeclarationBase<"connections", Alias> {
  readonly contract: Contract;
  readonly actions: Actions;
}

/** A `brain` permission: some operations on some collections. */
export interface BrainPermission<
  Operations extends readonly BrainOperation[] = readonly BrainOperation[],
> extends DeclarationBase<"brain", "brain"> {
  readonly operations: Operations;
  readonly collections: readonly string[];
}

/** A `guests` permission. */
export interface GuestsPermission<
  Operations extends readonly GuestsOperation[] = readonly GuestsOperation[],
> extends DeclarationBase<"guests", "guests"> {
  readonly operations: Operations;
}

/**
 * An `apps` permission: another App's public functions, and the App is
 * the one an admin binds it to, which must serve each exactly as declared.
 * Under alias `grasp`, the platform's own (`permission.grasp`).
 */
export interface AppPermission<
  Alias extends string = string,
  Functions extends Readonly<Record<string, AppFunctionConfig>> = Readonly<
    Record<string, AppFunctionConfig>
  >,
> extends DeclarationBase<"apps", Alias> {
  readonly functions: Readonly<Record<string, AppFunctionShape>>;
  /** The functions' types, for types only: never set. */
  readonly "~functions"?: Functions;
}

/**
 * A `files` permission (spec 10.7.5, 32.3): what the App's screens may do
 * with files, through the host. Browser-facing: no function lists it.
 */
export interface FilesPermission<
  Operations extends readonly FilesOperation[] = readonly FilesOperation[],
> extends DeclarationBase<"files", "files"> {
  readonly operations: Operations;
}

/**
 * A `links` permission (spec 10.7.7, 32.3): the exact HTTPS origins the
 * App's screens may link to. It grants no network access at all.
 */
export interface LinksPermission<
  Origins extends readonly string[] = readonly string[],
> extends DeclarationBase<"links", "links"> {
  readonly origins: Origins;
}

/** A permission the App's screens use, never its functions. */
export type BrowserPermission = FilesPermission | LinksPermission;

/**
 * A workflow permission (spec 7.4, 9.5): an independent workflow the App
 * starts, by an alias of its own. An action starts it
 * (`ctx.workflows.<alias>.start`), and a mutation stages its start for
 * after it commits (`ctx.afterCommit.workflows.<alias>.start`), each only
 * one it lists in its `uses`. Like every permission it grants nothing: the
 * host starts the version the App's builders bound under the alias,
 * through the App's own `start` permission on that workflow, acting for
 * the person the call acts for, and checks both again as each start is
 * admitted. It never reaches the workflow engine.
 */
export interface WorkflowPermission<
  Alias extends string = string,
  Input = unknown,
  Output = unknown,
> extends DeclarationBase<"workflows", Alias> {
  /**
   * The descriptor of the input the App starts it with: what the host
   * checks a start's input against before it goes anywhere.
   */
  readonly input: ValueDescriptor;
  /**
   * The descriptor of the output a completed run gives. With the input, it
   * is the contract the App's screens rely on: they get a reference to it
   * pinned to that contract's fingerprint (`workflows.<alias>` in
   * `@server/_generated/api`), and name it in what they ask of the host. The App's own
   * starts are checked against the bound version's input as they are
   * admitted, not against this contract.
   */
  readonly output: ValueDescriptor;
  /** The input as a caller passes it, for types only: never set. */
  readonly "~input"?: Input;
  /** The output a completed run gives, for types only: never set. */
  readonly "~output"?: Output;
}

/** What a workflow permission says. */
export interface WorkflowConfig<
  Input extends AnySchema,
  Output extends AnySchema,
> {
  /** The input the App starts it with. */
  readonly input: Input;
  /** The output a completed run gives. */
  readonly output: Output;
}

/** Any permission an action reaches through `ctx`. */
export type AnyPermission =
  | AiPermission
  | ConnectionPermission
  | BrainPermission
  | GuestsPermission
  | AppPermission;

/** One search result from the Brain: a title and an excerpt of it. */
export interface BrainHit {
  title: string;
  excerpt: string;
}

/** A document read from the Brain. */
export interface BrainDocument {
  title: string;
  text: string;
}

/** What `ctx.ai` is. */
export interface AiClient {
  /**
   * One answer to `prompt`, within the permission's token bound and the
   * App's budget: text, or a value of `output` when given, which the
   * model is told the shape of and the host checks the answer against.
   */
  readonly generate: <
    Output extends AnySchema | undefined = undefined,
  >(request: {
    readonly prompt: string;
    readonly instructions?: string;
    readonly output?: Output;
  }) => Promise<
    Output extends ValueSchema<unknown, unknown> ? Infer<Output> : string
  >;
}

/** A catalog action's arguments. */
type InputOf<Entry> = Entry extends { readonly input: infer Input }
  ? Input
  : never;

/**
 * A call's arguments: each action of `Action` paired with its own
 * arguments, so an action that may be either of two needs arguments that
 * fit whichever it is, never just one of them.
 */
type CallArgs<Contract, Action> = Action extends string
  ? [action: Action, args: InputOf<ContractAction<Contract, Action>>]
  : never;

/**
 * What `ctx.connections.<alias>` is: its calls typed by the contract's
 * catalog entry (`ConnectorCatalog`).
 */
export interface ConnectionClient<
  Contract extends string,
  Actions extends readonly string[],
> {
  /**
   * One of the declared actions, with its arguments, through connect: its
   * answer, or any of theirs when the action may be several. Both are
   * checked against the contract the binding serves.
   */
  readonly call: <Action extends Actions[number]>(
    ...call: CallArgs<Contract, Action>
  ) => Promise<ContractAction<Contract, Action>["output"]>;
}

/**
 * What `ctx.connections.<alias>` is for an HTTP connection: `call`, and
 * `fetch`, a request as the web's `fetch` makes one, to a path of the
 * connection's own origin, answered as a `Response`. A GET or HEAD is the
 * declaration's `get`; any other method its `send`, which the host may hold
 * for the person to confirm (`resource.awaiting_confirmation`).
 */
export interface HttpClient<
  Actions extends readonly string[],
> extends ConnectionClient<HttpContract, Actions> {
  readonly fetch: (path: string, init?: HttpRequestInit) => Promise<Response>;
}

/** What `ctx.brain` is, by its operations. */
export type BrainClient<Operations extends readonly BrainOperation[]> =
  ("search" extends Operations[number]
    ? {
        /**
         * The best matches for `text` in the declared collections: 1 to
         * `knowledgeSearchMaxLength` (500) code units, the Brain's own
         * limit; a longer text is refused as `contract.invalid_args`.
         */
        readonly search: (request: {
          readonly text: string;
          readonly limit?: number;
        }) => Promise<BrainHit[]>;
      }
    : unknown) &
    ("read" extends Operations[number]
      ? {
          /** One document of the declared collections, by its ID. */
          readonly read: (request: {
            readonly id: string;
          }) => Promise<BrainDocument>;
        }
      : unknown) &
    ("recall" extends Operations[number]
      ? {
          /**
           * The Brain's evidence for `query` from the declared collections,
           * or those `collections` names of them, as far as the person may
           * read each: a bounded memory pack, each item cited at its exact
           * version. Needs the Brain's permission too.
           */
          readonly recall: (
            request: ResourceRecallInput
          ) => Promise<MemoryPack>;
        }
      : unknown) &
    ("skillsSelect" extends Operations[number]
      ? {
          /**
           * The skill of the declared collections the person may read
           * that applies to `request.task`, pinned at the version read,
           * or an explicit no-skill result. Keep the pin for the task.
           * Needs the Brain's permission too.
           */
          readonly skillsSelect: (
            request: SkillsSelectInput
          ) => Promise<SkillSelection>;
        }
      : unknown) &
    ("skillsRead" extends Operations[number]
      ? {
          /**
           * A skill of the declared collections at exactly the version a
           * selection pinned, while the person may read it: its text is
           * data. Needs the Brain's permission too.
           */
          readonly skillsRead: (request: SkillsReadInput) => Promise<SkillRead>;
        }
      : unknown);

/** What `ctx.guests` is, by its operations. */
export type GuestsClient<Operations extends readonly GuestsOperation[]> =
  ("invite" extends Operations[number]
    ? {
        /**
         * Invites a guest, for the person the call acts for: only a
         * person's own call, never a workflow run's. The answer holds the
         * link, shown once.
         */
        readonly invite: (invite: GuestInvite) => Promise<GuestInvitation>;
      }
    : unknown) &
    ("list" extends Operations[number]
      ? {
          /** The App's guest chats: the open ones first, newest first. */
          readonly list: () => Promise<GuestChat[]>;
        }
      : unknown) &
    ("read" extends Operations[number]
      ? {
          /** A guest chat of the App, with what was written: untrusted text. */
          readonly read: (id: string) => Promise<GuestTranscript>;
        }
      : unknown) &
    ("revoke" extends Operations[number]
      ? {
          /** Stops a guest chat's link for good. */
          readonly revoke: (id: string) => Promise<GuestChat>;
        }
      : unknown);

/**
 * A call's arguments: each path of `Path` paired with its own arguments,
 * so a path that may be either of two needs arguments that fit whichever
 * it is, never just one of them.
 */
type FunctionCallArgs<
  Functions extends Readonly<
    Record<string, { readonly args: ValueShape; readonly returns: AnySchema }>
  >,
  Path,
> =
  Path extends Extract<keyof Functions, string>
    ? [path: Path, args: ObjectInput<Functions[Path]["args"]>]
    : never;

/**
 * What `ctx.apps.<alias>` is: each declared function by its path, with its
 * arguments, answering its return.
 */
export interface AppClient<
  Functions extends Readonly<Record<string, AppFunctionConfig>>,
> {
  readonly call: <Path extends Extract<keyof Functions, string>>(
    ...call: FunctionCallArgs<Functions, Path>
  ) => Promise<Infer<Functions[Path]["returns"]>>;
}

/** What `ctx.connections.<alias>` is for `Permission`. */
export type ConnectionClientOf<Permission> =
  Permission extends ConnectionPermission<string, infer Contract, infer Actions>
    ? Contract extends HttpContract
      ? HttpClient<Actions>
      : ConnectionClient<Contract, Actions>
    : never;

/** What `ctx.brain` is for `Permission`. */
export type BrainClientOf<Permission> =
  Permission extends BrainPermission<infer Operations>
    ? BrainClient<Operations>
    : never;

/** What `ctx.guests` is for `Permission`. */
export type GuestsClientOf<Permission> =
  Permission extends GuestsPermission<infer Operations>
    ? GuestsClient<Operations>
    : never;

/** What `ctx.apps.<alias>` is for `Permission`. */
export type AppClientOf<Permission> =
  Permission extends AppPermission<string, infer Functions>
    ? AppClient<Functions>
    : never;

/** Why a permission's declaration was refused. */
export class PermissionDefinitionError extends Error {
  readonly code = "permission.invalid_declaration";

  constructor(message: string) {
    super(message);
    this.name = "PermissionDefinitionError";
  }
}

const refuse = (message: string): never => {
  throw new PermissionDefinitionError(message);
};

/** A contract and its major version, e.g. `grasp.mail@1`. */
const contractPattern =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*@[1-9]\d{0,5}$/u;

/** An action, operation or collection name a declaration lists. */
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** The most entries one declaration lists. */
const listMax = 32;

/** Every declaration an action reaches that `permission` made. */
const declarations = new WeakSet<object>();

/** Every browser-facing declaration `permission` made. */
const browserDeclarations = new WeakSet<object>();

/** Every workflow declaration `permission` made. */
const workflowDeclarations = new WeakSet<object>();

/** Whether `value` is a declaration `permission` made for actions. */
export const isPermission = (value: unknown): value is AnyPermission =>
  typeof value === "object" && value !== null && declarations.has(value);

/** Whether `value` is a workflow declaration `permission` made. */
export const isWorkflowPermission = (
  value: unknown
): value is WorkflowPermission =>
  typeof value === "object" &&
  value !== null &&
  workflowDeclarations.has(value);

/** Whether `value` is a files or links declaration `permission` made. */
export const isBrowserPermission = (
  value: unknown
): value is BrowserPermission =>
  typeof value === "object" && value !== null && browserDeclarations.has(value);

/** The operations a guests permission may declare. */
const guestsOperations: readonly GuestsOperation[] = [
  "invite",
  "list",
  "read",
  "revoke",
];

/** The operations a files permission may declare. */
const filesOperations: readonly FilesOperation[] = [
  "upload",
  "read",
  "attach",
  "delete",
];

/**
 * An exact HTTPS origin a links permission may list (`originRefusal`, in
 * the shared app-link-limits module: the same rule core holds every open
 * to): scheme, a host name and an optional port, in lower case, with
 * nothing after it; never an IP address or a private network's host.
 */
const checkedOrigin = (origin: unknown): string => {
  const refused = originRefusal(origin);
  if (refused === "ip_literal") {
    return refuse(
      `\`${String(origin)}\` is an IP address: a link origin is a public site's host name.`
    );
  }
  if (refused === "private_network") {
    return refuse(
      `\`${String(origin)}\` is on a private network: a link origin is a public site's.`
    );
  }
  if (refused !== undefined || typeof origin !== "string") {
    return refuse(
      typeof origin === "string"
        ? `\`${origin}\` isn't an exact HTTPS origin: \`https://\`, a host and an optional port, in lower case, with nothing after it.`
        : "A link origin is an HTTPS origin, e.g. `https://example.com`."
    );
  }
  return origin;
};

const checkedAlias = (alias: unknown): string =>
  typeof alias === "string" && resourceAliasPattern.test(alias)
    ? alias
    : refuse(
        "A permission's alias is a letter, then letters, digits or underscores, at most 64."
      );

const checkedConfig = (
  config: unknown,
  keys: readonly string[]
): Record<string, unknown> => {
  if (!isPlainObject(config)) {
    return refuse("A permission's config is an object.");
  }
  for (const key of Object.keys(config)) {
    if (!keys.includes(key)) {
      refuse(`A permission's config has no \`${key}\`.`);
    }
  }
  return config;
};

// No longer than an identifier, so the audit events that name a binding's
// contract can carry it.
const checkedContract = (contract: unknown): string =>
  typeof contract === "string" &&
  contract.length <= identifierMaxLength &&
  contractPattern.test(contract)
    ? contract
    : refuse(
        `A contract is a dotted name and its major version, e.g. \`grasp.mail@1\`, of at most ${identifierMaxLength} characters.`
      );

const checkedList = (
  list: unknown,
  what: string,
  allowed?: readonly string[]
): readonly string[] => {
  if (!Array.isArray(list) || list.length === 0 || list.length > listMax) {
    return refuse(`A permission lists between 1 and ${listMax} ${what}.`);
  }
  const items: readonly unknown[] = list;
  const names: string[] = [];
  for (const name of items) {
    if (
      typeof name !== "string" ||
      !namePattern.test(name) ||
      (allowed !== undefined && !allowed.includes(name))
    ) {
      return refuse(`A permission lists ${what} it can't have.`);
    }
    if (names.includes(name)) {
      refuse(`A permission lists \`${name}\` twice.`);
    }
    names.push(name);
  }
  return Object.freeze(names);
};

/** The names of `list` that are among `known`, typed as such. */
const known = <Name extends string>(
  list: readonly string[],
  names: readonly Name[]
): Name[] =>
  list.filter((name): name is Name => names.some((each) => each === name));

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
 * `declaration`, frozen all the way down, so nothing changes what was
 * checked before the App registers it, and registered as genuine.
 */
const declared = (declaration: AnyPermission): AnyPermission => {
  const frozen = deepFreeze(declaration);
  declarations.add(frozen);
  return frozen;
};

/** A browser-facing declaration, frozen and registered as genuine. */
const declaredForBrowser = (
  declaration: BrowserPermission
): BrowserPermission => {
  const frozen = deepFreeze(declaration);
  browserDeclarations.add(frozen);
  return frozen;
};

/** A workflow declaration, frozen and registered as genuine. */
const declaredWorkflow = (
  declaration: WorkflowPermission
): WorkflowPermission => {
  const frozen = deepFreeze(declaration);
  workflowDeclarations.add(frozen);
  return frozen;
};

/** The origins a links permission lists: 1 to 32 exact HTTPS origins. */
const checkedOrigins = (origins: unknown): readonly string[] => {
  if (
    !Array.isArray(origins) ||
    origins.length === 0 ||
    origins.length > listMax
  ) {
    return refuse(`A links permission lists between 1 and ${listMax} origins.`);
  }
  const listed: readonly unknown[] = origins;
  const checked: string[] = [];
  for (const origin of listed) {
    const exact = checkedOrigin(origin);
    if (checked.includes(exact)) {
      refuse(`A links permission lists \`${exact}\` twice.`);
    }
    checked.push(exact);
  }
  return Object.freeze(checked);
};

/** The descriptors of one function's arguments and return. */
type FunctionShapeOf = (config: Record<string, unknown>) => {
  readonly args: ValueDescriptor;
  readonly returns: ValueDescriptor;
};

/**
 * An apps permission's functions, as data: 1 to 32 paths, each one of an
 * App's function paths (`storeOperationPathPattern`), a query, a mutation
 * or an action, its arguments an object, each with the descriptors
 * `shapeOf` reads from its config: from schemas in code, from data in a
 * manifest.
 */
const checkedFunctions = (
  functions: unknown,
  shapeOf: FunctionShapeOf
): Readonly<Record<string, AppFunctionShape>> => {
  if (!isPlainObject(functions)) {
    return refuse("An apps permission's `functions` is an object of paths.");
  }
  const entries = Object.entries(functions);
  if (entries.length === 0 || entries.length > listMax) {
    return refuse(
      `An apps permission lists between 1 and ${listMax} functions.`
    );
  }
  const checked: Record<string, AppFunctionShape> = {};
  for (const [path, entry] of entries) {
    if (
      path.length > storeOperationPathMaxLength ||
      !storeOperationPathPattern.test(path)
    ) {
      return refuse(
        `\`${path}\` isn't a function's path: up to four dotted names, at most ${storeOperationPathMaxLength} characters.`
      );
    }
    const config = checkedConfig(entry, ["kind", "args", "returns"]);
    const { kind } = config;
    if (kind !== "query" && kind !== "mutation" && kind !== "action") {
      return refuse(
        "An apps permission calls another App's queries, mutations and actions."
      );
    }
    const { args, returns } = shapeOf(config);
    if (args.kind !== "object") {
      return refuse("A function's arguments are an object.");
    }
    checked[path] = { kind, args, returns };
  }
  return checked;
};

/** A function's descriptors, from the schemas code declares it with. */
const shapeFromSchemas: FunctionShapeOf = (config) => {
  if (!isPlainObject(config.args)) {
    return refuse(
      "A function's `args` is a map of field names to schemas, as its App declares them."
    );
  }
  // SAFETY: `args` was checked to be a plain object; `v.object` checks
  // each field is a schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const argsSchema = v.object(config.args as ValueShape);
  return {
    args: structuredClone(descriptorOf(argsSchema)),
    returns: structuredClone(descriptorOf(config.returns)),
  };
};

/** A function's descriptors, as a manifest holds them. */
const shapeFromData: FunctionShapeOf = (config) => ({
  args: readDescriptor(config.args, 1, { nodes: 0 }),
  returns: readDescriptor(config.returns, 1, { nodes: 0 }),
});

/** An apps declaration, from its alias and its functions as data. */
const appDeclaration = (
  alias: string,
  functions: unknown,
  shapeOf: FunctionShapeOf
): AppPermission =>
  // SAFETY: built from what was checked: the alias and the functions,
  // each with its descriptors, as `AppPermission` holds them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  declared({
    "~permission": "apps",
    alias,
    functions: checkedFunctions(functions, shapeOf),
  }) as AppPermission;

/** The measures the platform publishes (`platformMeasures`). */
const measureNames = [
  "platform.workflow_runs",
  "platform.improvement_signals",
] as const satisfies readonly PlatformMeasure[];

/** The dimensions of the platform's measures. */
const measureDimensions = [
  "app",
  "workflow",
  "kind",
] as const satisfies readonly (typeof platformMeasures)[PlatformMeasure][number][];

/**
 * The platform's read-only functions an App reaches through `apps`, under
 * alias `grasp` (`permission.grasp`), by path:
 *
 * - `statistics.read`: a measure the platform publishes (such as the runs
 *   of Apps' workflows) over the last `days` × 24 hours up to `until`,
 *   of one App (`where.app`, narrowed by its other dimensions) or up to
 *   100 (`apps`), added up by the dimensions in `groupBy`, the page of
 *   groups from `offset` on. It counts only Apps whose runs the person
 *   the call acts for may see, and names the rest `unavailable`.
 */
export const graspFunctions = Object.freeze({
  "statistics.read": {
    kind: "query",
    args: {
      measure: v.enum(measureNames),
      days: v.number().integer().min(1).max(366),
      where: v.record(v.string().min(1).max(128)).default({}),
      apps: v
        .array(v.string().min(1).max(identifierMaxLength))
        .min(1)
        .max(100)
        .optional(),
      offset: v.number().integer().min(0).max(10_000).default(0),
      until: v.string().optional(),
      groupBy: v.array(v.enum(measureDimensions)).max(3).default([]),
    },
    returns: v.object({
      measure: v.string(),
      from: v.string(),
      to: v.string(),
      groups: v.array(
        v.object({
          dimensions: v.record(v.string().nullable()),
          count: v.number(),
          sum: v.number(),
          min: v.number(),
          max: v.number(),
        })
      ),
      truncated: v.boolean(),
      unavailable: v.array(v.string()).optional(),
      computation: v.string().nullable().optional(),
    }),
  },
} as const satisfies Readonly<Record<string, AppFunctionConfig>>);

/** The platform's read-only functions, as `ctx.apps.grasp` calls them. */
export type GraspFunctions = typeof graspFunctions;

/**
 * Permission declarations (spec 32.3). Each answers a frozen declaration
 * to list under its key of the App's `permissions`, and in the `uses` of
 * each function that reaches it; the host binds it.
 */
export const permission = Object.freeze({
  /**
   * Answers from the workspace's model, each at most `maxOutputTokens`
   * long. An App holds one (`ctx.ai`).
   */
  ai: (config: AiConfig): AiPermission => {
    const checked = checkedConfig(config, ["maxOutputTokens"]);
    const { maxOutputTokens } = checked;
    if (
      typeof maxOutputTokens !== "number" ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 100_000
    ) {
      return refuse("`maxOutputTokens` is a whole number, 1 to 100 000.");
    }
    // SAFETY: built from what was checked, as `AiPermission` holds it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~permission": "ai",
      alias: permissionAliases.ai,
      maxOutputTokens,
    }) as AiPermission;
  },
  /** Some of a connection's actions, by its contract (`ctx.connections.<alias>`). */
  connection: <
    const Alias extends string,
    const Contract extends ConnectorContract,
    const Actions extends readonly [
      ConnectorAction<Contract>,
      ...ConnectorAction<Contract>[],
    ],
  >(
    alias: Alias,
    config: ConnectionConfig<Contract, Actions>
  ): ConnectionPermission<Alias, Contract, Actions> => {
    const checked = checkedConfig(config, ["contract", "actions"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and lists holding exactly the names
    // given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~permission": "connections",
      alias: checkedAlias(alias),
      contract: checkedContract(checked.contract),
      actions: checkedList(checked.actions, "actions"),
    }) as ConnectionPermission<Alias, Contract, Actions>;
  },
  /** Some operations on some of the Brain's collections. An App holds one (`ctx.brain`). */
  brain: <
    const Operations extends readonly [BrainOperation, ...BrainOperation[]],
  >(
    config: BrainConfig<Operations>
  ): BrainPermission<Operations> => {
    const checked = checkedConfig(config, ["operations", "collections"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: lists holding exactly the names given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~permission": "brain",
      alias: permissionAliases.brain,
      operations: known(
        checkedList(checked.operations, "operations", brainOperations),
        brainOperations
      ),
      collections: checkedList(checked.collections, "collections"),
    }) as BrainPermission<Operations>;
  },
  /**
   * An independent workflow the App starts, with input of `input`: listed
   * in the App's `permissions.workflows`, and in the `uses` of each action
   * that starts it and each mutation that stages its start. Only ever what
   * the App's builders bind under the alias, started through the App's
   * own permission; never the engine.
   */
  workflow: <
    const Alias extends string,
    Input extends AnySchema,
    Output extends AnySchema,
  >(
    alias: Alias,
    config: WorkflowConfig<Input, Output>
  ): WorkflowPermission<Alias, InferInput<Input>, Infer<Output>> => {
    const checked = checkedConfig(config, ["input", "output"]);
    const input = descriptorOf(checked.input);
    const output = descriptorOf(checked.output);
    // A start left without input takes the schema's default; an input that
    // may be absent with none would be no JSON for the run to start with.
    if (input.presence === "optional") {
      refuse(
        "A workflow's input is required or has a default, never only optional."
      );
    }
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given and the schemas' descriptors.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declaredWorkflow({
      "~permission": "workflows",
      alias: checkedAlias(alias),
      // The descriptors, as data: what the host checks a start against.
      input: structuredClone(input),
      output: structuredClone(output),
    }) as WorkflowPermission<Alias, InferInput<Input>, Infer<Output>>;
  },
  /**
   * Some of another App's public functions, by path: queries, mutations
   * and actions, each with exactly the arguments and return that App
   * declares, so the host binds only an App that serves exactly that. Each
   * call runs as the person this App's call acts for, under the other
   * App's own roles (`ctx.apps.<alias>`).
   */
  app: <
    const Alias extends string,
    const Functions extends Readonly<Record<string, AppFunctionConfig>>,
  >(
    alias: Alias,
    config: AppConfig<Functions>
  ): AppPermission<Alias, Functions> => {
    const checked = checkedConfig(config, ["functions"]);
    if (alias === graspAlias) {
      refuse(
        `\`${graspAlias}\` is the platform's own functions: declare them with \`permission.grasp()\`.`
      );
    }
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the alias given, and the functions given, by path.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return appDeclaration(
      checkedAlias(alias),
      checked.functions,
      shapeFromSchemas
    ) as AppPermission<Alias, Functions>;
  },
  /**
   * The platform's own read-only functions (`graspFunctions`), such as the
   * runs of Apps' workflows, under alias `grasp` among the App's `apps`
   * (`ctx.apps.grasp`). An admin binds it to the platform's statistics
   * permission they grant the App.
   */
  grasp: (): AppPermission<typeof graspAlias, GraspFunctions> =>
    // SAFETY: the platform's own functions, declared as code declares
    // another App's.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    appDeclaration(
      graspAlias,
      graspFunctions,
      shapeFromSchemas
    ) as AppPermission<typeof graspAlias, GraspFunctions>,
  /**
   * Guest chats, under a permission an admin binds: inviting a guest for
   * the person the call acts for, and listing, reading back and revoking
   * the App's chats. An App holds one (`ctx.guests`).
   */
  guests: <
    const Operations extends readonly [GuestsOperation, ...GuestsOperation[]],
  >(config: {
    readonly operations: Operations;
  }): GuestsPermission<Operations> => {
    const checked = checkedConfig(config, ["operations"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the operations given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declared({
      "~permission": "guests",
      alias: permissionAliases.guests,
      operations: known(
        checkedList(checked.operations, "operations", guestsOperations),
        guestsOperations
      ),
    }) as GuestsPermission<Operations>;
  },
  /**
   * What the App's screens may do with files through the host: upload,
   * read, attach, delete. Never a function's.
   */
  files: <
    const Operations extends readonly [FilesOperation, ...FilesOperation[]],
  >(config: {
    readonly operations: Operations;
  }): FilesPermission<Operations> => {
    const checked = checkedConfig(config, ["operations"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the operations given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declaredForBrowser({
      "~permission": "files",
      alias: permissionAliases.files,
      operations: known(
        checkedList(checked.operations, "operations", filesOperations),
        filesOperations
      ),
    }) as FilesPermission<Operations>;
  },
  /**
   * The exact HTTPS origins the App's screens may link to. It grants no
   * network access: a screen still has none.
   */
  links: <const Origins extends readonly [string, ...string[]]>(config: {
    readonly origins: Origins;
  }): LinksPermission<Origins> => {
    const checked = checkedConfig(config, ["origins"]);
    // SAFETY: built from what was checked of the arguments the type is
    // inferred from: the origins given, in order.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return declaredForBrowser({
      "~permission": "links",
      alias: permissionAliases.links,
      origins: checkedOrigins(checked.origins),
    }) as LinksPermission<Origins>;
  },
});

/** Refuses `alias` for a permission whose alias is `fixed`. */
const fixedAlias = (alias: unknown, fixed: string): void => {
  if (alias !== fixed) {
    refuse(`A permission of this kind is always \`${fixed}\`.`);
  }
};

/**
 * The declaration `data` describes, as a manifest holds it, declared
 * again through `permission`: it passes exactly the checks a declaration
 * in code does, and anything else (an unknown kind or key, a value out of
 * bounds) throws `PermissionDefinitionError` or `ValueDefinitionError`.
 * Only the host reads declarations back (host.ts).
 */
export const readPermissionDeclaration = (
  data: unknown
): AnyPermission | BrowserPermission | WorkflowPermission => {
  if (!isPlainObject(data)) {
    return refuse("A permission declaration is an object.");
  }
  const { "~permission": kind, alias, ...config } = data;
  if (typeof alias !== "string") {
    return refuse("A permission declaration has an alias.");
  }
  // Each constructor refuses keys its kind hasn't; `~permission` and the
  // alias are read here, the rest is its config.
  // SAFETY: each constructor checks its config at run time.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const loose = config as never;
  if (
    kind === "ai" ||
    kind === "brain" ||
    kind === "guests" ||
    kind === "files" ||
    kind === "links"
  ) {
    fixedAlias(alias, permissionAliases[kind]);
    const constructors = {
      ai: permission.ai,
      brain: permission.brain,
      guests: permission.guests,
      files: permission.files,
      links: permission.links,
    } as const;
    // SAFETY: each constructor checks its config at run time, as above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const construct = constructors[kind] as (config: never) => AnyPermission;
    return construct(loose);
  }
  if (kind === "connections") {
    return permission.connection(alias, loose);
  }
  if (kind === "apps") {
    const { functions, ...rest } = config;
    if (Object.keys(rest).length > 0) {
      return refuse("An apps permission's config has only `functions`.");
    }
    if (alias !== graspAlias) {
      return appDeclaration(checkedAlias(alias), functions, shapeFromData);
    }
    // The platform's own, exactly: a manifest whose `grasp` declares
    // anything else is no declaration `permission.grasp` makes.
    const grasp = permission.grasp();
    if (canonicalText(functions) !== canonicalText(grasp.functions)) {
      return refuse(
        `\`${graspAlias}\` declares exactly the platform's own functions.`
      );
    }
    return grasp;
  }
  if (kind === "workflows") {
    const { input, output, ...rest } = config;
    // SAFETY: as above: `workflow` refuses any key but `input` and `output`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const workflowConfig = {
      ...rest,
      input: schemaOf(readDescriptor(input, 1, { nodes: 0 })),
      output: schemaOf(readDescriptor(output, 1, { nodes: 0 })),
    } as never;
    return permission.workflow(alias, workflowConfig);
  }
  return refuse("A permission declaration's kind isn't one this SDK knows.");
};
