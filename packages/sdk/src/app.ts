import {
  appMaxOperations,
  operationPathMaxLength,
  operationPathMaxSegments,
  operationSegmentPattern,
} from "@grasp-os/shared/operation-limits";

import { isResource } from "./resources.ts";
import type { AnyResource, ResourceKind } from "./resources.ts";
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
//   query writing, an action touching tables at all) is refused here.
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
  /** Its screens (spec 34): kept as declared, checked by their own module. */
  readonly screens: Readonly<Record<string, unknown>>;
  /** The resources its functions use, each by a distinct alias. */
  readonly uses: readonly AnyResource[];
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

/** A registered App, as data. */
export interface AppManifest {
  readonly name: string;
  /** Its schema's canonical manifest, with its tables' access. */
  readonly schema: SchemaManifest;
  /** Every function, public and internal, by path. */
  readonly operations: Readonly<Record<string, OperationManifest>>;
  /** The resources it needs, by alias. */
  readonly resources: Readonly<Record<string, AnyResource>>;
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
  "uses",
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

/** The App's resources by alias, each declared once. */
const resourcesOf = (uses: unknown): Map<string, AnyResource> => {
  if (!Array.isArray(uses)) {
    return refuse("An App's `uses` lists `resource` declarations.");
  }
  const byAlias = new Map<string, AnyResource>();
  for (const use of uses) {
    if (!isResource(use)) {
      refuse("An App's `uses` lists `resource` declarations only.");
      continue;
    }
    if (byAlias.has(use.alias)) {
      refuse(`Two of the App's resources have alias \`${use.alias}\`.`);
    }
    byAlias.set(use.alias, use);
  }
  return byAlias;
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

/** What `fn`, registered at `path`, uses, as data, checked against the App. */
const usesOf = (
  fn: AnyFunction,
  path: string,
  paths: ReadonlyMap<unknown, string>,
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
    const target = paths.get(use);
    if (target === undefined) {
      return refuse(`\`${path}\` uses a function the App doesn't register.`);
    }
    if (fn.kind === "mutation" && use.kind !== "query") {
      refuse(
        `\`${path}\` is a mutation: it may run the App's queries, never \`${target}\`, a ${use.kind}.`
      );
    }
    return { type: "function", path: target, kind: use.kind };
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
  const { name, screens } = definition;
  if (typeof name !== "string" || name.length === 0 || name.length > 100) {
    refuse("An App's `name` is 1 to 100 characters.");
  }
  if (!isPlainObject(screens)) {
    refuse("An App's `screens` is a map of names to screens.");
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
  const resources = resourcesOf(definition.uses);

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
        uses: Object.freeze(usesOf(fn, path, paths, resources)),
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
  inspections.set(
    made,
    Object.freeze({
      manifest: Object.freeze({
        name,
        schema: manifest,
        operations: Object.freeze(operations),
        resources: Object.freeze(Object.fromEntries(resources)),
      }),
      functions,
    })
  );
  return made;
};

/** What the host runs `registered` from; throws for anything `app` didn't make. */
export const inspectApp = (registered: unknown): AppInspection => {
  const inspection =
    typeof registered === "object" && registered !== null
      ? inspections.get(registered)
      : undefined;
  return inspection ?? refuse("That isn't an App `app` registered.");
};
