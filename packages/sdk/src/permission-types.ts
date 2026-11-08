import type {
  ConnectorAction,
  ConnectorContract,
} from "./connector-contracts.ts";
import type { FilesOperation } from "./file-link-references.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import type { AnySchema } from "./value-schema.ts";

/** The kinds of permission an action reaches through `ctx`. */
export type PermissionKind =
  | "ai"
  | "connections"
  | "brain"
  | "grasp"
  | "guests";

/**
 * The fixed alias of each permission an App holds at most once: what the
 * host binds it under, never chosen by the App.
 */
export const permissionAliases = Object.freeze({
  ai: "ai",
  brain: "brain",
  grasp: "grasp",
  guests: "guests",
  files: "files",
  links: "links",
  people: "people",
} as const);

/** What an `ai` permission may say. */
export interface AiConfig {
  /**
   * The most tokens one answer may take, all its asks together: a whole
   * number, 1 to 100 000.
   */
  readonly maxOutputTokens: number;
}

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

/** One of the platform's functions as a declaration holds it: data only. */
interface GraspFunctionShape {
  readonly kind: "query";
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
 * A `grasp` permission: the platform's own read-only functions
 * (`graspFunctions`), which an admin binds to the platform's statistics
 * permission they grant the App.
 */
export interface GraspPermission extends DeclarationBase<"grasp", "grasp"> {
  readonly functions: Readonly<Record<string, GraspFunctionShape>>;
}

/**
 * A `files` permission: what the App's pages may do
 * with files, through the host. Browser-facing: no function reaches it.
 */
export interface FilesPermission<
  Operations extends readonly FilesOperation[] = readonly FilesOperation[],
> extends DeclarationBase<"files", "files"> {
  readonly operations: Operations;
}

/**
 * A `links` permission: the exact HTTPS origins the
 * App's pages may link to. It grants no network access at all.
 */
export interface LinksPermission<
  Origins extends readonly string[] = readonly string[],
> extends DeclarationBase<"links", "links"> {
  readonly origins: Origins;
}

/** A permission the App's pages use, never its functions. */
export type BrowserPermission = FilesPermission | LinksPermission;

/**
 * The organization's people (`ctx.people`, `usePeople`), as a manifest
 * holds `permissions.people: true`: a flag in a config, never a
 * declaration App code makes.
 */
export type PeoplePermission = DeclarationBase<"people", "people">;

/** The one `people` permission, as a manifest holds it. */
export const peopleDeclaration: PeoplePermission = Object.freeze({
  "~permission": "people",
  alias: permissionAliases.people,
});

/**
 * A workflow permission: an independent workflow the App
 * starts, by an alias of its own. An action starts it
 * (`ctx.workflows.<alias>.start`), and a mutation stages its start for
 * after it commits (`ctx.afterCommit.workflows.<alias>.start`). Like
 * every permission it grants nothing: the
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
   * is the contract the App's pages rely on: they get a reference to it
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
  | GraspPermission;

/** Any permission an App declares, as its manifest holds it by alias. */
export type AppPermission =
  | AnyPermission
  | BrowserPermission
  | WorkflowPermission
  | PeoplePermission;
