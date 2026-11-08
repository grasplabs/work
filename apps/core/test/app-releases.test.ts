import { serverSdkModules } from "@grasp-os/compiler";
import { definitionManifest } from "@grasp-os/sdk/definition";
import { schemaHash } from "@grasp-os/sdk/host";
import { appLimits } from "@grasp-os/shared/app-limits";
import { releaseFormatVersion } from "@grasp-os/shared/app-releases";
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

import { publishVersion } from "../src/app-publish.ts";
import {
  loadDraftRelease,
  loadRelease,
  sealDraftRelease,
  sealRelease,
} from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  commitFiles,
  createApp,
  draftOverLatest,
  findVersion,
  proposeDraft,
} from "../src/apps.ts";
import { deleteStore, openStore } from "../src/data-stores.ts";
import {
  sdkReleaseManifests,
  sdkResourceBindings,
} from "../src/db/core/schema.ts";
import { buildAppCode, buildAppTests, buildPages } from "../src/pages.ts";
import { appDefinition, definitionOf } from "./app-definitions.ts";
import type { AppSpec } from "./app-definitions.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { allEvents } from "./audit-events.ts";
import {
  appWith,
  artifactKey,
  putArtifact,
  failure,
  person,
  seal,
  sweptAway,
} from "./sealed-apps.ts";

// Sealing an App's release (spec 8, 16) through the real compiler, Loader
// isolates, R2 and D1: what a seal pins, that what it pins can't change
// under it, and the ways App code and storage could try to make it seal
// or run something else. Running a sealed release is
// app-functions.test.ts. Gone with App workflows: the types an App's own
// workflow may name, as its build reads them.

/** Notes, laid out as spec 8 has an App: its schema, operations and registration. */
/** The Notes App's definition, named `label`. */
const notesSpec = (label = "Notes"): AppSpec => ({
  name: label,
  tables: {
    notes: {
      fields: {
        title: "v.string().trim().min(1).max(200)",
        body: 'v.string().max(100_000).default("")',
      },
      access: { read: "owner", write: "owner" },
      indexes: { by_updated: ["_updatedAt"] },
    },
  },
});

const notesFiles = (label = "Notes"): Record<string, string> => ({
  ...appDefinition(notesSpec(label)),
  "values.ts": `import { v } from "@grasp-os/sdk";

export const noteFields = {
  title: v.string().trim().min(1).max(200),
  body: v.string().max(100_000).default(""),
};
`,
  "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { internal } from "@server/_generated/internal";
import { action, doc, internalQuery, mutation, query } from "@server/_generated/server";
import { noteFields } from "../values.ts";

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
  handler: async (ctx) => await ctx.runQuery(internal.notes.count, {}),
});
`,
});

/** The Notes App's files with one more table, `name`. */
const withTable = (name: string): Record<string, string> => {
  const spec = notesSpec();
  return {
    ...notesFiles(),
    ...appDefinition({
      ...spec,
      tables: { ...spec.tables, [name]: { fields: { label: "v.string()" } } },
    }),
  };
};

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

/** How many builds of an App's server code the build cache holds. */
const builds = async (): Promise<number> => {
  const listed = await env.FILES.list({ prefix: "build-cache/" });
  return listed.objects.filter(({ key }) => key.includes("/app-build/")).length;
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
      files[`server/pad${index}.ts`] =
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
        "server/_generated/api.ts",
        "server/_generated/internal.ts",
        "server/_generated/server.ts",
        ".grasp/verification.json",
        "modules/app~grasp.config.js",
        "modules/app~server~notes.js",
        "modules/app~server~schema.js",
        "modules/app~server~_generated~server.js",
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
      await artifactKey(artifactAt(release, "server/_generated/api.ts").sha256)
    );
    const text = (await references?.text()) ?? "";
    // Names, the same for every release: no App or version in them.
    expect(text).not.toContain(fixture.app);
    expect(text).toContain('"name": "notes.create"');
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
        // Unused columns, kept until a later release drops them.
        targetPath: null,
        approvalId: null,
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
        verificationReportHash: release.manifest.verificationReportHash,
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
    // Sealed again: the release as sealed.
    const again = await sealRelease(env, {
      app: fixture.app,
      version: 1,
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
  ...appDefinition({ name: "Hello", tables: {} }),
  "server/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";
export const hello = query({ args: {}, returns: v.string(), handler: () => "hello" });
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
  const stored = await env.FILES.get(await artifactKey(sha256));
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
  const stored = await env.FILES.get(await artifactKey(entry.sha256));
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
  await putArtifact(sha256, bytes);
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
    const stored = await env.FILES.get(await artifactKey(entry.sha256));
    const contracts = jsonRecord((await stored?.text()) ?? "{}");
    change.contracts(contracts);
    const text = `${canonicalJson(contracts)}\n`;
    const bytes = new TextEncoder().encode(text);
    const sha256 = await sha256Hex(text);
    await putArtifact(sha256, bytes);
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
    const entry = artifactAt(release, "modules/app~server~notes.js");
    const stored = await env.FILES.get(await artifactKey(entry.sha256));
    const code = (await stored?.text()) ?? "";
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(code),
    ]);
    const sha256 = await sha256OfBytes(bytes);
    await putArtifact(sha256, bytes);
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
    expect(loaded.modules["app~server~notes.js"]).toBe(`\uFEFF${code}`);
  });

  it("is refused when one of its artifacts' bytes no longer match their hash", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    // The same number of bytes, one of them changed: only the hash tells.
    const entry = artifactAt(release, "modules/app~server~notes.js");
    const stored = await env.FILES.get(await artifactKey(entry.sha256));
    const code = (await stored?.text()) ?? "";
    const forged = code.replace("notes", "motes");
    expect([forged.length, forged === code]).toStrictEqual([
      code.length,
      false,
    ]);
    await putArtifact(entry.sha256, forged);
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

  it.each([
    [
      // Its runner lacks what the host's isolate module imports of it now.
      "the format before this one",
      (manifest: Record<string, Json>) => {
        manifest.formatVersion = releaseFormatVersion - 1;
      },
    ],
    [
      // It still named an SDK protocol, which this format's strict reader
      // would call corrupt.
      "a format that named an SDK protocol",
      (manifest: Record<string, Json>) => {
        manifest.formatVersion = releaseFormatVersion - 2;
        manifest.sdkProtocolVersion = 3;
      },
    ],
  ])(
    "is refused as sealed in %s, to seal again, not as tampering",
    async (_format, sealedIn) => {
      const fixture = await appWith(notesFiles());
      const release = await seal(fixture);
      await rewrite(fixture.app, release, { manifest: sealedIn });
      // Sealed for good: sealing the version again is refused the same way,
      // so a new version is what replaces it.
      await expect(
        Promise.all([
          failure(async () => await loadRelease(env, fixture.app, 1)),
          failure(async () => await seal(fixture)),
        ])
      ).resolves.toStrictEqual([
        "version.format_unsupported",
        "version.format_unsupported",
      ]);
    }
  );

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

  it("is refused when two of its artifacts share a path, every hash rewritten", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    const entry = artifactAt(release, "modules/app~server~notes.js");
    await rewrite(fixture.app, release, {
      last: (manifest) => {
        const artifacts: readonly Json[] = Array.isArray(manifest.artifacts)
          ? manifest.artifacts
          : [];
        // The same path again, under the bytes of another artifact.
        const other = artifactAt(release, "modules/app~server~schema.js");
        manifest.artifacts = [
          ...artifacts,
          { path: entry.path, sha256: other.sha256, bytes: other.bytes },
        ];
      },
    });
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
    const key = await artifactKey(entry.sha256);
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
      await artifactKey(artifactAt(release, ".grasp/contracts.json").sha256)
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
    const other = await storeOfNewApp(env, fixture.owner);
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
      const stored = await env.FILES.get(await artifactKey(entry.sha256));
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
          uiVersion: manifest.uiVersion,
        },
        manifest: await sha256Hex(
          canonicalJson(jsonRecord(JSON.stringify(release.app)))
        ),
        checkedModules: await sha256Hex(canonicalJson(release.modules)),
        sdkModules: await sha256Hex(canonicalJson(release.sdk)),
      });
    });

    it("loads with another inspection hash: the inspection text isn't sealed, so only the manifest hash and the audit chain bind it", async () => {
      const fixture = await appWith(notesFiles());
      const release = await seal(fixture);
      await rewrite(fixture.app, release, {
        evidence: inSection("observed", (section) => {
          section.inspection = otherHash;
        }),
      });
      await expect(refusedLoad(fixture.app)).resolves.toBe("loaded");
    });

    it("refuses a draft release whose evidence names another source", async () => {
      const fixture = await appWith(notesFiles());
      const key = { app: fixture.app, version: 2 };
      const draft = await sealDraftRelease(
        env,
        key,
        new Map(Object.entries(notesFiles()))
      );
      const bytes = new Map(
        draft.artifacts.map(({ sha256, bytes: kept }) => [sha256, kept])
      );
      const read = async (sha256: string) =>
        await Promise.resolve(bytes.get(sha256));
      /** The draft with its evidence's source tree `tree`, every hash rewritten. */
      const withSource = async (tree: string) => {
        const manifest = jsonRecord(draft.manifest);
        const entry = z
          .object({ sha256: z.string() })
          .parse(
            (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).find(
              (artifact) =>
                z.object({ path: z.string() }).parse(artifact).path ===
                evidencePath
            )
          );
        const evidence = jsonRecord(
          new TextDecoder().decode(bytes.get(entry.sha256))
        );
        inSection("source", (section) => {
          section.sourceTreeHash = tree;
        })(evidence);
        const text = canonicalJson(evidence);
        const encoded = new TextEncoder().encode(text);
        const sha256 = await sha256Hex(text);
        bytes.set(sha256, encoded);
        const artifacts: readonly Json[] = Array.isArray(manifest.artifacts)
          ? manifest.artifacts
          : [];
        manifest.artifacts = artifacts.map((artifact) =>
          z.object({ path: z.string() }).parse(artifact).path === evidencePath
            ? { path: evidencePath, sha256, bytes: encoded.byteLength }
            : artifact
        );
        manifest.verificationReportHash = sha256;
        const manifestText = canonicalJson(manifest);
        return {
          manifest: manifestText,
          manifestHash: await sha256Hex(manifestText),
        };
      };
      const sealedTree = z
        .object({ source: z.object({ sourceTreeHash: z.string() }) })
        .parse(
          JSON.parse(
            new TextDecoder().decode(
              bytes.get(
                z
                  .object({ verificationReportHash: z.string() })
                  .parse(JSON.parse(draft.manifest)).verificationReportHash
              )
            )
          )
        ).source.sourceTreeHash;

      const kept = await loadDraftRelease(
        key,
        await withSource(sealedTree),
        read
      );
      const refused = await failure(
        async () =>
          await loadDraftRelease(key, await withSource(otherHash), read)
      );
      expect([kept.manifest.resourceVersion, refused]).toStrictEqual([
        2,
        "version.artifact_corrupt",
      ]);
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
  "server/extra.ts": source,
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
      'import { v } from "@grasp-os/sdk";\nimport { query } from "@server/_generated/server";\n\nexport const wrong = query({ args: {}, returns: v.string(), handler: () => 1 });\n',
    ],
    [
      "a path into the kit's packages, for its types",
      'import type { runPage } from "../node_modules/@grasp-os/sdk/src/page-runtime.ts";\nexport type Reached = typeof runPage;\n',
    ],
    [
      "a module of the kit's pages, for its types",
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
      files: ["server/extra.ts"],
    });
  });

  it("refuses a name of another file that shares none, as the build loads each file on its own", async () => {
    // Without imports or exports, TypeScript would read the other file as
    // a script whose names every file sees; the build makes each a module.
    await expect(
      refusedSeal({
        ...withOperation("export const greeting = (): string => shared;\n"),
        "server/extra-name.ts": 'const shared = "Hi";\n',
      })
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["server/extra.ts"],
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
      files: ["server/extra.ts"],
    });
  });

  it("refuses a test that runs a streaming action as one that answers once", async () => {
    // A streaming action runs only for a page following it (spec
    // 10.7.6): a test principal's `action` answers once, so its type
    // refuses one, as the host does (`function.mode_mismatch`).
    const streamed = {
      ...notesFiles(),
      "server/streams.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

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
    };
    const running = (reference: string): Record<string, string> => ({
      ...streamed,
      "tests/helper.ts": `import type { api } from "@server/_generated/api";
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
          'import type { api } from "@server/_generated/api";\nimport type * as testing from "@grasp-os/sdk/testing";\nexport type Checked = [typeof api, typeof testing];\n',
      })
    ).resolves.toStrictEqual({ code: "ok", files: [] });
  });

  it("refuses a migration's global declarations, which the rest of the server code would see", async () => {
    await expect(
      refusedSeal({
        ...withOperation(
          "export const title = (): string => document.title;\n"
        ),
        "server/migrations/0001-globals.ts":
          "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
      })
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["server/migrations/0001-globals.ts"],
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
        "server/migrations/0001-dom.ts":
          '/// <reference lib="dom" />\nexport const migration = 1;\n',
      })
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["server/migrations/0001-dom.ts"],
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

  it("seals server code and tests with unused names: the lint reports them, before a version is proposed", async () => {
    await expect(
      refusedSeal({
        ...withOperation(
          'import { v } from "@grasp-os/sdk";\n\nexport const later = (): number => {\n  const spare = 1;\n  return 2;\n};\n'
        ),
        "tests/helper.ts":
          'import { v } from "@grasp-os/sdk";\n\nexport const helper = 1;\n',
      })
    ).resolves.toStrictEqual({ code: "ok", files: [] });
  });
});

describe("an App's definition", { timeout: 120_000 }, () => {
  it("seals as the App it is: its generated config and schema register as the definition does", async () => {
    // A definition of every part the generator writes: tables of row
    // rules, indexes and a search index, a sensitive one, permissions,
    // preferences, and an answer.
    const spec: AppSpec = {
      name: "Desk",
      tables: {
        notes: {
          fields: {
            title: "v.string().trim().min(1).max(200)",
            owner: "v.person().optional()",
            team: "v.string()",
            tags: "v.array(v.string()).max(5).default([])",
            priority: 'v.enum(["low", "high"])',
          },
          indexes: { by_title: ["title"] },
          searchIndex: ["title"],
          access: {
            read: "appMembers",
            write: "appMembers",
            rows: {
              read: [
                { kind: "owner" },
                { kind: "person", field: "owner" },
                { kind: "team", field: "team" },
              ],
            },
          },
        },
        salaries: {
          fields: { note: 'v.id("notes")', amount: "v.number().min(0)" },
          sensitive: true,
          access: { read: "appBuilders", write: "appBuilders" },
        },
      },
      permissions: [
        "permission.ai({ maxOutputTokens: 500 })",
        'permission.links({ origins: ["https://help.example.com"] })',
        "people",
      ],
      preferences: { compact: "v.boolean().default(false)" },
      answers: [{ table: "notes", field: "priority", value: "low" }],
    };
    const fixture = await appWith(appDefinition(spec), "Desk");
    const release = await seal(fixture);
    expect(release.app).toStrictEqual(definitionManifest(definitionOf(spec)));
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
        "server/extra.ts": 'await fetch("https://example.com");\nexport {};\n',
      })
    ).resolves.toBe("version.inspection_failed");
  });

  it("can't name a server module after an object's prototype", async () => {
    // Its modules are keyed by path in the generated entry: `__proto__`
    // is refused as a path, never taken for the map's prototype.
    const fixture = await appWith({
      ...notesFiles(),
      "server/__proto__.ts":
        'import { v } from "@grasp-os/sdk";\nimport { query } from "@server/_generated/server";\n\nexport const hello = query({ args: {}, returns: v.string(), handler: () => "hello" });\n',
    });
    const refused: unknown = await seal(fixture).then(
      () => {},
      (error: unknown) => error
    );
    const { code, details } = z
      .object({ code: z.string(), details: z.object({ message: z.string() }) })
      .parse(refused);
    expect({
      code,
      byPath: details.message.includes(
        "server/__proto__.ts doesn't make a function path"
      ),
    }).toStrictEqual({ code: "version.inspection_failed", byPath: true });
  });

  it("can't hand the host a manifest it didn't declare", async () => {
    // The App's code makes the SDK in its isolate answer a function with
    // a list of its own, as if it narrowed or widened what the App holds:
    // no declaration makes that, so the host refuses it.
    const forging = `const stringify = JSON.stringify;
JSON.stringify = (value, ...rest) => {
  const text = stringify(value, ...rest);
  return typeof value === "object" && value !== null && "operations" in value
    ? text.replace('"stream":null', '"stream":null,"uses":[{"type":"resource","kind":"ai","alias":"ai"}]')
    : text;
};
`;
    await expect(sealedWith({ "server/forge.ts": forging })).resolves.toBe(
      "version.invalid_manifest"
    );
  });

  it.each([
    [
      "server code that imports the Workers runtime",
      {
        "server/extra.ts":
          'import { env } from "cloudflare:workers";\nexport const leak = env;\n',
      },
    ],
    [
      "server code that imports a platform-only SDK module",
      {
        "server/extra.ts":
          'import { inspectApp } from "@grasp-os/sdk/host";\nexport const peek = inspectApp;\n',
      },
    ],
    [
      "server code that imports a module by a computed name",
      {
        "server/extra.ts":
          'const name = "cloudflare:" + "workers";\nexport const load = () => import(name);\n',
      },
    ],
  ])("doesn't build with %s", async (_case, changes) => {
    await expect(sealedWith(changes)).resolves.toBe("version.build_failed");
  });

  it("binds its own App's store alone: another App's seal, by a builder of both, never reaches it", async () => {
    const first = await appWith(notesFiles());
    await publishVersion(env, first.owner, first.app, 1);
    const second = await appWith(withTable("beta"), "Beta", first.owner);
    const sealed = await seal(second);
    const opened = await openStore(env, first.store);
    expect({
      bound: sealed.store?.storeId,
      apart: second.store !== first.store,
      // Its schema was never handed to the first App's store.
      untouched: await opened.generations(["beta"]),
    }).toStrictEqual({ bound: second.store, apart: true, untouched: {} });
  });

  it("is refused to someone who doesn't build the App, before a store is made or its code is built", async () => {
    const owner = await person("builder");
    const { id } = await createApp(env, owner, { name: "Beta" });
    await commitFiles(env, owner, id, withTable("beta"), "First version");
    const outsider = await person("builder");
    const before = await builds();
    const refused = await failure(
      async () => await sealRelease(env, { app: id, version: 1, by: outsider })
    );
    const stores = await env.DB.prepare(
      "SELECT store_id FROM app_default_stores WHERE app_id = ?"
    )
      .bind(id)
      .all();
    expect([refused, await builds(), stores.results]).toStrictEqual([
      "app.not_found",
      before,
      [],
    ]);
  });

  it("keeps its store from being deleted while any release kept binds it, and lets it go once retention removed them", async () => {
    const fixture = await appWith(notesFiles());
    await seal(fixture);
    await publishVersion(env, fixture.owner, fixture.app, 1);
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
      { ...tablelessFiles(), "server/notes.ts": null },
      "Two"
    );
    await seal(fixture, 2);
    await publishVersion(env, fixture.owner, fixture.app, 2);
    const retained = await failure(async () => {
      await deleteStore(env, fixture.owner, fixture.store);
    });
    // Retention lets version 1 go: no longer among the App's latest.
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

  it("seals server code that imports the App's preferences, and functions at any segment a reference doesn't answer", async () => {
    const files = notesFiles();
    const fixture = await appWith({
      ...files,
      "server/extra.ts": `import { v } from "@grasp-os/sdk";
import { api, preferences } from "@server/_generated/api";
import { action, query } from "@server/_generated/server";

export const defaults = query({
  args: {},
  returns: v.boolean(),
  handler: () => preferences.get.name === "preferences.get",
});

export const reach = action({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => await ctx.runQuery(api.extra.defaults, {}),
});
`,
      ...appDefinition({
        ...notesSpec(),
        preferences: { compact: "v.boolean().default(false)" },
      }),
    });
    const release = await seal(fixture);
    expect([
      release.app.preferences !== null,
      release.app.operations["extra.reach"]?.kind,
    ]).toStrictEqual([true, "action"]);
  });

  it("makes its App's one store when it first declares tables, keyed by the App and audited", async () => {
    const owner = await person("builder");
    const { id } = await createApp(env, owner, { name: "Notes" });
    await commitFiles(env, owner, id, notesFiles(), "First version");
    const first = await sealRelease(env, { app: id, version: 1, by: owner });
    await commitFiles(env, owner, id, withTable("beta"), "Second version");
    const second = await sealRelease(env, { app: id, version: 2, by: owner });
    const keyed = await env.DB.prepare(
      "SELECT store_id AS store FROM app_default_stores WHERE app_id = ?"
    )
      .bind(id)
      .all<{ store: string }>();
    const events = await allEvents();
    const created = events.filter(
      (event) => event.action === "store.created" && event.detail?.app === id
    );
    expect({
      keyed: keyed.results.map(({ store }) => store),
      second: second.store?.storeId,
      created: created.map((event) => event.target?.id),
    }).toStrictEqual({
      keyed: [first.store?.storeId],
      second: first.store?.storeId,
      created: [first.store?.storeId],
    });
  });

  it("is an App of spec 8's layout: a version holding the v1 server's files isn't even committed", async () => {
    await expect(
      failure(
        async () =>
          await appWith({
            ...notesFiles(),
            "app/server.ts": "export class App {}\n",
          })
      )
    ).resolves.toBe("app.v1_server");
  });

  it("is an App of spec 8's layout: a draft that drops its schema isn't proposed", async () => {
    const fixture = await appWith(notesFiles());
    const draft = await draftOverLatest(env, fixture.app, {
      base: 1,
      changes: { "server/schema.ts": null },
    });
    await expect(
      failure(
        async () =>
          await proposeDraft(
            env,
            fixture.owner,
            fixture.app,
            draft,
            "No schema"
          )
      )
    ).resolves.toBe("app.layout_missing");
  });

  it("can't keep anything but server code under operations/: each is refused by name", async () => {
    const strays = [
      "server/notes.json",
      "server/view.tsx",
      "server/types.d.ts",
      // Never saved (a save refuses each), never server code.
      "server/.hidden/notes.ts",
      "server/../app.ts",
      "server//x.ts",
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

  it("can't keep anything but one file per migration under server/migrations/: each is refused by name", async () => {
    const strays = [
      "server/migrations/lib/helper.ts",
      "server/migrations/v1.0/derive.ts",
      "server/migrations/notes.md",
      "server/migrations/types.d.ts",
      // Never saved (a save refuses each), never a migration.
      "server/migrations/.hidden.ts",
      "server/migrations/../app.ts",
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
                message.includes("which holds only the App's migrations")
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
        "server/v1.0/extra.ts": "export const one = 1;\n",
        "server/notes.ts/extra.ts": "export const two = 2;\n",
      },
      "app-test"
    );
    expect(
      built.ok
        ? Object.keys(built.modules).filter((name) =>
            name.startsWith("app~server~")
          )
        : built.diagnostics
    ).toStrictEqual(
      expect.arrayContaining([
        "app~server~notes.js",
        "app~server~v1.0~extra.js",
        "app~server~notes.ts~extra.js",
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
              "server/_generated/api.ts": "export const api = {};\n",
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
  "@grasp-os/sdk/page-runtime",
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

/** Types a page may name that its values may not: only `{ v }` is the SDK root's. */
const pageTypes =
  'import type { ReturnOf } from "@grasp-os/sdk";\nimport type { ReactNode } from "react";\nexport type Shown = ReturnOf<never> | ReactNode;';

/** Types other App code may name from a module its values may not reach. */
const codeTypes =
  'import type { Doc } from "@grasp-os/sdk/database";\nexport type Stored = Doc<never>;';

/** Each kind of App file, the build that reads it, and what it holds besides. */
const targets = {
  "a page": {
    types: pageTypes,
    file: "src/routes/index.tsx",
    wrap: (lines: string) =>
      `${lines}\nimport { createFileRoute } from "@tanstack/react-router";\n\nfunction Notes() {\n  return null;\n}\n\nexport const Route = createFileRoute("/")({ component: Notes });\n`,
    build: async (files: Record<string, string>) =>
      await buildPages(env, files, "app-test"),
  },
  "a component": {
    types: pageTypes,
    file: "src/components/note.tsx",
    others: {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Note } from "../components/note";

function Notes() {
  return <Note />;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
    },
    wrap: (lines: string) =>
      `${lines}\nexport function Note() {\n  return null;\n}\n`,
    build: async (files: Record<string, string>) =>
      await buildPages(env, files, "app-test"),
  },
  "a declaration file": {
    types: pageTypes,
    file: "notes.d.ts",
    // Declarations name modules only for their types.
    typesOnly: true,
    others: {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
    },
    wrap: (lines: string) => `${lines}\nexport type Declared = string;\n`,
    build: async (files: Record<string, string>) =>
      await buildPages(env, files, "app-test"),
  },
  "an operation": {
    types: codeTypes,
    file: "server/extra.ts",
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
    file: "server/migrations/0001-extra.ts",
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
} as const;

/** A page that imports `Props` by `line` and names it. */
const pageShowingProps = (line: string): string =>
  `import { createFileRoute } from "@tanstack/react-router";
${line}\nexport type Shown = Props;\nfunction Notes() {\n  return null;\n}\n

export const Route = createFileRoute("/")({ component: Notes });
`;

describe("pages", { timeout: 120_000 }, () => {
  it("import a component kept in a folder whose name has a dot", async () => {
    const built = await buildPages(
      env,
      {
        ...notesFiles(),
        "src/components/v1.0/title.tsx":
          "export function Title() {\n  return <h1>Notes</h1>;\n}\n",
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { Title } from "../components/v1.0/title.tsx";

function Notes() {
  return <Title />;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
      },
      "app-test"
    );
    expect(errorsOf(built)).toStrictEqual([]);
  });

  it("can't keep anything but the front end's TypeScript under src/: each is refused by name", async () => {
    const strays = [
      "src/components/styles.css",
      "src/components/data.json",
      // Never saved (a save refuses each), never a component.
      "src/components/.hidden/title.tsx",
      "src/components/../app.tsx",
      "src/components//title.tsx",
    ];
    const built = await buildPages(
      env,
      {
        ...notesFiles(),
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
        ...Object.fromEntries(strays.map((path) => [path, "export {};\n"])),
      },
      "app-test"
    );
    expect(
      new Set(
        saidSchema
          .parse(built)
          .diagnostics.filter(({ message }) =>
            message.includes("which holds only the App's front end")
          )
          .map(({ file }) => file)
      )
    ).toStrictEqual(new Set(strays));
  });

  it("name for their types the App's own declarations, a folder's index among them", async () => {
    const declarations = {
      "src/components/types/index.d.ts":
        "export interface Props {\n  title: string;\n}\n",
      "src/components/named.d.ts":
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
          await buildPages(
            env,
            {
              ...notesFiles(),
              ...declarations,
              "src/routes/index.tsx": pageShowingProps(line),
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
        '"../node_modules/@grasp-os/sdk/src" is not a file of this App\'s pages.',
      ],
    });
  });

  it("refuse a page's declaration naming a module by import() in a namespace", async () => {
    // The declaration's import check refuses it before any type check;
    // the type check's resolution, which holds it as well, is tested on its
    // own (packages/compiler, type-check.test.ts).
    const files = {
      ...notesFiles(),
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
      "probe.d.ts":
        'declare namespace Probe {\n  type Server = typeof import("@grasp-os/sdk/server");\n}\n',
    };
    const built = await buildPages(env, files, "app-test");
    expect(
      (built.ok ? [] : built.diagnostics)
        .filter(({ file }) => file === "probe.d.ts")
        .map(({ rule }) => rule)
    ).toStrictEqual(["imports"]);
  });

  it.each([
    [
      "imports inside it, in a declaration file",
      "leak.d.ts",
      'declare module "x-probe" {\n  import type { runPage } from "@grasp-os/sdk/page-runtime";\n  import type { serverModule } from "@grasp-os/sdk/server";\n  global {\n    type Leak = [typeof runPage, typeof serverModule];\n  }\n}\n',
    ],
    [
      "imports inside it, in a component's declarations",
      "src/components/leak.d.ts",
      'declare module "x-probe" {\n  import type { runPage } from "@grasp-os/sdk/page-runtime";\n  global {\n    type Leak = [typeof runPage];\n  }\n}\n',
    ],
    [
      "one that shadows a kit module",
      "shadow.d.ts",
      'declare module "@grasp-os/sdk/react" {\n  export const useQuery: (reference: unknown) => unknown;\n}\n',
    ],
  ])("never declare a module by name: %s", async (_case, file, source) => {
    const built = await buildPages(
      env,
      {
        ...notesFiles(),
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
export type Reached = unknown;
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
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

  it.each([
    [
      "a declaration file",
      "globals.d.ts",
      "export {};\ndeclare global {\n  var leak: number;\n}\n",
    ],
    [
      "a page",
      "src/routes/globals.tsx",
      "export {};\ndeclare global {\n  interface Window {\n    leak: number;\n  }\n}\n",
    ],
  ])("never declare globals, in %s", async (_case, file, source) => {
    const built = await buildPages(
      env,
      {
        ...notesFiles(),
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
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
            diagnostic.message.startsWith("declare global")
        ).length,
    }).toStrictEqual({ ok: false, refused: 1 });
  });

  it("read a declaration file as declarations: a const needs no value", async () => {
    const built = await buildPages(
      env,
      {
        ...notesFiles(),
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import type { Limit } from "../../limits";
export type Shown = Limit;
function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
        "limits.d.ts":
          "export const limit: number;\nexport type Limit = typeof limit;\n",
      },
      "app-test"
    );
    expect(built.ok ? [] : errorsOf(built)).toStrictEqual([]);
  });

  it.each([
    ["a page", "src/routes/index.tsx", "../"],
    ["a declaration file", "notes.d.ts", "./"],
  ])(
    "never name the kit's own files for their types in %s, by any path",
    async (_case, file, up) => {
      const lines = [
        `/// <reference path="${up}node_modules/@grasp-os/sdk/src/client.ts" />`,
        '/// <reference types="node" />',
        `export type R = typeof import("${up}node_modules/@grasp-os/sdk/src/page-runtime.ts");`,
        'import type * as C from "/node_modules/@grasp-os/sdk/src/client-core.ts";',
        `import type { serverModule } from "${up}node_modules/@grasp-os/sdk/src/server.ts";`,
        `import type { Doc } from "${up}node_modules/@grasp-os/sdk/src/database.ts";`,
        "export type Reached = typeof C | typeof serverModule | Doc<never>;",
      ].join("\n");
      const page =
        'import { createFileRoute } from "@tanstack/react-router";\n\nfunction Notes() {\n  return null;\n}\n\nexport const Route = createFileRoute("/")({ component: Notes });\n';
      const built = await buildPages(
        env,
        {
          ...notesFiles(),
          "src/routes/index.tsx":
            file === "src/routes/index.tsx" ? `${lines}\n${page}` : page,
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
        // The four imports, as the import check refuses them, and the two
        // directives, as the type check refuses them, all at once.
        imports: refused.length,
      }).toStrictEqual({ ok: false, imports: 6 });
      const directives = await buildPages(
        env,
        {
          ...notesFiles(),
          "src/routes/index.tsx":
            file === "src/routes/index.tsx"
              ? `${lines.split("\n").slice(0, 2).join("\n")}\n${page}`
              : page,
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
    ["a page", "src/routes/index.tsx"],
    ["a declaration file", "notes.d.ts"],
  ])(
    "never name the App's server code for its types in %s",
    async (_case, file) => {
      const typeLines = [
        'import type { query } from "@server/_generated/server";',
        'import type { internal } from "@server/_generated/internal";',
        'export type { create } from "../../server/notes.ts";',
        'export type Schema = typeof import("../../server/schema.ts");',
      ];
      const page =
        'import { createFileRoute } from "@tanstack/react-router";\n\nfunction Notes() {\n  return null;\n}\n\nexport const Route = createFileRoute("/")({ component: Notes });\n';
      const built = await buildPages(
        env,
        {
          ...notesFiles(),
          "src/routes/index.tsx":
            file === "src/routes/index.tsx"
              ? `${typeLines.join("\n")}\nexport type Q = typeof query | typeof internal;\n${page}`
              : page,
          ...(file === "notes.d.ts"
            ? {
                [file]: typeLines
                  .map((line) => line.replace("../../", "./"))
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
              "is the App's server code, which pages never import"
            )
          ),
      }).toStrictEqual({ ok: false, refused: [true, true, true, true] });
    }
  );

  it.each([
    [
      "the server constructors",
      'import { query } from "@server/_generated/server";',
    ],
    [
      "the internal references",
      'import { internal } from "@server/_generated/internal";',
    ],
    ["the schema", 'import schema from "../../server/schema.ts";'],
    ["the config", 'import notes from "../../grasp.config";'],
    ["an operation", 'import { create } from "../../server/notes.ts";'],
    [
      "an operation in a dotted folder",
      'import { create } from "../../server/v1.0/notes.ts";',
    ],
    [
      "a migration in a dotted folder",
      'import derive from "../../server/migrations/v1.0/derive.ts";',
    ],
    ["the host's SDK", 'import { inspectApp } from "@grasp-os/sdk/host";'],
  ])(
    "never import %s: the build fails before it starts",
    async (_case, line) => {
      const build = await buildPages(
        env,
        {
          ...notesFiles(),
          "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
${line}\nfunction Notes() {\n  return null;\n}\n

export const Route = createFileRoute("/")({ component: Notes });
`,
        },
        "app-test"
      );
      expect(build.ok).toBeFalsy();
      expect(build.diagnostics.map(({ message }) => message)).toStrictEqual([
        expect.stringContaining(
          "is the App's server code, which pages never import"
        ),
      ]);
    }
  );

  it.each([
    [
      "import type",
      'import type { Doc, Id } from "@server/_generated/dataModel";',
      [],
    ],
    [
      "type specifiers",
      'import { type Doc, type Id } from "@server/_generated/dataModel";',
      [],
    ],
    [
      "a value import",
      'import { Doc, Id } from "@server/_generated/dataModel";',
      [expect.stringContaining("import them with import type")],
    ],
    [
      "a value beside its types",
      'import { type Doc, type Id, default as model } from "@server/_generated/dataModel";',
      [expect.stringContaining("import them with import type")],
    ],
  ])(
    "take the data model's types by %s only, checked against the schema",
    async (_case, line, refused) => {
      const build = await buildPages(
        env,
        {
          ...notesFiles(),
          "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
${line}

export const titleOf = (note: Doc<"notes">): string => note.title;
export const idOf = (note: Doc<"notes">): Id<"notes"> => note._id;

function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
        },
        "app-test"
      );
      expect({
        ok: build.ok,
        said: build.diagnostics?.map(({ message }) => message) ?? [],
      }).toStrictEqual({ ok: refused.length === 0, said: refused });
    }
  );

  it("type-check a page's use of the data model against the App's own tables", async () => {
    const build = await buildPages(
      env,
      {
        ...notesFiles(),
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import type { Doc } from "@server/_generated/dataModel";

export const stray: Doc<"tasks"> | undefined = undefined;

function Notes() {
  return null;
}

export const Route = createFileRoute("/")({ component: Notes });
`,
      },
      "app-test"
    );
    expect({
      ok: build.ok,
      rules: build.diagnostics?.map(({ file, rule }) => `${file} ${rule}`),
    }).toStrictEqual({ ok: false, rules: ["src/routes/index.tsx TS2344"] });
  });
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
