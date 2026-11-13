import type {
  BoundWorkflowDecision,
  BoundWorkflowEvent,
} from "./bound-workflows.ts";
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

/** What an action may ask the Brain: `recall` (`brain-recall.ts`). */
export type BrainOperation = "recall";

/** What a `brain` permission may say. */
export interface BrainConfig<Operations extends readonly BrainOperation[]> {
  readonly operations: Operations;
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

/**
 * A `brain` permission: recall from the Brain of only what everyone in
 * the company may read, whoever a call acts for: never a team's content,
 * nor anyone's own. An admin binds it to the App's own permission to read
 * the Brain.
 */
export interface BrainPermission<
  Operations extends readonly BrainOperation[] = readonly BrainOperation[],
> extends DeclarationBase<"brain", "brain"> {
  readonly operations: Operations;
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
 * starts, by an alias of its own (`ctx.workflows.<alias>.start`): an
 * action starts it right away, and a mutation stages its start for after
 * it commits. Like
 * every permission it grants nothing: the
 * host starts the version the App's builders bound under the alias,
 * through the App's own `start` permission on that workflow, acting for
 * the person the call acts for, and checks both again as each start is
 * admitted. It never reaches the workflow engine.
 *
 * It is the contract the App relies on, as the App declares it: the args
 * a start takes and what a completed run returns, and the events its
 * pages and mutations send, the listen tasks waiting on them and the
 * decisions people answer. Its references (`workflows.<alias>` in
 * `@server/_generated/api`) are typed from it, and the host resolves what
 * they name in it; binding a version whose events, decisions or listens
 * differ is refused until the App declares them (bound-workflows.ts).
 */
export interface WorkflowPermission<
  Alias extends string = string,
  Args = unknown,
  Returns = unknown,
> extends DeclarationBase<"workflows", Alias> {
  /**
   * The descriptor of the args the App starts it with: what the host
   * checks a start's args against before they go anywhere.
   */
  readonly args: ValueDescriptor;
  /** The descriptor of what a completed run returns. */
  readonly returns: ValueDescriptor;
  /** The events the App sends a run, by their alias in the workflow. */
  readonly events: Readonly<Record<string, BoundWorkflowEvent>>;
  /**
   * The workflow's listen tasks, by path, with the aliases of the events
   * each listens for, in name order.
   */
  readonly listens: Readonly<Record<string, readonly string[]>>;
  /** The decisions people answer, by their alias in the workflow. */
  readonly decisions: Readonly<Record<string, BoundWorkflowDecision>>;
  /** The args as a caller passes them, for types only: never set. */
  readonly "~args"?: Args;
  /** What a completed run returns, for types only: never set. */
  readonly "~returns"?: Returns;
}

/** One event a workflow permission declares. */
export interface WorkflowEventConfig {
  /** The CloudEvents type the workflow's event binding admits. */
  readonly type: string;
  /** The event's data. */
  readonly data: AnySchema;
}

/** One decision a workflow permission declares. */
export interface WorkflowDecisionConfig {
  /** The value a response carries. */
  readonly value: AnySchema;
  /** The context a person reviews before answering. */
  readonly context: AnySchema;
}

/** What a workflow permission says. */
export interface WorkflowConfig<
  Args extends AnySchema,
  Returns extends AnySchema,
> {
  /** The args the App starts it with. */
  readonly args: Args;
  /** What a completed run returns. */
  readonly returns: Returns;
  /** The events the App sends a run, by alias; none when left out. */
  readonly events?: Readonly<Record<string, WorkflowEventConfig>>;
  /** The listen tasks, by path, with the events each listens for. */
  readonly listens?: Readonly<Record<string, readonly string[]>>;
  /** The decisions people answer, by alias; none when left out. */
  readonly decisions?: Readonly<Record<string, WorkflowDecisionConfig>>;
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
