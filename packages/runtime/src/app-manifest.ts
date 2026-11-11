import { appManifestMaxBytes } from "@grasp-os/shared/app-limits";
import { appMaxFunctions } from "@grasp-os/shared/function-limits";
import { canonicalText } from "@grasp-os/shared/json";

import { AppDefinitionError } from "./app-definition-error.ts";
import type { AppConfig, AppManifest } from "./app-types.ts";
import { defineApp, inspectApp, registerApp } from "./app.ts";
import { hasExactly, isOverBytes, refuser } from "./declaration.ts";
import { defineMigration } from "./migration.ts";
import type { Migration } from "./migration.ts";
import { readPermissionDeclaration } from "./permission-read.ts";
import type { AppPermission } from "./permission-types.ts";
import { readSchemaManifest } from "./schema-manifest-read.ts";
import type { FunctionKind, Visibility } from "./server-function.ts";
import { builderNames } from "./server-modules.ts";
import { serverModule } from "./server.ts";
import { isPlainObject } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";
import type { AnySchema } from "./value-schema.ts";

// Reading an App's manifest of unknown origin: what inspecting its code
// in a sandbox answered, or what a sealed release stored. The
// text is hostile, as anything App code produced is: the sandbox that
// made it ran the App's code, which can make the SDK in there answer
// whatever it likes.
//
// So it isn't checked against a second list of rules. It is declared
// again, through the same constructors App code uses: its schema through
// `readSchemaManifest`, each function through `serverModule(schema)` with
// schemas rebuilt from its descriptors and a handler that runs nothing,
// each permission through `permission`, each migration through `defineMigration`
// (its handler running nothing too), and the App through `defineApp` and
// `registerApp`. What that
// registration's inspection makes must then be exactly the manifest read,
// canonically: anything a declaration couldn't have made (a path no
// module's export makes, a key no declaration has, a permission filed
// under another alias, a descriptor out of bounds) is refused.
// There is no other path from text to an `AppManifest`.

const refuse: (message: string) => never = refuser(AppDefinitionError);

/** The entries of map `value`, refused when it isn't one. */
const entriesOf = (value: unknown, what: string): [string, unknown][] => {
  if (!isPlainObject(value)) {
    return refuse(`The manifest's ${what} is a map.`);
  }
  return Object.entries(value);
};

const kinds: ReadonlySet<unknown> = new Set(["query", "mutation", "action"]);
const visibilities: ReadonlySet<unknown> = new Set(["public", "internal"]);

/** A function as the manifest describes it, before it is declared again. */
interface ReadFunction {
  readonly path: string;
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
  readonly declaration: Record<string, unknown>;
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

/** A function of the manifest, read far enough to declare it again. */
const functionFrom = (path: string, input: unknown): ReadFunction => {
  if (
    !hasExactly(input, [
      "path",
      "kind",
      "visibility",
      "args",
      "returns",
      "stream",
    ])
  ) {
    return refuse(`\`${path}\` isn't a function as a manifest holds one.`);
  }
  const { kind, visibility, stream } = input;
  if (
    input.path !== path ||
    !kinds.has(kind) ||
    !visibilities.has(visibility)
  ) {
    return refuse(`\`${path}\`'s path, kind or visibility isn't one there is.`);
  }
  const declaration: Record<string, unknown> = {
    args: shapeFrom(input.args, path),
    handler: inert,
  };
  // Left out where the function declares none, as in code.
  if (input.returns !== null) {
    declaration.returns = schemaFrom(input.returns);
  }
  // Only an action's declaration has `stream`: anything else is the
  // constructor's to refuse, as it would in code.
  if (stream !== null) {
    declaration.stream = schemaFrom(stream);
  }
  // SAFETY: each was checked against its set just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const read = { kind, visibility } as {
    kind: FunctionKind;
    visibility: Visibility;
  };
  return { path, ...read, declaration };
};

/**
 * `value` exported as dotted `path` among `modules`: from the module of
 * every segment but the last (`tasks.list` is `server/tasks.ts`'s `list`),
 * as App code exports it, refusing a path no module could make.
 */
const place = (
  modules: Record<string, Record<string, unknown>>,
  path: string,
  value: unknown
): void => {
  const segments = path.split(".");
  const name = segments.pop();
  if (name === undefined || segments.length === 0) {
    refuse(
      `\`${path}\` isn't a module's export: a path is a module's and an export's name.`
    );
  }
  const module = segments.join("/");
  const exports = Object.hasOwn(modules, module) ? modules[module] : undefined;
  const target = exports ?? {};
  if (exports === undefined) {
    Object.defineProperty(modules, module, { enumerable: true, value: target });
  }
  if (Object.hasOwn(target, name)) {
    refuse(`\`${path}\` clashes with another registered path.`);
  }
  Object.defineProperty(target, name, { enumerable: true, value });
};

/**
 * A manifest's fixtures as a declaration lists them: `expect` left out
 * where the manifest records null. Anything else is passed on as it is,
 * for `defineMigration` to refuse.
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
    // SAFETY: `defineMigration` checks each part as it checks a declaration's,
    // and `registerApp` checks it against the schema.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return defineMigration({
      name,
      table: declared.table,
      fromSchema: declared.fromSchema,
      toSchema: declared.toSchema,
      ...(declared.input === null ? {} : { input: schemaFrom(declared.input) }),
      output: schemaFrom(declared.output),
      fixtures: fixturesFrom(declared.fixtures),
      handler: inert,
    } as Parameters<typeof defineMigration>[0]);
  });

/**
 * The manifest's `permissions`, each read back through `permission` and
 * filed under its own alias, as a config lists them, by kind:
 * `defineApp` refuses any declaration under a key that isn't its kind.
 */
const permissionsFrom = (input: unknown): Record<string, unknown> => {
  const permissions: Record<string, unknown> = {};
  const listed: Record<string, AppPermission[]> = {
    connections: [],
    workflows: [],
  };
  for (const [alias, entry] of entriesOf(input, "permissions")) {
    const declared = readPermissionDeclaration(entry);
    if (declared.alias !== alias) {
      refuse(`Permission \`${alias}\` isn't filed under its alias.`);
    }
    const kind = declared["~permission"];
    const list = Object.hasOwn(listed, kind) ? listed[kind] : undefined;
    if (list === undefined) {
      permissions[kind] = kind === "people" ? true : declared;
    } else {
      list.push(declared);
    }
  }
  for (const [kind, list] of Object.entries(listed)) {
    if (list.length > 0) {
      permissions[kind] = list;
    }
  }
  return permissions;
};

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
  const keys = ["name", "schema", "functions", "permissions", "migrations"];
  // `answers` only where it declares any.
  const answers = isPlainObject(data) && Object.hasOwn(data, "answers");
  if (!hasExactly(data, [...keys, ...(answers ? ["answers"] : [])])) {
    return refuse(
      "An App's manifest is `{ name, schema, functions, permissions, migrations, answers? }`."
    );
  }
  const { schema } = readSchemaManifest(JSON.stringify(data.schema));

  const functionEntries = entriesOf(data.functions, "functions");
  // Counted before any is read.
  if (functionEntries.length > appMaxFunctions) {
    refuse(`An App registers at most ${appMaxFunctions} functions.`);
  }
  const functions = functionEntries.map(([path, input]) =>
    functionFrom(path, input)
  );
  // Each constructor checks the declaration it is given at run time, as
  // it checks one in code; its types describe declarations in code, so it
  // is called as what it is at run time.
  const server: object = serverModule(schema);

  const config = defineApp(
    // SAFETY: `defineApp` checks the whole config at run time, as it
    // checks one App code declares.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    {
      name: data.name,
      permissions: permissionsFrom(data.permissions),
      ...(answers ? { answers: data.answers } : {}),
    } as AppConfig
  );
  const migrations = migrationsFrom(data.migrations);

  const modules: Record<string, Record<string, unknown>> = {};
  for (const { path, kind, visibility, declaration } of functions) {
    const construct: unknown = Reflect.get(
      server,
      builderNames[visibility][kind]
    );
    if (typeof construct !== "function") {
      return refuse(`\`${path}\` has no constructor.`);
    }
    place(modules, path, Reflect.apply(construct, undefined, [declaration]));
  }
  const { manifest } = inspectApp(
    registerApp({ config, schema, modules, migrations })
  );
  if (canonicalText(manifest) !== canonicalText(data)) {
    return refuse("The App's manifest isn't what its declaration makes.");
  }
  return manifest;
};
