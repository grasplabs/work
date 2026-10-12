import { sdkModules } from "@grasp-os/compiler";
import { schemaHash } from "@grasp-os/sdk/host";
import { appLimits } from "@grasp-os/shared/app-limits";
import { sdkProtocolVersion } from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { sha256OfBytes } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { loadRelease, sealRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  commitFiles,
  createApp,
  findVersion,
  setCurrentVersion,
} from "../src/apps.ts";
import { createStore, deleteStore, openStore } from "../src/data-stores.ts";
import {
  sdkReleaseManifests,
  sdkResourceBindings,
} from "../src/db/core/schema.ts";
import { buildScreens } from "../src/screens.ts";
import { allEvents } from "./audit-events.ts";
import {
  appWith,
  artifactKey,
  failure,
  person,
  seal,
  shareStoreWith,
} from "./sealed-apps.ts";

// Sealing an App's release (spec 8, 16) through the real compiler, Loader
// isolates, R2 and D1: what a seal pins, that what it pins can't change
// under it, and the ways App code and storage could try to make it seal
// or run something else. Running a sealed release is
// app-functions.test.ts.

/** Notes, laid out as spec 8 has an App: its schema, operations and registration. */
const notesFiles = (label = "Notes"): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};

export default defineSchema({
  notes: defineTable(noteFields).index("by_updated", ["_updatedAt"]),
});
`,
  "operations/notes.ts": `import { v } from "@grasp-os/sdk";
import { internal } from "#grasp/server-references";
import { action, doc, internalQuery, mutation, query } from "#grasp/server";
import { noteFields } from "../schema.ts";

export const get = query({
  args: { id: v.id("notes") },
  returns: doc("notes").nullable(),
  handler: async (ctx, args) => await ctx.db.get("notes", args.id),
});

export const create = mutation({
  args: { title: noteFields.title, body: noteFields.body },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const count = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const notes = await ctx.db.query("notes").take(100);
    return notes.length;
  },
});

export const tally = action({
  args: {},
  returns: v.number(),
  uses: [internal.notes.count],
  handler: async (ctx) => await ctx.runQuery(internal.notes.count, {}),
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { count, create, get, tally } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: ${JSON.stringify(label)},
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { get, create, tally } },
  internalOperations: { notes: { count } },
  screens: [],
  uses: [],
});
`,
});

/** `files` with one more table, `name`, in its schema. */
const withTable = (
  files: Record<string, string>,
  name: string
): Record<string, string> => ({
  ...files,
  "schema.ts": (files["schema.ts"] ?? "").replace(
    "export default defineSchema({",
    `export default defineSchema({\n  ${name}: defineTable({ label: v.string() }),`
  ),
});

/** The artifact of `release` at `path`. */
const artifactAt = (release: Release, path: string) => {
  const entry = release.manifest.artifacts.find(
    (artifact) => artifact.path === path
  );
  if (entry === undefined) {
    throw new Error(`No artifact at ${path}`);
  }
  return entry;
};

/** How many builds of an App's server code R2 holds. */
const builds = async (): Promise<number> => {
  const listed = await env.FILES.list({ prefix: "app-builds/" });
  return listed.objects.length;
};

describe("sealing a release", { timeout: 120_000 }, () => {
  it("seals the SDK it was inspected with, and loads it back", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    const sdk = await sdkModules(env.ASSETS);
    const hashed: [string, string][] = await Promise.all(
      Object.entries(sdk.modules).map(
        async ([name, code]): Promise<[string, string]> => [
          `sdk/${name}`,
          await sha256Hex(code),
        ]
      )
    );
    const sealed = Object.fromEntries(hashed);
    const named = Object.fromEntries(
      release.manifest.artifacts
        .filter((artifact) => artifact.path.startsWith("sdk/"))
        .map((artifact) => [artifact.path, artifact.sha256])
    );
    const loaded = await loadRelease(env, fixture.app, 1);
    expect([named, loaded.sdk, release.manifest.sdkVersion]).toStrictEqual([
      sealed,
      sdk.modules,
      sdk.version,
    ]);
  });

  it("seals an App at exactly the App's file and size limits", async () => {
    const base = notesFiles();
    const padding = appLimits.files - Object.keys(base).length;
    const used = Object.values(base).reduce(
      (sum, source) => sum + source.length,
      0
    );
    const files: Record<string, string> = { ...base };
    let left = appLimits.totalLength - used;
    for (let index = 0; index < padding; index += 1) {
      const head = `export const pad${index} = ${index};\n//`;
      const share = Math.ceil(left / (padding - index));
      files[`operations/pad${index}.ts`] =
        `${head}${"x".repeat(share - head.length - 1)}\n`;
      left -= share;
    }
    const sizes = Object.values(files).map((source) => source.length);
    expect([
      sizes.length,
      sizes.reduce((sum, size) => sum + size, 0),
    ]).toStrictEqual([appLimits.files, appLimits.totalLength]);
    const release = await seal(await appWith(files));
    expect(release.manifest.resourceVersion).toBe(1);
  });

  it("pins the source, schema, contracts, runtime, store and every artifact by hash", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    const { tree } = await findVersion(env, fixture.app, 1);
    const schema = await schemaHash(release.app.schema);
    expect(release.manifest).toMatchObject({
      formatVersion: 1,
      resourceId: fixture.app,
      resourceVersion: 1,
      sourceTreeHash: tree,
      schemaHash: schema,
      sdkProtocolVersion: 1,
      target: "app",
      bindings: [],
      artifactTrust: "unreviewed",
      dataStoreBindings: [
        { alias: "default", storeId: fixture.store, schemaHash: schema },
      ],
    });
    expect(release.manifest.artifacts.map(({ path }) => path)).toStrictEqual(
      expect.arrayContaining([
        ".grasp/contracts.json",
        ".grasp/references.ts",
        ".grasp/server-references.ts",
        ".grasp/server.ts",
        ".grasp/verification.json",
        "modules/app~app.js",
        "modules/app~operations~notes.js",
        "modules/app~schema.js",
        "modules/app~.grasp~server.js",
      ])
    );
    expect(Object.keys(release.fingerprints).toSorted()).toStrictEqual([
      "notes.count",
      "notes.create",
      "notes.get",
      "notes.tally",
    ]);
  });

  it("generates references a browser may hold for this release, its public functions only", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    const references = await env.FILES.get(
      artifactKey(artifactAt(release, ".grasp/references.ts").sha256)
    );
    const text = (await references?.text()) ?? "";
    expect(text).toContain(`"resourceId": "${fixture.app}"`);
    expect(text).toContain('"contractId": "notes.create"');
    expect(text).not.toContain("notes.count");
  });

  it("records the store it bound apart from the manifest, and audits the seal", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    const bindings = await drizzle(env.DB)
      .select()
      .from(sdkResourceBindings)
      .where(eq(sdkResourceBindings.resourceId, fixture.app));
    expect(bindings).toStrictEqual([
      {
        resourceId: fixture.app,
        resourceVersion: 1,
        alias: "default",
        kind: "store",
        targetId: fixture.store,
        schemaHash: release.manifest.schemaHash,
        manifestHash: release.manifestHash,
      },
    ]);
    const events = await allEvents();
    const sealed = events.filter(
      (event) =>
        event.action === "app.release.sealed" &&
        event.target?.id === fixture.app
    );
    expect(sealed.map((event) => event.detail)).toStrictEqual([
      expect.objectContaining({
        version: 1,
        manifestHash: release.manifestHash,
        store: fixture.store,
      }),
    ]);
  });

  it("reads every artifact back against its hash, and answers the same release again", async () => {
    const fixture = await appWith(notesFiles());
    const sealed = await seal(fixture);
    const loaded = await loadRelease(env, fixture.app, 1);
    expect(loaded.manifestHash).toBe(sealed.manifestHash);
    expect(loaded.modules).toStrictEqual(sealed.modules);
    expect(loaded.app).toStrictEqual(sealed.app);
    // Sealed again, even asking for another store: the release as sealed.
    const other = await createStore(env, fixture.owner);
    const again = await sealRelease(env, {
      app: fixture.app,
      version: 1,
      store: other,
      by: fixture.owner,
    });
    expect([again.manifestHash, again.store?.storeId]).toStrictEqual([
      sealed.manifestHash,
      fixture.store,
    ]);
  });

  it("is never changed by a later edit of the source: that is another version", async () => {
    const fixture = await appWith(notesFiles());
    const first = await seal(fixture);
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      notesFiles("Notes, renamed"),
      "Rename"
    );
    const second = await seal(fixture, 2);
    const firstAgain = await loadRelease(env, fixture.app, 1);
    expect([firstAgain.manifestHash, firstAgain.app.name]).toStrictEqual([
      first.manifestHash,
      "Notes",
    ]);
    expect(second.app.name).toBe("Notes, renamed");
    expect([
      second.manifestHash === first.manifestHash,
      second.manifest.sourceTreeHash === first.manifest.sourceTreeHash,
    ]).toStrictEqual([false, false]);
    // The store survives the edit: it is the App's, not the version's.
    expect(second.store?.storeId).toBe(first.store?.storeId);
  });
});

/** A table-less App: nothing to store, so no store binding. */
const tablelessFiles = (): Record<string, string> => ({
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";
export default defineSchema({});
`,
  "operations/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "#grasp/server";
export const hello = query({ args: {}, returns: v.string(), handler: () => "hello" });
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { hello } from "./operations/hello.ts";
import schema from "./schema.ts";
export default app({
  name: "Hello",
  schema,
  access: {},
  operations: { hello: { hello } },
  screens: [],
  uses: [],
});
`,
});

/** JSON text that holds an object, as a mutable record. */
const jsonRecord = (text: string): Record<string, Json> => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Not a JSON object");
  }
  // SAFETY: parsed JSON, checked just above to be an object.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return parsed as Record<string, Json>;
};

/** What a consistent rewrite of a sealed release changes. */
interface Rewrite {
  /** Changes `contracts.json`, stored again under its new hash. */
  readonly contracts?: (contracts: Record<string, Json>) => void;
  /** Changes the manifest. */
  readonly manifest?: (manifest: Record<string, Json>) => void;
  /** The manifest's text, when not canonical. */
  readonly text?: (manifest: Record<string, Json>) => string;
}

/**
 * Rewrites the stored release of `app`'s version 1 as someone with write
 * access to storage could, consistently: every hash recomputed, the
 * manifest's, its artifacts' and the binding's, so only what the change
 * itself breaks can be refused.
 */
const rewrite = async (
  app: string,
  release: Release,
  change: Rewrite
): Promise<void> => {
  const manifest = jsonRecord(JSON.stringify(release.manifest));
  if (change.contracts !== undefined) {
    const entry = artifactAt(release, ".grasp/contracts.json");
    const stored = await env.FILES.get(artifactKey(entry.sha256));
    const contracts = jsonRecord((await stored?.text()) ?? "{}");
    change.contracts(contracts);
    const text = `${canonicalJson(contracts)}\n`;
    const bytes = new TextEncoder().encode(text);
    const sha256 = await sha256Hex(text);
    await env.FILES.put(artifactKey(sha256), bytes);
    manifest.artifacts = release.manifest.artifacts.map((artifact) =>
      artifact.path === entry.path
        ? { path: artifact.path, sha256, bytes: bytes.byteLength }
        : { ...artifact }
    );
    manifest.contractHash = sha256;
  }
  change.manifest?.(manifest);
  const text = change.text?.(manifest) ?? canonicalJson(manifest);
  const hash = await sha256Hex(text);
  await drizzle(env.DB)
    .update(sdkReleaseManifests)
    .set({ manifest: text, manifestHash: hash })
    .where(eq(sdkReleaseManifests.appId, app));
  await drizzle(env.DB)
    .update(sdkResourceBindings)
    .set({ manifestHash: hash })
    .where(eq(sdkResourceBindings.resourceId, app));
};

describe("a sealed release that changed", { timeout: 120_000 }, () => {
  it("loads exactly the text it hashed, a leading byte order mark included", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    // App source loses a leading mark when built, so storage adds one.
    const entry = artifactAt(release, "modules/app~operations~notes.js");
    const stored = await env.FILES.get(artifactKey(entry.sha256));
    const code = (await stored?.text()) ?? "";
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(code),
    ]);
    const sha256 = await sha256OfBytes(bytes);
    await env.FILES.put(artifactKey(sha256), bytes);
    await rewrite(fixture.app, release, {
      manifest: (manifest) => {
        manifest.artifacts = release.manifest.artifacts.map((artifact) =>
          artifact.path === entry.path
            ? { path: artifact.path, sha256, bytes: bytes.byteLength }
            : { ...artifact }
        );
      },
    });
    const loaded = await loadRelease(env, fixture.app, 1);
    expect(loaded.modules["app~operations~notes.js"]).toBe(`\uFEFF${code}`);
  });

  it("is refused when one of its artifacts' bytes no longer match their hash", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    // The same number of bytes, one of them changed: only the hash tells.
    const entry = artifactAt(release, "modules/app~operations~notes.js");
    const stored = await env.FILES.get(artifactKey(entry.sha256));
    const code = (await stored?.text()) ?? "";
    const forged = code.replace("notes", "motes");
    expect([forged.length, forged === code]).toStrictEqual([
      code.length,
      false,
    ]);
    await env.FILES.put(artifactKey(entry.sha256), forged);
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.artifact_corrupt");
  });

  it("is refused when it vouches for itself, even rewritten with every hash", async () => {
    const fixture = await appWith(tablelessFiles());
    const release = await seal(fixture);
    await rewrite(fixture.app, release, {
      manifest: (manifest) => {
        manifest.artifactTrust = "approved";
      },
    });
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.manifest_corrupt");
  });

  it("is refused as another platform's when sealed for another protocol, not as tampering", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    await rewrite(fixture.app, release, {
      manifest: (manifest) => {
        manifest.sdkProtocolVersion = sdkProtocolVersion + 1;
      },
    });
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.protocol_unsupported");
  });

  it("is refused when its manifest hashes right but isn't canonical", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    await rewrite(fixture.app, release, {
      text: (manifest) => JSON.stringify(manifest, null, 2),
    });
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.manifest_corrupt");
  });

  it.each([
    [
      "fingerprints that aren't its functions'",
      (contracts: Record<string, Json>) => {
        contracts.fingerprints = { "notes.get": "0".repeat(64) };
      },
    ],
    [
      "another version",
      (contracts: Record<string, Json>) => {
        contracts.resourceVersion = 2;
      },
    ],
    [
      "another App",
      (contracts: Record<string, Json>) => {
        contracts.resourceId = "app_other";
      },
    ],
  ])(
    "is refused when its contracts name %s, every hash rewritten",
    async (_case, change) => {
      const fixture = await appWith(notesFiles());
      const release = await seal(fixture);
      await rewrite(fixture.app, release, { contracts: change });
      await expect(
        failure(async () => await loadRelease(env, fixture.app, 1))
      ).resolves.toBe("version.artifact_corrupt");
    }
  );

  it("is refused when its schema hash isn't its contracts' schema's, every hash rewritten", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    await rewrite(fixture.app, release, {
      manifest: (manifest) => {
        manifest.schemaHash = "1".repeat(64);
        manifest.dataStoreBindings = [];
      },
    });
    await drizzle(env.DB)
      .delete(sdkResourceBindings)
      .where(eq(sdkResourceBindings.resourceId, fixture.app));
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.artifact_corrupt");
  });

  it("hands out releases nobody can change for the next load", async () => {
    const fixture = await appWith(notesFiles());
    const sealed = await seal(fixture);
    const loaded = await loadRelease(env, fixture.app, 1);
    expect([
      Object.isFrozen(sealed.modules),
      Object.isFrozen(sealed.fingerprints),
      Object.isFrozen(loaded.modules),
      Object.isFrozen(loaded.fingerprints),
      Object.isFrozen(loaded.manifest.artifacts),
    ]).toStrictEqual([true, true, true, true, true]);
  });

  it("is refused when an artifact is gone", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    await env.FILES.delete(
      artifactKey(artifactAt(release, ".grasp/contracts.json").sha256)
    );
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.artifact_corrupt");
  });

  it("is refused when its manifest no longer matches its hash, or it vouches for itself", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    const forged = JSON.stringify({
      ...release.manifest,
      artifactTrust: "approved",
    });
    await drizzle(env.DB)
      .update(sdkReleaseManifests)
      .set({ manifest: forged })
      .where(
        and(
          eq(sdkReleaseManifests.appId, fixture.app),
          eq(sdkReleaseManifests.version, 1)
        )
      );
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.manifest_corrupt");
  });

  it("is refused when its manifest and hash were both rewritten, as its binding names the hash sealed", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    const forged = JSON.stringify({ ...release.manifest, bindings: [] });
    await drizzle(env.DB)
      .update(sdkReleaseManifests)
      .set({ manifest: forged, manifestHash: await sha256Hex(forged) })
      .where(eq(sdkReleaseManifests.appId, fixture.app));
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.manifest_corrupt");
  });

  it("is refused when the host's binding names another store than the manifest", async () => {
    const fixture = await appWith(notesFiles());
    await seal(fixture);
    const other = await createStore(env, fixture.owner);
    await drizzle(env.DB)
      .update(sdkResourceBindings)
      .set({ targetId: other })
      .where(eq(sdkResourceBindings.resourceId, fixture.app));
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.manifest_corrupt");
  });

  it("is refused to an invocation pinned to another manifest", async () => {
    const fixture = await appWith(notesFiles());
    await seal(fixture);
    await expect(
      failure(
        async () => await loadRelease(env, fixture.app, 1, "0".repeat(64))
      )
    ).resolves.toBe("version.manifest_corrupt");
  });

  it("is never there for a version not sealed", async () => {
    const fixture = await appWith(notesFiles());
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.not_sealed");
  });
});

describe("App code that a seal refuses", { timeout: 120_000 }, () => {
  /** Notes with `changes` to its files, sealed. */
  const sealedWith = async (
    changes: Record<string, string>
  ): Promise<string> => {
    const fixture = await appWith({ ...notesFiles(), ...changes });
    return await failure(async () => await seal(fixture));
  };

  it("can't reach the network while it is inspected", async () => {
    await expect(
      sealedWith({
        "app.ts": `${notesFiles()["app.ts"]}\nawait fetch("https://example.com");\n`,
      })
    ).resolves.toBe("version.inspection_failed");
  });

  it("must register an App", async () => {
    await expect(
      sealedWith({ "app.ts": "export default { name: 'Notes' };\n" })
    ).resolves.toBe("version.inspection_failed");
  });

  it("can't hand the host a manifest it didn't declare", async () => {
    // The App's code makes the SDK in its isolate answer a query that
    // writes: no declaration makes that, so the host refuses it.
    const forging = `${notesFiles()["app.ts"]}
const stringify = JSON.stringify;
JSON.stringify = (value, ...rest) => {
  const text = stringify(value, ...rest);
  return typeof value === "object" && value !== null && "operations" in value
    ? text.replace('"insert":false', '"insert":true')
    : text;
};
`;
    await expect(sealedWith({ "app.ts": forging })).resolves.toBe(
      "version.invalid_manifest"
    );
  });

  it("can't register differently each time it is inspected", async () => {
    const shifting = notesFiles()["app.ts"]?.replace(
      'name: "Notes"',
      'name: "Notes " + Math.random().toString(36).slice(2, 10)'
    );
    await expect(sealedWith({ "app.ts": shifting ?? "" })).resolves.toBe(
      "version.unstable_manifest"
    );
  });

  it.each([
    [
      "a schema that imports an operation",
      {
        "schema.ts": `import "./operations/notes.ts";\n${notesFiles()["schema.ts"]}`,
      },
    ],
    [
      "server code that imports the Workers runtime",
      {
        "operations/extra.ts":
          'import { env } from "cloudflare:workers";\nexport const leak = env;\n',
      },
    ],
    [
      "server code that imports a platform-only SDK module",
      {
        "operations/extra.ts":
          'import { inspectApp } from "@grasp-os/sdk/host";\nexport const peek = inspectApp;\n',
      },
    ],
    [
      "server code that imports a module by a computed name",
      {
        "operations/extra.ts":
          'const name = "cloudflare:" + "workers";\nexport const load = () => import(name);\n',
      },
    ],
  ])("doesn't build with %s", async (_case, changes) => {
    await expect(sealedWith(changes)).resolves.toBe("version.build_failed");
  });

  it("can't be bound to a store another App's releases use, and never touches its tables", async () => {
    const first = await appWith(notesFiles());
    await seal(first);
    const second = await appWith(withTable(notesFiles(), "beta"));
    // The second's owner manages the store too: only the claim refuses.
    await shareStoreWith(first, second);
    await expect(
      failure(
        async () =>
          await sealRelease(env, {
            app: second.app,
            version: 1,
            store: first.store,
            by: second.owner,
          })
      )
    ).resolves.toBe("version.store_bound_elsewhere");
    const opened = await openStore(env, first.store);
    await expect(opened.generations(["beta"])).resolves.toStrictEqual({});
  });

  it("goes to exactly one of two Apps sealed onto a new store at once, and only its tables", async () => {
    const alpha = await appWith(withTable(notesFiles(), "alpha"));
    const beta = await appWith(withTable(notesFiles(), "beta"));
    const store = await createStore(env, alpha.owner);
    // Both owners manage the store: only the claim decides.
    await shareStoreWith({ ...alpha, store }, beta);
    const outcomes = await Promise.all(
      [alpha, beta].map(
        async (fixture) =>
          await failure(
            async () =>
              await sealRelease(env, {
                app: fixture.app,
                version: 1,
                store,
                by: fixture.owner,
              })
          )
      )
    );
    expect(outcomes.toSorted()).toStrictEqual([
      "ok",
      "version.store_bound_elsewhere",
    ]);
    const loser = outcomes[0] === "ok" ? "beta" : "alpha";
    const opened = await openStore(env, store);
    await expect(opened.generations([loser])).resolves.toStrictEqual({});
  });

  it("is refused a store its sealer doesn't manage, before its code is built or run, and claims nothing", async () => {
    const first = await appWith(notesFiles());
    // Files no other seal builds: any build of them is this seal's.
    const second = await appWith({
      ...withTable(notesFiles(), "beta"),
      "operations/marker.ts": `export const marker = ${JSON.stringify(crypto.randomUUID())};\n`,
    });
    const before = await builds();
    await expect(
      failure(
        async () =>
          await sealRelease(env, {
            app: second.app,
            version: 1,
            store: first.store,
            by: second.owner,
          })
      )
    ).resolves.toBe("data.store_unavailable");
    const claims = await env.DB.prepare(
      "SELECT app_id FROM sdk_store_owners WHERE store_id = ?"
    )
      .bind(first.store)
      .all();
    const opened = await openStore(env, first.store);
    // Nothing built, so nothing inspected: the store was checked first.
    expect([await builds(), claims.results]).toStrictEqual([before, []]);
    // Never handed a schema: no tables were defined there either.
    await expect(opened.generations(["beta"])).rejects.toThrow(
      /wasn't handed/u
    );
  });

  it("keeps its store from being deleted while its version is current, and lets it go once none bound is", async () => {
    const fixture = await appWith(notesFiles());
    await seal(fixture);
    await setCurrentVersion(env, fixture.owner, fixture.app, 1);
    const refused = await failure(async () => {
      await deleteStore(env, fixture.owner, fixture.store);
    });
    const events = await allEvents();
    // A version without tables made current: no current release binds it.
    await commitFiles(env, fixture.owner, fixture.app, tablelessFiles(), "Two");
    await seal(fixture, 2);
    await setCurrentVersion(env, fixture.owner, fixture.app, 2);
    // Version 1 pending again (as an upgrade waiting for approval would
    // leave it): its calls may run again, so the store stays.
    await env.DB.prepare("UPDATE apps SET pending_version = 1 WHERE id = ?")
      .bind(fixture.app)
      .run();
    const pending = await failure(async () => {
      await deleteStore(env, fixture.owner, fixture.store);
    });
    await env.DB.prepare("UPDATE apps SET pending_version = NULL WHERE id = ?")
      .bind(fixture.app)
      .run();
    await deleteStore(env, fixture.owner, fixture.store);
    expect([
      pending,
      refused,
      events.some(
        (event) =>
          event.action === "store.delete_refused" &&
          event.target?.id === fixture.store &&
          event.detail?.reason === "data.store_bound"
      ),
      await failure(async () => await openStore(env, fixture.store)),
    ]).toStrictEqual([
      "data.store_bound",
      "data.store_bound",
      true,
      "data.store_unavailable",
    ]);
  });

  it("is refused a store that doesn't exist, and to Grasp staff, claiming nothing", async () => {
    const fixture = await appWith(notesFiles());
    const missing = crypto.randomUUID();
    const outcomes = [
      await failure(
        async () =>
          await sealRelease(env, {
            app: fixture.app,
            version: 1,
            // SAFETY: a well-formed ID the inventory doesn't list.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            store: missing as typeof fixture.store,
            by: fixture.owner,
          })
      ),
      await failure(
        async () =>
          await sealRelease(env, {
            app: fixture.app,
            version: 1,
            store: fixture.store,
            by: { ...fixture.owner, staff: true },
          })
      ),
    ];
    const claims = await env.DB.prepare(
      "SELECT store_id FROM sdk_store_owners WHERE store_id IN (?, ?)"
    )
      .bind(missing, fixture.store)
      .all();
    expect([outcomes, claims.results]).toStrictEqual([
      ["data.store_unavailable", "role.forbidden"],
      [],
    ]);
  });

  it("seals server code that imports the App's preferences, and functions at any segment a reference doesn't answer", async () => {
    const files = notesFiles();
    const fixture = await appWith({
      ...files,
      "operations/extra.ts": `import { v } from "@grasp-os/sdk";
import { api, preferences } from "#grasp";
import { action, query } from "#grasp/server";

export const defaults = query({
  args: {},
  returns: v.boolean(),
  handler: () => preferences.descriptor !== null,
});

export const reach = action({
  args: {},
  returns: v.boolean(),
  uses: [api.extra.defaults],
  handler: async (ctx) => await ctx.runQuery(api.extra.defaults, {}),
});
`,
      "app.ts": (files["app.ts"] ?? "")
        .replace(
          'import schema from "./schema.ts";',
          'import schema from "./schema.ts";\nimport { defaults, reach } from "./operations/extra.ts";\nimport { v } from "@grasp-os/sdk";'
        )
        .replace(
          "operations: { notes: { get, create, tally } },",
          "operations: { notes: { get, create, tally }, extra: { defaults, reach } },\n  preferences: v.object({ compact: v.boolean().default(false) }),"
        ),
    });
    const release = await seal(fixture);
    expect([
      release.app.preferences !== null,
      release.app.operations["extra.reach"]?.uses,
    ]).toStrictEqual([
      true,
      [{ type: "function", path: "extra.defaults", kind: "query" }],
    ]);
  });

  it("needs a store the host binds when it declares tables", async () => {
    const fixture = await appWith(notesFiles());
    await expect(
      failure(
        async () =>
          await sealRelease(env, {
            app: fixture.app,
            version: 1,
            by: fixture.owner,
          })
      )
    ).resolves.toBe("version.store_unbound");
  });

  it("is an App of spec 8's layout, not a server class", async () => {
    const fixture = await appWith({
      "app/server.ts": "export class App {}\n",
    });
    await expect(failure(async () => await seal(fixture))).resolves.toBe(
      "version.unsealable"
    );
  });

  it("can't put generated modules in its source", async () => {
    const owner = await person("builder");
    const { id } = await createApp(env, owner, { name: "Notes" });
    await expect(
      failure(
        async () =>
          await commitFiles(
            env,
            owner,
            id,
            {
              ...notesFiles(),
              ".grasp/references.ts": "export const api = {};\n",
            },
            "Forged references"
          )
      )
    ).resolves.toBe("app.invalid");
  });
});

describe("screens", { timeout: 120_000 }, () => {
  it.each([
    ["the server constructors", 'import { query } from "#grasp/server";'],
    [
      "the internal references",
      'import { internal } from "#grasp/server-references";',
    ],
    ["the schema", 'import schema from "../schema.ts";'],
    ["the registration", 'import notes from "../app";'],
    ["an operation", 'import { create } from "../operations/notes.ts";'],
    ["the host's SDK", 'import { inspectApp } from "@grasp-os/sdk/host";'],
  ])(
    "never import %s: the build fails before it starts",
    async (_case, line) => {
      const build = await buildScreens(env, {
        ...notesFiles(),
        "screens/notes.tsx": `${line}\nexport default function Notes() {\n  return null;\n}\n`,
      });
      expect(build.ok).toBeFalsy();
      expect(build.diagnostics.map(({ message }) => message)).toStrictEqual([
        expect.stringContaining(
          "is the App's server code, which screens never import"
        ),
      ]);
    }
  );
});
