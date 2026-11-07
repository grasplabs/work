import { canonicalText } from "@grasp-os/shared/json";
import {
  appMaxOperations,
  operationPathMaxLength,
  operationPathMaxSegments,
  operationSegmentPattern,
} from "@grasp-os/shared/operation-limits";

import { isMigration } from "./migration.ts";
import type { Migration, MigrationManifest } from "./migration.ts";
import {
  isBrowserPermission,
  isPermission,
  isWorkflowPermission,
  permissionAliases,
} from "./permissions.ts";
import type {
  AiPermission,
  AnyPermission,
  BrainPermission,
  BrowserPermission,
  ConnectionPermission,
  FilesPermission,
  GraspPermission,
  GuestsPermission,
  LinksPermission,
  PermissionKind,
  WorkflowPermission,
} from "./permissions.ts";
import { eventReferenceData, referenceName } from "./references.ts";
import { readSchemaAnswers } from "./schema-answer.ts";
import { schemaManifest } from "./schema-manifest.ts";
import type { SchemaManifest } from "./schema-manifest.ts";
import type { SchemaAnswer } from "./schema-plan.ts";
import type { AccessMode, SchemaDefinition } from "./schema.ts";
import { functionState, isServerFunction } from "./server.ts";
import type {
  AnyFunction,
  FunctionKind,
  TableVerbs,
  Visibility,
} from "./server.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// How an App registers itself (spec 7.1, 7.5), Convex's way: each part
// is a file of its own, and the host's entry (`.grasp/app.ts`) hands them
// all to `registerApp`:
//
// - its config, `grasp.config.ts`: `defineApp({ name, permissions,
//   preferences, answers })`, generated from the App's definition;
// - its schema, `server/schema.ts`, each table with its access
//   (`.access`), generated from the definition too;
// - its server functions: as in Convex, each an export of a module under
//   `server/`, whose path is its API (`server/tasks.ts`'s `list` is
//   `tasks.list`);
// - its migrations: the default export of each `server/migrations/*.ts`.
//
// Its pages aren't registered: they are its file routes under
// `src/routes/`, which the compiler reads (route-tree.ts).
//
// Registering grants nothing: every requirement here becomes usable only
// once the host authorizes it, and the host intersects it with the
// caller, the App's grants and current revocations on every read, commit
// and call.
//
// The registration is checked whole, so one that exists is coherent:
// - paths come from the server modules' paths and their exports' names
//   (`notes.create` for `server/notes.ts`'s `create`), each export read
//   once, so what registers is never something else a later read would
//   answer; exports that aren't server functions (helpers, constants) are
//   passed over;
// - a function's kind says whether it is public (`query`, `mutation`,
//   `action`) or internal (`internalQuery`, …), and no function is
//   exported at two paths;
// - every function was declared for the App's schema, and what it `uses`
//   is registered here too: a mutation only the App's queries and the
//   workflows its `permissions` list, an action any of its functions and
//   any permission the App lists in its own `permissions`;
// - `permissions` lists each kind under its own key, each declaration of
//   that kind, under an alias no other of the App's permissions has;
// - a function's `tables` only narrows what its tables' access and its
//   kind give it: a verb its table's access doesn't allow, or one a
//   function of its kind can't use (a query writing), is refused here;
// - a function's `uses` may name another by its generated reference
//   (spec 8), resolved here by its path: one whose visibility or kind
//   doesn't match what is registered there is refused, so a stale or
//   forged reference names nothing;
// - `preferences` (spec 10.7.7), when declared, is a strict object; the
//   top-level path segments `preferences`, `workflows` and `people` are
//   the platform's, so no function registers under them;
// - migrations (spec 17.2, migration.ts) are `migration` declarations,
//   each named once, one a table, of a table the schema has, whose
//   `output` declares exactly that table's fields.
//
// What the host runs from is `inspectApp` of what `registerApp` answered:
// the registration as data (descriptors, paths, the access each function
// may use), and the handlers by path, which only the runner calls.

/**
 * An App's server modules, by their path under `server/` without `.ts`
 * (`tasks`, `admin/users`): each module's exports, as its namespace.
 */
export type ServerModules = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

/** What an App's config (`grasp.config.ts`) declares. */
export interface AppConfig {
  /** What people call the App, 1 to 100 characters. */
  readonly name: string;
  /**
   * Everything it can reach outside itself, by kind; none unless listed.
   * Each needs an admin's binding or grant before it serves anything.
   */
  readonly permissions?: AppPermissions;
  /** Its people's preferences (spec 10.7.7): a strict object, when declared. */
  readonly preferences?: AnySchema;
  /**
   * Its answers for the records that lack a field a change of its schema
   * requires (schema-plan.ts, `SchemaAnswer`): for one field each, the
   * value they take where the field is absent or null, as a backfill's
   * default. The store checks every record as the version is made
   * current, and never writes over a value a record holds. Anything that
   * reshapes records is a migration (`server/migrations/`).
   */
  readonly answers?: readonly SchemaAnswer[];
}

/**
 * An App's permissions, by kind (permissions.ts): what its actions reach
 * through `ctx`, the workflows its functions start, what its pages may
 * do with files and link to, and whether it reads the organization's
 * people.
 */
export interface AppPermissions {
  /** Answers from the workspace's model (`ctx.ai`). */
  readonly ai?: AiPermission;
  /** Connections' actions, each under its alias (`ctx.connections.<alias>`). */
  readonly connections?: readonly ConnectionPermission[];
  /** The Brain's collections (`ctx.brain`). */
  readonly brain?: BrainPermission;
  /** The workflows it starts, each under its alias (`ctx.workflows.<alias>`). */
  // oxlint-disable-next-line typescript/no-explicit-any -- any workflow's input and output
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

/**
 * An App by its name: its config, as `defineApp` answers it, and the App
 * registered whole, as `registerApp` does. Each is what `registerApp` and
 * `inspectApp` take, and nothing else is.
 */
export interface App {
  readonly name: string;
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

/** What one entry of a function's `uses` is, as data. */
export type UseManifest =
  | {
      readonly type: "function";
      readonly path: string;
      readonly kind: FunctionKind;
    }
  | {
      readonly type: "resource";
      readonly kind: PermissionKind;
      readonly alias: string;
    }
  | {
      /** A workflow it starts (an action) or stages a start of (a mutation). */
      readonly type: "workflow";
      readonly alias: string;
    }
  | {
      /**
       * An event of one of the App's workflows a mutation notifies runs
       * of (spec 10.7.4): the workflow's alias, the event binding's, and
       * the type and fingerprint its reference was generated with, which
       * the host checks against the release it runs.
       */
      readonly type: "workflowEvent";
      readonly workflow: string;
      readonly alias: string;
      readonly eventType: string;
      readonly fingerprint: string;
    };

/** One registered function, as data: what the host checks a call against. */
export interface OperationManifest {
  readonly path: string;
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
  readonly args: ValueDescriptor;
  /** What it answers, checked by the host; null where it declares no `returns`. */
  readonly returns: ValueDescriptor | null;
  readonly stream: ValueDescriptor | null;
  readonly uses: readonly UseManifest[];
  /**
   * The verbs it may use on each of the schema's tables: their access,
   * narrowed by its kind and its `tables`. Every table is listed.
   */
  readonly tables: Readonly<Record<string, TableVerbs>>;
}

/** A registered App, as data. */
export interface AppManifest {
  readonly name: string;
  /** Its schema's canonical manifest, with its tables' access. */
  readonly schema: SchemaManifest;
  /** Every function, public and internal, by path. */
  readonly operations: Readonly<Record<string, OperationManifest>>;
  /** The permissions its actions reach, by alias. */
  readonly resources: Readonly<Record<string, AnyPermission>>;
  /** The permissions its pages use (files, links), by alias. */
  readonly browserResources: Readonly<Record<string, BrowserPermission>>;
  /** The workflows its functions start, by alias. */
  readonly workflows: Readonly<Record<string, WorkflowPermission>>;
  /** Its preferences' strict object, or null when it declares none. */
  readonly preferences: ValueDescriptor | null;
  /** Present when it reads the organization's people (`permissions.people`). */
  readonly people?: true;
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

/** Why an App's registration was refused. */
export class AppDefinitionError extends Error {
  readonly code = "app.invalid_definition";

  constructor(message: string) {
    super(message);
    this.name = "AppDefinitionError";
  }
}

const refuse = (message: string): never => {
  throw new AppDefinitionError(message);
};

/** `value` with every object and array in it frozen; data only. */
const deepFreeze = <Value>(value: Value): Value => {
  // Into frozen objects too: a frozen object can hold one that isn't.
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
  }
  return value;
};

/** Every config `defineApp` made, with what it checked of it. */
const configs = new WeakMap<object, CheckedConfig>();

/** Every App `registerApp` registered whole, with its inspection. */
const inspections = new WeakMap<object, AppInspection>();

/** What `defineApp` checked of a config, for `registerApp`. */
interface CheckedConfig {
  readonly config: AppConfig;
  readonly resources: ReadonlyMap<string, AnyPermission>;
  readonly browser: ReadonlyMap<string, BrowserPermission>;
  readonly workflows: ReadonlyMap<string, WorkflowPermission>;
  readonly people: boolean;
  readonly preferences: ValueDescriptor | null;
}

const configKeys: ReadonlySet<string> = new Set([
  "name",
  "permissions",
  "preferences",
  "answers",
]);

/**
 * The top-level path segments the platform keeps, with what each is for:
 * `preferences` for an App's preferences (spec 10.7.7), `workflows` for
 * its generated workflow references (`workflows.<alias>.queries.*`) and
 * `people` for who calls and the organization's people (people.ts), which
 * the host answers itself. No function registers under either, whether or
 * not the App declares preferences or workflows now, so declaring one
 * later never shadows or is shadowed by a function.
 */
export const reservedSegments: ReadonlyMap<string, string> = new Map([
  ["preferences", "the App's preferences"],
  ["workflows", "the App's workflow references"],
  ["people", "the organization's people"],
]);

/**
 * Path segments no function registers at, at any depth: `name`, which a
 * reference answers as data and a reference tree can't also hold as a
 * child, and `then`, which would make a reference look like a promise to
 * whatever awaits it.
 */
export const referenceKeys: ReadonlySet<string> = new Set(["name", "then"]);

/**
 * Refuses `segments`, a function's path, where it can't be one: past the
 * bounds of a path, holding a segment that isn't an identifier or that a
 * reference answers itself, or starting at a segment the platform keeps.
 * `where` names the module or export, for the message.
 */
const checkPath = (segments: readonly string[], where: string): string => {
  const path = segments.join(".");
  const named = segments.every((segment) =>
    operationSegmentPattern.test(segment)
  );
  if (
    !named ||
    segments.length > operationPathMaxSegments ||
    path.length > operationPathMaxLength
  ) {
    refuse(
      `${where} doesn't make a function path of up to ${operationPathMaxSegments} identifiers (letters, digits and _, not starting with a digit), each folder and file name included${named ? `: \`${path}\`` : ""}.`
    );
  }
  const answered = segments.find((segment) => referenceKeys.has(segment));
  if (answered !== undefined) {
    refuse(
      `${where} can't be a function's path: \`${answered}\` is a name a reference itself answers.`
    );
  }
  const reservedFor = reservedSegments.get(segments[0] ?? "");
  if (reservedFor !== undefined) {
    refuse(
      `${where} can't be a function's path: \`${segments[0] ?? ""}\` is the platform's, for ${reservedFor}.`
    );
  }
  return path;
};

/**
 * The server functions `modules` export, by path (each module's path
 * under `server/`, then the export's name), each export read once.
 * Exports that aren't server functions are passed over.
 */
const exportedFunctions = (modules: unknown): Map<string, unknown> => {
  if (!isPlainObject(modules)) {
    return refuse("An App's server modules are a map of module namespaces.");
  }
  const found = new Map<string, unknown>();
  for (const module of Object.keys(modules).toSorted()) {
    const where = `server/${module}.ts`;
    const namespace: unknown = modules[module];
    if (typeof namespace !== "object" || namespace === null) {
      refuse(`${where} isn't a module.`);
      continue;
    }
    const segments = module.split("/");
    for (const name of Object.keys(namespace).toSorted()) {
      // Read once: what registers is what this read answered, whatever a
      // getter (a bundler's namespace has them) would answer later.
      const value: unknown = Reflect.get(namespace, name);
      if (!isServerFunction(value)) {
        continue;
      }
      found.set(
        checkPath([...segments, name], `\`${name}\` of ${where}`),
        value
      );
      if (found.size > appMaxOperations) {
        refuse(`An App has at most ${appMaxOperations} functions.`);
      }
    }
  }
  // A function's path is a reference's place in `api`: never also a
  // folder of others' (`server/notes.ts`'s `get` beside
  // `server/notes/get.ts`).
  const sorted = [...found.keys()].toSorted();
  for (const [index, path] of sorted.entries()) {
    const next = sorted[index + 1];
    if (next?.startsWith(`${path}.`) === true) {
      refuse(
        `\`${path}\` clashes with another registered path, \`${next}\`: rename the module or the export.`
      );
    }
  }
  return found;
};

/** The keys of an App's `permissions`, and what each holds. */
const permissionKeys: ReadonlyMap<string, string> = new Map([
  ["ai", "one `permission.ai`"],
  ["connections", "a list of `permission.connection`"],
  ["brain", "one `permission.brain`"],
  ["workflows", "a list of `permission.workflow`"],
  ["grasp", "one `permission.grasp()`"],
  ["people", "`true` when it reads the organization's people"],
  ["files", "one `permission.files`"],
  ["guests", "one `permission.guests`"],
  ["links", "one `permission.links`"],
]);

/** The keys of an App's `permissions` that hold a list. */
const listedKeys: ReadonlySet<string> = new Set(["connections", "workflows"]);

/** The App's permissions, by what reaches them and by alias, each once. */
interface PermissionsOf {
  readonly actions: Map<string, AnyPermission>;
  readonly browser: Map<string, BrowserPermission>;
  readonly workflows: Map<string, WorkflowPermission>;
  readonly people: boolean;
}

/** The declarations `permissions[key]` holds: one, or a list. */
const declarationsUnder = (
  permissions: Readonly<Record<string, unknown>>,
  key: string
): readonly unknown[] => {
  const held = permissions[key];
  if (held === undefined) {
    return [];
  }
  if (listedKeys.has(key) !== Array.isArray(held)) {
    return refuse(
      `An App's \`permissions.${key}\` is ${permissionKeys.get(key) ?? "a permission"}.`
    );
  }
  const listed: readonly unknown[] = Array.isArray(held) ? held : [held];
  return listed;
};

/** The alias of `declaration`, if `permissions[key]` may hold it. */
const aliasUnder = (declaration: unknown, key: string): string | undefined => {
  if (isWorkflowPermission(declaration)) {
    return key === "workflows" ? declaration.alias : undefined;
  }
  if (isPermission(declaration) || isBrowserPermission(declaration)) {
    return declaration["~permission"] === key ? declaration.alias : undefined;
  }
  return undefined;
};

/** `permissions`, refused unless an object of the kinds there are. */
const checkedKeys = (
  permissions: unknown
): Readonly<Record<string, unknown>> => {
  if (!isPlainObject(permissions)) {
    return refuse(
      "An App's `permissions` is an object of its permissions by kind."
    );
  }
  for (const key of Object.keys(permissions)) {
    if (!permissionKeys.has(key)) {
      refuse(
        `An App's \`permissions\` has no \`${key}\`: its kinds are ${[...permissionKeys.keys()].join(", ")}.`
      );
    }
  }
  const { people } = permissions;
  if (people !== undefined && typeof people !== "boolean") {
    refuse(
      "An App's `permissions.people` is `true` when it reads the organization's people."
    );
  }
  return permissions;
};

/**
 * Refuses a fixed alias held by another kind: no connection or
 * workflow takes one, so the host never mistakes `ai` for a connection.
 */
const requireFixedAliases = ({
  actions,
  browser,
  workflows,
}: Omit<PermissionsOf, "people">): void => {
  for (const [kind, alias] of Object.entries(permissionAliases)) {
    const held =
      actions.get(alias) ?? browser.get(alias) ?? workflows.get(alias);
    if (held !== undefined && held["~permission"] !== kind) {
      refuse(`\`${alias}\` is the alias of the App's \`${kind}\` permission.`);
    }
  }
};

/** The App's permissions (see `PermissionsOf`), each kind under its key. */
const permissionsOf = (given: unknown): PermissionsOf => {
  const actions = new Map<string, AnyPermission>();
  const browser = new Map<string, BrowserPermission>();
  const workflows = new Map<string, WorkflowPermission>();
  if (given === undefined) {
    return { actions, browser, workflows, people: false };
  }
  const permissions = checkedKeys(given);
  for (const key of permissionKeys.keys()) {
    for (const declaration of key === "people"
      ? []
      : declarationsUnder(permissions, key)) {
      const alias = aliasUnder(declaration, key);
      if (alias === undefined) {
        refuse(
          `An App's \`permissions.${key}\` is ${permissionKeys.get(key) ?? "a permission"}.`
        );
        continue;
      }
      if (actions.has(alias) || browser.has(alias) || workflows.has(alias)) {
        refuse(`Two of the App's permissions have alias \`${alias}\`.`);
      }
      if (isWorkflowPermission(declaration)) {
        workflows.set(alias, declaration);
      } else if (isPermission(declaration)) {
        actions.set(alias, declaration);
      } else if (isBrowserPermission(declaration)) {
        browser.set(alias, declaration);
      }
    }
  }
  requireFixedAliases({ actions, browser, workflows });
  return { actions, browser, workflows, people: permissions.people === true };
};

/** The App's preferences' descriptor, or null: a strict required object. */
const preferencesOf = (preferences: unknown): ValueDescriptor | null => {
  if (preferences === undefined) {
    return null;
  }
  // Throws for anything but a `v` schema.
  const descriptor = descriptorOf(preferences);
  if (
    descriptor.kind !== "object" ||
    descriptor.nullable ||
    descriptor.presence !== "required"
  ) {
    return refuse("An App's `preferences` is a required `v.object`.");
  }
  // Every field has a default: a person who never chose answers them, and
  // a patch leaves out what it doesn't change. `_rev` is what the host
  // answers beside them, and `_` names are the platform's.
  for (const [name, field] of Object.entries(descriptor.fields)) {
    if (name.startsWith("_")) {
      return refuse(
        `An App's preference \`${name}\` starts with \`_\`, which is the platform's.`
      );
    }
    if (field.presence !== "default") {
      return refuse(
        `An App's preference \`${name}\` needs a \`.default(…)\`: every preference has one.`
      );
    }
  }
  return descriptor;
};

/** The most migrations an App registers. */
export const appMaxMigrations = 16;

/**
 * The App's migrations, by name, in the order declared, each checked
 * against `schema`: a table it has, and an `output` declaring exactly that
 * table's fields, so what the host validates a transform's rows against
 * is the table the reviewer reads.
 */
const migrationsOf = (
  migrations: unknown,
  schema: SchemaManifest
): {
  manifests: Record<string, MigrationManifest>;
  byName: Map<string, Migration>;
} => {
  const listed: readonly unknown[] = Array.isArray(migrations)
    ? migrations
    : [];
  if (
    (migrations !== undefined && !Array.isArray(migrations)) ||
    listed.length > appMaxMigrations
  ) {
    refuse(
      `An App's \`migrations\` is a list of at most ${appMaxMigrations} \`migration\` declarations.`
    );
  }
  const manifests: Record<string, MigrationManifest> = {};
  const byName = new Map<string, Migration>();
  for (const declared of listed) {
    if (!isMigration(declared)) {
      refuse("An App's `migrations` lists `migration` declarations only.");
      continue;
    }
    const manifest = declared["~migration"];
    if (byName.has(manifest.name)) {
      refuse(`Two of the App's migrations are named \`${manifest.name}\`.`);
    }
    if (
      [...byName.values()].some(
        (other) => other["~migration"].table === manifest.table
      )
    ) {
      refuse(
        `Two of the App's migrations transform \`${manifest.table}\`: a table takes one migration a version.`
      );
    }
    const table = Object.hasOwn(schema.tables, manifest.table)
      ? schema.tables[manifest.table]
      : undefined;
    if (table === undefined) {
      refuse(
        `Migration \`${manifest.name}\` transforms \`${manifest.table}\`, a table the schema doesn't have.`
      );
      continue;
    }
    if (
      manifest.output.kind !== "object" ||
      canonicalText(manifest.output.fields) !== canonicalText(table.fields)
    ) {
      refuse(
        `Migration \`${manifest.name}\`'s \`output\` doesn't declare exactly the fields of \`${manifest.table}\`: declare them as the schema does.`
      );
    }
    byName.set(manifest.name, declared);
    Object.defineProperty(manifests, manifest.name, {
      enumerable: true,
      value: manifest,
    });
  }
  return { manifests, byName };
};

/** Whether `mode` lets anyone at all use the table. */
const allows = (mode: AccessMode): boolean => mode !== "none";

/** What `kind` may do to a table with access `read` and `write`. */
const baseVerbs = (
  kind: FunctionKind,
  read: AccessMode,
  write: AccessMode
): TableVerbs => ({
  read: kind !== "action" && allows(read),
  insert: kind === "mutation" && allows(write),
  update: kind === "mutation" && allows(write),
  delete: kind === "mutation" && allows(write),
});

/**
 * The verbs of each table for function `fn`, registered at `path`: its
 * base verbs, narrowed by its `tables` when it declares them, in which a
 * table or verb left out is denied. A verb `tables` sets that the base
 * doesn't allow is a widening, and refused.
 */
const verbsOf = (
  schema: SchemaManifest,
  path: string,
  fn: AnyFunction
): Record<string, TableVerbs> => {
  const verbs: Record<string, TableVerbs> = {};
  const narrowing = fn.tables;
  for (const [table, { access }] of Object.entries(schema.tables)) {
    const base = baseVerbs(fn.kind, access.read, access.write);
    if (narrowing === null) {
      verbs[table] = base;
      continue;
    }
    const declared = Object.hasOwn(narrowing, table) ? narrowing[table] : {};
    const narrowed = (verb: keyof TableVerbs): boolean => {
      const wanted = declared?.[verb] === true;
      if (wanted && !base[verb]) {
        refuse(
          `\`${path}\`'s \`tables.${table}.${verb}\` widens access: ${fn.kind === "query" && verb !== "read" ? "a query only reads" : `\`${table}\`'s \`${verb === "read" ? "read" : "write"}\` access is \`none\``}.`
        );
      }
      return wanted;
    };
    verbs[table] = {
      read: narrowed("read"),
      insert: narrowed("insert"),
      update: narrowed("update"),
      delete: narrowed("delete"),
    };
  }
  return verbs;
};

/**
 * The registered path and kind `use` names: a definition by the path it is
 * registered at, a reference by its path, if what is registered there has
 * its visibility and, for a generated reference, its kind.
 */
const usedFunction = (
  use: unknown,
  path: string,
  paths: ReadonlyMap<unknown, string>,
  functions: ReadonlyMap<string, AnyFunction>
): { target: string; kind: FunctionKind } => {
  const registered = paths.get(use);
  if (registered !== undefined) {
    const fn = functions.get(registered);
    if (fn !== undefined) {
      return { target: registered, kind: fn.kind };
    }
  }
  const name = referenceName(use);
  const target = name === undefined ? undefined : functions.get(name);
  if (name === undefined || target === undefined) {
    return refuse(`\`${path}\` uses a function the App doesn't register.`);
  }
  return { target: name, kind: target.kind };
};

/** What `fn`, registered at `path`, uses, as data, checked against the App. */
const usesOf = (
  fn: AnyFunction,
  path: string,
  paths: ReadonlyMap<unknown, string>,
  functions: ReadonlyMap<string, AnyFunction>,
  resources: ReadonlyMap<string, AnyPermission>,
  workflows: ReadonlyMap<string, WorkflowPermission>
): UseManifest[] => {
  const seen = new Set<unknown>();
  return fn.uses.map((use): UseManifest => {
    if (seen.has(use)) {
      refuse(`\`${path}\` lists the same reference twice in \`uses\`.`);
    }
    seen.add(use);
    if (isPermission(use)) {
      // Every permission an action reaches goes outside the App: AI, a
      // connection, the Brain, another App, guest chats. Only an action
      // may.
      if (fn.kind !== "action") {
        refuse(
          `\`${path}\` is a ${fn.kind}: only an action reaches \`${use["~permission"]}\`, and queries and mutations never call AI, connections, the Brain, other Apps or guests.`
        );
      }
      if (resources.get(use.alias) !== use) {
        refuse(
          `\`${path}\` uses permission \`${use.alias}\`, which the App's \`permissions\` don't list.`
        );
      }
      return { type: "resource", kind: use["~permission"], alias: use.alias };
    }
    if (isWorkflowPermission(use)) {
      // A start is a change, never a read: an action makes one, a mutation
      // stages one with its commit. A query lists nothing.
      if (fn.kind === "query") {
        refuse(`\`${path}\` is a query: it starts no workflow.`);
      }
      if (workflows.get(use.alias) !== use) {
        refuse(
          `\`${path}\` starts workflow \`${use.alias}\`, which the App's \`permissions.workflows\` don't list.`
        );
      }
      return { type: "workflow", alias: use.alias };
    }
    const event = eventReferenceData(use);
    if (event !== undefined) {
      // A notification is a change staged with a commit: only a mutation
      // stages one. An action calls a mutation that does.
      if (fn.kind !== "mutation") {
        refuse(
          `\`${path}\` is a ${fn.kind}: only a mutation notifies a workflow's run, staged with its commit.`
        );
      }
      if (!workflows.has(event.workflow)) {
        refuse(
          `\`${path}\` notifies workflow \`${event.workflow}\`, which the App's \`permissions.workflows\` don't list.`
        );
      }
      return {
        type: "workflowEvent",
        workflow: event.workflow,
        alias: event.alias,
        eventType: event.type,
        fingerprint: event.fingerprint,
      };
    }
    const { target, kind } = usedFunction(use, path, paths, functions);
    if (fn.kind === "mutation" && kind !== "query") {
      refuse(
        `\`${path}\` is a mutation: it may run the App's queries, never \`${target}\`, a ${kind}.`
      );
    }
    return { type: "function", path: target, kind };
  });
};

/**
 * The functions `found` holds, by path, and the path of each: every one
 * declared for `schema`, exported at one path only.
 */
const registeredFunctions = (
  schema: unknown,
  found: ReadonlyMap<string, unknown>
): {
  functions: Map<string, AnyFunction>;
  paths: Map<unknown, string>;
} => {
  const functions = new Map<string, AnyFunction>();
  const paths = new Map<unknown, string>();
  for (const [path, value] of found) {
    if (!isServerFunction(value)) {
      continue;
    }
    const known = paths.get(value);
    if (known !== undefined) {
      refuse(
        `One function is exported twice, as \`${known}\` and \`${path}\`: export it from one module only.`
      );
    }
    if (functionState(value).schema !== schema) {
      refuse(
        `\`${path}\` was declared for another schema than the App's: declare it with the builders of server/_generated/server.`
      );
    }
    functions.set(path, value);
    paths.set(value, path);
  }
  return { functions, paths };
};

/** Refuses a config with keys it can't have, or without a name. */
const checkConfig = (config: unknown): void => {
  if (!isPlainObject(config)) {
    refuse("An App's config is an object.");
    return;
  }
  for (const key of Object.keys(config)) {
    if (!configKeys.has(key)) {
      refuse(`An App's config has no \`${key}\`.`);
    }
  }
  const { name } = config;
  if (typeof name !== "string" || name.length === 0 || name.length > 100) {
    refuse("An App's `name` is 1 to 100 characters.");
  }
};

/**
 * An App's config (`grasp.config.ts`), checked: its name, its
 * permissions and its preferences. Throws `AppDefinitionError` for one
 * that isn't coherent; what needs its schema (`answers`) is checked as it
 * registers (`registerApp`).
 */
export const defineApp = (config: AppConfig): App => {
  checkConfig(config);
  const {
    actions: resources,
    browser,
    workflows,
    people,
  } = permissionsOf(config.permissions);
  const made: App = Object.freeze({ name: config.name });
  configs.set(made, {
    config,
    resources,
    browser,
    workflows,
    people,
    preferences: preferencesOf(config.preferences),
  });
  return made;
};

/**
 * Registers an App from its parts (see the header), checked whole: what
 * `inspectApp` reads. The host calls it from the entry it generates for
 * every App (`.grasp/app.ts`); App code never does. Throws
 * `AppDefinitionError` (or the schema's own error) for an App that isn't
 * coherent.
 */
export const registerApp = (parts: AppParts): App => {
  if (!isPlainObject(parts)) {
    return refuse("An App is registered from its parts.");
  }
  const checked =
    typeof parts.config === "object" && parts.config !== null
      ? configs.get(parts.config)
      : undefined;
  if (checked === undefined) {
    return refuse(
      "grasp.config.ts's default export isn't a config `defineApp` made."
    );
  }
  const { config, resources, workflows } = checked;
  // Throws for a schema `defineSchema` didn't make.
  const manifest = schemaManifest(parts.schema);
  const { manifests: migrations, byName: migrationsByName } = migrationsOf(
    parts.migrations,
    manifest
  );
  const answers = readSchemaAnswers(config.answers, manifest, refuse);
  const { functions, paths } = registeredFunctions(
    parts.schema,
    exportedFunctions(parts.modules)
  );

  const operations: Record<string, OperationManifest> = {};
  for (const [path, fn] of functions) {
    Object.defineProperty(operations, path, {
      enumerable: true,
      value: Object.freeze({
        path,
        kind: fn.kind,
        visibility: fn.visibility,
        args: fn.args.descriptor,
        returns: fn.returns === null ? null : fn.returns.descriptor,
        stream: fn.stream === null ? null : fn.stream.descriptor,
        uses: Object.freeze(
          usesOf(fn, path, paths, functions, resources, workflows)
        ),
        tables: Object.freeze(verbsOf(manifest, path, fn)),
      }),
    });
  }

  const made: App = Object.freeze({ name: config.name });
  inspections.set(made, {
    manifest: deepFreeze({
      name: config.name,
      schema: manifest,
      operations,
      resources: Object.fromEntries(resources),
      browserResources: Object.fromEntries(checked.browser),
      workflows: Object.fromEntries(workflows),
      preferences: checked.preferences,
      ...(checked.people ? { people: true } : {}),
      migrations,
      ...(answers.length > 0 ? { answers } : {}),
    }),
    schema: parts.schema,
    functions,
    migrations: new Map(migrationsByName),
  });
  return made;
};

/**
 * What the host runs `registered` from; throws for anything `registerApp`
 * didn't make. The manifest is frozen all the way down, and the handlers
 * are a copy each time, so nothing a caller does to them changes the App.
 */
export const inspectApp = (registered: unknown): AppInspection => {
  const inspection =
    typeof registered === "object" && registered !== null
      ? inspections.get(registered)
      : undefined;
  if (inspection === undefined) {
    return refuse("That isn't an App `registerApp` registered.");
  }
  return Object.freeze({
    manifest: inspection.manifest,
    schema: inspection.schema,
    functions: new Map(inspection.functions),
    migrations: new Map(inspection.migrations),
  });
};
