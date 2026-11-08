import { AppDefinitionError } from "./app-definition-error.ts";
import { exportedFunctions, registeredFunctions } from "./app-functions.ts";
import { migrationsOf } from "./app-migrations.ts";
import { permissionsOf } from "./app-permissions.ts";
import { preferencesOf } from "./app-preferences.ts";
import type {
  App,
  AppConfig,
  AppInspection,
  AppParts,
  AppPermissions,
  GrantsOf,
  OperationManifest,
} from "./app-types.ts";
import { deepFreeze, refuser } from "./declaration.ts";
import type { AppPermission } from "./permissions.ts";
import { readSchemaAnswers } from "./schema-answer.ts";
import { schemaManifest } from "./schema-manifest.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

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

const refuse: (message: string) => never = refuser(AppDefinitionError);

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

/** Refuses a config with keys it can't have, or without a name. */
const checkConfig = (config: unknown): void => {
  if (!isPlainObject(config)) {
    refuse("An App's config is an object.");
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
): App<GrantsOf<Permissions>> => {
  checkConfig(config);
  const made: App<GrantsOf<Permissions>> = Object.freeze({ name: config.name });
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
