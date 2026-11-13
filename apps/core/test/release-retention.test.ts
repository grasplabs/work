import { serverModuleSource } from "@grasp-os/runtime/host";
import { sha256Hex, sha256HexOfBytes } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction, invocationFor } from "../src/app-functions.ts";
import {
  loadRelease,
  readBackRelease,
  sealRelease,
} from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { appKind, isPublished } from "../src/apps.ts";
import { hostFunctionCall } from "../src/function-host.ts";
import type { Runner } from "../src/function-host.ts";
import { rollback } from "../src/publish.ts";
import {
  leaseRelease,
  pinRelease,
  placeHold,
  releaseHold,
  revokeRelease,
  sealGraceMs,
  sweepReleases,
  unpinRelease,
} from "../src/release-retention.ts";
import { hostedRelease } from "../src/release-runner.ts";
import {
  collectArtifacts,
  collectBatch,
  storeArtifacts,
  strayCursorKey,
  sweepStrayKeys,
  unnamedSealMs,
} from "../src/sealed-artifacts.ts";
import { testApp } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { commitDefined, lostAnswerDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  appWith,
  artifactKey,
  failure,
  newerReleases,
  person,
  seal,
  sweptAway,
} from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// How long sealed releases stay, and how one is revoked (spec 16.3),
// through real D1, R2 and seals: what keeps a release, that nothing
// referenced is deleted, that shared bytes outlive the release that goes,
// and that a deleted release's version runs again only once published
// again.

const files = (label: string): TestApp =>
  testApp(
    {
      name: "Notes",
      tables: {
        notes: {
          fields: { title: "v.string()" },
          access: { read: "owner", write: "owner" },
        },
      },
    },
    {
      "server/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "@server/_generated/server";
export const label = query({
  args: {},
  returns: v.string(),
  handler: () => ${JSON.stringify(label)},
});
export const touch = mutation({
  args: {},
  returns: v.id("notes"),
  handler: async (ctx) => await ctx.db.insert("notes", { title: "Touched" }),
});
export const touchTwice = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(touch, {});
    await ctx.runMutation(touch, {});
    return null;
  },
});
`,
    }
  );

const day = 24 * 60 * 60_000;

/** A Notes App with versions 1 and 2 sealed, version 2 current, as of `start`. */
const twoVersions = async (
  start: Date
): Promise<Fixture & { first: Release; second: Release }> => {
  const fixture = await appWith(files("one"));
  const first = await seal(fixture);
  await rollback(env, appKind, fixture.owner, fixture.app, 1);
  // The sweep sees version 1 current.
  await sweepReleases(env, start);
  await commitDefined(env, fixture.owner, fixture.app, files("two"));
  const second = await seal(fixture, 2);
  await rollback(env, appKind, fixture.owner, fixture.app, 2);
  await sweepReleases(env, start);
  return { ...fixture, first, second };
};

/** Whether `release`'s artifact at `path` still has its bytes. */
const stored = async (release: Release, path: string): Promise<boolean> => {
  const entry = release.manifest.artifacts.find(
    (artifact) => artifact.path === path
  );
  return (
    (await env.FILES.head(await artifactKey(entry?.sha256 ?? ""))) !== null
  );
};

/** Sweeps at each of `times`, in turn. */
const sweepsAt = async (...times: Date[]): Promise<void> => {
  for (const time of times) {
    // In turn: each sweep sees what the one before left.
    // oxlint-disable-next-line no-await-in-loop -- see above
    await sweepReleases(env, time);
  }
};

/** The manifest hash of App `app`'s release `version`, as loaded. */
const loadedHash = async (app: Fixture["app"], version: number) => {
  const loaded = await loadRelease(env, app, version);
  return loaded.manifestHash;
};

/** `start`, `ms` later. */
const after = (start: Date, ms: number): Date => new Date(start.getTime() + ms);

describe("retention", { timeout: 120_000 }, () => {
  it("keeps the current version however old it is", async () => {
    const start = new Date();
    const { app, second } = await twoVersions(start);
    const removeNewer = await newerReleases(app);
    await sweepsAt(after(start, 400 * day));
    await removeNewer();
    const loaded = await loadRelease(env, app, 2);
    expect(loaded.manifestHash).toBe(second.manifestHash);
  });

  it("keeps a version among the App's latest and for a day after its seal, then deletes it, only its own bytes, and its version counts as unpublished", async () => {
    const start = new Date();
    const { app, first, second } = await twoVersions(start);
    // One of the App's latest releases, however old: kept.
    await sweepsAt(after(start, 400 * day));
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
    // No longer among them, but sealed within the day: kept.
    const removeNewer = await newerReleases(app);
    await sweepsAt(after(start, sealGraceMs - 60_000));
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
    // A day after its seal: deleted.
    await sweepsAt(after(start, sealGraceMs + day));
    await removeNewer();
    // Its own bytes are gone; the bytes the current version shares with it
    // stay, and the current version loads whole.
    expect({
      first: await failure(async () => await loadRelease(env, app, 1)),
      own: await stored(first, "modules/app~server~notes.js"),
      shared: await stored(first, "server/_generated/server.ts"),
      second: await loadedHash(app, 2),
      published: await isPublished(env, app, 1),
    }).toStrictEqual({
      first: "version.not_sealed",
      own: false,
      shared: true,
      second: second.manifestHash,
      published: false,
    });
  });

  it("keeps a version an open page leases, for as long as it renews", async () => {
    const start = new Date();
    const { app, first } = await twoVersions(start);
    const removeNewer = await newerReleases(app);
    const key = { app, version: 1 };
    const past = after(start, sealGraceMs + day);
    const minute = 60_000;
    await leaseRelease(env, key, "frame-1", past);
    // Leased and renewed: kept.
    await sweepsAt(past, after(past, 10 * minute));
    await leaseRelease(env, key, "frame-1", after(past, 12 * minute));
    await sweepsAt(after(past, 20 * minute));
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
    // Not renewed again: once the lease lapsed, it goes.
    await sweepsAt(after(past, 30 * minute));
    await removeNewer();
    await expect(
      failure(async () => await loadRelease(env, app, 1))
    ).resolves.toBe("version.not_sealed");
  });

  it("keeps a version an admin's legal hold holds until it is released, both audited", async () => {
    const start = new Date();
    const { app, first } = await twoVersions(start);
    const admin = await person("admin");
    const key = { app, version: 1 };
    await placeHold(env, admin, key, "legal-1", "Litigation");
    await placeHold(env, admin, key, "legal-1", "Again");
    const removeNewer = await newerReleases(app);
    const past = after(start, sealGraceMs + day);
    await sweepsAt(past);
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
    await releaseHold(env, admin, key, "legal-1");
    await sweepsAt(after(past, 60_000));
    await removeNewer();
    await expect(
      failure(async () => await loadRelease(env, app, 1))
    ).resolves.toBe("version.not_sealed");
    const events = await allEvents();
    expect(
      events
        .filter(
          (event) =>
            ["app.release.held", "app.release.hold_released"].includes(
              event.action
            ) && event.target?.id === app
        )
        .map((event) => [event.action, event.detail?.hold])
    ).toStrictEqual([
      ["app.release.held", "legal-1"],
      ["app.release.hold_released", "legal-1"],
    ]);
  });

  it("lets only an admin hold a release, and never with an expiry", async () => {
    const start = new Date();
    const { app } = await twoVersions(start);
    const builder = await person("builder");
    await expect(
      failure(async () => {
        await placeHold(env, builder, { app, version: 1 }, "mine", "Mine");
      })
    ).resolves.toBe("role.forbidden");
    // SAFETY: a deliberately ill-typed call, for a hold the types refuse.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const loosePin = pinRelease as (...args: unknown[]) => Promise<void>;
    await expect(
      loosePin(env, { app, version: 1 }, { kind: "hold", id: "x" }, new Date())
    ).rejects.toThrow(/placeHold/u);
    const admin = await person("admin");
    await placeHold(env, admin, { app, version: 1 }, "legal-1", "Litigation");
    // SAFETY: as above, for unpinning a hold.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const looseUnpin = unpinRelease as (...args: unknown[]) => Promise<void>;
    await expect(
      looseUnpin(env, { app, version: 1 }, { kind: "hold", id: "legal-1" })
    ).rejects.toThrow(/releaseHold/u);
    const holds = await env.DB.prepare(
      "SELECT holder_id FROM sdk_release_pins WHERE app_id = ? AND holder_kind = 'hold'"
    )
      .bind(app)
      .all();
    expect(holds.results).toStrictEqual([{ holder_id: "legal-1" }]);
  });

  it("deletes a lapsed lease at the next sweep", async () => {
    const start = new Date();
    const { app } = await twoVersions(start);
    await leaseRelease(env, { app, version: 1 }, "frame-1", start);
    await sweepsAt(after(start, 20 * 60_000));
    const pins = await env.DB.prepare(
      "SELECT holder_id FROM sdk_release_pins WHERE app_id = ?"
    )
      .bind(app)
      .all();
    expect(pins.results).toStrictEqual([]);
  });

  it("pins only what was sealed", async () => {
    const fixture = await appWith(files("one"));
    await expect(
      failure(async () => {
        await pinRelease(
          env,
          { app: fixture.app, version: 1 },
          { kind: "run", id: "run-1" },
          null
        );
      })
    ).resolves.toBe("version.not_sealed");
  });
});

/** The seal App `app`'s release `version` names. */
const sealOf = async (app: string, version: number): Promise<string> => {
  const row = await env.DB.prepare(
    "SELECT seal_id AS seal FROM sdk_release_manifests WHERE app_id = ? AND version = ?"
  )
    .bind(app, version)
    .first<{ seal: string }>();
  return row?.seal ?? "";
};

/** Whether the artifact `sha256` has its live row and its bytes. */
const kept = async (sha256: string): Promise<boolean> =>
  (await env.FILES.head(await artifactKey(sha256))) !== null;

describe("shared bytes", { timeout: 120_000 }, () => {
  it("are referenced for every artifact a release names, its sealed SDK included", async () => {
    const fixture = await appWith(files("one"));
    const release = await seal(fixture);
    const rows = await env.DB.prepare(
      "SELECT sha256 FROM sdk_artifact_refs WHERE seal = ?"
    )
      .bind(await sealOf(fixture.app, 1))
      .all<{ sha256: string }>();
    const referenced = new Set(rows.results.map(({ sha256 }) => sha256));
    const named = release.manifest.artifacts;
    expect([
      named.some((artifact) => artifact.path.startsWith("sdk/")),
      named.filter((artifact) => !referenced.has(artifact.sha256)),
    ]).toStrictEqual([true, []]);
  });

  it("are never collected while a release references them", async () => {
    const start = new Date();
    const { app, second } = await twoVersions(start);
    const entry = second.manifest.artifacts.find(
      ({ path }) => path === "server/_generated/server.ts"
    );
    await collectArtifacts(env, [entry?.sha256 ?? ""]);
    await expect(
      stored(second, "server/_generated/server.ts")
    ).resolves.toBeTruthy();
    await expect(loadedHash(app, 2)).resolves.toBe(second.manifestHash);
  });

  it("collected while another seal takes them are never lost to the release it seals", async () => {
    // Another App's release went: none of its references are left, so
    // every artifact it named that nothing else names is collectable,
    // the SDK modules a new seal shares with it among them.
    const other = await appWith(files("other"));
    const gone = await seal(other);
    await env.DB.prepare("DELETE FROM sdk_artifact_refs WHERE seal = ?")
      .bind(await sealOf(other.app, 1))
      .run();
    const hashes = gone.manifest.artifacts.map(({ sha256 }) => sha256);
    const fixture = await appWith(files("one"));
    const state = { sealing: true };
    const collecting = async (): Promise<number> => {
      let sweeps = 0;
      while (state.sealing) {
        // oxlint-disable-next-line no-await-in-loop -- sweep after sweep
        await collectArtifacts(env, hashes);
        sweeps += 1;
        // oxlint-disable-next-line no-await-in-loop -- as above
        await scheduler.wait(1);
      }
      return sweeps;
    };
    const publishing = async () => {
      try {
        return await rollback(env, appKind, fixture.owner, fixture.app, 1);
      } finally {
        state.sealing = false;
      }
    };
    const [made, sweeps] = await Promise.all([publishing(), collecting()]);
    const release = await readBackRelease(env, fixture.app, 1);
    expect({
      current: made.version,
      sweeps: sweeps > 0,
      readBack: release.manifestHash,
    }).toStrictEqual({
      current: 1,
      sweeps: true,
      readBack: release.manifestHash,
    });
  });

  it("are referenced and their rows taken or made in one batch, however many a seal names", async () => {
    const artifacts = await Promise.all(
      Array.from({ length: 300 }, async (_, index) => {
        const bytes = new TextEncoder().encode(`artifact ${index}`);
        return [await sha256HexOfBytes(bytes), bytes] as const;
      })
    );
    const id = crypto.randomUUID();
    let batches = 0;
    let runs = 0;
    const real = env.DB;
    const counted: D1Database = {
      prepare: (query) => {
        const statement = real.prepare(query);
        return Object.assign(statement, {
          run: async () => {
            runs += 1;
            return await real.prepare(query).run();
          },
        });
      },
      batch: async <T>(statements: D1PreparedStatement[]) => {
        batches += 1;
        return await real.batch<T>(statements);
      },
      exec: async (query) => await real.exec(query),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await real.dump(),
      withSession: (constraint) => real.withSession(constraint),
    };
    await storeArtifacts({ ...env, DB: counted }, id, artifacts);
    const references = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sdk_artifact_refs WHERE seal = ?"
    )
      .bind(id)
      .first<{ n: number }>();
    const uploaded = await Promise.all(
      artifacts.map(async ([sha256]) => await kept(sha256))
    );
    expect({
      batches,
      runs,
      references: references?.n,
      uploaded: uploaded.every(Boolean),
    }).toStrictEqual({
      batches: 1,
      runs: 0,
      references: 300,
      uploaded: true,
    });
  });

  it("of a release whose sealing batch committed though its answer was lost stay, through a sweep", async () => {
    const fixture = await appWith(files("one"));
    const lost = await failure(
      async () =>
        await sealRelease(
          {
            ...env,
            DB: lostAnswerDb(/^insert into "sdk_release_manifests"/iu),
          },
          {
            app: fixture.app,
            version: 1,
            by: fixture.owner,
          }
        )
    );
    await sweepsAt(new Date());
    const release = await readBackRelease(env, fixture.app, 1);
    expect({
      lost,
      references: release.manifest.artifacts.length > 0,
      readBack: release.manifestHash.length,
    }).toStrictEqual({
      lost: "Error: D1 lost the batch's answer",
      references: true,
      readBack: 64,
    });
  });

  it("left in storage by a failed bulk delete are deleted by a later sweep, never a live one's, after the listing wraps", async () => {
    const fixture = await appWith(files("one"));
    const release = await seal(fixture);
    const [live] = release.manifest.artifacts;
    const sha256 = live?.sha256 ?? "";
    // Bytes of a generation whose row went, as a failed bulk delete leaves
    // them, sorting before where the last sweep stopped.
    const stray = `artifacts/${"0".repeat(64)}/${crypto.randomUUID()}`;
    await env.FILES.put(stray, "left behind");
    await env.FILES.put(strayCursorKey, `artifacts/${"f".repeat(64)}`);
    // Goes on after the saved key, finds the listing's end, and wraps.
    await sweepStrayKeys(env);
    const beforeWrap = (await env.FILES.head(stray)) !== null;
    await sweepStrayKeys(env);
    expect({
      beforeWrap,
      stray: await env.FILES.head(stray),
      live: await kept(sha256),
    }).toStrictEqual({ beforeWrap: true, stray: null, live: true });
  });

  it("a seal named and lost the reference of keep it from sealing", async () => {
    const fixture = await appWith(files("one"));
    const sha256 = await sha256Hex(serverModuleSource);
    const put = env.FILES.put.bind(env.FILES);
    // A reference gone between the seal writing and recording it.
    const losing = async (
      ...args: Parameters<typeof put>
    ): ReturnType<typeof put> => {
      await env.DB.prepare(
        "DELETE FROM sdk_artifact_refs WHERE sha256 = ? AND seal NOT IN (SELECT seal_id FROM sdk_release_manifests WHERE seal_id IS NOT NULL)"
      )
        .bind(sha256)
        .run();
      return await put(...args);
    };
    Reflect.set(env.FILES, "put", losing);
    let outcome: string;
    try {
      outcome = await failure(async () => await seal(fixture));
    } finally {
      Reflect.set(env.FILES, "put", put);
    }
    expect(outcome).toBe("version.seal_busy");
    await expect(
      failure(async () => await loadRelease(env, fixture.app, 1))
    ).resolves.toBe("version.not_sealed");
  });

  it("a seal never finished referenced are swept a day later, with their bytes", async () => {
    const start = new Date();
    const bytes = new TextEncoder().encode(
      `left behind ${crypto.randomUUID()}`
    );
    const sha256 = await sha256HexOfBytes(bytes);
    await storeArtifacts(env, crypto.randomUUID(), [[sha256, bytes]]);
    await env.DB.prepare(
      "UPDATE sdk_artifact_refs SET created_at = ? WHERE sha256 = ?"
    )
      .bind(start.getTime(), sha256)
      .run();
    await sweepsAt(after(start, unnamedSealMs - 60_000));
    const early = await kept(sha256);
    const key = await artifactKey(sha256);
    await sweepsAt(after(start, unnamedSealMs + 60_000));
    expect({
      early,
      row: await env.DB.prepare("SELECT 1 FROM sdk_artifacts WHERE sha256 = ?")
        .bind(sha256)
        .first(),
      bytes: await env.FILES.head(key),
    }).toStrictEqual({ early: true, row: null, bytes: null });
  });

  it("nothing references are collected in batches past one statement's, keys and all", async () => {
    const artifacts = await Promise.all(
      Array.from({ length: collectBatch + 20 }, async (_, index) => {
        const bytes = new TextEncoder().encode(
          `unreferenced ${index} ${crypto.randomUUID()}`
        );
        return [await sha256HexOfBytes(bytes), bytes] as const;
      })
    );
    const id = crypto.randomUUID();
    await storeArtifacts(env, id, artifacts);
    const keys = await Promise.all(
      artifacts.map(async ([sha256]) => await artifactKey(sha256))
    );
    await env.DB.prepare("DELETE FROM sdk_artifact_refs WHERE seal = ?")
      .bind(id)
      .run();
    await sweepsAt(new Date());
    const left = await Promise.all(
      keys.map(async (key) => await env.FILES.head(key))
    );
    expect(left.filter((object) => object !== null)).toHaveLength(0);
  });
});

describe("revocation", { timeout: 120_000 }, () => {
  it("stops a release from running at once, and keeps its bytes", async () => {
    const start = new Date();
    const { app, owner, second } = await twoVersions(start);
    const admin = await person("admin");
    await revokeRelease(env, admin, { app, version: 2 }, "Leaks data");
    await expect(
      failure(async () => await loadRelease(env, app, 2))
    ).resolves.toBe("version.revoked");
    const answer = await callAppFunction(
      env,
      owner,
      app,
      JSON.stringify({
        reference: { name: "notes.label", kind: "query" },
        args: {},
      })
    );
    expect(answer.result).toMatchObject({
      ok: false,
      error: { code: "version.revoked" },
    });
    await expect(
      stored(second, "modules/app~server~notes.js")
    ).resolves.toBeTruthy();
  });

  it("stops a call already running: its mutation commits nothing", async () => {
    const start = new Date();
    const { app, owner, second } = await twoVersions(start);
    const admin = await person("admin");
    const hosted = hostedRelease(env, second);
    let revoked = false;
    // Revoked while the action's first mutation runs, before it commits.
    const run: Runner = async (path, args, channel) => {
      if (path === "notes.touch" && !revoked) {
        revoked = true;
        await revokeRelease(env, admin, { app, version: 2 }, "Mid-call");
      }
      return await hosted.run(path, args, channel);
    };
    const invocation = await invocationFor(env, second, {
      by: owner,
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 60_000,
    });
    const result = await hostFunctionCall(
      { manifest: second.app, run },
      invocation,
      { path: "notes.touchTwice", kind: "action" },
      {}
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "version.revoked" },
    });
  });

  it("keeps a revoked release for good", async () => {
    const start = new Date();
    const { app, first } = await twoVersions(start);
    const admin = await person("admin");
    await revokeRelease(env, admin, { app, version: 1 }, "Leaks data");
    const removeNewer = await newerReleases(app);
    await sweepsAt(after(start, 400 * day));
    await removeNewer();
    const row = await env.DB.prepare(
      "SELECT manifest_hash AS hash FROM sdk_release_manifests WHERE app_id = ? AND version = 1"
    )
      .bind(app)
      .first<{ hash: string }>();
    expect(row?.hash).toBe(first.manifestHash);
    await expect(
      stored(first, "modules/app~server~notes.js")
    ).resolves.toBeTruthy();
  });

  it("is refused to an admin demoted since their session was read, and to staff", async () => {
    const start = new Date();
    const { app, second } = await twoVersions(start);
    const demoted = await person("admin");
    await env.DB.prepare(
      "UPDATE members SET role = 'builder' WHERE user_id = ?"
    )
      .bind(demoted.userId)
      .run();
    await expect(
      failure(async () => {
        await revokeRelease(env, demoted, { app, version: 2 }, "Stale");
      })
    ).resolves.toBe("role.forbidden");
    const staff = { ...(await person("admin")), staff: true };
    await expect(
      failure(async () => {
        await revokeRelease(env, staff, { app, version: 2 }, "Staff");
      })
    ).resolves.toBe("role.forbidden");
    await expect(loadedHash(app, 2)).resolves.toBe(second.manifestHash);
  });

  it("is an admin's, audited once", async () => {
    const start = new Date();
    const { app, first } = await twoVersions(start);
    const builder = await person("builder");
    const admin = await person("admin");
    await expect(
      failure(async () => {
        await revokeRelease(env, builder, { app, version: 1 }, "Mine");
      })
    ).resolves.toBe("role.forbidden");
    await revokeRelease(env, admin, { app, version: 1 }, "Leaks data");
    await revokeRelease(env, admin, { app, version: 1 }, "Again");
    const events = await allEvents();
    expect(
      events
        .filter(
          (event) =>
            event.action === "app.release.revoked" && event.target?.id === app
        )
        .map((event) => event.detail)
    ).toStrictEqual([
      { version: 1, manifestHash: first.manifestHash, reason: "Leaks data" },
    ]);
  });
});

describe("a deleted release", { timeout: 120_000 }, () => {
  it("runs again only once published again, sealed anew and tested", async () => {
    const start = new Date();
    const { app, owner } = await twoVersions(start);
    await sweptAway(app, 1);
    // Nobody makes it current as it is, whoever writes.
    await expect(
      failure(
        async () =>
          await env.DB.prepare(
            "UPDATE apps SET current_version = 1 WHERE id = ?"
          )
            .bind(app)
            .run()
      )
    ).resolves.toContain("apps are made current from a published version");
    const back = await rollback(env, appKind, owner, app, 1);
    const events = await allEvents();
    const published = events.filter(
      (event) =>
        event.action === "app.version.built" &&
        event.target?.id === app &&
        event.detail?.version === 1
    );
    const deleted = events.filter(
      (event) =>
        event.action === "app.release.deleted" && event.target?.id === app
    );
    expect({
      current: back.version,
      published: published.length,
      deleted: deleted.map(({ actor, detail }) => [actor, detail?.version]),
      loads: await failure(async () => await loadRelease(env, app, 1)),
    }).toStrictEqual({
      current: 1,
      published: 2,
      deleted: [[{ type: "system" }, 1]],
      loads: "ok",
    });
  });

  it("leaves its store serving its App alone, even with every binding gone", async () => {
    const start = new Date();
    const fixture = await twoVersions(start);
    const { app, store } = fixture;
    // As retention leaves the store once every release of the App went.
    await env.DB.prepare(
      "DELETE FROM sdk_resource_bindings WHERE resource_id = ?"
    )
      .bind(app)
      .run();
    // Another App's seal, by someone who builds both: its own store.
    const other = await appWith(files("other"), "Other", fixture.owner);
    const sealed = await seal(other);
    expect({
      bound: sealed.store?.storeId,
      apart: other.store !== store,
    }).toStrictEqual({ bound: other.store, apart: true });
  });
});
