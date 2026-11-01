import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { createD1Database } from "../src/cloudflare/accounts.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import {
  applyD1Migrations,
  putSchedules,
  queryD1,
  setScriptSubdomain,
  uploadTargetScript,
} from "../src/cloudflare/workers.ts";
import type {
  AssetFile,
  ScriptTarget,
  WorkerUpload,
} from "../src/cloudflare/workers.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
const api = cloudflareApi({ token, retryDelayMs: 0 });

const encoder = new TextEncoder();

/** A release's core Worker: one module, one binding, tagged `releaseId`. */
const release = (
  releaseId: string,
  assets?: readonly AssetFile[]
): WorkerUpload => ({
  releaseId,
  metadata: {
    main_module: "index.js",
    compatibility_date: "2026-09-15",
    bindings: [
      { type: "plain_text", name: "PLATFORM_CHANGE", text: releaseId },
    ],
    ...(assets === undefined
      ? {}
      : { assets: { config: { run_worker_first: true } } }),
  },
  modules: [
    {
      name: "index.js",
      type: "application/javascript+module",
      content: `export default { fetch: () => new Response("${releaseId}") };`,
    },
    { name: "skills/SKILL.md", type: "text/plain", content: "# Skill" },
  ],
  ...(assets === undefined ? {} : { assets }),
});

const file = (path: string, content: string): AssetFile => ({
  path,
  content: encoder.encode(content),
  type: "text/plain",
});

/**
 * A version's assets metadata: its config, and whether its token came from
 * a completed upload (`complete-`) or straight from the session (`assets-`).
 */
const assetsOf = (metadata: Record<string, unknown>) => {
  const { config, jwt } = z
    .object({ config: z.unknown(), jwt: z.string() })
    .parse(metadata.assets);
  return { config, completed: jwt.startsWith("complete-") };
};

/** The account's own script `grasp-os-core`. */
const core = (accountId: string): ScriptTarget => ({
  accountId,
  scriptName: "grasp-os-core",
  namespace: null,
});

/** A new D1 database `name` in the account, in the EU. */
const database = async (accountId: string, name: string) =>
  await createD1Database(api, accountId, name, "eu");

describe("static assets", () => {
  it("uploads only the files the account lacks, and names them in each upload", async () => {
    const account = cloudflare.addAccount();
    const files = [
      file("/index.html", "<!doctype html>"),
      file("/app.js", "console.log(1)"),
      file("/app.css", "body{}"),
    ];
    await uploadTargetScript(api, core(account.id), release("26.01.1", files));
    const firstUploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    await uploadTargetScript(
      api,
      core(account.id),
      release("26.01.2", [...files, file("/new.js", "1")])
    );
    const allUploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );

    // Three files in buckets of two, then only the new one.
    expect(firstUploads).toHaveLength(2);
    expect(allUploads).toHaveLength(3);
    expect(account.assets.size).toBe(4);
    for (const { headers } of allUploads) {
      expect(headers.get("authorization")).not.toBe(`Bearer ${token}`);
    }
    const versions = account.scripts.get("grasp-os-core")?.versions ?? [];
    expect(versions.map(({ metadata }) => assetsOf(metadata))).toStrictEqual(
      versions.map(() => ({
        config: { run_worker_first: true },
        completed: true,
      }))
    );
  });

  it("names each file by the key the release manifest gives it (Wrangler's shape and extension rule, with SHA-256), dot-files included", async () => {
    const account = cloudflare.addAccount();
    await uploadTargetScript(
      api,
      core(account.id),
      release("26.01.1", [
        file("/index.html", "<html></html>"),
        file("/.hidden", "x"),
        file("/.well-known/security.txt", "x"),
        file("/a.tar.gz", "x"),
      ])
    );

    const session = cloudflare.calls.find(({ path }) =>
      path.endsWith("/assets-upload-session")
    );
    // Wrangler's key with SHA-256 in place of BLAKE3: base64 of the
    // contents, then the extension as Node's path.extname finds it (none
    // for a dot-file, the last for a.tar.gz). Worked out with Node.
    expect(session?.body).toStrictEqual({
      manifest: {
        "/index.html": { hash: "d4c01ae8630098078a961cef6cb9e3b3", size: 13 },
        "/.hidden": { hash: "5e21d86b709b6aa2d5fff6d7cfed56ab", size: 1 },
        "/.well-known/security.txt": {
          hash: "18bc01c2f3ff74fee5bf89429d922436",
          size: 1,
        },
        "/a.tar.gz": { hash: "c1a6faede032be6f91315fcad5b29e55", size: 1 },
      },
    });
    expect(account.assets.size).toBe(4);
    // Each file goes up as the base64 of its contents.
    const parts: [string, FormDataEntryValue][] = cloudflare.calls
      .filter(({ path }) => path.endsWith("/workers/assets/upload"))
      .flatMap(({ body }) =>
        body instanceof FormData ? [...body.entries()] : []
      );
    const uploaded = Object.fromEntries(
      await Promise.all(
        parts.map(async ([hash, part]): Promise<[string, string]> => [
          hash,
          part instanceof Blob ? await part.text() : part,
        ])
      )
    );
    expect(uploaded).toStrictEqual({
      d4c01ae8630098078a961cef6cb9e3b3: btoa("<html></html>"),
      "5e21d86b709b6aa2d5fff6d7cfed56ab": btoa("x"),
      "18bc01c2f3ff74fee5bf89429d922436": btoa("x"),
      c1a6faede032be6f91315fcad5b29e55: btoa("x"),
    });
  });

  it("names files the account already holds by the session's token", async () => {
    const account = cloudflare.addAccount();
    const files = [file("/index.html", "<!doctype html>")];
    await uploadTargetScript(api, core(account.id), release("26.01.1", files));
    await uploadTargetScript(api, core(account.id), release("26.01.2", files));
    const uploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    expect(uploads).toHaveLength(1);
    const [, second] = account.scripts.get("grasp-os-core")?.versions ?? [];
    expect(assetsOf(second?.metadata ?? {})).toMatchObject({
      completed: false,
    });
  });
});

describe("uploads that fail part way", () => {
  it("uploads asset buckets three at a time, retrying one after a server error", async () => {
    const account = cloudflare.addAccount();
    const files = Array.from({ length: 15 }, (_, index) =>
      file(`/file-${index}.js`, `export default ${index};`)
    );
    // The session, then the first bucket's upload fails once.
    cloudflare.failCall(2, 500);
    await uploadTargetScript(api, core(account.id), release("26.01.1", files));
    const uploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    // Eight buckets of two, one sent twice.
    expect(uploads).toHaveLength(9);
    expect(account.assets.size).toBe(15);
    expect(cloudflare.peakConcurrency()).toBe(3);
  });

  it("retries a script upload after a server error, unless it migrates Durable Objects", async () => {
    const account = cloudflare.addAccount();
    // The upload fails once.
    cloudflare.failCall(1, 500);
    await uploadTargetScript(api, core(account.id), release("26.01.1"));
    expect(cloudflare.calls.map(({ method }) => method)).toStrictEqual([
      "PUT",
      "PUT",
    ]);

    const migrating = release("26.01.2");
    cloudflare.failCall(1, 500);
    await expect(
      uploadTargetScript(api, core(account.id), {
        ...migrating,
        metadata: {
          ...migrating.metadata,
          migrations: { new_tag: "v2", new_sqlite_classes: ["Uploads"] },
        },
      })
    ).rejects.toMatchObject({ status: 500 });
    expect(cloudflare.calls).toHaveLength(3);
  });
});

describe("schedules and workers.dev", () => {
  it("serves a Worker on workers.dev without preview URLs", async () => {
    const account = cloudflare.addAccount();
    await uploadTargetScript(api, core(account.id), release("26.01.1"));
    await setScriptSubdomain(api, account.id, "grasp-os-core", {
      enabled: true,
      previewsEnabled: false,
    });
    expect(account.scripts.get("grasp-os-core")?.subdomain).toStrictEqual({
      enabled: true,
      previews_enabled: false,
    });
  });

  it("sets cron schedules", async () => {
    const account = cloudflare.addAccount();
    await uploadTargetScript(api, core(account.id), release("26.01.1"));
    await putSchedules(api, account.id, "grasp-os-core", [
      "* * * * *",
      "*/15 * * * *",
    ]);
    expect(account.scripts.get("grasp-os-core")?.schedules).toStrictEqual([
      "* * * * *",
      "*/15 * * * *",
    ]);
  });
});

describe("D1 migrations", () => {
  const table = `t_${crypto.randomUUID().replaceAll("-", "")}`;
  const migrations = [
    {
      name: `${table}_0000.sql`,
      sql: `CREATE TABLE ${table} (id TEXT PRIMARY KEY);`,
    },
    {
      name: `${table}_0001.sql`,
      sql: `-- A comment; with a semicolon.\nALTER TABLE ${table} ADD "note" TEXT;\n--> statement-breakpoint\n/* A block; comment. */\nINSERT INTO ${table} (id, "note") VALUES ('a', 'it''s; here');`,
    },
  ];

  it("applies each migration once, in order, as Wrangler records them", async () => {
    const account = cloudflare.addAccount();
    const { uuid } = await database(account.id, "grasp-os-core");

    await expect(
      applyD1Migrations(api, account.id, uuid, migrations.slice(0, 1))
    ).resolves.toStrictEqual([migrations[0]?.name]);
    await expect(
      applyD1Migrations(api, account.id, uuid, migrations)
    ).resolves.toStrictEqual([migrations[1]?.name]);
    await expect(
      applyD1Migrations(api, account.id, uuid, migrations)
    ).resolves.toStrictEqual([]);

    const [rows, recorded] = await queryD1(
      api,
      account.id,
      uuid,
      `SELECT id, note FROM ${table}; SELECT name FROM d1_migrations WHERE name LIKE '${table}%' ORDER BY id;`
    );
    expect(rows).toStrictEqual([{ id: "a", note: "it's; here" }]);
    expect(recorded).toStrictEqual(migrations.map(({ name }) => ({ name })));
  });

  it("applies core's real migrations: FTS5 tables, triggers and comments", async () => {
    const account = cloudflare.addAccount();
    const { uuid } = await database(account.id, "grasp-os-knowledge");
    const files = z
      .array(z.object({ name: z.string(), sql: z.string() }))
      .parse(Reflect.get(env, "KNOWLEDGE_MIGRATION_FILES"));
    expect(files.length).toBeGreaterThan(0);

    await expect(
      applyD1Migrations(api, account.id, uuid, files)
    ).resolves.toStrictEqual(files.map(({ name }) => name));

    const [triggers] = await queryD1(
      api,
      account.id,
      uuid,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sections_search_%' ORDER BY name;"
    );
    expect(triggers?.length).toBeGreaterThan(0);
  });

  it("keeps each database's tables to itself", async () => {
    const account = cloudflare.addAccount();
    const coreDb = await database(account.id, "grasp-os-core");
    const knowledge = await database(account.id, "grasp-os-knowledge");
    await applyD1Migrations(api, account.id, coreDb.uuid, [
      { name: "0000_only_core.sql", sql: "CREATE TABLE only_core (id TEXT);" },
    ]);
    const tablesOf = async (uuid: string) => {
      const [rows] = await queryD1(
        api,
        account.id,
        uuid,
        "SELECT name FROM sqlite_master WHERE name IN ('only_core', 'd1_migrations') ORDER BY name;"
      );
      return rows;
    };
    await expect(tablesOf(coreDb.uuid)).resolves.toStrictEqual([
      { name: "d1_migrations" },
      { name: "only_core" },
    ]);
    await expect(tablesOf(knowledge.uuid)).resolves.toStrictEqual([]);
  });

  it("keeps each account's databases apart too", async () => {
    const acme = cloudflare.addAccount("Acme");
    const globex = cloudflare.addAccount("Globex");
    const first = await database(acme.id, "grasp-os-core");
    const second = await database(globex.id, "grasp-os-core");
    await applyD1Migrations(api, acme.id, first.uuid, [
      { name: "0000_acme.sql", sql: "CREATE TABLE acme_only (id TEXT);" },
    ]);
    await applyD1Migrations(api, globex.id, second.uuid, [
      { name: "0000_globex.sql", sql: "CREATE TABLE globex_only (id TEXT);" },
    ]);
    const tables = async (accountId: string, uuid: string) => {
      const [rows] = await queryD1(
        api,
        accountId,
        uuid,
        "SELECT name FROM sqlite_master WHERE name LIKE '%_only' ORDER BY name;"
      );
      return rows;
    };
    await expect(tables(acme.id, first.uuid)).resolves.toStrictEqual([
      { name: "acme_only" },
    ]);
    await expect(tables(globex.id, second.uuid)).resolves.toStrictEqual([
      { name: "globex_only" },
    ]);
  });

  it("fails a query when a statement in it failed, though the answer succeeded", async () => {
    const account = cloudflare.addAccount();
    const { uuid } = await database(account.id, "grasp-os-core");
    cloudflare.failCall(1, "statement-failed");
    await expect(
      queryD1(api, account.id, uuid, "SELECT 1; SELECT 2;")
    ).rejects.toThrow(`D1 query on ${uuid} failed at statement 2 of 2`);
  });

  it("stops at a migration that fails, recording none after it", async () => {
    const account = cloudflare.addAccount();
    const { uuid } = await database(account.id, "grasp-os-core");
    const broken = `t_${crypto.randomUUID().replaceAll("-", "")}`;

    await expect(
      applyD1Migrations(api, account.id, uuid, [
        { name: `${broken}_0000.sql`, sql: "CREATE TABLE oops (" },
        {
          name: `${broken}_0001.sql`,
          sql: `CREATE TABLE ${broken} (id TEXT);`,
        },
      ])
    ).rejects.toMatchObject({ status: 400, codes: [7500] });

    const [recorded] = await queryD1(
      api,
      account.id,
      uuid,
      `SELECT name FROM d1_migrations WHERE name LIKE '${broken}%';`
    );
    expect(recorded).toStrictEqual([]);
  });
});
