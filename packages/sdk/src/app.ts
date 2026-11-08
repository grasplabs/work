import {
  appMaxOperations,
  operationPathMaxLength,
  operationPathMaxSegments,
  operationSegmentPattern,
} from "@grasp-os/shared/function-limits";
import { canonicalText } from "@grasp-os/shared/json";

import { isServerFunction, serverFunctions } from "./handlers.ts";
import { isMigration } from "./migration.ts";
import type { Migration, MigrationManifest } from "./migration.ts";
import {
  isBrowserPermission,
  isPermission,
  isWorkflowPermission,
  peopleDeclaration,
  permissionAliases,
} from "./permissions.ts";
import type {
  AiPermission,
  AnyPermission,
  AppPermission,
  BrainPermission,
  ConnectionPermission,
  FilesPermission,
  GraspPermission,
  GuestsPermission,
  LinksPermission,
  WorkflowPermission,
} from "./permissions.ts";
import { readSchemaAnswers } from "./schema-answer.ts";
import type { SchemaAnswer } from "./schema-answer.ts";
import { schemaManifest } from "./schema-manifest.ts";
import type { SchemaManifest } from "./schema-manifest.ts";
import type { SchemaDefinition } from "./schema.ts";
import type { AnyFunction, FunctionKind, Grant, Visibility } from "./server.ts";
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
// and call. The App's `permissions` are its one list, as in Convex, where
// every function of an app may use what the app may: any of its
// functions may use any of them, as its kind allows (server.ts), and what
// it reads and writes is decided by its tables' access and row rules for
// whoever calls, by the store.
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
// - every function was declared for the App's schema;
// - `permissions` lists each kind under its own key, each declaration of
//   that kind, under an alias no other of the App's permissions has;
// - `preferences` (spec 10.7.7), when declared, is a strict object; the
//   top-level path segments `preferences`, `workflows` and `people` are
//   the platform's, so no function registers under them;
// - migrations (spec 17.2, migration.ts) are `migration` declarations,
//   each named once, one a table, of a table the schema has, whose
//   `output` declares exactly that table's fields.
//
// What the host runs from is `inspectApp` of what `registerApp` answered:
// the registration as data (descriptors, paths, the App's permissions by
// alias), and the handlers by path, which only the runner calls.

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
  /** Its people's preferences (spec 10.7.7): a strict object, when declared. */
  readonly preferences?: AnySchema;
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
 * An App's permissions, by kind (permissions.ts): what its actions reach
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
export interface App<Permissions extends AppPermissions = AppPermissions> {
  readonly name: string;
  /**
   * What its permissions grant its functions, for types only: never set.
   * The generated `server/_generated/server` reads it (`serverModule`).
   */
  readonly "~grants"?: GrantsOf<Permissions>;
}

/** The parts of an App the host's entry hands `registerApp`. */
interface AppParts {
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
export interface OperationManifest {
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
  readonly operations: Readonly<Record<string, OperationManifest>>;
  /**
   * Every permission it declares, by alias, each with its kind
   * (`~permission`): what its actions reach, the workflows it starts,
   * what its pages use (files, links), and `people` when it reads the
   * organization's people. What the host checks every use against.
   */
  readonly permissions: Readonly<Record<string, AppPermission>>;
  /** Its preferences' strict object, or null when it declares none. */
  readonly preferences: ValueDescriptor | null;
  /** Its migrations, by name, in the order declared. */
  readonly migrations: Readonly<Record<string, MigrationManifest>>;
  /** Its answers for a schema change, when it declares any. */
  readonly answers?: readonly SchemaAnswer[];
}

/** What the host runs an App from: its manifest and its handlers by path. */
interface AppInspection {
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
  readonly permissions: ReadonlyMap<string, AppPermission>;
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
const reservedSegments: ReadonlyMap<string, string> = new Map([
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
const referenceKeys: ReadonlySet<string> = new Set(["name", "then"]);

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
const requireFixedAliases = (
  permissions: ReadonlyMap<string, AppPermission>
): void => {
  for (const [kind, alias] of Object.entries(permissionAliases)) {
    const held = permissions.get(alias);
    if (held !== undefined && held["~permission"] !== kind) {
      refuse(`\`${alias}\` is the alias of the App's \`${kind}\` permission.`);
    }
  }
};

/**
 * The App's permissions, each kind under its key, as one map by alias,
 * each alias once: `people: true` as the `people` permission.
 */
const permissionsOf = (given: unknown): Map<string, AppPermission> => {
  const declared = new Map<string, AppPermission>();
  if (given === undefined) {
    return declared;
  }
  const permissions = checkedKeys(given);
  for (const key of permissionKeys.keys()) {
    for (const declaration of key === "people"
      ? []
      : declarationsUnder(permissions, key)) {
      const alias = aliasUnder(declaration, key);
      if (
        alias === undefined ||
        !(
          isWorkflowPermission(declaration) ||
          isPermission(declaration) ||
          isBrowserPermission(declaration)
        )
      ) {
        refuse(
          `An App's \`permissions.${key}\` is ${permissionKeys.get(key) ?? "a permission"}.`
        );
        continue;
      }
      if (declared.has(alias)) {
        refuse(`Two of the App's permissions have alias \`${alias}\`.`);
      }
      declared.set(alias, declaration);
    }
  }
  requireFixedAliases(declared);
  if (permissions.people === true) {
    declared.set(peopleDeclaration.alias, peopleDeclaration);
  }
  return declared;
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
const appMaxMigrations = 16;

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

/**
 * The functions `found` holds, by path: every one declared for `schema`,
 * exported at one path only.
 */
const registeredFunctions = (
  schema: unknown,
  found: ReadonlyMap<string, unknown>
): Map<string, AnyFunction> => {
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
    if (serverFunctions.of(value)?.schema !== schema) {
      refuse(
        `\`${path}\` was declared for another schema than the App's: declare it with the builders of server/_generated/server.`
      );
    }
    functions.set(path, value);
    paths.set(value, path);
  }
  return functions;
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
 * registers (`registerApp`). What it answers carries its permissions'
 * types, which type its functions' contexts (`serverModule`).
 */
export const defineApp = <
  const Permissions extends AppPermissions = Record<never, never>,
>(
  config: AppConfig<Permissions>
): App<Permissions> => {
  checkConfig(config);
  const made: App<Permissions> = Object.freeze({ name: config.name });
  configs.set(made, {
    config,
    permissions: permissionsOf(config.permissions),
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
  const { config, permissions } = checked;
  // Throws for a schema `defineSchema` didn't make.
  const manifest = schemaManifest(parts.schema);
  const { manifests: migrations, byName: migrationsByName } = migrationsOf(
    parts.migrations,
    manifest
  );
  const answers = readSchemaAnswers(config.answers, manifest, refuse);
  const functions = registeredFunctions(
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
      }),
    });
  }

  const made: App = Object.freeze({ name: config.name });
  inspections.set(made, {
    manifest: deepFreeze({
      name: config.name,
      schema: manifest,
      operations,
      permissions: Object.fromEntries(permissions),
      preferences: checked.preferences,
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

/** A permission's kind, as a manifest files it (`~permission`). */
export type AppPermissionKind = AppPermission["~permission"];

/** The permission of kind `Kind`. */
export type PermissionOfKind<Kind extends AppPermissionKind> = Extract<
  AppPermission,
  { readonly "~permission": Kind }
>;

/** Whether `declared` is of kind `kind`. */
const isOfKind = <Kind extends AppPermissionKind>(
  declared: AppPermission,
  kind: Kind
): declared is PermissionOfKind<Kind> => declared["~permission"] === kind;

/**
 * The permission `manifest` declares under `alias`, if it is of kind
 * `kind`: what the host checks a use against, so an alias of another kind
 * (a workflow named where a connection is asked for) is none.
 */
export const declaredPermission = <Kind extends AppPermissionKind>(
  manifest: Pick<AppManifest, "permissions">,
  alias: unknown,
  kind: Kind
): PermissionOfKind<Kind> | undefined => {
  const declared =
    typeof alias === "string" && Object.hasOwn(manifest.permissions, alias)
      ? manifest.permissions[alias]
      : undefined;
  return declared !== undefined && isOfKind(declared, kind)
    ? declared
    : undefined;
};

/** The permissions of kind `kind` that `manifest` declares, in alias order. */
export const declaredPermissions = <Kind extends AppPermissionKind>(
  manifest: Pick<AppManifest, "permissions">,
  kind: Kind
): PermissionOfKind<Kind>[] =>
  Object.keys(manifest.permissions)
    .toSorted()
    .flatMap((alias) => declaredPermission(manifest, alias, kind) ?? []);

/** The kinds of permission an action reaches through `ctx`. */
const reachedKinds: ReadonlySet<AppPermissionKind> = new Set([
  "ai",
  "connections",
  "brain",
  "grasp",
  "guests",
]);

/** Whether `declared` is one an action reaches through `ctx`. */
export const isActionPermission = (
  declared: AppPermission
): declared is AnyPermission => reachedKinds.has(declared["~permission"]);

/**
 * The permission an action reaches under `alias` (`ctx.ai`,
 * `ctx.connections.<alias>`, …) that `manifest` declares, if any: never a
 * workflow, a pages' permission or `people`.
 */
export const actionPermission = (
  manifest: Pick<AppManifest, "permissions">,
  alias: unknown
): AnyPermission | undefined => {
  const declared =
    typeof alias === "string" && Object.hasOwn(manifest.permissions, alias)
      ? manifest.permissions[alias]
      : undefined;
  return declared !== undefined && isActionPermission(declared)
    ? declared
    : undefined;
};

/** The permissions an action reaches that `manifest` declares, in alias order. */
export const actionPermissions = (
  manifest: Pick<AppManifest, "permissions">
): AnyPermission[] =>
  Object.keys(manifest.permissions)
    .toSorted()
    .flatMap((alias) => actionPermission(manifest, alias) ?? []);
