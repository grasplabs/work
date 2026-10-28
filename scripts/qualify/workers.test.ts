import { describe, expect, it } from "vite-plus/test";

import { knownName, ownsAll } from "./cf.ts";
import { clientConfig, liveClasses, outputOf, storageOf } from "./workers.ts";

// A release's core, as deploy-lib.ts writes its wrangler.json: what each
// test client's copy is made from.
const core = {
  name: "grasp-os-core",
  workers_dev: true,
  preview_urls: true,
  triggers: { crons: ["* * * * *"] },
  d1_databases: [
    { binding: "DB", database_name: "grasp-os-core", migrations_dir: "m/DB" },
  ],
  r2_buckets: [
    { binding: "FILES", bucket_name: "grasp-os-files", jurisdiction: "eu" },
  ],
  services: [{ binding: "CONNECT", service: "grasp-os-connect" }],
  durable_objects: {
    bindings: [{ name: "WORKSPACE", class_name: "Workspace" }],
  },
  worker_loaders: [{ binding: "LOADER" }],
  ai: { binding: "AI" },
};

const apps = { "grasp-os-core": "core", "grasp-os-connect": "connect" };

describe("a test client's copy of a release Worker", () => {
  it("names only the client's own script, storage and connect, with no workers.dev or crons", () => {
    const config = clientConfig(core, {
      prefix: "qual-20261028",
      client: "a",
      apps,
      databaseIds: { "grasp-os-core": "db-a" },
      without: new Set(),
    });

    expect(config).toMatchObject({
      name: "qual-20261028-a-core",
      workers_dev: false,
      preview_urls: false,
      triggers: { crons: [] },
      d1_databases: [
        { database_name: "qual-20261028-a-grasp-os-core", database_id: "db-a" },
      ],
      r2_buckets: [
        { bucket_name: "qual-20261028-a-grasp-os-files", jurisdiction: "eu" },
      ],
      services: [{ binding: "CONNECT", service: "qual-20261028-a-connect" }],
    });
    expect(JSON.stringify(config)).not.toContain("qual-20261028-b-");
  });

  it("leaves out the binding kinds an attempt goes without", () => {
    const config = clientConfig(core, {
      prefix: "qual-20261028",
      client: "b",
      apps,
      databaseIds: { "grasp-os-core": "db-b" },
      without: new Set(["ai", "worker_loaders"]),
    });

    expect({
      ai: Object.hasOwn(config, "ai"),
      loaders: Object.hasOwn(config, "worker_loaders"),
      objects: Object.hasOwn(config, "durable_objects"),
    }).toStrictEqual({ ai: false, loaders: false, objects: true });
  });

  it("refuses a service binding to a Worker outside the release, and a database it made none for", () => {
    expect(() =>
      clientConfig(
        { ...core, services: [{ binding: "X", service: "someone-else" }] },
        {
          prefix: "qual-x",
          client: "a",
          apps,
          databaseIds: { "grasp-os-core": "d" },
          without: new Set(),
        }
      )
    ).toThrow("isn't a Worker of the release");
    expect(() =>
      clientConfig(core, {
        prefix: "qual-x",
        client: "a",
        apps,
        databaseIds: {},
        without: new Set(),
      })
    ).toThrow("No database was created for grasp-os-core");
  });

  it("lists the storage to create first", () => {
    expect(storageOf(core)).toStrictEqual({
      databases: ["grasp-os-core"],
      buckets: ["grasp-os-files"],
    });
  });
});

describe("the run's writes", () => {
  it("may name only the run's own resources", () => {
    const created = new Set(["0b3c-uuid"]);
    const owns = (names: string[]) => ownsAll(names, "qual-20261028", created);
    expect({
      own: owns(["qual-20261028-dispatcher"]),
      created: owns(["0b3c-uuid"]),
      other: owns(["grasp-os-core"]),
      // Ours by its first name, another's by its second.
      mixed: owns(["qual-20261028", "grasp-os-core"]),
      hidden: owns(["qual-20261028/../grasp-os-core"]),
      flag: owns(["qual-20261028 --force"]),
      none: owns([]),
      // Another run's, whose prefix only starts the same.
      longer: owns(["qual-202610280-dispatcher"]),
      prefixItself: owns(["qual-20261028"]),
    }).toStrictEqual({
      own: true,
      created: true,
      other: false,
      mixed: false,
      hidden: false,
      flag: false,
      none: false,
      longer: false,
      prefixItself: true,
    });
  });
});

describe("the account a run starts in", () => {
  it("may hold the platform's, placed clients' and qualification runs' resources, nothing else", () => {
    expect(
      [
        "grasp-os-clients",
        "grasp-os-admin",
        "g7k2m9-grasp-os-core",
        "qual-20261023-a-grasp-os-core",
        "someone-elses-worker",
        "g-grasp-os-core",
      ].map((name) => knownName(name))
    ).toStrictEqual([true, true, true, true, false, false]);
  });
});

describe("a client's release Worker as Build Output", () => {
  it("names each binding by the kind cf names it, its vars as text or JSON, its classes as exports", () => {
    const config = clientConfig(
      {
        ...core,
        compatibility_date: "2026-09-15",
        compatibility_flags: ["nodejs_compat"],
        vars: { CLIENT_ID: "qual-x-a-client", MAIL_FROM: { address: "a@b" } },
        assets: {
          binding: "ASSETS",
          not_found_handling: "single-page-application",
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["Workspace", "Old"] },
          { tag: "v2", renamed_classes: [{ from: "Old", to: "AuditLog" }] },
        ],
      },
      {
        prefix: "qual-x",
        client: "a",
        apps,
        databaseIds: { "grasp-os-core": "db-a" },
        without: new Set(["ai"]),
      }
    );

    expect(outputOf(config)).toStrictEqual({
      name: "qual-x-a-core",
      compatibilityDate: "2026-09-15",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: false,
      previewUrls: false,
      env: {
        WORKSPACE: {
          type: "unsafe:durable_object_namespace",
          class_name: "Workspace",
        },
        LOADER: { type: "worker-loader" },
        DB: { type: "d1", id: "db-a" },
        FILES: {
          type: "r2",
          name: "qual-x-a-grasp-os-files",
          jurisdiction: "eu",
        },
        CONNECT: { type: "worker", worker: "qual-x-a-connect" },
        CLIENT_ID: { type: "text", value: "qual-x-a-client" },
        MAIL_FROM: { type: "json", value: { address: "a@b" } },
        ASSETS: { type: "assets" },
      },
      exports: {
        Workspace: { type: "durable-object", storage: "sqlite" },
        AuditLog: { type: "durable-object", storage: "sqlite" },
      },
      assets: { notFoundHandling: "single-page-application" },
    });
  });

  it("declares only the classes its migrations leave live", () => {
    expect(
      liveClasses([
        { new_sqlite_classes: ["A", "B"] },
        { new_classes: ["Legacy"] },
        { renamed_classes: [{ from: "B", to: "C" }], deleted_classes: ["A"] },
      ])
    ).toStrictEqual({ Legacy: "legacy-kv", C: "sqlite" });
  });
});
