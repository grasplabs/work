import { serverSdkModules } from "@grasp-os/compiler";
import { schemaHash } from "@grasp-os/sdk/host";
import { appLimits } from "@grasp-os/shared/app-limits";
import {
  releaseFormatVersion,
  sdkProtocolVersion,
} from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { sha256OfBytes } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { inspected } from "../src/app-inspection.ts";
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
import { platformRunner } from "../src/platform-sandbox.ts";
import {
  buildAppCode,
  buildAppTests,
  buildScreens,
  buildWorkflows,
} from "../src/screens.ts";
import { allEvents } from "./audit-events.ts";
import {
  appWith,
  artifactKey,
  failure,
  person,
  seal,
  shareStoreWith,
  sweptAway,
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
    const sdk = await serverSdkModules(env.ASSETS);
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
    expect([
      named,
      loaded.sdk,
      release.manifest.sdkVersion,
      // The server's SDK set only: never the workflow SDK it doesn't use.
      Object.keys(named).filter((path) => path.includes("workflow")),
    ]).toStrictEqual([sealed, sdk.modules, sdk.version, []]);
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
      formatVersion: releaseFormatVersion,
      resourceId: fixture.app,
      resourceVersion: 1,
      sourceTreeHash: tree,
      schemaHash: schema,
      sdkProtocolVersion,
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
        // The store's first definition (business_store_versions).
        targetVersion: 1,
        // A store's binding names no contract key.
        contractId: null,
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

/** Where a release's check evidence is among its artifacts. */
const evidencePath = ".grasp/verification.json";

/** What a consistent rewrite of a sealed release changes. */
interface Rewrite {
  /** Changes the check's evidence, recorded again for the rewritten release first. */
  readonly evidence?: (evidence: Record<string, Json>) => void;
  /** The evidence's text, when not canonical. */
  readonly evidenceText?: (evidence: Record<string, Json>) => string;
  /** Changes the manifest once its evidence is recorded again. */
  readonly last?: (manifest: Record<string, Json>) => void;
  /** Changes `contracts.json`, stored again under its new hash. */
  readonly contracts?: (contracts: Record<string, Json>) => void;
  /** Changes the manifest. */
  readonly manifest?: (manifest: Record<string, Json>) => void;
  /** The manifest's text, when not canonical. */
  readonly text?: (manifest: Record<string, Json>) => string;
}

/** The text of the stored artifact `entry` names, as a load decodes it. */
const storedText = async (entry: Json): Promise<[string, string]> => {
  const { path, sha256 } = z
    .object({ path: z.string(), sha256: z.string() })
    .parse(entry);
  const stored = await env.FILES.get(artifactKey(sha256));
  const bytes = (await stored?.arrayBuffer()) ?? new ArrayBuffer(0);
  return [
    path,
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  ];
};

/** The modules among `manifest`'s artifacts under `dir`, by name. */
const modulesUnder = async (
  manifest: Record<string, Json>,
  dir: string
): Promise<Record<string, string>> => {
  const entries = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const texts = await Promise.all(entries.map(storedText));
  return Object.fromEntries(
    texts
      .filter(([path]) => path.startsWith(dir))
      .map(([path, text]) => [path.slice(dir.length), text])
  );
};

/**
 * Records the check's evidence of `release` again for `manifest`, its
 * rewrite, as someone with write access to storage could: its identities
 * the rewritten manifest's and the hashes of its modules, SDK and
 * migration evidence recomputed, then `change.evidence` applied, stored
 * under its new hash and named by the manifest.
 */
const recordEvidence = async (
  release: Release,
  manifest: Record<string, Json>,
  change: Rewrite
): Promise<void> => {
  const entry = artifactAt(release, evidencePath);
  const stored = await env.FILES.get(artifactKey(entry.sha256));
  const evidence = jsonRecord((await stored?.text()) ?? "{}");
  const observed = jsonRecord(JSON.stringify(evidence.observed));
  evidence.source = {
    resourceId: manifest.resourceId ?? null,
    sourceTreeHash: manifest.sourceTreeHash ?? null,
  };
  evidence.candidate = {
    resourceVersion: manifest.resourceVersion ?? null,
    contractHash: manifest.contractHash ?? null,
    schemaHash: manifest.schemaHash ?? null,
  };
  evidence.profile = {
    target: manifest.target ?? null,
    compilerVersion: manifest.compilerVersion ?? null,
    sdkVersion: manifest.sdkVersion ?? null,
    sdkProtocolVersion: manifest.sdkProtocolVersion ?? null,
    uiVersion: manifest.uiVersion ?? null,
  };
  observed.checkedModules = await sha256Hex(
    canonicalJson(await modulesUnder(manifest, "modules/"))
  );
  observed.sdkModules = await sha256Hex(
    canonicalJson(await modulesUnder(manifest, "sdk/"))
  );
  observed.migrations = await sha256Hex(
    canonicalJson(manifest.migrationEvidence ?? null)
  );
  evidence.observed = observed;
  change.evidence?.(evidence);
  const text = change.evidenceText?.(evidence) ?? canonicalJson(evidence);
  const bytes = new TextEncoder().encode(text);
  const sha256 = await sha256Hex(text);
  await env.FILES.put(artifactKey(sha256), bytes);
  const artifacts: readonly Json[] = Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : [];
  manifest.artifacts = artifacts.map((artifact) =>
    z.object({ path: z.string() }).parse(artifact).path === evidencePath
      ? { path: evidencePath, sha256, bytes: bytes.byteLength }
      : artifact
  );
  manifest.verificationReportHash = sha256;
};

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
  await recordEvidence(release, manifest, change);
  change.last?.(manifest);
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

  it("is refused as sealed in another format, to seal again, not as tampering", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    await rewrite(fixture.app, release, {
      manifest: (manifest) => {
        manifest.formatVersion = releaseFormatVersion - 1;
      },
    });
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.format_unsupported");
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

  it.each([
    [
      "names another kind of release",
      (manifest: Record<string, Json>) => {
        manifest.target = "workflow";
      },
    ],
    [
      "binds a second store",
      (manifest: Record<string, Json>) => {
        // Its one binding, twice: the first still agrees with the host's.
        const bindings: readonly Json[] = Array.isArray(
          manifest.dataStoreBindings
        )
          ? manifest.dataStoreBindings.map((binding: Json) => binding)
          : [];
        manifest.dataStoreBindings = [...bindings, ...bindings];
      },
    ],
  ])("is refused when it %s, every hash rewritten", async (_case, change) => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    await rewrite(fixture.app, release, { manifest: change });
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.manifest_corrupt");
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

  it("answers the next load of a release whose first load was cancelled mid-read", async () => {
    const fixture = await appWith(tablelessFiles());
    const sealed = await seal(fixture);
    // R2 that never answers a read: as the first load's request was
    // cancelled while it read, which workerd never settles.
    const reading = Promise.withResolvers<boolean>();
    const stuck = new Proxy(env.FILES, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (property === "get") {
          return async (): Promise<never> => {
            reading.resolve(true);
            return await Promise.withResolvers<never>().promise;
          };
        }
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const bounded = { ...env, RELEASE_READ_MS: "50" };
    // Never awaited: it never answers.
    const cancelled = loadRelease({ ...bounded, FILES: stuck }, fixture.app, 1);
    await reading.promise;

    const next = await Promise.race([
      loadRelease(bounded, fixture.app, 1),
      scheduler.wait(5000).then(() => "still waiting" as const),
    ]);

    expect(next === "still waiting" ? next : next.manifestHash).toBe(
      sealed.manifestHash
    );
    await expect(
      Promise.race([cancelled, Promise.resolve("never answers")])
    ).resolves.toBe("never answers");
  });

  it("verifies a release anew after a load of it failed, keeping no failure", async () => {
    const fixture = await appWith(tablelessFiles());
    const sealed = await seal(fixture);
    const entry = artifactAt(sealed, ".grasp/contracts.json");
    const key = artifactKey(entry.sha256);
    const stored = await env.FILES.get(key);
    const bytes = (await stored?.arrayBuffer()) ?? new ArrayBuffer(0);
    await env.FILES.delete(key);
    const failed = await failure(
      async () => await loadRelease(env, fixture.app, 1)
    );
    await env.FILES.put(key, bytes);

    const loaded = await loadRelease(env, fixture.app, 1);

    expect({
      failed,
      manifestHash: loaded.manifestHash,
      manifest: loaded.manifest,
      app: loaded.app,
      modules: loaded.modules,
      sdk: loaded.sdk,
    }).toStrictEqual({
      failed: "version.artifact_corrupt",
      manifestHash: sealed.manifestHash,
      manifest: sealed.manifest,
      app: sealed.app,
      modules: sealed.modules,
      sdk: sealed.sdk,
    });
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

/** What loading `app`'s version 1 was refused with: its code, and the artifact it names. */
const refusedLoad = async (app: AppId): Promise<string> => {
  try {
    await loadRelease(env, app, 1);
  } catch (error) {
    const refused = z
      .object({
        code: z.string(),
        details: z.object({ path: z.string() }).partial().optional(),
      })
      .safeParse(error);
    return refused.success
      ? `${refused.data.code} at ${refused.data.details?.path ?? "none"}`
      : String(error);
  }
  return "loaded";
};

/** `record`'s object member `key`, as a mutable record. */
const member = (record: Record<string, Json>, key: string) =>
  jsonRecord(JSON.stringify(record[key] ?? null));

/** `change` made to `evidence`'s section `key`. */
const inSection =
  (key: string, change: (section: Record<string, Json>) => void) =>
  (evidence: Record<string, Json>): void => {
    const section = member(evidence, key);
    change(section);
    evidence[key] = section;
  };

const otherHash = "1".repeat(64);

describe(
  "the evidence a seal records of its checks",
  { timeout: 120_000 },
  () => {
    it("names the release it checked and what it checked, by hash", async () => {
      const fixture = await appWith(notesFiles());
      const release = await seal(fixture);
      const entry = artifactAt(release, evidencePath);
      const stored = await env.FILES.get(artifactKey(entry.sha256));
      const evidence = jsonRecord((await stored?.text()) ?? "{}");
      const { manifest } = release;
      const { tree } = await findVersion(env, fixture.app, 1);
      expect({
        reportHash: manifest.verificationReportHash,
        source: evidence.source,
        candidate: evidence.candidate,
        profile: evidence.profile,
        manifest: member(evidence, "observed").manifest,
        checkedModules: member(evidence, "observed").checkedModules,
        sdkModules: member(evidence, "observed").sdkModules,
        finalInspection: member(evidence, "observed").finalInspection,
      }).toStrictEqual({
        reportHash: entry.sha256,
        source: {
          resourceId: fixture.app,
          sourceTreeHash: tree,
        },
        candidate: {
          resourceVersion: 1,
          contractHash: manifest.contractHash,
          schemaHash: await schemaHash(release.app.schema),
        },
        profile: {
          target: "app",
          compilerVersion: manifest.compilerVersion,
          sdkVersion: manifest.sdkVersion,
          sdkProtocolVersion,
          uiVersion: manifest.uiVersion,
        },
        manifest: await sha256Hex(
          canonicalJson(jsonRecord(JSON.stringify(release.app)))
        ),
        checkedModules: await sha256Hex(canonicalJson(release.modules)),
        sdkModules: await sha256Hex(canonicalJson(release.sdk)),
        // The same code and SDK register the same: what inspecting the
        // sealed release answers now is what the seal's inspection did.
        finalInspection: await sha256Hex(
          await inspected(env, release.modules, release.sdk)
        ),
      });
    });

    it("loads when recorded again consistently, every hash rewritten", async () => {
      const fixture = await appWith(notesFiles());
      const release = await seal(fixture);
      await rewrite(fixture.app, release, {});
      await expect(refusedLoad(fixture.app)).resolves.toBe("loaded");
    });

    it.each([
      [
        "another App",
        inSection("source", (s) => {
          s.resourceId = "app_other";
        }),
      ],
      [
        "another source tree",
        inSection("source", (s) => {
          s.sourceTreeHash = otherHash;
        }),
      ],
      [
        "another version",
        inSection("candidate", (s) => {
          s.resourceVersion = 2;
        }),
      ],
      [
        "other contracts",
        inSection("candidate", (s) => {
          s.contractHash = otherHash;
        }),
      ],
      [
        "another schema",
        inSection("candidate", (s) => {
          s.schemaHash = otherHash;
        }),
      ],
      [
        "another kind of release",
        inSection("profile", (s) => {
          s.target = "workflow";
        }),
      ],
      [
        "another compiler",
        inSection("profile", (s) => {
          s.compilerVersion = "0.0.0-other";
        }),
      ],
      [
        "another SDK",
        inSection("profile", (s) => {
          s.sdkVersion = "0.0.0-other";
        }),
      ],
      [
        "another UI kit",
        inSection("profile", (s) => {
          s.uiVersion = "0.0.0-other";
        }),
      ],
      [
        "code it didn't check",
        inSection("observed", (s) => {
          s.checkedModules = otherHash;
        }),
      ],
      [
        "another SDK's modules",
        inSection("observed", (s) => {
          s.sdkModules = otherHash;
        }),
      ],
      [
        "another registration",
        inSection("observed", (s) => {
          s.manifest = otherHash;
        }),
      ],
      [
        "other migration evidence",
        inSection("observed", (s) => {
          s.migrations = otherHash;
        }),
      ],
      [
        "a trust of its own",
        (evidence: Record<string, Json>) => {
          evidence.artifactTrust = "approved";
        },
      ],
    ])(
      "refuses the release when its evidence names %s, every hash rewritten",
      async (_case, change) => {
        const fixture = await appWith(notesFiles());
        const release = await seal(fixture);
        await rewrite(fixture.app, release, { evidence: change });
        await expect(refusedLoad(fixture.app)).resolves.toBe(
          `version.artifact_corrupt at ${evidencePath}`
        );
      }
    );

    it.each([
      [
        "another source tree",
        (manifest: Record<string, Json>) => {
          manifest.sourceTreeHash = otherHash;
        },
      ],
      [
        "another compiler",
        (manifest: Record<string, Json>) => {
          manifest.compilerVersion = "0.0.0-other";
        },
      ],
      [
        "no evidence",
        (manifest: Record<string, Json>) => {
          const artifacts = Array.isArray(manifest.artifacts)
            ? manifest.artifacts
            : [];
          manifest.artifacts = artifacts.filter(
            (artifact) =>
              z.object({ path: z.string() }).parse(artifact).path !==
              evidencePath
          );
        },
      ],
    ])(
      "refuses the release when its manifest names %s than its evidence, every hash rewritten",
      async (_case, change) => {
        const fixture = await appWith(notesFiles());
        const release = await seal(fixture);
        await rewrite(fixture.app, release, { last: change });
        await expect(refusedLoad(fixture.app)).resolves.toBe(
          `version.artifact_corrupt at ${evidencePath}`
        );
      }
    );

    it("refuses the release when its report hash names another artifact, every hash rewritten", async () => {
      const fixture = await appWith(notesFiles());
      const release = await seal(fixture);
      const contracts = artifactAt(release, ".grasp/contracts.json");
      await rewrite(fixture.app, release, {
        last: (manifest) => {
          manifest.verificationReportHash = contracts.sha256;
        },
      });
      await expect(refusedLoad(fixture.app)).resolves.toBe(
        `version.artifact_corrupt at ${evidencePath}`
      );
    });

    it.each([
      [
        "isn't canonical",
        (evidence: Record<string, Json>) => JSON.stringify(evidence, null, 2),
      ],
      ["isn't JSON", () => "checked: yes"],
    ])(
      "refuses the release when its evidence %s, every hash rewritten",
      async (_case, text) => {
        const fixture = await appWith(notesFiles());
        const release = await seal(fixture);
        await rewrite(fixture.app, release, { evidenceText: text });
        await expect(refusedLoad(fixture.app)).resolves.toBe(
          `version.artifact_corrupt at ${evidencePath}`
        );
      }
    );
  }
);

/** What a seal of `files` was refused with: its code, and the files its diagnostics name. */
const refusedSeal = async (
  files: Record<string, string>
): Promise<{ code: string; files: string[] }> => {
  const fixture = await appWith(files);
  try {
    await seal(fixture);
    return { code: "ok", files: [] };
  } catch (error) {
    const refusal = z
      .object({
        code: z.string(),
        details: z
          .object({
            diagnostics: z.array(z.object({ file: z.string().nullable() })),
          })
          .optional(),
      })
      .safeParse(error);
    if (!refusal.success) {
      return { code: String(error), files: [] };
    }
    const { code, details } = refusal.data;
    return {
      code,
      files: [
        ...new Set(
          (details?.diagnostics ?? []).map(({ file }) => file ?? "(App)")
        ),
      ].toSorted(),
    };
  }
};

/** An operation file added to the notes, holding `source`. */
const withOperation = (source: string): Record<string, string> => ({
  ...notesFiles(),
  "operations/extra.ts": source,
});

describe("server code a seal type-checks", { timeout: 120_000 }, () => {
  it.each([
    [
      "a DOM global, which its isolate doesn't have",
      "export const title = (): string => document.title;\n",
    ],
    [
      "browser storage",
      'export const saved = (): string | null => localStorage.getItem("x");\n',
    ],
    [
      "a type error",
      'import { v } from "@grasp-os/sdk";\nimport { query } from "#grasp/server";\n\nexport const wrong = query({ args: {}, returns: v.string(), handler: () => 1 });\n',
    ],
    [
      "a path into the kit's packages, for its types",
      'import type { runScreen } from "../node_modules/@grasp-os/sdk/src/screen-runtime.ts";\nexport type Reached = typeof runScreen;\n',
    ],
    [
      "a module of the kit's screens, for its types",
      'import type { ReactNode } from "react";\nexport type Reached = ReactNode;\n',
    ],
    [
      "a module the SDK doesn't give it, named with a trailing slash",
      'import type { GraspClient } from "@grasp-os/sdk/client/";\nexport type Reached = GraspClient;\n',
    ],
    [
      "a reference path into the kit",
      '/// <reference path="../node_modules/@grasp-os/sdk/src/client.ts" />\nexport const extra = 1;\n',
    ],
    [
      "a lib it references, the DOM's",
      '/// <reference lib="dom" />\nexport const title = (): string => document.title;\n',
    ],
    [
      "a types reference",
      '/// <reference types="node" />\nexport const extra = 1;\n',
    ],
    [
      "a dynamic import of the platform's bootstrap",
      'export const load = async (): Promise<unknown> => await import("@grasp-os/sdk/client");\n',
    ],
    [
      "a type's import() of the platform's bootstrap",
      'export type Host = typeof import("@grasp-os/sdk/host");\n',
    ],
    [
      "a re-export of everything of the platform's bootstrap",
      'export * from "@grasp-os/sdk/client";\n',
    ],
    [
      "a require-style import of the platform's bootstrap",
      'import client = require("@grasp-os/sdk/client");\nexport const reached = client;\n',
    ],
    [
      "a line the type check is told to ignore",
      "// @ts-ignore\nexport const title = (): string => document.title;\n",
    ],
    [
      "an error the type check is told to expect",
      "// @ts-expect-error\nexport const title = (): string => document.title;\n",
    ],
    [
      "a file the type check is told to skip",
      "// @ts-nocheck\nexport const title = (): string => document.title;\n",
    ],
    [
      "a line the type check is told to ignore, run into the next word",
      "// @ts-ignoreX\nexport const title = (): string => document.title;\n",
    ],
    [
      "a line the type check is told to ignore, in a block comment",
      "/***@ts-ignore*/\nexport const title = (): string => document.title;\n",
    ],
    [
      "a file the type check is told to skip, in another case",
      "// @ts-NoCheck\nexport const title = (): string => document.title;\n",
    ],
    [
      "an ambient module that shadows the SDK's",
      'declare module "@grasp-os/sdk" {\n  export const leak: number;\n}\nexport const extra = 1;\n',
    ],
  ])("refuses %s", async (_case, source) => {
    await expect(refusedSeal(withOperation(source))).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["operations/extra.ts"],
    });
  });

  it("refuses a name of another file that shares none, as the build loads each file on its own", async () => {
    // Without imports or exports, TypeScript would read the other file as
    // a script whose names every file sees; the build makes each a module.
    await expect(
      refusedSeal({
        ...withOperation("export const greeting = (): string => shared;\n"),
        "operations/extra-name.ts": 'const shared = "Hi";\n',
      })
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["operations/extra.ts"],
    });
  });

  it("refuses a test's type error with the server code's", async () => {
    await expect(
      refusedSeal({
        ...notesFiles(),
        "tests/helper.ts": 'export const count: number = "none";\n',
      })
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["tests/helper.ts"],
    });
  });

  it("checks no test that steers the check, so it gives the server code nothing", async () => {
    // A test that doesn't build (here, globals it declares) never joins
    // the check: the operation's `document` stays an error. It is refused
    // where tests run, as a version is made current.
    await expect(
      refusedSeal({
        ...withOperation(
          "export const title = (): string => document.title;\n"
        ),
        "tests/helper.ts":
          "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
      })
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["operations/extra.ts"],
    });
  });

  it("refuses a test that runs a streaming action as one that answers once", async () => {
    // A streaming action runs only for a screen following it (spec
    // 10.7.6): a test principal's `action` answers once, so its type
    // refuses one, as the host does (`operation.mode_mismatch`).
    const streamed = {
      ...notesFiles(),
      "operations/streams.ts": `import { v } from "@grasp-os/sdk";
import { action } from "#grasp/server";

export const once = action({ args: {}, returns: v.number(), handler: async () => 1 });

export const progress = action({
  args: {},
  returns: v.number(),
  stream: v.object({ done: v.number() }),
  handler: async (ctx) => {
    await ctx.emit({ done: 1 });
    return 1;
  },
});
`,
      "app.ts": (notesFiles()["app.ts"] ?? "")
        .replace(
          'import schema from "./schema.ts";',
          'import { once, progress } from "./operations/streams.ts";\nimport schema from "./schema.ts";'
        )
        .replace(
          "operations: { notes: { get, create, tally } },",
          "operations: { notes: { get, create, tally }, streams: { once, progress } },"
        ),
    };
    const running = (reference: string): Record<string, string> => ({
      ...streamed,
      "tests/helper.ts": `import type { api } from "#grasp";
import type { TestPrincipal } from "@grasp-os/sdk/testing";

export const run = async (principal: TestPrincipal, refs: typeof api, flag: boolean): Promise<number> =>
  await principal.action(${reference}, {});
`,
    });
    await expect(
      Promise.all(
        [
          "refs.streams.once",
          "refs.streams.progress",
          // Either one: it may stream, so it is refused as well.
          "flag ? refs.streams.once : refs.streams.progress",
        ].map(async (reference) => await refusedSeal(running(reference)))
      )
    ).resolves.toStrictEqual([
      { code: "ok", files: [] },
      { code: "version.build_failed", files: ["tests/helper.ts"] },
      { code: "version.build_failed", files: ["tests/helper.ts"] },
    ]);
  });

  it("seals tests that name the App's references and the SDK's testing module for their types", async () => {
    await expect(
      refusedSeal({
        ...notesFiles(),
        "tests/helper.ts":
          'import type { api } from "#grasp";\nimport type * as testing from "@grasp-os/sdk/testing";\nexport type Checked = [typeof api, typeof testing];\n',
      })
    ).resolves.toStrictEqual({ code: "ok", files: [] });
  });

  it("refuses a migration's global declarations, which the rest of the server code would see", async () => {
    await expect(
      refusedSeal({
        ...withOperation(
          "export const title = (): string => document.title;\n"
        ),
        "migrations/0001-globals.ts":
          "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
      })
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["migrations/0001-globals.ts"],
    });
  });

  it("refuses a migration's directive that would reach the rest of the server code", async () => {
    // Refused before the type check reads it, as its directive would reach
    // every file of the program.
    await expect(
      refusedSeal({
        ...withOperation(
          "export const title = (): string => document.title;\n"
        ),
        "migrations/0001-dom.ts":
          '/// <reference lib="dom" />\nexport const migration = 1;\n',
      })
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["migrations/0001-dom.ts"],
    });
  });

  it("seals what the worker's globals and the SDK type, with its generated modules", async () => {
    await expect(
      refusedSeal(
        withOperation(
          '/// <summary>A comment, not a directive.</summary>\n// Do not use @ts-ignore here: a comment that mentions it.\nexport const later = async (): Promise<string> => {\n  await new Promise((resolve) => setTimeout(resolve, 1));\n  return crypto.randomUUID() + new TextEncoder().encode("x").length + new URL("https://acme.test").host;\n};\n'
        )
      )
    ).resolves.toStrictEqual({ code: "ok", files: [] });
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

  it("keeps its store from being deleted while any release kept binds it, and lets it go once retention removed them", async () => {
    const fixture = await appWith(notesFiles());
    await seal(fixture);
    await setCurrentVersion(env, fixture.owner, fixture.app, 1);
    const current = await failure(async () => {
      await deleteStore(env, fixture.owner, fixture.store);
    });
    const events = await allEvents();
    // A version without tables made current: version 1 binds the store
    // still, kept as a rollback target.
    // Its operations replaced: the notes' file goes, which reads tables
    // version 2 doesn't have.
    await commitFiles(
      env,
      fixture.owner,
      fixture.app,
      { ...tablelessFiles(), "operations/notes.ts": null },
      "Two"
    );
    await seal(fixture, 2);
    await setCurrentVersion(env, fixture.owner, fixture.app, 2);
    const retained = await failure(async () => {
      await deleteStore(env, fixture.owner, fixture.store);
    });
    // Retention lets version 1 go: past its 90 days, then the grace.
    await sweptAway(fixture.app, 1);
    await deleteStore(env, fixture.owner, fixture.store);
    expect([
      current,
      retained,
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

  it("is refused a store whose deletion has begun, and seals once that deletion let it be", async () => {
    const fixture = await appWith(notesFiles());
    // A deletion of the store in flight: its closing mark is set.
    await env.DB.prepare(
      "UPDATE business_stores SET closing_at = ?, closing_owner = 'deleting' WHERE id = ?"
    )
      .bind(Date.now(), fixture.store)
      .run();
    const refused = await failure(async () => await seal(fixture));
    const bound = await env.DB.prepare(
      "SELECT 1 FROM sdk_resource_bindings WHERE target_id = ?"
    )
      .bind(fixture.store)
      .all();
    // That deletion refused, and its mark cleared: the seal binds it.
    await env.DB.prepare(
      "UPDATE business_stores SET closing_at = NULL, closing_owner = NULL WHERE id = ?"
    )
      .bind(fixture.store)
      .run();
    const release = await seal(fixture);
    expect([refused, bound.results, release.store?.storeId]).toStrictEqual([
      "data.store_unavailable",
      [],
      fixture.store,
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

  it("can't keep anything but server code under operations/: each is refused by name", async () => {
    const strays = [
      "operations/notes.json",
      "operations/view.tsx",
      "operations/types.d.ts",
      // Never saved (a save refuses each), never server code.
      "operations/.hidden/notes.ts",
      "operations/../app.ts",
      "operations//x.ts",
    ];
    const built = await buildAppCode(
      env,
      {
        ...notesFiles(),
        ...Object.fromEntries(strays.map((path) => [path, "export {};\n"])),
      },
      "app-test"
    );
    expect({
      ok: built.ok,
      refused: new Set(
        built.ok
          ? []
          : built.diagnostics
              .filter(({ message }) =>
                message.includes("which holds only the App's server code")
              )
              .map(({ file }) => file)
      ),
    }).toStrictEqual({ ok: false, refused: new Set(strays) });
  });

  it("builds each operations file as a module of its own, dotted folders included", async () => {
    // A folder named like a file beside it: each still has its own module.
    const built = await buildAppCode(
      env,
      {
        ...notesFiles(),
        "operations/v1.0/extra.ts": "export const one = 1;\n",
        "operations/notes.ts/extra.ts": "export const two = 2;\n",
      },
      "app-test"
    );
    expect(
      built.ok
        ? Object.keys(built.modules).filter((name) =>
            name.startsWith("app~operations~")
          )
        : built.diagnostics
    ).toStrictEqual(
      expect.arrayContaining([
        "app~operations~notes.js",
        "app~operations~v1.0~extra.js",
        "app~operations~notes.ts~extra.js",
      ])
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

/** The modules only the platform's bootstrap imports (spec 10.7.1). */
const bootstrapModules = [
  "@grasp-os/sdk/client",
  "@grasp-os/sdk/host",
  "@grasp-os/sdk/screen-runtime",
] as const;

/** How a file names a module: for its values, or for its types alone. */
const importForms = {
  values: (module: string, index: number) =>
    `import { a${index} } from "${module}";\nvoid a${index};`,
  types: (module: string, index: number) =>
    `import type { A${index} } from "${module}";\nexport type B${index} = A${index};`,
  "re-exported types": (module: string, index: number) =>
    `export type { A${index} } from "${module}";`,
  "an import type": (module: string, index: number) =>
    `export type C${index} = typeof import("${module}");`,
  "a type's require": (module: string, index: number) =>
    `import type D${index} = require("${module}");\nexport type E${index} = typeof D${index};`,
} as const;

/** A file that names every bootstrap module as `form` writes one. */
const namingAll = (form: (module: string, index: number) => string): string =>
  bootstrapModules.map((module, index) => form(module, index)).join("\n");

/** What a build said, whatever it built. */
const saidSchema = z.object({
  diagnostics: z
    .array(
      z.object({
        file: z.string().optional(),
        rule: z.string(),
        message: z.string(),
        severity: z.string(),
      })
    )
    .default([]),
});

/** What a build said about `file`, as the modules each import it refused named. */
const refusedIn = (built: object, file: string): string[] =>
  saidSchema
    .parse(built)
    .diagnostics.filter((diagnostic) => diagnostic.file === file)
    .flatMap(({ message }) =>
      bootstrapModules.filter((module) => message.includes(`"${module}"`))
    )
    .toSorted();

/** The errors a build said. */
const errorsOf = (built: object): string[] =>
  saidSchema
    .parse(built)
    .diagnostics.filter(({ severity }) => severity === "error")
    .map(({ message }) => message);

/** Types a screen may name that its values may not: only `{ v }` is the SDK root's. */
const screenTypes =
  'import type { ReturnOf } from "@grasp-os/sdk";\nimport type { ReactNode } from "react";\nexport type Shown = ReturnOf<never> | ReactNode;';

/** Types other App code may name from a module its values may not reach. */
const codeTypes =
  'import type { Doc } from "@grasp-os/sdk/database";\nexport type Stored = Doc<never>;';

/**
 * Types a workflow may name: only the SDK's modules it imports, as its
 * type check resolves them (it never reaches the App's schema, so a
 * module like `@grasp-os/sdk/database` has nothing to give it).
 */
const workflowTypes =
  'import type { WorkflowEnv } from "@grasp-os/sdk/workflow";\nexport type Bound = WorkflowEnv;';

/** Each kind of App file, the build that reads it, and what it holds besides. */
const targets = {
  "a screen": {
    types: screenTypes,
    file: "screens/notes.tsx",
    wrap: (lines: string) =>
      `${lines}\nexport default function Notes() {\n  return null;\n}\n`,
    build: async (files: Record<string, string>) =>
      await buildScreens(env, files, "app-test"),
  },
  "a component": {
    types: screenTypes,
    file: "components/note.tsx",
    others: {
      "screens/notes.tsx":
        'import { Note } from "../components/note";\n\nexport default function Notes() {\n  return <Note />;\n}\n',
    },
    wrap: (lines: string) =>
      `${lines}\nexport function Note() {\n  return null;\n}\n`,
    build: async (files: Record<string, string>) =>
      await buildScreens(env, files, "app-test"),
  },
  "a declaration file": {
    types: screenTypes,
    file: "notes.d.ts",
    // Declarations name modules only for their types.
    typesOnly: true,
    others: {
      "screens/notes.tsx":
        "export default function Notes() {\n  return null;\n}\n",
    },
    wrap: (lines: string) => `${lines}\nexport type Declared = string;\n`,
    build: async (files: Record<string, string>) =>
      await buildScreens(env, files, "app-test"),
  },
  "an operation": {
    types: codeTypes,
    file: "operations/extra.ts",
    wrap: (lines: string) => `${lines}\nexport const extra = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildAppCode(env, files, "app-test"),
  },
  "the shared values": {
    types: codeTypes,
    file: "values.ts",
    wrap: (lines: string) => `${lines}\nexport const shared = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildAppCode(env, files, "app-test"),
  },
  "a migration": {
    types: codeTypes,
    file: "migrations/0001-extra.ts",
    wrap: (lines: string) => `${lines}\nexport const migration = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildAppCode(env, files, "app-test"),
  },
  "a test": {
    types: codeTypes,
    file: "tests/extra.test.ts",
    wrap: (lines: string) => `${lines}\nexport const test = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildAppTests(env, files, "app-test"),
  },
  "a workflow": {
    types: workflowTypes,
    file: "workflows/extra.ts",
    wrap: (lines: string) => `${lines}\nexport const workflow = 1;\n`,
    build: async (files: Record<string, string>) =>
      await buildWorkflows(env, files, "app-test"),
  },
} as const;

/** A screen that imports `Props` by `line` and names it. */
const screenShowingProps = (line: string): string =>
  `${line}\nexport type Shown = Props;\nexport default function Notes() {\n  return null;\n}\n`;

describe("screens", { timeout: 120_000 }, () => {
  it("name for their types the App's own declarations, a folder's index among them", async () => {
    const declarations = {
      "components/types/index.d.ts":
        "export interface Props {\n  title: string;\n}\n",
      "components/named.d.ts":
        "export interface Props {\n  title: string;\n}\n",
    };
    const [folder, extension, outside] = await Promise.all(
      [
        'import type { Props } from "../components/types";',
        'import type { Props } from "../components/named.js";',
        // A folder whose index would be the kit's, never an App file.
        'import type { Props } from "../node_modules/@grasp-os/sdk/src";',
      ].map(
        async (line) =>
          await buildScreens(
            env,
            {
              ...notesFiles(),
              ...declarations,
              "screens/notes.tsx": screenShowingProps(line),
            },
            "app-test"
          )
      )
    );
    expect({
      folder: errorsOf(folder ?? {}),
      extension: errorsOf(extension ?? {}),
      outside: errorsOf(outside ?? {}),
    }).toStrictEqual({
      folder: [],
      extension: [],
      outside: [
        '"../node_modules/@grasp-os/sdk/src" is not a file of this App\'s screens.',
      ],
    });
  });

  it("check a screen's declaration naming a module by import() in a namespace as its build does", async () => {
    // The compiler's check is its build's diagnostics (GRA-676, GRA-683),
    // so the declaration's import check refuses it before any type check;
    // the type check's resolution, which holds it as well, is tested on its
    // own (packages/compiler, type-check.test.ts).
    const files = {
      ...notesFiles(),
      "screens/notes.tsx":
        "export default function Notes() {\n  return null;\n}\n",
      "probe.d.ts":
        'declare namespace Probe {\n  type Server = typeof import("@grasp-os/sdk/server");\n}\n',
    };
    const checked = z
      .array(z.object({ file: z.string().optional(), rule: z.string() }))
      .parse(
        await platformRunner(env, "app-test").run("compiler", "check", [
          "screens",
          files,
        ])
      );
    expect(
      checked
        .filter(({ file }) => file === "probe.d.ts")
        .map(({ rule }) => rule)
    ).toStrictEqual(["imports"]);
  });

  it.each([
    [
      "imports inside it, in a declaration file",
      "leak.d.ts",
      'declare module "x-probe" {\n  import type { runScreen } from "@grasp-os/sdk/screen-runtime";\n  import type { serverModule } from "@grasp-os/sdk/server";\n  global {\n    type Leak = [typeof runScreen, typeof serverModule];\n  }\n}\n',
    ],
    [
      "imports inside it, in a component's declarations",
      "components/leak.d.ts",
      'declare module "x-probe" {\n  import type { runScreen } from "@grasp-os/sdk/screen-runtime";\n  global {\n    type Leak = [typeof runScreen];\n  }\n}\n',
    ],
    [
      "one that shadows a kit module",
      "shadow.d.ts",
      'declare module "@grasp-os/sdk/react" {\n  export const useQuery: (reference: unknown) => unknown;\n}\n',
    ],
  ])("never declare a module by name: %s", async (_case, file, source) => {
    const built = await buildScreens(
      env,
      {
        ...notesFiles(),
        "screens/notes.tsx":
          "export type Reached = unknown;\nexport default function Notes() {\n  return null;\n}\n",
        [file]: source,
      },
      "app-test"
    );
    expect({
      ok: built.ok,
      refused: saidSchema
        .parse(built)
        .diagnostics.filter(
          (diagnostic) =>
            diagnostic.file === file &&
            diagnostic.message.startsWith("declare module")
        ).length,
    }).toStrictEqual({ ok: false, refused: 1 });
  });

  it("never declare globals, in a declaration file", async () => {
    const built = await buildScreens(
      env,
      {
        ...notesFiles(),
        "screens/notes.tsx":
          "export default function Notes() {\n  return null;\n}\n",
        "globals.d.ts":
          "export {};\ndeclare global {\n  var leak: number;\n}\n",
      },
      "app-test"
    );
    expect({
      ok: built.ok,
      refused: saidSchema
        .parse(built)
        .diagnostics.filter(
          (diagnostic) =>
            diagnostic.file === "globals.d.ts" &&
            diagnostic.message.startsWith("declare global")
        ).length,
    }).toStrictEqual({ ok: false, refused: 1 });
  });

  it.each([
    ["a screen", "screens/notes.tsx", "../"],
    ["a declaration file", "notes.d.ts", "./"],
  ])(
    "never name the kit's own files for their types in %s, by any path",
    async (_case, file, up) => {
      const lines = [
        `/// <reference path="${up}node_modules/@grasp-os/sdk/src/client.ts" />`,
        '/// <reference types="node" />',
        `export type R = typeof import("${up}node_modules/@grasp-os/sdk/src/screen-runtime.ts");`,
        'import type * as C from "/node_modules/@grasp-os/sdk/src/client-core.ts";',
        `import type { serverModule } from "${up}node_modules/@grasp-os/sdk/src/server.ts";`,
        `import type { Doc } from "${up}node_modules/@grasp-os/sdk/src/database.ts";`,
        "export type Reached = typeof C | typeof serverModule | Doc<never>;",
      ].join("\n");
      const screen = "export default function Notes() {\n  return null;\n}\n";
      const built = await buildScreens(
        env,
        {
          ...notesFiles(),
          "screens/notes.tsx":
            file === "screens/notes.tsx" ? `${lines}\n${screen}` : screen,
          ...(file === "notes.d.ts" ? { [file]: lines } : {}),
        },
        "app-test"
      );
      const refused = saidSchema
        .parse(built)
        .diagnostics.filter(
          (diagnostic) =>
            diagnostic.file === file && diagnostic.rule === "imports"
        );
      expect({
        ok: built.ok,
        // The four imports, as the import check refuses them before any
        // type check; then, alone, the two directives, as the type check
        // refuses them.
        imports: refused.length,
      }).toStrictEqual({ ok: false, imports: 4 });
      const directives = await buildScreens(
        env,
        {
          ...notesFiles(),
          "screens/notes.tsx":
            file === "screens/notes.tsx"
              ? `${lines.split("\n").slice(0, 2).join("\n")}\n${screen}`
              : screen,
          ...(file === "notes.d.ts"
            ? { [file]: lines.split("\n").slice(0, 2).join("\n") }
            : {}),
        },
        "app-test"
      );
      expect({
        ok: directives.ok,
        directives: saidSchema
          .parse(directives)
          .diagnostics.filter(
            (diagnostic) =>
              diagnostic.file === file && diagnostic.rule === "imports"
          ).length,
      }).toStrictEqual({ ok: false, directives: 2 });
    }
  );

  it.each([
    ["a screen", "screens/notes.tsx"],
    ["a declaration file", "notes.d.ts"],
  ])(
    "never name the App's server code for its types in %s",
    async (_case, file) => {
      const typeLines = [
        'import type { query } from "#grasp/server";',
        'import type { internal } from "#grasp/server-references";',
        'export type { create } from "../operations/notes.ts";',
        'export type Schema = typeof import("../schema.ts");',
      ];
      const screen = "export default function Notes() {\n  return null;\n}\n";
      const built = await buildScreens(
        env,
        {
          ...notesFiles(),
          "screens/notes.tsx":
            file === "screens/notes.tsx"
              ? `${typeLines.join("\n")}\nexport type Q = typeof query | typeof internal;\n${screen}`
              : screen,
          ...(file === "notes.d.ts"
            ? {
                [file]: typeLines
                  .map((line) => line.replace("../", "./"))
                  .join("\n"),
              }
            : {}),
        },
        "app-test"
      );
      expect({
        ok: built.ok,
        refused: saidSchema
          .parse(built)
          .diagnostics.filter((diagnostic) => diagnostic.file === file)
          .map(({ message }) =>
            message.includes(
              "is the App's server code, which screens never import"
            )
          ),
      }).toStrictEqual({ ok: false, refused: [true, true, true, true] });
    }
  );

  it.each([
    ["the server constructors", 'import { query } from "#grasp/server";'],
    [
      "the internal references",
      'import { internal } from "#grasp/server-references";',
    ],
    ["the schema", 'import schema from "../schema.ts";'],
    ["the registration", 'import notes from "../app";'],
    ["an operation", 'import { create } from "../operations/notes.ts";'],
    [
      "an operation in a dotted folder",
      'import { create } from "../operations/v1.0/notes.ts";',
    ],
    ["the host's SDK", 'import { inspectApp } from "@grasp-os/sdk/host";'],
  ])(
    "never import %s: the build fails before it starts",
    async (_case, line) => {
      const build = await buildScreens(
        env,
        {
          ...notesFiles(),
          "screens/notes.tsx": `${line}\nexport default function Notes() {\n  return null;\n}\n`,
        },
        "app-test"
      );
      expect(build.ok).toBeFalsy();
      expect(build.diagnostics.map(({ message }) => message)).toStrictEqual([
        expect.stringContaining(
          "is the App's server code, which screens never import"
        ),
      ]);
    }
  );
});

describe("import boundaries", { timeout: 120_000 }, () => {
  it.each(
    Object.entries(targets).flatMap(([target, kind]) =>
      Object.entries(importForms)
        .filter(([form]) => !("typesOnly" in kind && form === "values"))
        .map(([form, write]) => [target, form, kind, write] as const)
    )
  )(
    "keep the platform's bootstrap out of %s, naming it for its %s",
    async (_target, _form, kind, write) => {
      const { file, wrap, build } = kind;
      const built = await build({
        ...notesFiles(),
        ...("others" in kind ? kind.others : {}),
        [file]: wrap(namingAll(write)),
      });
      expect({ ok: built.ok, refused: refusedIn(built, file) }).toStrictEqual({
        ok: false,
        refused: [...bootstrapModules].toSorted(),
      });
    }
  );

  it.each(Object.entries(targets))(
    "build %s that names none of it, with the types it may name",
    async (_target, kind) => {
      const { file, wrap, build, types } = kind;
      const built = await build({
        ...notesFiles(),
        ...("others" in kind ? kind.others : {}),
        [file]: wrap(types),
      });
      expect({
        ok: built.ok,
        errors: errorsOf(built),
      }).toStrictEqual({ ok: true, errors: [] });
    }
  );
});
