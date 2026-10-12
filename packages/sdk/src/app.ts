import {
  appMaxOperations,
  operationPathMaxLength,
  operationPathMaxSegments,
  operationSegmentPattern,
} from "@grasp-os/shared/operation-limits";

import { referenceData } from "./references.ts";
import { isBrowserResource, isResource } from "./resources.ts";
import type {
  AnyResource,
  BrowserResource,
  ResourceKind,
} from "./resources.ts";
import { schemaManifest } from "./schema-manifest.ts";
import type {
  AccessMode,
  SchemaAccess,
  SchemaManifest,
} from "./schema-manifest.ts";
import type { AnyTable, SchemaDefinition } from "./schema.ts";
import { functionState, isServerFunction } from "./server.ts";
import type { AnyFunction, FunctionKind, Visibility } from "./server.ts";
import { isPlainObject } from "./value-descriptor.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { descriptorOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// `app`: how an App registers itself (spec 7.1, 7.5): its schema, the
// access its tables need, its public and internal server functions by
// path, how particular functions narrow that access, its screens and the
// resources it needs. Registering grants nothing: every requirement here
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
//   is registered here too: a mutation only the App's queries, an action
//   any of its functions and resources the App lists in its own `uses`;
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
//   segment `preferences` is the platform's, so no function registers
//   under it and declaring preferences later never collides with one.
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
  /**
   * The resources it needs, each by a distinct alias: those its actions
   * use, and those its screens use (files, links).
   */
  readonly uses: readonly (AnyResource | BrowserResource)[];
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
      readonly kind: ResourceKind;
      readonly alias: string;
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

/** A registered App, as data. */
export interface AppManifest {
  readonly name: string;
  /** Its schema's canonical manifest, with its tables' access. */
  readonly schema: SchemaManifest;
  /** Every function, public and internal, by path. */
  readonly operations: Readonly<Record<string, OperationManifest>>;
  /** The resources its actions use, by alias. */
  readonly resources: Readonly<Record<string, AnyResource>>;
  /** The resources its screens use (files, links), by alias. */
  readonly browserResources: Readonly<Record<string, BrowserResource>>;
  /** Its screens, by name, in the order declared. */
  readonly screens: Readonly<Record<string, ScreenManifest>>;
  /** Its preferences' strict object, or null when it declares none. */
  readonly preferences: ValueDescriptor | null;
}

/** What the host runs an App from: its manifest and its handlers by path. */
export interface AppInspection {
  readonly manifest: AppManifest;
  readonly functions: ReadonlyMap<string, AnyFunction>;
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
  "preferences",
  "uses",
]);

/**
 * The top-level path segment the platform keeps for an App's preferences
 * (spec 10.7.7): no function registers under it, whether or not the App
 * declares preferences now.
 */
export const reservedSegment = "preferences";

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
  "uses",
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
    if (prefix.length === 0 && name === reservedSegment) {
      refuse(
        `\`${what}\` can't register \`${reservedSegment}\`: that path is the platform's, for the App's preferences.`
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

/** The App's resources by alias, each declared once, across both kinds. */
const resourcesOf = (
  uses: unknown
): {
  actions: Map<string, AnyResource>;
  browser: Map<string, BrowserResource>;
} => {
  if (!Array.isArray(uses)) {
    return refuse("An App's `uses` lists `resource` declarations.");
  }
  const actions = new Map<string, AnyResource>();
  const browser = new Map<string, BrowserResource>();
  const listed: readonly unknown[] = uses;
  for (const use of listed) {
    if (!isResource(use) && !isBrowserResource(use)) {
      refuse("An App's `uses` lists `resource` declarations only.");
      continue;
    }
    if (actions.has(use.alias) || browser.has(use.alias)) {
      refuse(`Two of the App's resources have alias \`${use.alias}\`.`);
    }
    if (isResource(use)) {
      actions.set(use.alias, use);
    } else {
      browser.set(use.alias, use);
    }
  }
  return { actions, browser };
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
  return descriptor;
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
  resources: ReadonlyMap<string, AnyResource>
): UseManifest[] => {
  const seen = new Set<unknown>();
  return fn.uses.map((use): UseManifest => {
    if (seen.has(use)) {
      refuse(`\`${path}\` lists the same reference twice in \`uses\`.`);
    }
    seen.add(use);
    if (isResource(use)) {
      // Every resource reaches outside the App: a model, a connection,
      // knowledge or a template. Only an action may.
      if (fn.kind !== "action") {
        refuse(
          `\`${path}\` is a ${fn.kind}: only an action uses resources, and queries and mutations never call models, connections, knowledge or templates.`
        );
      }
      if (resources.get(use.alias) !== use) {
        refuse(
          `\`${path}\` uses resource \`${use.alias}\`, which the App's \`uses\` doesn't list.`
        );
      }
      return { type: "resource", kind: use["~resource"], alias: use.alias };
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
  const { actions: resources, browser } = resourcesOf(definition.uses);
  const screens = screensOf(definition.screens);
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
        uses: Object.freeze(usesOf(fn, path, paths, functions, resources)),
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

  const made: App<Tables> = Object.freeze({ name, schema });
  inspections.set(made, {
    manifest: deepFreeze({
      name,
      schema: manifest,
      operations,
      resources: Object.fromEntries(resources),
      browserResources: Object.fromEntries(browser),
      screens,
      preferences,
    }),
    functions,
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
  });
};
