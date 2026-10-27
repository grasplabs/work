import type {
  ClientStateRegistry,
  StateEntry,
} from "@grasp-os/shared/state-registry";
import { describe, expect, it } from "vite-plus/test";

import {
  coverageErrors,
  durableObjectClassesOf,
  migrationTables,
  runtimeTablesOf,
  schemaTables,
  workerBindingsOf,
} from "./state-coverage.ts";
import type { FoundState } from "./state-coverage.ts";

const entry = (owner: string): StateEntry => ({
  owner,
  kind: "authoritative",
  export: "exported",
});

/** A registry of one Worker with a database, a namespace and a bucket. */
const registry: ClientStateRegistry = {
  workers: { core: { config: "apps/core/wrangler.jsonc" } },
  notClientState: { "apps/admin/wrangler.jsonc": "Grasp's own." },
  d1: [
    {
      role: "core-db",
      worker: "core",
      binding: "DB",
      database: "core",
      schema: "apps/core/src/db/core",
      tables: { users: entry("apps/core/src/auth.ts") },
    },
  ],
  durableObjects: [
    {
      role: "runs",
      worker: "core",
      binding: "RUNS",
      className: "Runs",
      owner: "apps/core/src/runs.ts",
      objects: {
        kind: "named",
        name: "The run's ID.",
        inventories: ["core-db/users"],
      },
      schema: "apps/core/src/db/runs",
      tables: { steps: entry("apps/core/src/runs.ts") },
      runtimeTables: { journal: entry("apps/core/src/runs.ts") },
    },
  ],
  r2: [
    {
      role: "files",
      worker: "core",
      binding: "FILES",
      bucket: "files",
      prefixes: { "apps/": entry("apps/core/src/apps.ts") },
    },
  ],
  carriers: [],
  bookkeeping: {},
};

/** What a repo that `registry` covers exactly declares. */
const found: FoundState = {
  workers: {
    core: {
      d1: [
        {
          binding: "DB",
          database: "core",
          migrationsDir: "src/db/core/migrations",
        },
      ],
      r2: [{ binding: "FILES", bucket: "files" }],
      durableObjects: [{ binding: "RUNS", className: "Runs" }],
      registeredClasses: ["Runs"],
      otherState: [],
    },
  },
  configs: ["apps/admin/wrangler.jsonc", "apps/core/wrangler.jsonc"],
  schemas: {
    "apps/core/src/db/core": ["users"],
    "apps/core/src/db/runs": ["steps"],
  },
  runtimeTables: { "apps/core/src/runs.ts": ["journal"] },
  classes: { Runs: "apps/core/src/runs.ts" },
  exists: () => true,
};

const core = found.workers.core ?? {
  d1: [],
  r2: [],
  durableObjects: [],
  registeredClasses: [],
  otherState: [],
};

describe("client state coverage", () => {
  it("accepts a registry that covers exactly what the repo declares", () => {
    expect(coverageErrors(registry, found)).toStrictEqual([]);
  });

  it("refuses a table without an entry, and an entry for a table that's gone", () => {
    expect(
      coverageErrors(registry, {
        ...found,
        schemas: { ...found.schemas, "apps/core/src/db/core": ["sessions"] },
      })
    ).toStrictEqual([
      "Table sessions of apps/core/src/db/core has no registry entry.",
      "The registry's table users of apps/core/src/db/core no longer exists.",
    ]);
  });

  it("refuses a schema folder no database or namespace claims", () => {
    expect(
      coverageErrors(registry, {
        ...found,
        schemas: { ...found.schemas, "apps/core/src/db/cache": ["entries"] },
      })
    ).toStrictEqual([
      "Schema apps/core/src/db/cache belongs to no registered database or Durable Object namespace.",
    ]);
  });

  it("refuses new and vanished D1 databases, R2 buckets and Durable Object bindings", () => {
    expect(
      coverageErrors(registry, {
        ...found,
        workers: {
          core: {
            ...core,
            d1: [
              {
                binding: "BRAIN_DB",
                database: "brain",
                migrationsDir: undefined,
              },
            ],
            r2: [{ binding: "ARCHIVE", bucket: "archive" }],
            durableObjects: [{ binding: "LEDGER", className: "Runs" }],
          },
        },
      })
    ).toStrictEqual([
      "D1 database core: BRAIN_DB (brain) has no registry entry.",
      "The registry's D1 database core: DB (core) no longer exists.",
      "R2 bucket core: ARCHIVE (archive) has no registry entry.",
      "The registry's R2 bucket core: FILES (files) no longer exists.",
      "Durable Object binding core: LEDGER (Runs) has no registry entry.",
      "The registry's Durable Object binding core: RUNS (Runs) no longer exists.",
    ]);
  });

  it("refuses a Durable Object class that is defined or registered but not in the registry", () => {
    expect(
      coverageErrors(registry, {
        ...found,
        workers: {
          core: { ...core, registeredClasses: ["Runs", "Ledger"] },
        },
        classes: { ...found.classes, Cache: "apps/core/src/cache.ts" },
      })
    ).toStrictEqual([
      "Durable Object class core: Ledger has no registry entry.",
      "Durable Object class Cache (apps/core/src/cache.ts) has no registry entry.",
    ]);
  });

  it("refuses a table made at runtime without an entry for its file, and one no longer made", () => {
    expect(
      coverageErrors(registry, {
        ...found,
        runtimeTables: { "apps/core/src/runs.ts": ["history"] },
      })
    ).toStrictEqual([
      "Table history, made by apps/core/src/runs.ts, has no registry entry with that owner.",
      "The registry's table journal (runs) isn't made by its owner apps/core/src/runs.ts any more.",
    ]);
  });

  it("refuses a Worker it doesn't know, and a client Worker binding state it has no place for", () => {
    expect(
      coverageErrors(registry, {
        ...found,
        workers: { core: { ...core, otherState: ["kv_namespaces"] } },
        configs: [...found.configs, "apps/cache/wrangler.jsonc"],
      })
    ).toStrictEqual([
      "apps/cache/wrangler.jsonc: a Worker the registry doesn't know. Register it as a client Worker, or under notClientState with why it holds no client state.",
      "apps/core/wrangler.jsonc binds kv_namespaces, state the registry has no place for yet: add it to the registry and its check.",
    ]);
  });

  it("refuses an inventory of objects that isn't a registered table", () => {
    const [runs] = registry.durableObjects;
    expect(
      coverageErrors(
        {
          ...registry,
          durableObjects: runs
            ? [
                {
                  ...runs,
                  objects: {
                    kind: "named",
                    name: "The run's ID.",
                    inventories: ["core-db/runs"],
                  },
                },
              ]
            : [],
        },
        found
      )
    ).toStrictEqual([
      "runs's objects names core-db/runs, which isn't a registered table.",
    ]);
  });

  it("refuses an owner module that doesn't exist", () => {
    expect(
      coverageErrors(registry, {
        ...found,
        exists: (path) => path !== "apps/core/src/apps.ts",
      })
    ).toStrictEqual([
      "files/apps/: its owner apps/core/src/apps.ts doesn't exist.",
    ]);
  });

  it("refuses a schema whose migrations the config applies from elsewhere", () => {
    expect(
      coverageErrors(registry, {
        ...found,
        workers: {
          core: {
            ...core,
            d1: [
              {
                binding: "DB",
                database: "core",
                migrationsDir: "migrations",
              },
            ],
          },
        },
      })
    ).toStrictEqual([
      "D1 database core: DB applies migrations from apps/core/migrations, not its registered schema apps/core/src/db/core.",
    ]);
  });
});

describe("reading what the repo declares", () => {
  it("finds the tables migrations leave, through drizzle-kit's rebuilds and hand-made virtual tables", () => {
    expect(
      migrationTables([
        "CREATE TABLE `users` (`id` text);\n--> statement-breakpoint\nCREATE TABLE `old` (`id` text);",
        "CREATE VIRTUAL TABLE `search` USING fts5(text);\n--> statement-breakpoint\nDROP TABLE `old`;",
        "CREATE TABLE `__new_users` (`id` text, `name` text);\nINSERT INTO `__new_users` SELECT * FROM `users`;\nDROP TABLE `users`;\nALTER TABLE `__new_users` RENAME TO `users`;",
      ]).toSorted()
    ).toStrictEqual(["search", "users"]);
  });

  it("finds a Drizzle schema's tables by their SQL names", () => {
    expect(
      schemaTables(`export const users = sqliteTable("users", {});
export const teamMembers = sqliteTable(
  "team_members",
  {}
);`)
    ).toStrictEqual(["users", "team_members"]);
  });

  it("finds tables made at runtime, by name or through a constant, and names one it can't resolve", () => {
    expect(
      runtimeTablesOf(`const cancelTable = "run_cancelled";
sql.exec(\`CREATE TABLE IF NOT EXISTS \${cancelTable} (at INTEGER)\`);
sql.exec("CREATE TABLE IF NOT EXISTS tombstones (key TEXT)");
sql.exec(\`CREATE TABLE IF NOT EXISTS \${elsewhere} (key TEXT)\`);`)
    ).toStrictEqual(["run_cancelled", "tombstones", `\${elsewhere}`]);
  });

  it("finds the Durable Object classes a Worker can bind, through bases in other files, not an abstract base", () => {
    expect(
      durableObjectClassesOf({
        "apps/core/src/clock.ts":
          "export class Clock extends ClockObject<Env> {}",
        "packages/workerflow/src/clock.ts":
          "export abstract class ClockObject<E> extends TaskObject<E> {}",
        "packages/workerflow/src/tasks.ts":
          "export abstract class TaskObject<E> extends DurableObject<E> {}",
        "apps/core/src/ledger.ts": `export class Ledger extends DurableObject<Env> {}
class Helper extends Base {}`,
      })
    ).toStrictEqual({
      Clock: "apps/core/src/clock.ts",
      Ledger: "apps/core/src/ledger.ts",
    });
  });

  it("reads a config's state bindings, with classes as its migrations leave them", () => {
    expect(
      workerBindingsOf(`{
  // A Worker.
  "d1_databases": [{ "binding": "DB", "database_name": "core", "migrations_dir": "src/db/core/migrations" }],
  "r2_buckets": [{ "binding": "FILES", "bucket_name": "files", "jurisdiction": "eu" }],
  "durable_objects": { "bindings": [{ "name": "RUNS", "class_name": "Runs" }] },
  "kv_namespaces": [{ "binding": "CACHE" }],
  "queues": { "producers": [{ "binding": "JOBS", "queue": "jobs" }] },
  "vectorize": [],
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["Runs", "Old", "Before"] },
    { "tag": "v2", "deleted_classes": ["Old"] },
    { "tag": "v3", "renamed_classes": [{ "from": "Before", "to": "After" }] },
  ],
}`)
    ).toStrictEqual({
      d1: [
        {
          binding: "DB",
          database: "core",
          migrationsDir: "src/db/core/migrations",
        },
      ],
      r2: [{ binding: "FILES", bucket: "files" }],
      durableObjects: [{ binding: "RUNS", className: "Runs" }],
      registeredClasses: ["Runs", "After"],
      otherState: ["kv_namespaces", "queues"],
    });
  });
});
