import { serverModuleSource } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction, invocationFor } from "../src/app-functions.ts";
import { publishVersion } from "../src/app-publish.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles } from "../src/apps.ts";
import { callOperation } from "../src/operations.ts";
import type { Runner } from "../src/operations.ts";
import {
  candidatePage,
  leaseRelease,
  pinRelease,
  placeHold,
  queueOrphanedReservations,
  releaseHold,
  revokeRelease,
  sealGraceMs,
  sweepReleases,
  unpinRelease,
} from "../src/release-retention.ts";
import { hostedRelease } from "../src/release-runner.ts";
import { appDefinition } from "./app-definitions.ts";
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

const files = (label: string): Record<string, string> => ({
  ...appDefinition({
    name: "Notes",
    tables: {
      notes: {
        fields: { title: "v.string()" },
        access: { read: "owner", write: "owner" },
      },
    },
  }),
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
  uses: [touch],
  handler: async (ctx) => {
    await ctx.runMutation(touch, {});
    await ctx.runMutation(touch, {});
    return null;
  },
});
`,
});

const day = 24 * 60 * 60_000;

/** A Notes App with versions 1 and 2 sealed, version 2 current, as of `start`. */
const twoVersions = async (
  start: Date
): Promise<Fixture & { first: Release; second: Release }> => {
  const fixture = await appWith(files("one"));
  const first = await seal(fixture);
  await publishVersion(env, fixture.owner, fixture.app, 1);
  // The sweep sees version 1 current.
  await sweepReleases(env, start);
  await commitFiles(env, fixture.owner, fixture.app, files("two"), "Two");
  const second = await seal(fixture, 2);
  await publishVersion(env, fixture.owner, fixture.app, 2);
  await sweepReleases(env, start);
  return { ...fixture, first, second };
};

/** Whether `release`'s artifact at `path` still has its bytes. */
const stored = async (release: Release, path: string): Promise<boolean> => {
  const entry = release.manifest.artifacts.find(
    (artifact) => artifact.path === path
  );
  return (await env.FILES.head(artifactKey(entry?.sha256 ?? ""))) !== null;
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

/** Queues `hashes` for the sweep, as removing their last reference does. */
const queueForSweep = async (...hashes: string[]): Promise<void> => {
  await env.DB.batch(
    hashes.map((sha256) =>
      env.DB.prepare(
        "INSERT INTO sdk_artifact_candidates (sha256, queued_at) VALUES (?, ?)"
      ).bind(sha256, Date.now())
    )
  );
};

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

  it("keeps a version among the App's latest and for a day after its seal, then deletes it, only its own bytes, and unpublishes it", async () => {
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
    const status = await env.DB.prepare(
      "SELECT status FROM app_versions WHERE app_id = ? AND version = 1"
    )
      .bind(app)
      .first<{ status: string | null }>();
    // Its own bytes are gone; the bytes the current version shares with it
    // stay, and the current version loads whole.
    expect({
      first: await failure(async () => await loadRelease(env, app, 1)),
      own: await stored(first, "modules/app~server~notes.js"),
      shared: await stored(first, "server/_generated/server.ts"),
      second: await loadedHash(app, 2),
      status: status?.status,
    }).toStrictEqual({
      first: "version.not_sealed",
      own: false,
      shared: true,
      second: second.manifestHash,
      status: null,
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

  it("keeps a version a workflow run is still active on", async () => {
    const start = new Date();
    const { app, first } = await twoVersions(start);
    await env.DB.prepare(
      "INSERT INTO workflow_runs (id, app_id, workflow_id, version, status, created_at) VALUES (?, ?, 'intake', 1, 'paused', ?)"
    )
      .bind(crypto.randomUUID(), app, start.getTime())
      .run();
    const removeNewer = await newerReleases(app);
    await sweepsAt(after(start, sealGraceMs + day));
    await removeNewer();
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
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

describe("shared bytes", { timeout: 120_000 }, () => {
  it("are referenced for every artifact a release names, its sealed SDK included", async () => {
    const fixture = await appWith(files("one"));
    const release = await seal(fixture);
    const rows = await env.DB.prepare(
      "SELECT sha256 FROM sdk_release_artifacts WHERE app_id = ? AND version = 1"
    )
      .bind(fixture.app)
      .all<{ sha256: string }>();
    const reserved = new Set(rows.results.map(({ sha256 }) => sha256));
    const named = release.manifest.artifacts;
    expect([
      named.some((artifact) => artifact.path.startsWith("sdk/")),
      named.filter((artifact) => !reserved.has(artifact.sha256)),
    ]).toStrictEqual([true, []]);
  });

  it("are never deleted while a release references them", async () => {
    const start = new Date();
    const { app, second } = await twoVersions(start);
    const entry = second.manifest.artifacts.find(
      ({ path }) => path === "server/_generated/server.ts"
    );
    await queueForSweep(entry?.sha256 ?? "");
    await sweepsAt(new Date());
    await expect(
      stored(second, "server/_generated/server.ts")
    ).resolves.toBeTruthy();
    await expect(loadedHash(app, 2)).resolves.toBe(second.manifestHash);
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
        "DELETE FROM sdk_release_artifacts WHERE sha256 = ? AND app_id = ?"
      )
        .bind(sha256, fixture.app)
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

  it("a sealed release lost the references of are referenced again by sealing it again", async () => {
    const fixture = await appWith(files("one"));
    const release = await seal(fixture);
    await env.DB.prepare(
      "DELETE FROM sdk_release_artifacts WHERE app_id = ? AND version = 1"
    )
      .bind(fixture.app)
      .run();
    const again = await seal(fixture);
    const rows = await env.DB.prepare(
      "SELECT sha256 FROM sdk_release_artifacts WHERE app_id = ? AND version = 1"
    )
      .bind(fixture.app)
      .all<{ sha256: string }>();
    const reserved = new Set(rows.results.map(({ sha256 }) => sha256));
    expect([
      again.manifestHash,
      release.manifest.artifacts.filter(
        (artifact) => !reserved.has(artifact.sha256)
      ),
    ]).toStrictEqual([release.manifestHash, []]);
  });

  it("a seal references again are referenced anew, so a sweep can't take them mid-seal", async () => {
    const fixture = await appWith(files("one"));
    // A seal of this version failed a long time ago, after referencing.
    const sha256 = await sha256Hex(serverModuleSource);
    await env.DB.prepare(
      "INSERT INTO sdk_release_artifacts (sha256, app_id, version, reserved_at) VALUES (?, ?, 1, ?)"
    )
      .bind(sha256, fixture.app, Date.now() - 30 * day)
      .run();
    const before = Date.now();
    await seal(fixture);
    const row = await env.DB.prepare(
      "SELECT reserved_at AS reservedAt FROM sdk_release_artifacts WHERE sha256 = ? AND app_id = ?"
    )
      .bind(sha256, fixture.app)
      .first<{ reservedAt: number }>();
    expect(row?.reservedAt).toBeGreaterThanOrEqual(before);
  });

  it("a seal never finished referenced are swept a day later", async () => {
    const start = new Date();
    const orphan = "f".repeat(64);
    await env.FILES.put(artifactKey(orphan), "left behind");
    await env.DB.prepare(
      "INSERT INTO sdk_release_artifacts (sha256, app_id, version, reserved_at) VALUES (?, 'app_gone', 1, ?)"
    )
      .bind(orphan, start.getTime())
      .run();
    await sweepsAt(after(start, sealGraceMs - 60_000));
    await expect(env.FILES.head(artifactKey(orphan))).resolves.not.toBeNull();
    await sweepsAt(after(start, sealGraceMs + 60_000));
    await expect(env.FILES.head(artifactKey(orphan))).resolves.toBeNull();
  });
});

describe("bytes left without a reference", { timeout: 120_000 }, () => {
  it("one of which fails to delete leave the others deleted, and it queued", async () => {
    const hashes = await Promise.all(
      [1, 2, 3].map(async () => await sha256Hex(crypto.randomUUID()))
    );
    await Promise.all(
      hashes.map(async (sha256) => {
        await env.FILES.put(artifactKey(sha256), "unreserved");
      })
    );
    const failing = artifactKey(hashes[1] ?? "");
    const remove = env.FILES.delete.bind(env.FILES);
    const failingOne = async (
      ...args: Parameters<typeof remove>
    ): ReturnType<typeof remove> => {
      if (args[0] === failing) {
        throw new Error("R2 is unavailable for this one");
      }
      await remove(...args);
    };
    await queueForSweep(...hashes);
    Reflect.set(env.FILES, "delete", failingOne);
    try {
      await sweepsAt(new Date());
    } finally {
      Reflect.set(env.FILES, "delete", remove);
    }
    const left = await Promise.all(
      hashes.map(
        async (sha256) => (await env.FILES.head(artifactKey(sha256))) !== null
      )
    );
    const still = await env.DB.prepare(
      "SELECT sha256 FROM sdk_artifact_candidates WHERE sha256 IN (?, ?, ?)"
    )
      .bind(...hashes)
      .all<{ sha256: string }>();
    expect([left, still.results]).toStrictEqual([
      [false, true, false],
      [{ sha256: hashes[1] }],
    ]);
  });

  it("of more seals than one page holds are all deleted", async () => {
    const start = new Date();
    const hashes = await Promise.all(
      Array.from(
        { length: candidatePage + 20 },
        async () => await sha256Hex(crypto.randomUUID())
      )
    );
    await Promise.all(
      hashes.map(async (sha256) => {
        await env.FILES.put(artifactKey(sha256), "left behind");
      })
    );
    await env.DB.batch(
      hashes.map((sha256) =>
        env.DB.prepare(
          "INSERT INTO sdk_release_artifacts (sha256, app_id, version, reserved_at) VALUES (?, 'app_gone', 1, ?)"
        ).bind(sha256, start.getTime())
      )
    );
    await sweepsAt(after(start, sealGraceMs + 60_000));
    const left = await Promise.all(
      hashes.map(async (sha256) => await env.FILES.head(artifactKey(sha256)))
    );
    expect(left.filter((object) => object !== null)).toHaveLength(0);
  });

  it("queued again while a sweep deletes them stay queued for the next", async () => {
    const sha256 = await sha256Hex(crypto.randomUUID());
    await env.FILES.put(artifactKey(sha256), "queued");
    await env.DB.prepare(
      "INSERT INTO sdk_artifact_candidates (sha256, queued_at) VALUES (?, ?)"
    )
      .bind(sha256, Date.now() - 60_000)
      .run();
    const remove = env.FILES.delete.bind(env.FILES);
    // Mid-delete, an unfinished seal's reservation of them is swept, which
    // queues them again: another sweep's step, run for real.
    const requeueing = async (
      ...args: Parameters<typeof remove>
    ): ReturnType<typeof remove> => {
      if (args[0] === artifactKey(sha256)) {
        await env.DB.prepare(
          "INSERT INTO sdk_release_artifacts (sha256, app_id, version, reserved_at) VALUES (?, 'app_gone', 1, ?)"
        )
          .bind(sha256, Date.now() - 2 * sealGraceMs)
          .run();
        await queueOrphanedReservations(env, new Date());
      }
      await remove(...args);
    };
    Reflect.set(env.FILES, "delete", requeueing);
    try {
      await sweepsAt(new Date());
    } finally {
      Reflect.set(env.FILES, "delete", remove);
    }
    const queued = await env.DB.prepare(
      "SELECT sha256 FROM sdk_artifact_candidates WHERE sha256 = ?"
    )
      .bind(sha256)
      .all();
    expect(queued.results).toStrictEqual([{ sha256 }]);
  });

  it("a sweep queued and didn't get to are dealt with by the next", async () => {
    const [gone, kept] = await Promise.all([
      sha256Hex(crypto.randomUUID()),
      sha256Hex(crypto.randomUUID()),
    ]);
    await env.FILES.put(artifactKey(gone), "queued");
    await env.FILES.put(artifactKey(kept), "referenced again");
    // Queued as their references went; one was referenced again since.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sdk_artifact_candidates (sha256, queued_at) VALUES (?1, ?3), (?2, ?3)"
      ).bind(gone, kept, Date.now()),
      env.DB.prepare(
        "INSERT INTO sdk_release_artifacts (sha256, app_id, version, reserved_at) VALUES (?, 'app_sealing', 1, ?)"
      ).bind(kept, Date.now()),
    ]);
    await sweepsAt(new Date());
    const queued = await env.DB.prepare(
      "SELECT sha256 FROM sdk_artifact_candidates WHERE sha256 IN (?, ?)"
    )
      .bind(gone, kept)
      .all();
    expect([
      await env.FILES.head(artifactKey(gone)),
      (await env.FILES.head(artifactKey(kept))) !== null,
      queued.results,
    ]).toStrictEqual([null, true, []]);
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
        input: {},
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
    const result = await callOperation(
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
    const back = await publishVersion(env, owner, app, 1);
    const events = await allEvents();
    const published = events.filter(
      (event) =>
        event.action === "app.version.published" &&
        event.target?.id === app &&
        event.detail?.version === 1
    );
    expect({
      current: back.currentVersion,
      published: published.length,
      loads: await failure(async () => await loadRelease(env, app, 1)),
    }).toStrictEqual({ current: 1, published: 2, loads: "ok" });
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
