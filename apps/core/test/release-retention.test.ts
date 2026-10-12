import { serverModuleSource } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  callAppFunction,
  hostedRelease,
  invocationFor,
} from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { commitFiles, setCurrentVersion } from "../src/apps.ts";
import { callOperation } from "../src/operations.ts";
import type { Runner } from "../src/operations.ts";
import {
  deleteUnreservedArtifacts,
  finishDeletion,
  leaseRelease,
  markArtifact,
  markTakeoverMs,
  pinRelease,
  placeHold,
  releaseGraceMs,
  releaseHold,
  releaseRetentionMs,
  revokeRelease,
  sweepReleases,
} from "../src/release-retention.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, artifactKey, failure, person, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";

// How long sealed releases stay, and how one is revoked (spec 16.3),
// through real D1, R2 and seals: what keeps a release, that nothing
// referenced is deleted, that shared bytes outlive the release that goes,
// and that a seal and a sweep can't delete what the other relies on.

const files = (label: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";
export default defineSchema({ notes: defineTable({ title: v.string() }) });
`,
  "operations/notes.ts": `import { v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";
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
  "app.ts": `import { app } from "@grasp-os/sdk";
import { label, touch, touchTwice } from "./operations/notes.ts";
import schema from "./schema.ts";
export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "owner", write: "owner" } } },
  operations: { notes: { label, touch, touchTwice } },
  screens: [],
  uses: [],
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
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  // The sweep sees version 1 current.
  await sweepReleases(env, start);
  await commitFiles(env, fixture.owner, fixture.app, files("two"), "Two");
  const second = await seal(fixture, 2);
  await setCurrentVersion(env, fixture.owner, fixture.app, 2);
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

describe("retention", { timeout: 120_000 }, () => {
  it("keeps the current version however old it is", async () => {
    const start = new Date();
    const { app, second } = await twoVersions(start);
    await sweepsAt(
      after(start, 400 * day),
      after(start, 400 * day + 2 * releaseGraceMs)
    );
    const loaded = await loadRelease(env, app, 2);
    expect(loaded.manifestHash).toBe(second.manifestHash);
  });

  it("keeps a version 90 days after it was last current, then a grace, then deletes it and only its own bytes", async () => {
    const start = new Date();
    const { app, first, second } = await twoVersions(start);
    // Within the 90 days, and within the grace once past them: kept.
    await sweepsAt(
      after(start, releaseRetentionMs - day),
      after(start, releaseRetentionMs + 60_000),
      after(start, releaseRetentionMs + releaseGraceMs - 60_000)
    );
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
    // A grace after it was first found unreferenced: deleted.
    await sweepsAt(after(start, releaseRetentionMs + releaseGraceMs + 120_000));
    await expect(
      failure(async () => await loadRelease(env, app, 1))
    ).resolves.toBe("version.not_sealed");
    // Its own bytes are gone; the bytes the current version shares with it
    // stay, and the current version loads whole.
    expect([
      await stored(first, "modules/app~operations~notes.js"),
      await stored(first, ".grasp/server.ts"),
    ]).toStrictEqual([false, true]);
    await expect(loadedHash(app, 2)).resolves.toBe(second.manifestHash);
  });

  it("keeps a version an open screen leases, for as long as it renews", async () => {
    const start = new Date();
    const { app, first } = await twoVersions(start);
    const key = { app, version: 1 };
    const past = after(start, releaseRetentionMs + day);
    const minute = 60_000;
    await leaseRelease(env, key, "frame-1", past);
    // Leased: not marked while the lease holds; marked once it lapses.
    await sweepsAt(past, after(past, 10 * minute), after(past, 20 * minute));
    // The screen comes back within the grace and renews: the next sweep
    // finds it held again, and the grace starts over once it lapses.
    await leaseRelease(env, key, "frame-1", after(past, 30 * minute));
    const renewedLapse = after(past, 20 * minute + releaseGraceMs + minute);
    await sweepsAt(after(past, 35 * minute), renewedLapse);
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
    // Not renewed again: a grace after the lease lapsed, it goes.
    await sweepsAt(after(renewedLapse, releaseGraceMs + minute));
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
    const past = after(start, releaseRetentionMs + day);
    await sweepsAt(past, after(past, 2 * releaseGraceMs));
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
  });

  it("keeps a version an admin's legal hold holds until it is released, both audited", async () => {
    const start = new Date();
    const { app, first } = await twoVersions(start);
    const admin = await person("admin");
    const key = { app, version: 1 };
    await placeHold(env, admin, key, "legal-1", "Litigation");
    await placeHold(env, admin, key, "legal-1", "Again");
    const past = after(start, releaseRetentionMs + day);
    await sweepsAt(past, after(past, 2 * releaseGraceMs));
    await expect(loadedHash(app, 1)).resolves.toBe(first.manifestHash);
    await releaseHold(env, admin, key, "legal-1");
    await sweepsAt(
      after(past, 3 * releaseGraceMs),
      after(past, 4 * releaseGraceMs + 60_000)
    );
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

  it("counts a version's retention from when it stopped being current, not from the next sweep", async () => {
    const fixture = await appWith(files("one"));
    await seal(fixture);
    await setCurrentVersion(env, fixture.owner, fixture.app, 1);
    await commitFiles(env, fixture.owner, fixture.app, files("two"), "Two");
    await seal(fixture, 2);
    await setCurrentVersion(env, fixture.owner, fixture.app, 2);
    // Sealed long ago, and never swept while current.
    await env.DB.prepare(
      "UPDATE sdk_release_manifests SET sealed_at = ? WHERE app_id = ? AND version = 1"
    )
      .bind(Date.now() - 200 * day, fixture.app)
      .run();
    const now = new Date();
    await sweepsAt(after(now, 60_000), after(now, releaseGraceMs + 2 * 60_000));
    await expect(loadedHash(fixture.app, 1)).resolves.toMatch(
      /^[0-9a-f]{64}$/u
    );
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
  it("are never deleted while a release reserves them", async () => {
    const start = new Date();
    const { app, second } = await twoVersions(start);
    const entry = second.manifest.artifacts.find(
      ({ path }) => path === ".grasp/server.ts"
    );
    await deleteUnreservedArtifacts(env, [entry?.sha256 ?? ""]);
    await expect(stored(second, ".grasp/server.ts")).resolves.toBeTruthy();
    await expect(loadedHash(app, 2)).resolves.toBe(second.manifestHash);
  });

  it("being deleted are written by a seal only after the deleter's own delete", async () => {
    // A deleter marks the server module's bytes (every App's are the
    // same), and stalls before deleting them.
    const sha256 = await sha256Hex(serverModuleSource);
    await env.DB.prepare("DELETE FROM sdk_release_artifacts WHERE sha256 = ?")
      .bind(sha256)
      .run();
    const owner = await markArtifact(env, sha256);
    expect(owner).toBeDefined();
    const fixture = await appWith(files("one"));
    const sealing = seal(fixture);
    // The seal has reserved its other artifacts, and waits on the mark.
    const reserving = async (): Promise<void> => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polled in turn
        const rows = await env.DB.prepare(
          "SELECT 1 FROM sdk_release_artifacts WHERE app_id = ? LIMIT 1"
        )
          .bind(fixture.app)
          .all();
        if (rows.results.length > 0) {
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- see above
        await scheduler.wait(50);
      }
      throw new Error("The seal never reserved");
    };
    await reserving();
    await scheduler.wait(500);
    const mark = await env.DB.prepare(
      "SELECT owner FROM sdk_artifact_deletions WHERE sha256 = ?"
    )
      .bind(sha256)
      .first<{ owner: string }>();
    // Still the deleter's: the seal took nothing over.
    expect(mark?.owner).toBe(owner);
    await finishDeletion(env, sha256, owner ?? "");
    const release = await sealing;
    await expect(stored(release, ".grasp/server.ts")).resolves.toBeTruthy();
    await expect(loadedHash(fixture.app, 1)).resolves.toBe(
      release.manifestHash
    );
  });

  it("being deleted by a deleter that stopped are taken over by a seal", async () => {
    const sha256 = await sha256Hex(serverModuleSource);
    await env.DB.prepare("DELETE FROM sdk_release_artifacts WHERE sha256 = ?")
      .bind(sha256)
      .run();
    await markArtifact(env, sha256, new Date(Date.now() - 2 * markTakeoverMs));
    const fixture = await appWith(files("one"));
    const release = await seal(fixture);
    const marks = await env.DB.prepare(
      "SELECT sha256 FROM sdk_artifact_deletions WHERE sha256 = ?"
    )
      .bind(sha256)
      .all();
    expect(marks.results).toStrictEqual([]);
    await expect(stored(release, ".grasp/server.ts")).resolves.toBeTruthy();
  });

  it("a seal reserves again are reserved anew, so a sweep can't take them mid-seal", async () => {
    const fixture = await appWith(files("one"));
    // A seal of this version failed a long time ago, after reserving.
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

  it("a seal never finished reserved are swept a grace later", async () => {
    const start = new Date();
    const orphan = "f".repeat(64);
    await env.FILES.put(artifactKey(orphan), "left behind");
    await env.DB.prepare(
      "INSERT INTO sdk_release_artifacts (sha256, app_id, version, reserved_at) VALUES (?, 'app_gone', 1, ?)"
    )
      .bind(orphan, start.getTime())
      .run();
    await sweepsAt(after(start, releaseGraceMs - 60_000));
    await expect(env.FILES.head(artifactKey(orphan))).resolves.not.toBeNull();
    await sweepsAt(after(start, releaseGraceMs + 60_000));
    await expect(env.FILES.head(artifactKey(orphan))).resolves.toBeNull();
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
        reference: {
          resourceId: app,
          resourceVersion: 2,
          contractId: "notes.label",
          fingerprint: second.fingerprints["notes.label"],
          kind: "query",
        },
        input: {},
      })
    );
    expect(answer.result).toMatchObject({
      ok: false,
      error: { code: "version.revoked" },
    });
    await expect(
      stored(second, "modules/app~operations~notes.js")
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
    const past = after(start, 2 * releaseRetentionMs);
    await sweepsAt(past, after(past, 2 * releaseGraceMs));
    const row = await env.DB.prepare(
      "SELECT manifest_hash AS hash FROM sdk_release_manifests WHERE app_id = ? AND version = 1"
    )
      .bind(app)
      .first<{ hash: string }>();
    expect(row?.hash).toBe(first.manifestHash);
    await expect(
      stored(first, "modules/app~operations~notes.js")
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
  it("seals again only as itself", async () => {
    const start = new Date();
    const { app, owner, store, first } = await twoVersions(start);
    await sweepsAt(
      after(start, releaseRetentionMs + 60_000),
      after(start, releaseRetentionMs + releaseGraceMs + 120_000)
    );
    await expect(
      failure(async () => await loadRelease(env, app, 1))
    ).resolves.toBe("version.not_sealed");
    // A tombstone naming another manifest: the seal is refused.
    await env.DB.prepare(
      "UPDATE sdk_release_tombstones SET manifest_hash = ? WHERE app_id = ? AND version = 1"
    )
      .bind("0".repeat(64), app)
      .run();
    await expect(
      failure(async () => await seal({ owner, app, store }, 1))
    ).resolves.toBe("version.seal_conflict");
    // Its own: the same release again.
    await env.DB.prepare(
      "UPDATE sdk_release_tombstones SET manifest_hash = ? WHERE app_id = ? AND version = 1"
    )
      .bind(first.manifestHash, app)
      .run();
    const again = await seal({ owner, app, store }, 1);
    expect(again.manifestHash).toBe(first.manifestHash);
  });
});
