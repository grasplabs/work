import { appManifestMaxBytes } from "@grasp-os/shared/app-limits";
import { canonicalText } from "@grasp-os/shared/json";
import { appMaxOperations } from "@grasp-os/shared/operation-limits";

import { app, AppDefinitionError, inspectApp } from "./app.ts";
import type {
  AppManifest,
  OperationAccess,
  ScreenDefinition,
  SurfaceDefinition,
  TableVerbs,
} from "./app.ts";
import { migration } from "./migration.ts";
import type { Migration } from "./migration.ts";
import {
  isBrowserResource,
  isResource,
  isWorkflowResource,
  readResourceDeclaration,
} from "./resources.ts";
import type { AnyResource, WorkflowResource } from "./resources.ts";
import { readSchemaManifest } from "./schema-manifest.ts";
import type { TableAccess } from "./schema-manifest.ts";
import { serverModule } from "./server.ts";
import type { FunctionKind, Visibility } from "./server.ts";
import { isPlainObject } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// Reading an App's manifest of unknown origin: what inspecting its code
// in a sandbox answered (spec 8), or what a sealed release stored. The
// text is hostile, as anything App code produced is: the sandbox that
// made it ran the App's code, which can make the SDK in there answer
// whatever it likes.
//
// So it isn't checked against a second list of rules. It is declared
// again, through the same constructors App code uses: its schema through
// `readSchemaManifest`, each function through `serverModule(schema)` with
// schemas rebuilt from its descriptors and a handler that runs nothing,
// each resource through `resource`, each migration through `migration`
// (its handler running nothing too), and the App through `app`. What that
// registration's inspection makes must then be exactly the manifest read,
// canonically: anything a declaration couldn't have made (a widened verb,
// a use of something unregistered, a public function in the internal
// tree, a key no declaration has, a descriptor out of bounds) is refused.
// There is no other path from text to an `AppManifest`.

const refuse = (message: string): never => {
  throw new AppDefinitionError(message);
};

const encoder = new TextEncoder();

/** Whether `text` is more than `max` bytes as UTF-8. */
const isOverBytes = (text: string, max: number): boolean =>
  text.length > max ||
  (text.length * 3 > max && encoder.encode(text).byteLength > max);

/** Whether `value` is a plain object with exactly the keys `keys`. */
const hasExactly = (
  value: unknown,
  keys: readonly string[]
): value is Record<string, unknown> =>
  isPlainObject(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** The entries of map `value`, refused when it isn't one. */
const entriesOf = (value: unknown, what: string): [string, unknown][] => {
  if (!isPlainObject(value)) {
    return refuse(`The manifest's ${what} is a map.`);
  }
  return Object.entries(value);
};

/** The constructor name for a kind and visibility, e.g. `internalQuery`. */
const constructorOf = {
  public: { query: "query", mutation: "mutation", action: "action" },
  internal: {
    query: "internalQuery",
    mutation: "internalMutation",
    action: "internalAction",
  },
} as const;

const kinds: ReadonlySet<unknown> = new Set(["query", "mutation", "action"]);
const visibilities: ReadonlySet<unknown> = new Set(["public", "internal"]);

/** A function as the manifest describes it, before it is declared again. */
interface ReadFunction {
  readonly path: string;
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
  readonly declaration: Record<string, unknown>;
  readonly tables: unknown;
}

/** A handler that runs nothing: the host never runs a read manifest. */
const inert = (): never => {
  throw new Error("A manifest read back runs nothing.");
};

/** The schema a descriptor of unknown origin describes. */
const schemaFrom = (descriptor: unknown): AnySchema =>
  schemaOf(readDescriptor(descriptor, 1, { nodes: 0 }));

/** The `args` shape of an arguments descriptor: its fields, as schemas. */
const shapeFrom = (
  descriptor: unknown,
  path: string
): Record<string, AnySchema> => {
  const read = readDescriptor(descriptor, 1, { nodes: 0 });
  if (read.kind !== "object") {
    return refuse(`\`${path}\`'s arguments are an object.`);
  }
  const shape: Record<string, AnySchema> = {};
  for (const [name, field] of Object.entries(read.fields)) {
    Object.defineProperty(shape, name, {
      enumerable: true,
      value: schemaOf(field),
    });
  }
  return shape;
};

/** One entry of a function's `uses`, as what a declaration would list. */
const useFrom = (
  use: unknown,
  path: string,
  operations: Readonly<Record<string, unknown>>,
  resources: ReadonlyMap<string, AnyResource>,
  workflows: ReadonlyMap<string, WorkflowResource>
): unknown => {
  if (hasExactly(use, ["type", "path", "kind"]) && use.type === "function") {
    const target =
      typeof use.path === "string" && Object.hasOwn(operations, use.path)
        ? operations[use.path]
        : undefined;
    const visibility = isPlainObject(target) ? target.visibility : undefined;
    // A reference by its path, which `app` resolves against what is
    // registered there, as it does a generated one.
    return { contractId: use.path, visibility, kind: use.kind };
  }
  if (hasExactly(use, ["type", "kind", "alias"]) && use.type === "resource") {
    const declared =
      typeof use.alias === "string" ? resources.get(use.alias) : undefined;
    if (declared === undefined || declared["~resource"] !== use.kind) {
      return refuse(`\`${path}\` uses a resource the App doesn't declare.`);
    }
    return declared;
  }
  if (hasExactly(use, ["type", "alias"]) && use.type === "workflow") {
    const declared =
      typeof use.alias === "string" ? workflows.get(use.alias) : undefined;
    if (declared === undefined) {
      return refuse(`\`${path}\` starts a workflow the App doesn't declare.`);
    }
    return declared;
  }
  return refuse(`\`${path}\`'s \`uses\` holds an entry no declaration makes.`);
};

/** A function of the manifest, read far enough to declare it again. */
const functionFrom = (
  path: string,
  input: unknown,
  operations: Readonly<Record<string, unknown>>,
  resources: ReadonlyMap<string, AnyResource>,
  workflows: ReadonlyMap<string, WorkflowResource>
): ReadFunction => {
  if (
    !hasExactly(input, [
      "path",
      "kind",
      "visibility",
      "args",
      "returns",
      "stream",
      "uses",
      "tables",
    ])
  ) {
    return refuse(`\`${path}\` isn't a function as a manifest holds one.`);
  }
  const { kind, visibility, uses, stream } = input;
  if (
    input.path !== path ||
    !kinds.has(kind) ||
    !visibilities.has(visibility)
  ) {
    return refuse(`\`${path}\`'s path, kind or visibility isn't one there is.`);
  }
  if (!Array.isArray(uses)) {
    return refuse(`\`${path}\`'s \`uses\` is a list.`);
  }
  const listed: readonly unknown[] = uses;
  const declaration: Record<string, unknown> = {
    args: shapeFrom(input.args, path),
    returns: schemaFrom(input.returns),
    handler: inert,
  };
  // Only what the kind's declaration has: a query's has no `uses`, and
  // only an action's has `stream`. Anything else is the constructor's to
  // refuse, as it would in code.
  if (kind !== "query" || listed.length > 0) {
    declaration.uses = listed.map((use) =>
      useFrom(use, path, operations, resources, workflows)
    );
  }
  if (stream !== null) {
    declaration.stream = schemaFrom(stream);
  }
  // SAFETY: each was checked against its set just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const read = { kind, visibility } as {
    kind: FunctionKind;
    visibility: Visibility;
  };
  return { path, ...read, declaration, tables: input.tables };
};

/** `value` placed at dotted `path` in `tree`, refusing a path that clashes. */
const place = (
  tree: Record<string, unknown>,
  path: string,
  value: unknown
): void => {
  const segments = path.split(".");
  let node = tree;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const existing = Object.hasOwn(node, segment) ? node[segment] : undefined;
    if (last) {
      if (existing !== undefined) {
        refuse(`\`${path}\` clashes with another registered path.`);
      }
      Object.defineProperty(node, segment, { enumerable: true, value });
      return;
    }
    if (existing === undefined) {
      const child: Record<string, unknown> = {};
      Object.defineProperty(node, segment, {
        enumerable: true,
        value: child,
      });
      node = child;
    } else if (isPlainObject(existing)) {
      node = existing;
    } else {
      refuse(`\`${path}\` clashes with another registered path.`);
    }
  }
};

/** The screens of the manifest, as a declaration lists them. */
const screensFrom = (input: unknown): ScreenDefinition[] =>
  entriesOf(input, "screens").map(([name, screen]) => {
    if (!hasExactly(screen, ["name", "path", "source", "input"])) {
      return refuse(
        `Screen \`${name}\` isn't a screen as a manifest holds one.`
      );
    }
    if (screen.name !== name) {
      return refuse(`Screen \`${name}\` is filed under another name.`);
    }
    // SAFETY: `app` checks each part as it checks a declaration's.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return {
      name,
      path: screen.path,
      source: screen.source,
      input: schemaFrom(screen.input),
    } as ScreenDefinition;
  });

/** The surfaces of the manifest, as a declaration lists them. */
const surfacesFrom = (input: unknown): SurfaceDefinition[] =>
  entriesOf(input, "surfaces").map(([name, surface]) => {
    if (!hasExactly(surface, ["name", "kind", "screen", "title", "input"])) {
      return refuse(
        `Surface \`${name}\` isn't a surface as a manifest holds one.`
      );
    }
    if (surface.name !== name) {
      return refuse(`Surface \`${name}\` is filed under another name.`);
    }
    // SAFETY: `app` checks each part as it checks a declaration's.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return {
      name,
      kind: surface.kind,
      screen: surface.screen,
      title: surface.title,
      input: schemaFrom(surface.input),
    } as SurfaceDefinition;
  });

/**
 * A manifest's fixtures as a declaration lists them: `expect` left out
 * where the manifest records null. Anything else is passed on as it is,
 * for `migration` to refuse.
 */
const fixturesFrom = (fixtures: unknown): unknown =>
  Array.isArray(fixtures)
    ? fixtures.map((fixture: unknown) =>
        isPlainObject(fixture) &&
        hasExactly(fixture, ["row", "expect"]) &&
        fixture.expect === null
          ? { row: fixture.row }
          : fixture
      )
    : fixtures;

/** The migrations of the manifest, declared again, in the order filed. */
const migrationsFrom = (input: unknown): Migration[] =>
  entriesOf(input, "migrations").map(([name, declared]) => {
    if (
      !hasExactly(declared, [
        "name",
        "table",
        "fromSchema",
        "toSchema",
        "input",
        "output",
        "fixtures",
      ])
    ) {
      return refuse(
        `Migration \`${name}\` isn't a migration as a manifest holds one.`
      );
    }
    if (declared.name !== name) {
      return refuse(`Migration \`${name}\` is filed under another name.`);
    }
    // SAFETY: `migration` checks each part as it checks a declaration's,
    // and `app` checks it against the schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return migration({
      name,
      table: declared.table,
      fromSchema: declared.fromSchema,
      toSchema: declared.toSchema,
      ...(declared.input === null ? {} : { input: schemaFrom(declared.input) }),
      output: schemaFrom(declared.output),
      fixtures: fixturesFrom(declared.fixtures),
      handler: inert,
    } as Parameters<typeof migration>[0]);
  });

/**
 * The declarations map `input` (the manifest's `what`) files, each read
 * back through `resource`: of the kind `is` accepts (`kind`, as a refusal
 * names it) and filed under its own alias, or refused.
 */
const declaredFrom = <Declaration extends { readonly alias: string }>(
  input: unknown,
  what: string,
  is: (value: unknown) => value is Declaration,
  kind: string
): Map<string, Declaration> => {
  const declarations = new Map<string, Declaration>();
  for (const [alias, entry] of entriesOf(input, what)) {
    const declared = readResourceDeclaration(entry);
    if (!is(declared) || declared.alias !== alias) {
      refuse(`Resource \`${alias}\` isn't ${kind} filed under its alias.`);
    } else {
      declarations.set(alias, declared);
    }
  }
  return declarations;
};

/** Whether two verb maps grant the same verbs on every table. */
const sameVerbs = (
  one: Readonly<Record<string, TableVerbs>>,
  other: unknown
): boolean => canonicalText(one) === canonicalText(other);

/**
 * The App the manifest in `text` describes, declared again, and its
 * manifest made again from that declaration (see the header). Throws an
 * SDK definition error (`AppDefinitionError`, or the schema's, a value's
 * or a resource's own) for text that isn't JSON, is too large, or isn't
 * exactly what some declaration makes.
 */
export const readAppManifest = (text: string): AppManifest => {
  if (typeof text !== "string") {
    return refuse("An App's manifest is read from its JSON text.");
  }
  if (isOverBytes(text, appManifestMaxBytes)) {
    return refuse(`An App's manifest is at most ${appManifestMaxBytes} bytes.`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return refuse("The App's manifest isn't JSON.");
  }
  if (
    !hasExactly(data, [
      "name",
      "schema",
      "operations",
      "resources",
      "browserResources",
      "workflows",
      "screens",
      "surfaces",
      "preferences",
      "migrations",
    ])
  ) {
    return refuse(
      "An App's manifest is `{ name, schema, operations, resources, browserResources, workflows, screens, surfaces, preferences, migrations }`."
    );
  }
  const { schema, manifest: schemaManifest } = readSchemaManifest(
    JSON.stringify(data.schema)
  );

  const resources = declaredFrom(
    data.resources,
    "resources",
    isResource,
    "an action's resource"
  );
  const browser = declaredFrom(
    data.browserResources,
    "browser resources",
    isBrowserResource,
    "a screens' resource"
  );
  const workflows = declaredFrom(
    data.workflows,
    "workflows",
    isWorkflowResource,
    "a workflow"
  );

  const operationEntries = entriesOf(data.operations, "operations");
  // Counted before any is read.
  if (operationEntries.length > appMaxOperations) {
    refuse(`An App registers at most ${appMaxOperations} functions.`);
  }
  const operationData = Object.fromEntries(operationEntries);
  const functions = operationEntries.map(([path, input]) =>
    functionFrom(path, input, operationData, resources, workflows)
  );
  // Each constructor checks the declaration it is given at run time, as
  // it checks one in code; its types describe declarations in code, so it
  // is called as what it is at run time.
  const server: object = serverModule(schema);

  /** The registration, with `overrides` narrowing access by path. */
  const declare = (
    overrides: Readonly<Record<string, OperationAccess>>
  ): AppManifest => {
    const operations: Record<string, unknown> = {};
    const internalOperations: Record<string, unknown> = {};
    for (const { path, kind, visibility, declaration } of functions) {
      const construct: unknown = Reflect.get(
        server,
        constructorOf[visibility][kind]
      );
      if (typeof construct !== "function") {
        return refuse(`\`${path}\` has no constructor.`);
      }
      place(
        visibility === "public" ? operations : internalOperations,
        path,
        Reflect.apply(construct, undefined, [declaration])
      );
    }
    const access: Record<string, TableAccess> = {};
    for (const [name, table] of Object.entries(schemaManifest.tables)) {
      access[name] = table.access;
    }
    // SAFETY: `app` checks the whole registration at run time, as it
    // checks one App code declares.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const definition = {
      name: data.name,
      schema,
      access: { tables: access },
      operations,
      internalOperations,
      operationAccess: overrides,
      screens: screensFrom(data.screens),
      surfaces: surfacesFrom(data.surfaces),
      ...(data.preferences === null
        ? {}
        : { preferences: schemaFrom(data.preferences) }),
      uses: [...resources.values(), ...browser.values(), ...workflows.values()],
      migrations: migrationsFrom(data.migrations),
    } as Parameters<typeof app>[0];
    return inspectApp(app(definition)).manifest;
  };

  // A function whose verbs aren't what its kind and the App's access give
  // it was narrowed by `operationAccess`: declared again with its verbs as
  // the override, which `app` refuses if they widen anything.
  const base = declare({});
  const overrides: Record<string, OperationAccess> = {};
  for (const { path, tables } of functions) {
    const derived = base.operations[path]?.tables;
    if (derived === undefined || !sameVerbs(derived, tables)) {
      if (!isPlainObject(tables)) {
        refuse(`\`${path}\`'s tables are a map of verbs.`);
      }
      // SAFETY: `app` checks every table and verb of an override.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      overrides[path] = { tables } as OperationAccess;
    }
  }
  const manifest =
    Object.keys(overrides).length === 0 ? base : declare(overrides);
  if (canonicalText(manifest) !== canonicalText(data)) {
    return refuse("The App's manifest isn't what its declaration makes.");
  }
  return manifest;
};
