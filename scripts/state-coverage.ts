/**
 * The pure logic of the client state registry's coverage check
 * (check-state-registry.ts): what a client deployment's code declares as
 * state (its Workers' D1 databases, R2 buckets and Durable Object
 * namespaces, its SQLite tables, the Durable Object classes in its source),
 * read from the repo's own files, and how that differs from the registry
 * (@grasp-os/shared/state-registry). Either side running ahead of the
 * other is an error: state nobody registered would be left out of a
 * client's export, and an entry for state that is gone would make the
 * export look for something that isn't there.
 */
import type {
  ClientStateRegistry,
  StateEntry,
  TableRef,
} from "@grasp-os/shared/state-registry";

import { parseJsonc } from "./wrangler-config-rules.ts";

/** One Worker's state bindings, as its wrangler config declares them. */
export interface WorkerBindings {
  d1: readonly {
    binding: string;
    database: string;
    migrationsDir: string | undefined;
  }[];
  r2: readonly { binding: string; bucket: string }[];
  durableObjects: readonly { binding: string; className: string }[];
  /**
   * The classes the config's `migrations` leave registered: every class
   * created, new or renamed into, and not deleted or renamed away. A
   * registered class holds its objects' storage whether or not anything
   * binds it.
   */
  registeredClasses: readonly string[];
  /** Kinds of state binding the registry has no place for, by config key. */
  otherState: readonly string[];
}

/** What the repo declares, read from its files. */
export interface FoundState {
  /** Each client Worker's bindings, by its name in the registry. */
  workers: Readonly<Record<string, WorkerBindings>>;
  /**
   * Each Worker config in the repo, by path: those of client Workers and
   * of Workers the registry says hold no client state alike.
   */
  configs: readonly string[];
  /**
   * Each SQLite schema folder (`src/db/<name>/`, or `src/db/` for an app
   * with one database), by path: the tables its Drizzle schema declares
   * together with those its migrations leave, so a table made by hand in
   * a migration (a full-text index) is found too.
   */
  schemas: Readonly<Record<string, readonly string[]>>;
  /**
   * Tables source files make at runtime (`CREATE TABLE IF NOT EXISTS`),
   * by file: a Durable Object's own tables outside any Drizzle schema.
   */
  runtimeTables: Readonly<Record<string, readonly string[]>>;
  /** Durable Object classes defined in source, by name, with their file. */
  classes: Readonly<Record<string, string>>;
  /** Whether a path exists in the repo, for owner modules. */
  exists: (path: string) => boolean;
}

/**
 * Wrangler config keys that bind state of other kinds: a client Worker
 * that binds one holds state the registry has no place for yet.
 */
const otherStateKeys = [
  "kv_namespaces",
  "queues",
  "vectorize",
  "hyperdrive",
  "analytics_engine_datasets",
  "workflows",
  "secrets_store_secrets",
  "pipelines",
] as const;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

const arrayOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

/**
 * Whether a config value binds anything: a non-empty array, or an object
 * of them, as `queues` has `producers` and `consumers`.
 */
const bindsAny = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length > 0
    : Object.values(recordOf(value)).some((part) => arrayOf(part).length > 0);

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const stringsOf = (value: unknown): string[] =>
  arrayOf(value).flatMap((item) => {
    const text = stringOf(item);
    return text === undefined ? [] : [text];
  });

/** The classes a config's `migrations` leave registered, in order. */
const registeredClassesOf = (migrations: unknown): string[] => {
  const classes = new Set<string>();
  for (const step of arrayOf(migrations).map(recordOf)) {
    for (const name of [
      ...stringsOf(step.new_classes),
      ...stringsOf(step.new_sqlite_classes),
    ]) {
      classes.add(name);
    }
    for (const renamed of arrayOf(step.renamed_classes).map(recordOf)) {
      const from = stringOf(renamed.from);
      const to = stringOf(renamed.to);
      if (from !== undefined && to !== undefined) {
        classes.delete(from);
        classes.add(to);
      }
    }
    for (const name of stringsOf(step.deleted_classes)) {
      classes.delete(name);
    }
  }
  return [...classes];
};

/** A Worker's state bindings, from its wrangler config's text. */
export const workerBindingsOf = (text: string): WorkerBindings => {
  const config = recordOf(parseJsonc(text));
  const d1 = arrayOf(config.d1_databases).map((entry) => {
    const database = recordOf(entry);
    return {
      binding: stringOf(database.binding) ?? "",
      database: stringOf(database.database_name) ?? "",
      migrationsDir: stringOf(database.migrations_dir),
    };
  });
  const r2 = arrayOf(config.r2_buckets).map((entry) => {
    const bucket = recordOf(entry);
    return {
      binding: stringOf(bucket.binding) ?? "",
      bucket: stringOf(bucket.bucket_name) ?? "",
    };
  });
  const durableObjects = arrayOf(recordOf(config.durable_objects).bindings).map(
    (entry) => {
      const binding = recordOf(entry);
      return {
        binding: stringOf(binding.name) ?? "",
        className: stringOf(binding.class_name) ?? "",
      };
    }
  );
  const otherState = otherStateKeys.filter((key) => bindsAny(config[key]));
  return {
    d1,
    r2,
    durableObjects,
    registeredClasses: registeredClassesOf(config.migrations),
    otherState,
  };
};

/** A table name in SQL, quoted or not, captured as `group`. */
const sqlName = (group: string): string =>
  String.raw`["'\x60]?(?<${group}>\w+)["'\x60]?`;

/**
 * One statement that changes which tables exist, in the order the text
 * has them: a create (`CREATE [VIRTUAL] TABLE`), a drop, or a rename.
 */
const tableChange = new RegExp(
  [
    String.raw`CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${sqlName("created")}`,
    String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${sqlName("dropped")}`,
    String.raw`ALTER\s+TABLE\s+${sqlName("from")}\s+RENAME\s+TO\s+${sqlName("to")}`,
  ].join("|"),
  "giu"
);

/**
 * The tables a database's migrations leave, applied in order: drizzle-kit
 * rebuilds a table as `__new_<name>`, drops the old one and renames the
 * new one into its place, so only the tables left at the end count.
 */
export const migrationTables = (migrations: readonly string[]): string[] => {
  const tables = new Set<string>();
  for (const text of migrations) {
    for (const { groups } of text.matchAll(tableChange)) {
      const { created, dropped, from, to } = groups ?? {};
      if (created !== undefined) {
        tables.add(created);
      } else if (dropped !== undefined) {
        tables.delete(dropped);
      } else if (from !== undefined && to !== undefined) {
        tables.delete(from);
        tables.add(to);
      }
    }
  }
  return [...tables];
};

const schemaTable = /sqliteTable\(\s*["'`](?<name>\w+)["'`]/gu;

/** The tables a Drizzle schema module declares, by their SQL names. */
export const schemaTables = (source: string): string[] =>
  [...source.matchAll(schemaTable)].map(({ groups }) => groups?.name ?? "");

const runtimeTable =
  /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+(?:\$\{(?<constant>\w+)\}|[`"]?(?<literal>\w+))/gu;

/**
 * The tables a source file makes at runtime, by name: written out, or a
 * constant of the same file (`${cancelTable}`). A name it can't resolve
 * is returned as `${<constant>}`, which no registry entry matches, so the
 * check names it rather than missing the table.
 */
export const runtimeTablesOf = (source: string): string[] =>
  [...source.matchAll(runtimeTable)].map(({ groups }) => {
    const constant = groups?.constant;
    if (constant === undefined) {
      return groups?.literal ?? "";
    }
    const declared = new RegExp(
      String.raw`const\s+${constant}\s*=\s*["'\x60](?<name>\w+)["'\x60]`,
      "u"
    ).exec(source);
    return declared?.groups?.name ?? `\${${constant}}`;
  });

const classDeclaration =
  /(?<abstract>abstract\s+)?class\s+(?<name>\w+)(?:<[^>]*>)?\s+extends\s+(?<base>\w+)/gu;

/**
 * The Durable Object classes source files define, by name, with their
 * file: every class that extends `DurableObject`, directly or through a
 * base of the same sources (workerflow's `WorkflowRun`, `ClockObject`).
 * Not an abstract base itself, which no Worker can bind.
 */
export const durableObjectClassesOf = (
  sources: Readonly<Record<string, string>>
): Record<string, string> => {
  const declarations = Object.entries(sources).flatMap(([file, source]) =>
    [...source.matchAll(classDeclaration)].map(({ groups }) => ({
      file,
      name: groups?.name ?? "",
      base: groups?.base ?? "",
      isAbstract: groups?.abstract !== undefined,
    }))
  );
  const durable = new Set(["DurableObject"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, base } of declarations) {
      if (durable.has(base) && !durable.has(name)) {
        durable.add(name);
        grew = true;
      }
    }
  }
  return Object.fromEntries(
    declarations
      .filter(({ name, isAbstract }) => !isAbstract && durable.has(name))
      .map(({ name, file }) => [name, file])
  );
};

/** Every entry of the registry that names a table, with where it is. */
interface RegisteredTables {
  /** Tables of a schema folder, by folder. */
  bySchema: Map<string, Map<string, string>>;
  /** Tables made at runtime, by declaring file: where each is registered. */
  byFile: Map<string, Map<string, string>>;
  /** Every table reference that resolves (`<role>/<table>`). */
  refs: Set<string>;
}

const add = (
  map: Map<string, Map<string, string>>,
  key: string,
  table: string,
  where: string
): void => {
  const tables = map.get(key) ?? new Map<string, string>();
  tables.set(table, where);
  map.set(key, tables);
};

const registeredTables = (registry: ClientStateRegistry): RegisteredTables => {
  const bySchema = new Map<string, Map<string, string>>();
  const byFile = new Map<string, Map<string, string>>();
  const refs = new Set<string>();
  const owners = [
    ...registry.d1.map((database) => ({
      role: database.role,
      schema: database.schema,
      tables: database.tables,
      runtimeTables: {},
    })),
    ...registry.durableObjects.map((namespace) => ({
      role: namespace.role,
      schema: namespace.schema,
      tables: namespace.tables ?? {},
      runtimeTables: namespace.runtimeTables ?? {},
    })),
  ];
  for (const { role, schema, tables, runtimeTables } of owners) {
    for (const table of Object.keys(tables)) {
      refs.add(`${role}/${table}`);
      if (schema !== undefined) {
        add(bySchema, schema, table, role);
      }
    }
    for (const [table, entry] of Object.entries(runtimeTables)) {
      refs.add(`${role}/${table}`);
      add(byFile, entry.owner, table, role);
    }
  }
  for (const carrier of registry.carriers) {
    for (const [table, entry] of Object.entries(carrier.runtimeTables)) {
      add(byFile, entry.owner, table, `carrier ${carrier.className}`);
    }
  }
  for (const [table, entry] of Object.entries(registry.bookkeeping)) {
    add(byFile, entry.owner, table, "bookkeeping");
  }
  return { bySchema, byFile, refs };
};

/** Every entry with an owner module, named for an error. */
const entriesOf = (
  registry: ClientStateRegistry
): { where: string; entry: Pick<StateEntry, "owner"> }[] => [
  ...registry.d1.flatMap((database) =>
    Object.entries(database.tables).map(([table, entry]) => ({
      where: `${database.role}/${table}`,
      entry,
    }))
  ),
  ...registry.durableObjects.flatMap((namespace) => [
    { where: namespace.role, entry: namespace },
    ...Object.entries({
      ...namespace.tables,
      ...namespace.runtimeTables,
      ...namespace.kv,
      ...namespace.facets,
    }).map(([name, entry]) => ({
      where: `${namespace.role}/${name}`,
      entry,
    })),
  ]),
  ...registry.r2.flatMap((bucket) =>
    Object.entries(bucket.prefixes).map(([prefix, entry]) => ({
      where: `${bucket.role}/${prefix}`,
      entry,
    }))
  ),
  ...registry.carriers.map((carrier) => ({
    where: `carrier ${carrier.className}`,
    entry: { owner: carrier.owner },
  })),
  ...Object.entries(registry.bookkeeping).map(([table, entry]) => ({
    where: `bookkeeping ${table}`,
    entry,
  })),
];

const difference = (
  left: Iterable<string>,
  right: ReadonlySet<string>
): string[] => [...left].filter((item) => !right.has(item)).toSorted();

const workerErrors = (
  registry: ClientStateRegistry,
  found: FoundState
): string[] => {
  const errors: string[] = [];
  const clientConfigs = new Set(
    Object.values(registry.workers).map(({ config }) => config)
  );
  for (const config of found.configs) {
    if (!clientConfigs.has(config) && !(config in registry.notClientState)) {
      errors.push(
        `${config}: a Worker the registry doesn't know. Register it as a client Worker, or under notClientState with why it holds no client state.`
      );
    }
  }
  for (const config of Object.keys(registry.notClientState)) {
    if (!found.configs.includes(config)) {
      errors.push(`notClientState names ${config}, which no longer exists.`);
    }
  }
  for (const [worker, { config }] of Object.entries(registry.workers)) {
    const bindings = found.workers[worker];
    if (bindings === undefined) {
      errors.push(`Client Worker ${worker} (${config}) no longer exists.`);
      continue;
    }
    for (const key of bindings.otherState) {
      errors.push(
        `${config} binds ${key}, state the registry has no place for yet: add it to the registry and its check.`
      );
    }
  }
  return errors;
};

const bindingErrors = (
  registry: ClientStateRegistry,
  found: FoundState
): string[] => {
  const errors: string[] = [];
  const pairs = <T extends { worker: string }>(
    kind: string,
    registered: readonly T[],
    keyOf: (entry: T) => string,
    declared: (bindings: WorkerBindings) => readonly string[]
  ): void => {
    const registeredKeys = new Set(
      registered.map((entry) => `${entry.worker}: ${keyOf(entry)}`)
    );
    const declaredKeys = new Set(
      Object.entries(found.workers).flatMap(([worker, bindings]) =>
        declared(bindings).map((key) => `${worker}: ${key}`)
      )
    );
    for (const key of difference(declaredKeys, registeredKeys)) {
      errors.push(`${kind} ${key} has no registry entry.`);
    }
    for (const key of difference(registeredKeys, declaredKeys)) {
      errors.push(`The registry's ${kind} ${key} no longer exists.`);
    }
  };
  pairs(
    "D1 database",
    registry.d1,
    (database) => `${database.binding} (${database.database})`,
    (bindings) =>
      bindings.d1.map(({ binding, database }) => `${binding} (${database})`)
  );
  pairs(
    "R2 bucket",
    registry.r2,
    (bucket) => `${bucket.binding} (${bucket.bucket})`,
    (bindings) =>
      bindings.r2.map(({ binding, bucket }) => `${binding} (${bucket})`)
  );
  pairs(
    "Durable Object binding",
    registry.durableObjects,
    (namespace) => `${namespace.binding} (${namespace.className})`,
    (bindings) =>
      bindings.durableObjects.map(
        ({ binding, className }) => `${binding} (${className})`
      )
  );
  pairs(
    "Durable Object class",
    registry.durableObjects,
    (namespace) => namespace.className,
    (bindings) => bindings.registeredClasses
  );
  // A database's migrations are its schema folder's: the registry's schema
  // must be the folder the config applies migrations from.
  for (const database of registry.d1) {
    const declared = found.workers[database.worker]?.d1.find(
      ({ binding }) => binding === database.binding
    );
    const config = registry.workers[database.worker]?.config ?? "";
    const appDir = config.slice(0, config.lastIndexOf("/"));
    if (
      declared?.migrationsDir !== undefined &&
      `${appDir}/${declared.migrationsDir}` !== `${database.schema}/migrations`
    ) {
      errors.push(
        `D1 database ${database.worker}: ${database.binding} applies migrations from ${appDir}/${declared.migrationsDir}, not its registered schema ${database.schema}.`
      );
    }
  }
  return errors;
};

const classErrors = (
  registry: ClientStateRegistry,
  found: FoundState
): string[] => {
  const known = new Map([
    ...registry.durableObjects.map(
      (namespace) => [namespace.className, namespace.role] as const
    ),
    ...registry.carriers.map(
      (carrier) => [carrier.className, `carrier ${carrier.className}`] as const
    ),
  ]);
  const errors: string[] = [];
  for (const [className, file] of Object.entries(found.classes)) {
    if (!known.has(className)) {
      errors.push(
        `Durable Object class ${className} (${file}) has no registry entry.`
      );
    }
  }
  for (const carrier of registry.carriers) {
    if (!(carrier.className in found.classes)) {
      errors.push(
        `The registry's carrier ${carrier.className} no longer exists.`
      );
    }
  }
  return errors;
};

const schemaErrors = (
  registry: ClientStateRegistry,
  found: FoundState
): string[] => {
  const errors: string[] = [];
  const { bySchema } = registeredTables(registry);
  const claimed = new Map<string, string[]>();
  for (const owner of [...registry.d1, ...registry.durableObjects]) {
    if (owner.schema !== undefined) {
      claimed.set(owner.schema, [
        ...(claimed.get(owner.schema) ?? []),
        owner.role,
      ]);
    }
  }
  for (const [schema, roles] of claimed) {
    if (roles.length > 1) {
      errors.push(`Schema ${schema} is claimed by ${roles.join(" and ")}.`);
    }
  }
  for (const [schema, tables] of Object.entries(found.schemas)) {
    const registered = bySchema.get(schema);
    if (!claimed.has(schema)) {
      errors.push(
        `Schema ${schema} belongs to no registered database or Durable Object namespace.`
      );
      continue;
    }
    for (const table of difference(tables, new Set(registered?.keys()))) {
      errors.push(`Table ${table} of ${schema} has no registry entry.`);
    }
    for (const table of difference(registered?.keys() ?? [], new Set(tables))) {
      errors.push(
        `The registry's table ${table} of ${schema} no longer exists.`
      );
    }
  }
  for (const schema of claimed.keys()) {
    if (!(schema in found.schemas)) {
      errors.push(`The registry's schema ${schema} no longer exists.`);
    }
  }
  return errors;
};

const runtimeTableErrors = (
  registry: ClientStateRegistry,
  found: FoundState
): string[] => {
  const errors: string[] = [];
  const { byFile } = registeredTables(registry);
  for (const [file, tables] of Object.entries(found.runtimeTables)) {
    const registered = byFile.get(file);
    for (const table of difference(tables, new Set(registered?.keys()))) {
      errors.push(
        `Table ${table}, made by ${file}, has no registry entry with that owner.`
      );
    }
  }
  for (const [file, tables] of byFile) {
    const made = new Set(found.runtimeTables[file]);
    for (const table of difference(tables.keys(), made)) {
      errors.push(
        `The registry's table ${table} (${tables.get(table)}) isn't made by its owner ${file} any more.`
      );
    }
  }
  return errors;
};

const referenceErrors = (
  registry: ClientStateRegistry,
  found: FoundState
): string[] => {
  const { refs } = registeredTables(registry);
  const errors: string[] = [];
  const roles = [
    ...registry.d1,
    ...registry.durableObjects,
    ...registry.r2,
  ].map(({ role }) => role);
  for (const role of new Set(roles)) {
    if (roles.filter((other) => other === role).length > 1) {
      errors.push(`Role ${role} is registered more than once.`);
    }
  }
  const check = (where: string, ref: TableRef): void => {
    if (!refs.has(ref)) {
      errors.push(`${where} names ${ref}, which isn't a registered table.`);
    }
  };
  for (const carrier of registry.carriers) {
    for (const role of carrier.carries) {
      if (!roles.includes(role)) {
        errors.push(
          `Carrier ${carrier.className} carries ${role}, which isn't a registered role.`
        );
      }
    }
  }
  for (const namespace of registry.durableObjects) {
    if (namespace.objects.kind === "named") {
      for (const ref of namespace.objects.inventories) {
        check(`${namespace.role}'s objects`, ref);
      }
    }
  }
  for (const { where, entry } of entriesOf(registry)) {
    if (!found.exists(entry.owner)) {
      errors.push(`${where}: its owner ${entry.owner} doesn't exist.`);
    }
  }
  return errors;
};

/**
 * Everything that differs between the registry and what the repo
 * declares, one sentence each; none when the registry covers exactly the
 * repo's state.
 */
export const coverageErrors = (
  registry: ClientStateRegistry,
  found: FoundState
): string[] => [
  ...workerErrors(registry, found),
  ...bindingErrors(registry, found),
  ...classErrors(registry, found),
  ...schemaErrors(registry, found),
  ...runtimeTableErrors(registry, found),
  ...referenceErrors(registry, found),
];
