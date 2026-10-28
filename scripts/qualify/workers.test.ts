import { describe, expect, it } from "vite-plus/test";

import { knownName, namesOwn } from "./cloudflare.ts";
import { clientConfig, storageOf } from "./workers.ts";

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
    expect({
      own: namesOwn(
        "/workers/scripts/qual-20261028-dispatcher",
        "qual-20261028",
        created
      ),
      created: namesOwn("/d1/database/0b3c-uuid", "qual-20261028", created),
      other: namesOwn(
        "/workers/scripts/grasp-os-core",
        "qual-20261028",
        created
      ),
      // Ours by its first segment, another's by its last.
      nested: namesOwn(
        "/workers/dispatch/namespaces/qual-20261028/scripts/grasp-os-core/secrets",
        "qual-20261028",
        created
      ),
      encoded: namesOwn(
        "/workers/scripts/qual-20261028%2F..%2Fgrasp-os-core",
        "qual-20261028",
        created
      ),
    }).toStrictEqual({
      own: true,
      created: true,
      other: false,
      nested: false,
      encoded: false,
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
