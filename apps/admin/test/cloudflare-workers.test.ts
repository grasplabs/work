import { encodeAsset } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { createD1Database } from "../src/cloudflare/accounts.ts";
import { cloudflareApi } from "../src/cloudflare/api.ts";
import {
  applyD1Migrations,
  queryD1,
  uploadTargetAssets,
  uploadTargetScript,
} from "../src/cloudflare/workers.ts";
import type {
  AssetFile,
  ScriptTarget,
  WorkerModule,
  WorkerUpload,
} from "../src/cloudflare/workers.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
const api = cloudflareApi({ token, retryDelayMs: 0 });

const encoder = new TextEncoder();

/** A module `name` of `type` holding `content`. */
const workerModule = (
  name: string,
  type: string,
  content: string
): WorkerModule => {
  const bytes = encoder.encode(content);
  return {
    name,
    type,
    size: bytes.byteLength,
    stream: async () => await Promise.resolve(new Blob([bytes]).stream()),
  };
};

/**
 * A release's core Worker: one module, one binding, tagged `releaseId`,
 * serving the static files uploaded under `assetsJwt`, if any.
 */
const release = (releaseId: string, assetsJwt?: string): WorkerUpload => ({
  releaseId,
  metadata: {
    main_module: "index.js",
    compatibility_date: "2026-09-15",
    bindings: [
      { type: "plain_text", name: "PLATFORM_CHANGE", text: releaseId },
    ],
    ...(assetsJwt === undefined
      ? {}
      : { assets: { config: { run_worker_first: true } } }),
  },
  modules: [
    workerModule(
      "index.js",
      "application/javascript+module",
      `export default { fetch: () => new Response("${releaseId}") };`
    ),
    workerModule("skills/SKILL.md", "text/plain", "# Skill"),
  ],
  ...(assetsJwt === undefined ? {} : { assetsJwt }),
});

/** Release `releaseId` deployed to `target`: its static files `files`, then its script. */
const deploy = async (
  target: ScriptTarget,
  releaseId: string,
  files: readonly AssetFile[]
): Promise<void> => {
  const assetsJwt = await uploadTargetAssets(api, target, files);
  await uploadTargetScript(api, target, release(releaseId, assetsJwt));
};

/** A static file at `path` holding `content`, of type `type`. */
const file = async (
  path: string,
  content: string,
  type = "text/plain"
): Promise<AssetFile> => {
  const bytes = encoder.encode(content);
  const { key, base64 } = await encodeAsset(bytes, path);
  return {
    path,
    key,
    size: bytes.length,
    type,
    readBase64: async () => await Promise.resolve(base64),
  };
};

const mebibyte = 1024 * 1024;

/**
 * `count` static files of `size` zero bytes each, numbered from `first`,
 * sharing one base64 encoded up front: only how a deploy groups them is
 * tested, so each has a key of its own without encoding its own copy.
 */
const zeroFiles = async (
  first: number,
  count: number,
  size: number
): Promise<AssetFile[]> => {
  const { base64 } = await encodeAsset(new Uint8Array(size), "/zeros.wasm");
  return Array.from({ length: count }, (_, offset) => {
    const index = first + offset;
    return {
      path: `/chunk-${index}.wasm`,
      key: index.toString(16).padStart(32, "0"),
      size,
      type: "application/wasm",
      readBase64: async () => await Promise.resolve(base64),
    };
  });
};

/** Base64's padding, at the end. */
const padding = /=*$/u;

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

/** The namespace a client's scripts are uploaded to. */
const namespace = "grasp-clients";

/** Script `grasp-os-core` in the account's namespace. */
const core = (accountId: string): ScriptTarget => ({
  accountId,
  scriptName: "grasp-os-core",
  namespace,
});

/** A new account with the namespace in it. */
const namespaced = () => {
  const account = cloudflare.addAccount();
  account.namespaces.set(namespace, new Map());
  return account;
};

/** A new D1 database `name` in the account, in the EU. */
const database = async (accountId: string, name: string) =>
  await createD1Database(api, accountId, name, "eu");

describe("static assets", () => {
  it("uploads only the files the account lacks, and names them in each upload", async () => {
    const account = namespaced();
    const files = await Promise.all([
      file("/index.html", "<!doctype html>"),
      file("/app.js", "console.log(1)"),
      file("/app.css", "body{}"),
    ]);
    await deploy(core(account.id), "26.01.1", files);
    const firstUploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    await deploy(core(account.id), "26.01.2", [
      ...files,
      await file("/new.js", "1"),
    ]);
    const allUploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );

    // Three small files in one request, then only the new one.
    expect(firstUploads).toHaveLength(1);
    expect(allUploads).toHaveLength(2);
    expect(account.assets.size).toBe(4);
    for (const { headers } of allUploads) {
      expect(headers.get("authorization")).not.toBe(`Bearer ${token}`);
    }
    const versions =
      account.namespaces.get(namespace)?.get("grasp-os-core")?.versions ?? [];
    expect(versions.map(({ metadata }) => assetsOf(metadata))).toStrictEqual(
      versions.map(() => ({
        config: { run_worker_first: true },
        completed: true,
      }))
    );
  });

  it("names each file by the key the release manifest gives it (Wrangler's shape and extension rule, with SHA-256) bound to its type, dot-files included", async () => {
    const account = namespaced();
    await deploy(
      core(account.id),
      "26.01.1",
      await Promise.all([
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
    // for a dot-file, the last for a.tar.gz); then that key, a newline and
    // the file's type, hashed again and cut to 32. Worked out with Node.
    expect(session?.body).toStrictEqual({
      manifest: {
        "/index.html": { hash: "19e91371c32f3214fc69ea207074a888", size: 13 },
        "/.hidden": { hash: "fb6b5177c1a39410e400a12a2f3c0b00", size: 1 },
        "/.well-known/security.txt": {
          hash: "f945fe61bad9a4aa7c8540c88c5cea3a",
          size: 1,
        },
        "/a.tar.gz": { hash: "321c5b73a6f69713cfb2cec1c7f50077", size: 1 },
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
      "19e91371c32f3214fc69ea207074a888": btoa("<html></html>"),
      fb6b5177c1a39410e400a12a2f3c0b00: btoa("x"),
      f945fe61bad9a4aa7c8540c88c5cea3a: btoa("x"),
      "321c5b73a6f69713cfb2cec1c7f50077": btoa("x"),
    });
  });

  it("uploads a file the account holds again when its type changes, and the account serves it with the new one", async () => {
    const account = namespaced();
    const wasm = async (type: string): Promise<AssetFile> =>
      await file("/_compiler/v1/esbuild.wasm", "\0asm", type);
    await deploy(core(account.id), "26.01.1", [
      await wasm("application/octet-stream"),
    ]);
    await deploy(core(account.id), "26.01.2", [await wasm("application/wasm")]);

    const uploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    const sessions = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/assets-upload-session")
    );
    const served = z
      .object({
        manifest: z.record(z.string(), z.object({ hash: z.string() })),
      })
      .parse(sessions.at(-1)?.body).manifest["/_compiler/v1/esbuild.wasm"];
    expect(uploads).toHaveLength(2);
    expect(account.assets.get(served?.hash ?? "")).toBe("application/wasm");
  });

  it("uploads a first deploy's files within a deadline its requests' latency sets, not one a file", async () => {
    const account = namespaced();
    const files = await Promise.all(
      Array.from(
        { length: 40 },
        async (_, index) => await file(`/chunk-${index}.js`, `export ${index};`)
      )
    );
    // Each upload answered after 200 ms. They fit one request, so 200 ms
    // and a second's margin; one file a request would take 8 s.
    const latencyMs = 200;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/workers/assets/upload")) {
        await scheduler.wait(latencyMs);
      }
      return await cloudflare.fetch(request);
    });

    await uploadTargetAssets(api, core(account.id), files, {
      signal: AbortSignal.timeout(latencyMs + 1000),
    });

    expect(account.assets.size).toBe(40);
  });

  it("uploads a first deploy's files with small ones sharing up to 8 MiB a request, three at a time, and a larger one alone", async () => {
    const account = namespaced();
    // Thirty files of 1 MiB and two of 9 MiB.
    const files = [
      ...(await zeroFiles(0, 30, mebibyte)),
      ...(await zeroFiles(30, 2, 9 * mebibyte)),
    ];
    // Answered after a moment, so the requests overlap as they would.
    const latencyMs = 20;
    const active = new Set<{ files: number; raw: number; alongside: number }>();
    const requests: { files: number; raw: number; alongside: number }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (!new URL(request.url).pathname.endsWith("/workers/assets/upload")) {
        return await cloudflare.fetch(request);
      }
      const sent = { files: 0, raw: 0, alongside: 0 };
      active.add(sent);
      requests.push(sent);
      for (const each of active) {
        each.alongside = Math.max(each.alongside, active.size);
      }
      try {
        const form = await request.clone().formData();
        // Each part's raw size, from its base64's length and padding.
        const sizes = await Promise.all(
          [...form.values()].map(async (part) => {
            const tail =
              part instanceof Blob ? await part.slice(-2).text() : "";
            const length = part instanceof Blob ? part.size : 0;
            return (length / 4) * 3 - (padding.exec(tail)?.[0].length ?? 0);
          })
        );
        sent.files = sizes.length;
        sent.raw = sizes.reduce((total, size) => total + size, 0);
        await scheduler.wait(latencyMs);
        return await cloudflare.fetch(request);
      } finally {
        active.delete(sent);
      }
    });

    await uploadTargetAssets(api, core(account.id), files);

    const budget = 8 * mebibyte;
    expect({
      stored: account.assets.size,
      files: requests
        .map(({ files: count }) => count)
        .toSorted((a, b) => a - b),
      alongside: Math.max(...requests.map(({ alongside }) => alongside)),
      shared: requests
        .filter(({ files: count }) => count > 1)
        .every(({ raw }) => raw <= budget),
      large: requests
        .filter(({ raw }) => raw > budget)
        .map(({ alongside }) => alongside),
    }).toStrictEqual({
      stored: 32,
      // Eight 1 MiB files a request, then each 9 MiB file on its own.
      files: [1, 1, 6, 8, 8, 8],
      alongside: 3,
      shared: true,
      large: [1, 1],
    });
  });

  it("names files the account already holds by the session's token", async () => {
    const account = namespaced();
    const files = [await file("/index.html", "<!doctype html>")];
    await deploy(core(account.id), "26.01.1", files);
    await deploy(core(account.id), "26.01.2", files);
    const uploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    expect(uploads).toHaveLength(1);
    const [, second] =
      account.namespaces.get(namespace)?.get("grasp-os-core")?.versions ?? [];
    expect(assetsOf(second?.metadata ?? {})).toMatchObject({
      completed: false,
    });
  });
});

describe("uploads that fail part way", () => {
  it("retries a static files upload after a server error", async () => {
    const account = namespaced();
    const files = await Promise.all(
      Array.from(
        { length: 15 },
        async (_, index) =>
          await file(`/file-${index}.js`, `export default ${index};`)
      )
    );
    // The session, then the files' upload fails once.
    cloudflare.failCall(2, 500);
    await deploy(core(account.id), "26.01.1", files);
    const uploads = cloudflare.calls.filter(({ path }) =>
      path.endsWith("/workers/assets/upload")
    );
    // Fifteen small files in one request, sent twice.
    expect(uploads).toHaveLength(2);
    expect(account.assets.size).toBe(15);
  });

  it("retries a script upload after a server error, unless it migrates Durable Objects", async () => {
    const account = namespaced();
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
