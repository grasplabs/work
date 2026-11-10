import { serverSdkModules } from "@grasp-os/compiler";
import { schemaHash } from "@grasp-os/sdk/host";
import { appLimits } from "@grasp-os/shared/app-limits";
import { releaseFormatVersion } from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { sha256OfBytes } from "@grasp-os/shared/release";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  loadDraftRelease,
  loadRelease,
  sealDraftRelease,
  sealRelease,
} from "../src/app-releases.ts";
import { findVersion } from "../src/apps.ts";
import {
  sdkReleaseManifests,
  sdkResourceBindings,
} from "../src/db/core/schema.ts";
import { appOf, withFiles } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import {
  artifactAt,
  evidencePath,
  inSection,
  jsonRecord,
  member,
  notesFiles,
  otherHash,
  refusedLoad,
  refusedSeal,
  rewrite,
  tablelessFiles,
  withOperation,
} from "./app-releases-harness.ts";
import { storeOfNewApp } from "./app-stores.ts";
import { commitDefined } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  appWith,
  artifactKey,
  putArtifact,
  failure,
  seal,
} from "./sealed-apps.ts";

// Sealing an App's release (spec 8, 16) through the real compiler, Loader
// isolates, R2 and D1: what a seal pins, that what it pins can't change
// under it, and the ways App code and storage could try to make it seal
// or run something else. Running a sealed release is
// app-functions.test.ts. Gone with App workflows: the types an App's own
// workflow may name, as its build reads them.

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
    const padding = appLimits.files - Object.keys(base.files).length;
    const used = Object.values(base.files).reduce(
      (sum, source) => sum + source.length,
      0
    );
    const files: Record<string, string> = { ...base.files };
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
    const release = await seal(await appWith(appOf(base.definition, files)));
    expect(release.manifest.resourceVersion).toBe(1);
  });

  it("pins the source, schema, contracts, runtime, store and every artifact by hash", async () => {
    const fixture = await appWith(notesFiles());
    const release = await seal(fixture);
    const { tree, definitionHash } = await findVersion(env, fixture.app, 1);
    const schema = await schemaHash(release.app.schema);
    expect(release.manifest).toMatchObject({
      formatVersion: releaseFormatVersion,
      resourceId: fixture.app,
      resourceVersion: 1,
      sourceTreeHash: tree,
      definitionHash,
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
    await commitDefined(
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
      const { tree, definitionHash } = await findVersion(env, fixture.app, 1);
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
          definitionHash,
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
        new Map(Object.entries(notesFiles().files)),
        notesFiles().definition
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
      refusedSeal(
        withFiles(
          withOperation("export const greeting = (): string => shared;\n"),
          {
            "server/extra-name.ts": 'const shared = "Hi";\n',
          }
        )
      )
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["server/extra.ts"],
    });
  });

  it("refuses a test's type error with the server code's", async () => {
    await expect(
      refusedSeal(
        withFiles(notesFiles(), {
          "tests/helper.ts": 'export const count: number = "none";\n',
        })
      )
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
      refusedSeal(
        withFiles(
          withOperation("export const title = (): string => document.title;\n"),
          {
            "tests/helper.ts":
              "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
          }
        )
      )
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["server/extra.ts"],
    });
  });

  it("refuses a test that runs a streaming action as one that answers once", async () => {
    // A streaming action runs only for a page following it (spec
    // 10.7.6): a test principal's `action` answers once, so its type
    // refuses one, as the host does (`function.mode_mismatch`).
    const streamed = withFiles(notesFiles(), {
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
    });
    const running = (reference: string): TestApp =>
      withFiles(streamed, {
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
      refusedSeal(
        withFiles(notesFiles(), {
          "tests/helper.ts":
            'import type { api } from "@server/_generated/api";\nimport type * as testing from "@grasp-os/sdk/testing";\nexport type Checked = [typeof api, typeof testing];\n',
        })
      )
    ).resolves.toStrictEqual({ code: "ok", files: [] });
  });

  it("refuses a migration's global declarations, which the rest of the server code would see", async () => {
    await expect(
      refusedSeal(
        withFiles(
          withOperation("export const title = (): string => document.title;\n"),
          {
            "server/migrations/0001-globals.ts":
              "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
          }
        )
      )
    ).resolves.toStrictEqual({
      code: "version.build_failed",
      files: ["server/migrations/0001-globals.ts"],
    });
  });

  it("refuses a migration's directive that would reach the rest of the server code", async () => {
    // Refused before the type check reads it, as its directive would reach
    // every file of the program.
    await expect(
      refusedSeal(
        withFiles(
          withOperation("export const title = (): string => document.title;\n"),
          {
            "server/migrations/0001-dom.ts":
              '/// <reference lib="dom" />\nexport const migration = 1;\n',
          }
        )
      )
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
      refusedSeal(
        withFiles(
          withOperation(
            'import { v } from "@grasp-os/sdk";\n\nexport const later = (): number => {\n  const spare = 1;\n  return 2;\n};\n'
          ),
          {
            "tests/helper.ts":
              'import { v } from "@grasp-os/sdk";\n\nexport const helper = 1;\n',
          }
        )
      )
    ).resolves.toStrictEqual({ code: "ok", files: [] });
  });
});
