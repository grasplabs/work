import type { Grant } from "./ctx-workflows.ts";
import type { Migration, MigrationManifest } from "./migration.ts";
import type {
  AiPermission,
  AppPermission,
  BrainPermission,
  ConnectionPermission,
  FilesPermission,
  GraspPermission,
  GuestsPermission,
  LinksPermission,
  WorkflowPermission,
} from "./permission-types.ts";
import type { SchemaAnswer } from "./schema-answer.ts";
import type { SchemaManifest } from "./schema-manifest.ts";
import type { SchemaDefinition } from "./schema-types.ts";
import type {
  AnyFunction,
  FunctionKind,
  Visibility,
} from "./server-function.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

/**
 * An App's server modules, by their path under `server/` without `.ts`
 * (`tasks`, `admin/users`): each module's exports, as its namespace.
 */
export type ServerModules = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** What an App's config (`grasp.config.ts`) declares. */
export interface AppConfig<
  Permissions extends AppPermissions = AppPermissions,
> {
  /** What people call the App, 1 to 100 characters. */
  readonly name: string;
  /**
   * Everything it can reach outside itself, by kind; none unless listed.
   * Each needs an admin's binding or grant before it serves anything.
   * Every function of the App may use them, as its kind allows.
   */
  readonly permissions?: Permissions;
  /**
   * Its answers for the records that lack a field a change of its schema
   * requires (schema-answer.ts): for one field each, the value they take
   * where the field is absent, or null where it can't be, filled in as
   * the version is
   * published, never over a value a record holds. Anything that reshapes
   * records is a migration (`server/migrations/`).
   */
  readonly answers?: readonly SchemaAnswer[];
}

/**
 * An App's permissions, by kind (permission.ts): what its actions reach
 * through `ctx`, the workflows its actions and mutations start, what its
 * pages may do with files and link to, and whether it reads the
 * organization's people.
 */
export interface AppPermissions {
  /** Answers from the workspace's model (`ctx.ai`). */
  readonly ai?: AiPermission;
  /** Connections' actions, each under its alias (`ctx.connections.<alias>`). */
  readonly connections?: readonly ConnectionPermission[];
  /** The Brain's collections (`ctx.brain`). */
  readonly brain?: BrainPermission;
  /** The workflows it starts, each under its alias (`ctx.workflows.<alias>`). */
  // oxlint-disable-next-line typescript/no-explicit-any -- any workflow's args and returns
  readonly workflows?: readonly WorkflowPermission<string, any, any>[];
  /** The platform's own read-only functions (`ctx.grasp`). */
  readonly grasp?: GraspPermission;
  /**
   * Whether it reads the organization's people (`ctx.people`,
   * `usePeople`): names, emails and teams of every member. Shown to whoever
   * reviews its versions; no admin approves it. Without it, every read is
   * refused. Who calls (`ctx.auth.getUser()`) needs nothing.
   */
  readonly people?: boolean;
  /** What its pages may do with files. */
  readonly files?: FilesPermission;
  /** Guest chats (`ctx.guests`). */
  readonly guests?: GuestsPermission;
  /** The exact HTTPS origins its pages may link to; no network access. */
  readonly links?: LinksPermission;
}

/** A list's entries, or the value itself when it isn't one. */
type Entries<Value> = Value extends readonly (infer Entry)[] ? Entry : Value;

/**
 * What `Permissions` grant the App's functions (`Grant`), as one union:
 * each declaration its keys hold, but the pages' and `people`.
 */
export type GrantsOf<Permissions extends AppPermissions> = Extract<
  {
    readonly [Key in keyof Permissions]-?: Entries<
      NonNullable<Permissions[Key]>
    >;
  }[keyof Permissions],
  Grant
>;

/**
 * An App by its name: its config, as `defineApp` answers it, and the App
 * registered whole, as `registerApp` does. Each is what `registerApp` and
 * `inspectApp` take, and nothing else is.
 */
export interface App<Grants extends Grant = Grant> {
  readonly name: string;
  /**
   * What its permissions grant its functions, for types only: never set.
   * The generated `server/_generated/server` reads it (`serverModule`).
   */
  readonly "~grants"?: Grants;
}

/** The parts of an App the host's entry hands `registerApp`. */
export interface AppParts {
  /** `grasp.config.ts`'s default export. */
  readonly config: App;
  /** `server/schema.ts`'s default export. */
  readonly schema: SchemaDefinition;
  /** Each module under `server/` but the schema, `_generated/` and `migrations/`. */
  readonly modules: ServerModules;
  /** The default export of each `server/migrations/*.ts`, in path order. */
  readonly migrations: readonly unknown[];
}

/** One registered function, as data: what the host checks a call against. */
export interface FunctionManifest {
  readonly path: string;
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
  readonly args: ValueDescriptor;
  /** What it answers, checked by the host; null where it declares no `returns`. */
  readonly returns: ValueDescriptor | null;
  readonly stream: ValueDescriptor | null;
}

/** A registered App, as data. */
export interface AppManifest {
  readonly name: string;
  /** Its schema's canonical manifest, with its tables' access. */
  readonly schema: SchemaManifest;
  /** Every function, public and internal, by path. */
  readonly functions: Readonly<Record<string, FunctionManifest>>;
  /**
   * Every permission it declares, by alias, each with its kind
   * (`~permission`): what its actions reach, the workflows it starts,
   * what its pages use (files, links), and `people` when it reads the
   * organization's people. What the host checks every use against.
   */
  readonly permissions: Readonly<Record<string, AppPermission>>;
  /** Its migrations, by name, in the order declared. */
  readonly migrations: Readonly<Record<string, MigrationManifest>>;
  /** Its answers for a schema change, when it declares any. */
  readonly answers?: readonly SchemaAnswer[];
}

/** What the host runs an App from: its manifest and its handlers by path. */
export interface AppInspection {
  readonly manifest: AppManifest;
  /** Its schema, which its functions read and write through. */
  readonly schema: SchemaDefinition;
  readonly functions: ReadonlyMap<string, AnyFunction>;
  /** Its migrations, by name. */
  readonly migrations: ReadonlyMap<string, Migration>;
}
