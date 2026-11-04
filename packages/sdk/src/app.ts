import { canonicalText } from "@grasp-os/shared/json";
import {
  appMaxOperations,
  operationPathMaxLength,
  operationPathMaxSegments,
  operationSegmentPattern,
} from "@grasp-os/shared/operation-limits";

import { assignable } from "./descriptor-assignable.ts";
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
  AppPermission,
  BrainPermission,
  BrowserPermission,
  ConnectionPermission,
  FilesPermission,
  GuestsPermission,
  LinksPermission,
  PermissionKind,
  WorkflowPermission,
} from "./permissions.ts";
import { eventReferenceData, referenceData } from "./references.ts";
import { readSchemaAnswers } from "./schema-answer.ts";
import { schemaManifest } from "./schema-manifest.ts";
import type {
  AccessMode,
  SchemaAccess,
  SchemaManifest,
} from "./schema-manifest.ts";
import type { SchemaAnswer } from "./schema-plan.ts";
import type { AnyTable, SchemaDefinition } from "./schema.ts";
import { functionState, isServerFunction } from "./server.ts";
import type { AnyFunction, FunctionKind, Visibility } from "./server.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";
import { descriptorOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// `app`: how an App registers itself (spec 7.1, 7.5): its schema, the
// access its tables need, its public and internal server functions by
// path, how particular functions narrow that access, its screens and the
// permissions it needs. Registering grants nothing: every requirement here
// becomes usable only once the host authorizes it, and the host
// intersects it with the caller, the App's grants and current revocations
// on every read, commit and call.
//
// The registration is checked whole as it is declared, so one that exists
// is coherent:
// - paths come from the maps' keys (`notes.create` for `{ notes: { create
//   } }`), each a static data property: no getters, nothing computed when
//   it is read;
// - the public tree (`operations`) holds only public functions and the
//   internal tree (`internalOperations`) only internal ones, no path is
//   in both and no function is registered twice;
// - every function was declared for this App's schema, and what it `uses`
//   is registered here too: a mutation only the App's queries and the
//   workflows its `permissions` list, an action any of its functions and
//   any permission the App lists in its own `permissions`;
// - `permissions` lists each kind under its own key, each declaration of
//   that kind, under an alias no other of the App's permissions has;
// - `access.tables` modes default to `none`, and `operationAccess` only
//   narrows them: a path, table or verb that doesn't exist, a verb the
//   App's mode doesn't allow or one a function of its kind can't use (a
//   query writing, an action touching tables at all) is refused here;
// - a function's `uses` may name another by its generated reference
//   (spec 8), resolved here by its path: one whose visibility or kind
//   doesn't match what is registered there is refused, so a stale or
//   forged reference names nothing;
// - screens (spec 8) are a list of named routes, each a screen file and
//   the route input its parameters are validated with, and `preferences`
//   (spec 10.7.7), when declared, is a strict object; the top-level path
//   segments `preferences` and `workflows` are the platform's, so no
//   function registers under them and declaring preferences or workflows
//   later never collides with one;
// - migrations (spec 17.2, migration.ts) are `migration` declarations,
//   each named once, one a table, of a table the schema has, whose
//   `output` declares exactly that table's fields.
//
// What the host runs from is `inspectApp`: the registration as data
// (descriptors, paths, the access each function may use), and the
// handlers by path, which only the runner calls.

/** The verbs a function may use on a table. */
export interface TableVerbs {
  readonly read: boolean;
  readonly insert: boolean;
  readonly update: boolean;
  readonly delete: boolean;
}

const tableVerbs: ReadonlySet<string> = new Set([
  "read",
  "insert",
  "update",
  "delete",
]);

/** How one registered function narrows the App's access to its tables. */
export interface OperationAccess {
  readonly tables: Readonly<Record<string, Partial<TableVerbs>>>;
}

/** A nested map of registered functions: modules of exports, by name. */
export interface OperationTree {
  readonly [name: string]: AnyFunction | OperationTree;
}

/** One of an App's screens: a named route to a screen file. */
export interface ScreenDefinition {
  /** Its name in the generated `screens`: an identifier. */
  readonly name: string;
  /** Its route: `/`, or segments, each a lower-case name or a `:parameter`. */
  readonly path: string;
  /** Its file, `screens/<file>.tsx`. */
  readonly source: string;
  /**
   * What its route input is: an object with a string field for each of
   * the route's parameters. A route without parameters may leave it out,
   * for a strict empty object.
   */
  readonly input?: AnySchema;
}

/** Where the host places a surface (spec 34.1). */
export type SurfaceKind = "sidebar" | "panel" | "settings" | "deepLink";

/**
 * One of an App's surfaces (spec 34.1): a place the host opens one of its
 * screens, with input of its own, which must be assignable to the screen's.
 */
export interface SurfaceDefinition {
  /** Its name, unique in the App: an identifier. */
  readonly name: string;
  readonly kind: SurfaceKind;
  /** The name of the screen it opens. */
  readonly screen: string;
  /** What the host calls it, 1 to 100 characters. */
  readonly title: string;
  /** What it is opened with: a required `v.object`. */
  readonly input: AnySchema;
}

/** What an App registers. */
export interface AppDefinition<
  Tables extends Readonly<Record<string, AnyTable>>,
> {
  /** What people call the App, 1 to 100 characters. */
  readonly name: string;
  readonly schema: SchemaDefinition<Tables>;
  /** The access its tables need; a table or mode left out is `none`. */
  readonly access: SchemaAccess;
  /** Its public functions, by path. */
  readonly operations: OperationTree;
  /** Its internal functions, which only its own server code calls. */
  readonly internalOperations?: OperationTree;
  /** How particular functions narrow `access`, by path. */
  readonly operationAccess?: Readonly<Record<string, OperationAccess>>;
  /** Its screens (spec 8): named routes, each to a screen file. */
  readonly screens: readonly ScreenDefinition[];
  /** Its people's preferences (spec 10.7.7): a strict object, when declared. */
  readonly preferences?: AnySchema;
  /** Where the host places its screens besides their routes (spec 34.1). */
  readonly surfaces?: readonly SurfaceDefinition[];
  /**
   * Everything it can reach outside itself, by kind; none unless listed.
   * Each needs an admin's binding or grant before it serves anything.
   */
  readonly permissions?: AppPermissions;
  /**
   * Its explicit migrations (spec 17.2), each a `migration` declared in
   * `migrations/`: transforms of one of its tables' records to this
   * schema, which only the host runs.
   */
  readonly migrations?: readonly Migration[];
  /**
   * Its answers for the records a change of its schema doesn't fit
   * (schema-plan.ts, `SchemaAnswer`): for one field each, a value, another
   * field's value, a map of the values they hold, or a standard
   * conversion. The store checks every record as the version is made
   * current, and rewrites only those that don't fit.
   */
  readonly answers?: readonly SchemaAnswer[];
}

/**
 * An App's permissions, by kind (permissions.ts): what its actions reach
 * through `ctx`, the workflows its functions start, what its screens may
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
  /** Other Apps' public functions, each under its alias (`ctx.apps.<alias>`). */
  readonly apps?: readonly AppPermission[];
  /**
   * Whether it reads the organization's people (`ctx.people`,
   * `usePeople`): names, emails and teams of every member. Shown to whoever
   * reviews its versions; no admin approves it. Without it, every read is
   * refused. Who calls (`ctx.caller`) needs nothing.
   */
  readonly people?: boolean;
  /** What its screens may do with files. */
  readonly files?: FilesPermission;
  /** Guest chats (`ctx.guests`). */
  readonly guests?: GuestsPermission;
  /** The exact HTTPS origins its screens may link to; no network access. */
  readonly links?: LinksPermission;
}

/** A registered App, as `app` answers it. */
export interface App<Tables extends Readonly<Record<string, AnyTable>>> {
  readonly name: string;
  readonly schema: SchemaDefinition<Tables>;
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
  readonly returns: ValueDescriptor;
  readonly stream: ValueDescriptor | null;
  readonly uses: readonly UseManifest[];
  /**
   * The verbs it may use on each of the schema's tables: the App's access,
   * narrowed by its kind and its `operationAccess`. Every table is listed.
   */
  readonly tables: Readonly<Record<string, TableVerbs>>;
}

/** One screen, as data. */
export interface ScreenManifest {
  readonly name: string;
  readonly path: string;
  readonly source: string;
  /** The strict object its route input is validated with. */
  readonly input: ValueDescriptor;
}

/** One surface, as data. */
export interface SurfaceManifest {
  readonly name: string;
  readonly kind: SurfaceKind;
  readonly screen: string;
  readonly title: string;
  /** The strict object its input is validated with. */
  readonly input: ValueDescriptor;
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
  /** The permissions its screens use (files, links), by alias. */
  readonly browserResources: Readonly<Record<string, BrowserPermission>>;
  /** The workflows its functions start, by alias. */
  readonly workflows: Readonly<Record<string, WorkflowPermission>>;
  /** Its screens, by name, in the order declared. */
  readonly screens: Readonly<Record<string, ScreenManifest>>;
  /** Its surfaces, by name, in the order declared. */
  readonly surfaces: Readonly<Record<string, SurfaceManifest>>;
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

/** Every App `app` registered, with its inspection. */
const inspections = new WeakMap<object, AppInspection>();

const appKeys: ReadonlySet<string> = new Set([
  "name",
  "schema",
  "access",
  "operations",
  "internalOperations",
  "operationAccess",
  "screens",
  "surfaces",
  "preferences",
  "permissions",
  "migrations",
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
 * Path segments no function registers at, at any depth: the names a
 * reference answers as data (`contractId`, `visibility`, `kind`), which a
 * reference tree can't also hold as children, and `then`, which would
 * make a reference look like a promise to whatever awaits it.
 */
export const referenceKeys: ReadonlySet<string> = new Set([
  "contractId",
  "visibility",
  "kind",
  "then",
]);

const requiredKeys = [
  "name",
  "schema",
  "access",
  "operations",
  "screens",
] as const;

/**
 * The functions of `tree`, by path, read only from static data properties
 * of plain objects (module namespaces included): never a getter, which
 * could answer something else each time it is read.
 */
const walk = (
  tree: unknown,
  prefix: readonly string[],
  found: Map<string, unknown>,
  what: string
): void => {
  if (!isPlainObject(tree)) {
    refuse(`\`${what}\` is a map of module exports.`);
    return;
  }
  for (const name of Object.keys(tree)) {
    const segments = [...prefix, name];
    const path = segments.join(".");
    if (
      !operationSegmentPattern.test(name) ||
      segments.length > operationPathMaxSegments ||
      path.length > operationPathMaxLength
    ) {
      refuse(
        `\`${what}\` has a path that isn't up to ${operationPathMaxSegments} identifiers: ${operationSegmentPattern.test(name) ? `\`${path}\`` : "a key that isn't an identifier"}.`
      );
    }
    if (referenceKeys.has(name)) {
      refuse(
        `\`${path}\` can't be registered: \`${name}\` is a name a reference itself answers, never a path segment.`
      );
    }
    const reservedFor =
      prefix.length === 0 ? reservedSegments.get(name) : undefined;
    if (reservedFor !== undefined) {
      refuse(
        `\`${what}\` can't register \`${name}\`: that path is the platform's, for ${reservedFor}.`
      );
    }
    const property = Object.getOwnPropertyDescriptor(tree, name);
    if (property === undefined || !("value" in property)) {
      refuse(`\`${path}\` is a getter; register a module export.`);
      return;
    }
    const value: unknown = property.value;
    if (isServerFunction(value)) {
      found.set(path, value);
    } else if (isPlainObject(value)) {
      walk(value, segments, found, what);
    } else {
      refuse(
        `\`${path}\` isn't a server function or a module of them; export helpers from another module.`
      );
    }
    if (found.size > appMaxOperations) {
      refuse(`An App registers at most ${appMaxOperations} functions.`);
    }
  }
};

/** The keys of an App's `permissions`, and what each holds. */
const permissionKeys: ReadonlyMap<string, string> = new Map([
  ["ai", "one `permission.ai`"],
  ["connections", "a list of `permission.connection`"],
  ["brain", "one `permission.brain`"],
  ["workflows", "a list of `permission.workflow`"],
  ["apps", "a list of `permission.app` or `permission.grasp`"],
  ["people", "`true` when it reads the organization's people"],
  ["files", "one `permission.files`"],
  ["guests", "one `permission.guests`"],
  ["links", "one `permission.links`"],
]);

/** The keys of an App's `permissions` that hold a list. */
const listedKeys: ReadonlySet<string> = new Set([
  "connections",
  "workflows",
  "apps",
]);

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
 * Refuses a fixed alias held by another kind: no connection, App or
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

/** A screen's or a route parameter's name: an identifier. */
const screenNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** A screen's file: `screens/<file>.tsx`. */
const screenSourcePattern = /^screens\/[\w-]{1,64}\.tsx$/u;

/** One literal segment of a route: lower-case letters, digits and dashes. */
const routeSegmentPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** One parameter of a route, `:name`. */
const routeParameterPattern = /^:(?<name>[A-Za-z][A-Za-z0-9_]{0,63})$/u;

/** The most screens an App declares, and the longest route. */
export const screenLimits = { screens: 64, pathLength: 200, segments: 16 };

/** The descriptor kinds a route parameter's field may be: strings. */
const parameterKinds: ReadonlySet<string> = new Set(["string", "id", "enum"]);

/** A strict empty object, the input of a route without parameters. */
const emptyInput: ValueDescriptor = Object.freeze({
  descriptorVersion: 1,
  kind: "object",
  presence: "required",
  nullable: false,
  fields: Object.freeze({}),
});

/** The parameters of route `path`, checked: refuses a route that isn't one. */
const routeParameters = (path: unknown, name: string): string[] => {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.length > screenLimits.pathLength
  ) {
    return refuse(
      `Screen \`${name}\`'s \`path\` is a route starting with \`/\`, at most ${screenLimits.pathLength} characters.`
    );
  }
  if (path === "/") {
    return [];
  }
  const segments = path.slice(1).split("/");
  if (segments.length > screenLimits.segments) {
    return refuse(
      `Screen \`${name}\`'s route has more than ${screenLimits.segments} segments.`
    );
  }
  const parameters: string[] = [];
  for (const segment of segments) {
    const parameter = routeParameterPattern.exec(segment)?.groups?.name;
    if (parameter !== undefined) {
      if (parameters.includes(parameter)) {
        refuse(`Screen \`${name}\`'s route names \`:${parameter}\` twice.`);
      }
      parameters.push(parameter);
    } else if (!routeSegmentPattern.test(segment)) {
      refuse(
        `Screen \`${name}\`'s route has a segment that is neither a lower-case name nor a \`:parameter\`.`
      );
    }
  }
  return parameters;
};

/** The input descriptor of a screen whose route has `parameters`. */
const screenInput = (
  input: unknown,
  parameters: readonly string[],
  name: string
): ValueDescriptor => {
  if (input === undefined) {
    if (parameters.length > 0) {
      refuse(
        `Screen \`${name}\`'s route has parameters: declare its \`input\`, with a field for each.`
      );
    }
    return emptyInput;
  }
  // Throws for anything but a `v` schema.
  const descriptor = descriptorOf(input);
  if (
    descriptor.kind !== "object" ||
    descriptor.nullable ||
    descriptor.presence !== "required"
  ) {
    return refuse(`Screen \`${name}\`'s \`input\` is a required \`v.object\`.`);
  }
  for (const parameter of parameters) {
    const field = Object.hasOwn(descriptor.fields, parameter)
      ? descriptor.fields[parameter]
      : undefined;
    if (
      field === undefined ||
      !parameterKinds.has(field.kind) ||
      field.nullable ||
      field.presence !== "required"
    ) {
      refuse(
        `Screen \`${name}\`'s \`input\` has no required string, ID or enum field \`${parameter}\` for its route parameter.`
      );
    }
  }
  return descriptor;
};

/** The App's screens, by name, in the order declared, each checked. */
const screensOf = (screens: unknown): Record<string, ScreenManifest> => {
  if (!Array.isArray(screens) || screens.length > screenLimits.screens) {
    return refuse(
      `An App's \`screens\` is a list of at most ${screenLimits.screens} routes.`
    );
  }
  const declared: readonly unknown[] = screens;
  const byName: Record<string, ScreenManifest> = {};
  const paths = new Set<string>();
  for (const screen of declared) {
    if (
      !isPlainObject(screen) ||
      !Object.keys(screen).every((key) =>
        ["name", "path", "source", "input"].includes(key)
      )
    ) {
      refuse("A screen is `{ name, path, source, input? }`.");
      continue;
    }
    const { name, path, source, input } = screen;
    if (typeof name !== "string" || !screenNamePattern.test(name)) {
      refuse("A screen's `name` is an identifier, at most 64 characters.");
      continue;
    }
    if (Object.hasOwn(byName, name)) {
      refuse(`Two screens are named \`${name}\`.`);
    }
    const parameters = routeParameters(path, name);
    // Parameter names don't make two routes different: `/notes/:id` and
    // `/notes/:noteId` are the same route.
    const route = String(path).replaceAll(/:[A-Za-z0-9_]+/gu, ":");
    if (paths.has(route)) {
      refuse(`Two screens have route \`${String(path)}\`.`);
    }
    paths.add(route);
    if (typeof source !== "string" || !screenSourcePattern.test(source)) {
      refuse(`Screen \`${name}\`'s \`source\` is \`screens/<file>.tsx\`.`);
    }
    Object.defineProperty(byName, name, {
      enumerable: true,
      value: {
        name,
        path: String(path),
        source: String(source),
        input: screenInput(input, parameters, name),
      },
    });
  }
  return byName;
};

/** The kinds a surface may be, until file and mention surfaces come. */
const surfaceKinds: ReadonlySet<unknown> = new Set<SurfaceKind>([
  "sidebar",
  "panel",
  "settings",
  "deepLink",
]);

/** The kinds the host opens with nothing: their input takes `{}`. */
const openedEmpty: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>([
  "sidebar",
  "settings",
]);

/** The most surfaces an App declares. */
export const surfaceLimits = { surfaces: 32, titleLength: 100 };

/** One surface's input: a required strict object its screen takes. */
const surfaceInput = (
  input: unknown,
  kind: SurfaceKind,
  screen: ScreenManifest,
  name: string
): ValueDescriptor => {
  if (input === undefined) {
    return refuse(
      `Surface \`${name}\` declares its \`input\`, a \`v.object\`.`
    );
  }
  // Throws for anything but a `v` schema.
  const descriptor = descriptorOf(input);
  if (
    descriptor.kind !== "object" ||
    descriptor.nullable ||
    descriptor.presence !== "required"
  ) {
    return refuse(
      `Surface \`${name}\`'s \`input\` is a required \`v.object\`.`
    );
  }
  if (!assignable(descriptor, screen.input)) {
    return refuse(
      `Surface \`${name}\`'s \`input\` isn't one screen \`${screen.name}\` takes.`
    );
  }
  if (openedEmpty.has(kind) && !("value" in validateValue(descriptor, {}))) {
    return refuse(
      `Surface \`${name}\` is a ${kind}, which opens with nothing: its \`input\` takes \`{}\`.`
    );
  }
  return descriptor;
};

/** The App's surfaces, by name, in the order declared, each checked. */
const surfacesOf = (
  surfaces: unknown,
  screens: Readonly<Record<string, ScreenManifest>>
): Record<string, SurfaceManifest> => {
  if (surfaces === undefined) {
    return {};
  }
  if (!Array.isArray(surfaces) || surfaces.length > surfaceLimits.surfaces) {
    return refuse(
      `An App's \`surfaces\` is a list of at most ${surfaceLimits.surfaces}.`
    );
  }
  const declared: readonly unknown[] = surfaces;
  const byName: Record<string, SurfaceManifest> = {};
  let settings = 0;
  for (const surface of declared) {
    if (
      !isPlainObject(surface) ||
      !Object.keys(surface).every((key) =>
        ["name", "kind", "screen", "title", "input"].includes(key)
      )
    ) {
      refuse("A surface is `{ name, kind, screen, title, input }`.");
      continue;
    }
    const { name, kind, screen, title, input } = surface;
    if (typeof name !== "string" || !screenNamePattern.test(name)) {
      refuse("A surface's `name` is an identifier, at most 64 characters.");
      continue;
    }
    if (Object.hasOwn(byName, name)) {
      refuse(`Two surfaces are named \`${name}\`.`);
    }
    if (!surfaceKinds.has(kind)) {
      refuse(
        `Surface \`${name}\`'s \`kind\` is \`sidebar\`, \`panel\`, \`settings\` or \`deepLink\`.`
      );
      continue;
    }
    // SAFETY: checked against the kinds just above.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const surfaceKind = kind as SurfaceKind;
    if (surfaceKind === "settings") {
      settings += 1;
      if (settings > 1) {
        refuse("An App declares at most one `settings` surface.");
      }
    }
    if (
      typeof title !== "string" ||
      title.trim().length === 0 ||
      title.length > surfaceLimits.titleLength
    ) {
      refuse(
        `Surface \`${name}\`'s \`title\` is 1 to ${surfaceLimits.titleLength} characters.`
      );
    }
    const target =
      typeof screen === "string" && Object.hasOwn(screens, screen)
        ? screens[screen]
        : undefined;
    if (target === undefined) {
      refuse(`Surface \`${name}\` opens a screen the App doesn't declare.`);
      continue;
    }
    Object.defineProperty(byName, name, {
      enumerable: true,
      value: {
        name,
        kind: surfaceKind,
        screen: target.name,
        title: String(title),
        input: surfaceInput(input, surfaceKind, target, name),
      },
    });
  }
  return byName;
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
 * The verbs of each table for function `path` of `kind`: its base verbs,
 * narrowed by `override` when it has one, in which a table or verb left
 * out is denied. A verb the override sets that the base doesn't allow is
 * a widening, and refused.
 */
const verbsOf = (
  schema: SchemaManifest,
  path: string,
  kind: FunctionKind,
  override: unknown
): Record<string, TableVerbs> => {
  const verbs: Record<string, TableVerbs> = {};
  let byTable: Record<string, unknown> | undefined;
  if (override !== undefined) {
    if (kind === "action") {
      refuse(
        `\`operationAccess\` can't name action \`${path}\`: an action has no tables to narrow.`
      );
    }
    const tables = isPlainObject(override) ? override.tables : undefined;
    if (
      !isPlainObject(override) ||
      !Object.keys(override).every((key) => key === "tables") ||
      !isPlainObject(tables)
    ) {
      return refuse(
        `\`operationAccess.${path}\` is \`{ tables }\`, a map of table names to verbs.`
      );
    }
    byTable = tables;
    for (const table of Object.keys(tables)) {
      if (!Object.hasOwn(schema.tables, table)) {
        refuse(
          `\`operationAccess.${path}\` names a table the schema doesn't have.`
        );
      }
    }
  }
  for (const [table, { access }] of Object.entries(schema.tables)) {
    const base = baseVerbs(kind, access.read, access.write);
    if (byTable === undefined) {
      verbs[table] = base;
      continue;
    }
    const declared = Object.hasOwn(byTable, table) ? byTable[table] : {};
    if (!isPlainObject(declared)) {
      refuse(
        `\`operationAccess.${path}.tables.${table}\` is a map of verbs to booleans.`
      );
      continue;
    }
    for (const [verb, value] of Object.entries(declared)) {
      if (!tableVerbs.has(verb)) {
        refuse(
          `\`operationAccess.${path}.tables.${table}\` has no verb \`${verb}\`; the verbs are read, insert, update and delete.`
        );
      }
      if (typeof value !== "boolean") {
        refuse(
          `\`operationAccess.${path}.tables.${table}.${verb}\` is a boolean.`
        );
      }
    }
    const narrowed = (verb: keyof TableVerbs): boolean => {
      const wanted = declared[verb] === true;
      if (wanted && !base[verb]) {
        refuse(
          `\`operationAccess.${path}.tables.${table}.${verb}\` widens access: ${kind === "query" && verb !== "read" ? "a query only reads" : `the App's \`${verb === "read" ? "read" : "write"}\` access to \`${table}\` is \`none\``}.`
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
  const reference = referenceData(use);
  const target =
    reference === undefined ? undefined : functions.get(reference.path);
  if (reference === undefined || target === undefined) {
    return refuse(`\`${path}\` uses a function the App doesn't register.`);
  }
  if (
    target.visibility !== reference.visibility ||
    (reference.kind !== undefined && target.kind !== reference.kind)
  ) {
    return refuse(
      `\`${path}\` uses a reference to \`${reference.path}\` that doesn't match what is registered there: regenerate the App's references.`
    );
  }
  return { target: reference.path, kind: target.kind };
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

/** Refuses a registration with keys it can't have or without those it must. */
const checkRegistration = (definition: unknown): void => {
  if (!isPlainObject(definition)) {
    refuse("An App is registered with an object.");
    return;
  }
  for (const key of Object.keys(definition)) {
    if (!appKeys.has(key)) {
      refuse(`An App's registration has no \`${key}\`.`);
    }
  }
  for (const key of requiredKeys) {
    if (definition[key] === undefined) {
      refuse(`An App's registration declares \`${key}\`.`);
    }
  }
  const { name } = definition;
  if (typeof name !== "string" || name.length === 0 || name.length > 100) {
    refuse("An App's `name` is 1 to 100 characters.");
  }
};

/**
 * The functions found in the public and internal trees, by path, and the
 * path of each: every one in the tree of its visibility, declared for
 * `schema`, at one path only.
 */
const registeredFunctions = (
  schema: unknown,
  publicFound: ReadonlyMap<string, unknown>,
  internalFound: ReadonlyMap<string, unknown>
): {
  functions: Map<string, AnyFunction>;
  paths: Map<unknown, string>;
} => {
  const functions = new Map<string, AnyFunction>();
  const paths = new Map<unknown, string>();
  const register = (
    found: ReadonlyMap<string, unknown>,
    visibility: Visibility
  ) => {
    for (const [path, value] of found) {
      if (!isServerFunction(value)) {
        continue;
      }
      if (value.visibility !== visibility) {
        refuse(
          visibility === "public"
            ? `\`${path}\` is internal: register it under \`internalOperations\`.`
            : `\`${path}\` is public: register it under \`operations\`.`
        );
      }
      if (functions.has(path)) {
        refuse(`\`${path}\` is registered as public and as internal.`);
      }
      const known = paths.get(value);
      if (known !== undefined) {
        refuse(
          `One function is registered twice, at \`${known}\` and \`${path}\`.`
        );
      }
      if (functionState(value).schema !== schema) {
        refuse(`\`${path}\` was declared for another schema than the App's.`);
      }
      functions.set(path, value);
      paths.set(value, path);
    }
  };
  register(publicFound, "public");
  register(internalFound, "internal");
  return { functions, paths };
};

/**
 * Registers an App, checked whole (see the header): throws
 * `AppDefinitionError` (or the schema's own error, for `access`) for a
 * registration that isn't coherent.
 */
export const app = <const Tables extends Readonly<Record<string, AnyTable>>>(
  definition: AppDefinition<Tables>
): App<Tables> => {
  checkRegistration(definition);
  const { name, schema, access } = definition;
  // Throws for a schema `defineSchema` didn't make, and for access that
  // names a table the schema hasn't or a mode that doesn't exist.
  const manifest = schemaManifest(schema, access);
  const {
    actions: resources,
    browser,
    workflows,
    people,
  } = permissionsOf(definition.permissions);
  const screens = screensOf(definition.screens);
  const surfaces = surfacesOf(definition.surfaces, screens);
  const preferences = preferencesOf(definition.preferences);

  const publicFound = new Map<string, unknown>();
  const internalFound = new Map<string, unknown>();
  walk(definition.operations, [], publicFound, "operations");
  walk(
    definition.internalOperations ?? {},
    [],
    internalFound,
    "internalOperations"
  );
  if (publicFound.size + internalFound.size > appMaxOperations) {
    refuse(`An App registers at most ${appMaxOperations} functions.`);
  }
  const { functions, paths } = registeredFunctions(
    schema,
    publicFound,
    internalFound
  );

  const overrides = definition.operationAccess ?? {};
  if (!isPlainObject(overrides)) {
    refuse("`operationAccess` is a map of registered paths to their access.");
  }
  for (const path of Object.keys(overrides)) {
    if (!functions.has(path)) {
      refuse(`\`operationAccess\` names \`${path}\`, which isn't registered.`);
    }
  }

  const operations: Record<string, OperationManifest> = {};
  for (const [path, fn] of functions) {
    Object.defineProperty(operations, path, {
      enumerable: true,
      value: Object.freeze({
        path,
        kind: fn.kind,
        visibility: fn.visibility,
        args: fn.args.descriptor,
        returns: fn.returns.descriptor,
        stream: fn.stream === null ? null : fn.stream.descriptor,
        uses: Object.freeze(
          usesOf(fn, path, paths, functions, resources, workflows)
        ),
        tables: Object.freeze(
          verbsOf(
            manifest,
            path,
            fn.kind,
            Object.hasOwn(overrides, path) ? overrides[path] : undefined
          )
        ),
      }),
    });
  }

  const { manifests: migrations, byName: migrationsByName } = migrationsOf(
    definition.migrations,
    manifest
  );

  const answers = readSchemaAnswers(definition.answers, manifest, refuse);

  const made: App<Tables> = Object.freeze({ name, schema });
  inspections.set(made, {
    manifest: deepFreeze({
      name,
      schema: manifest,
      operations,
      resources: Object.fromEntries(resources),
      browserResources: Object.fromEntries(browser),
      workflows: Object.fromEntries(workflows),
      screens,
      surfaces,
      preferences,
      ...(people ? { people: true } : {}),
      migrations,
      ...(answers.length > 0 ? { answers } : {}),
    }),
    functions,
    migrations: migrationsByName,
  });
  return made;
};

/**
 * What the host runs `registered` from; throws for anything `app` didn't
 * make. The manifest is frozen all the way down, and the handlers are a
 * copy each time, so nothing a caller does to them changes the App.
 */
export const inspectApp = (registered: unknown): AppInspection => {
  const inspection =
    typeof registered === "object" && registered !== null
      ? inspections.get(registered)
      : undefined;
  if (inspection === undefined) {
    return refuse("That isn't an App `app` registered.");
  }
  return Object.freeze({
    manifest: inspection.manifest,
    functions: new Map(inspection.functions),
    migrations: new Map(inspection.migrations),
  });
};
