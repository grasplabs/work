import { compilerVersion } from "@grasp-os/compiler";
import { sdkProtocolVersion } from "@grasp-os/shared/app-releases";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { activateVersion } from "../src/app-activation.ts";
import {
  activateCandidate,
  freezeCandidate,
  maxCandidateAttempts,
  runCandidate,
} from "../src/app-candidates.ts";
import type { CandidateRow } from "../src/app-candidates.ts";
import { addMember, removeMember } from "../src/app-members.ts";
import { loadRelease, sealRelease } from "../src/app-releases.ts";
import { commitFiles, findApp, findVersion } from "../src/apps.ts";
import type { Acting } from "../src/auth/identity.ts";
import { appCandidateReports, appCandidates } from "../src/db/core/schema.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, artifactKey, failure, person } from "./sealed-apps.ts";
import { workflowFiles } from "./workflow-apps.ts";

// Candidates (app-candidates.ts), from their threat model: a version is
// made current only from a candidate verified with its report, over the
// version it was based on; reports and what a candidate pins never
// change, and it moves forward only; a person's newer commit supersedes
// it, and a run that lost it writes nothing more; a crash leaves it to be
// taken over; each failure ends it in its outcome with the current
// version untouched.

/** An App of spec 8's layout answering `greeting`. */
const helloFiles = (greeting = "hello"): Record<string, string> => ({
  "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
  "operations/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "#grasp/server";

export const hello = query({
  args: {},
  returns: v.string(),
  handler: () => ${JSON.stringify(greeting)},
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { hello } from "./operations/hello.ts";
import schema from "./schema.ts";

export default app({
  name: "Hello",
  schema,
  access: { tables: {} },
  operations: { hello: { hello } },
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
});

/** Commits `files` as `app`'s next version, by `by`: its number. */
const committed = async (
  by: Acting & Identity,
  app: AppId,
  files: Record<string, string | null>
): Promise<number> => {
  const { version } = await commitFiles(env, by, app, files, "Next");
  return version;
};

/** Seals `version` of `app` as activation does, its move to building first. */
const sealing =
  (by: Acting & Identity, app: AppId, version: number) =>
  async (building: () => Promise<void>): Promise<void> => {
    await sealRelease(env, { app, version, by, building });
  };

/** The candidate `id`, as core keeps it now. */
const candidate = async (id: string): Promise<CandidateRow | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(appCandidates)
    .where(eq(appCandidates.id, id))
    .get();

/** `app`'s current version. */
const currentOf = async (app: AppId): Promise<number | null> => {
  const { currentVersion } = await findApp(env, app);
  return currentVersion;
};

/** The current version of the App `activation` answers with. */
const currentAfter = async (
  activation: Promise<{ currentVersion: number | null }>
): Promise<number | null> => {
  const { currentVersion } = await activation;
  return currentVersion;
};

/** `field` of the candidate `id`, as core keeps it now. */
const fieldOf = async (
  id: string,
  field: "state" | "outcome"
): Promise<string | null | undefined> => {
  const row = await candidate(id);
  return row?.[field];
};

/** How many reports the candidate `id` has. */
const reportCount = async (id: string): Promise<number> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(appCandidateReports)
    .where(eq(appCandidateReports.candidateId, id))
    .all();
  return rows.length;
};

/** `app`'s candidates, oldest first. */
const candidatesOf = async (app: AppId): Promise<CandidateRow[]> =>
  await drizzle(env.DB)
    .select()
    .from(appCandidates)
    .where(eq(appCandidates.appId, app))
    .orderBy(appCandidates.createdAt, asc(sql`rowid`))
    .all();

/** A candidate of `version` frozen over what is current, run to verified. */
const verifiedCandidate = async (
  by: Acting & Identity,
  app: AppId,
  version: number
): Promise<CandidateRow> => {
  const { currentVersion } = await findApp(env, app);
  const frozen = await freezeCandidate(env, by, app, version, currentVersion);
  return await runCandidate(env, by, frozen, sealing(by, app, version));
};

/**
 * Core's database as a Worker running another compiler reads it: every
 * report's environment is one it didn't verify under, as for the newer
 * Worker of a rollout.
 */
const otherCompilerDb = (): D1Database => {
  const real = env.DB;
  return {
    prepare: (query) =>
      real.prepare(
        query.replace(
          /^select "report" from "app_candidate_reports"/u,
          `select json_set("report", '$.environment.compilerVersion', 'other') from "app_candidate_reports"`
        )
      ),
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

/** Appends a byte to the stored artifact at `key`. */
const appendByte = async (key: string): Promise<void> => {
  const stored = await env.FILES.get(key);
  await env.FILES.put(key, `${(await stored?.text()) ?? ""} `);
};

/** Runs `statement`, answering the error it was aborted with, or "ok". */
const aborted = async (statement: string, ...binds: unknown[]) =>
  await failure(
    async () =>
      await env.DB.prepare(statement)
        .bind(...binds)
        .run()
  );

/** "refused" for the refusal of a version made current by hand, else what happened. */
const madeCurrentRefusal = (outcome: string): string =>
  outcome.includes("apps are made current from a verified candidate")
    ? "refused"
    : outcome;

describe(
  "making a version current through a candidate",
  { timeout: 120_000 },
  () => {
    it("moves it through every stage to active, with a report of what core read back", async () => {
      const { owner, app } = await appWith(helloFiles());
      const activated = await activateVersion(env, owner, app, 1);
      const [made] = await candidatesOf(app);
      const release = await loadRelease(env, app, 1);
      const { tree } = await findVersion(env, app, 1);
      const report = await drizzle(env.DB)
        .select()
        .from(appCandidateReports)
        .where(eq(appCandidateReports.candidateId, made?.id ?? ""))
        .get();
      const expected = canonicalText({
        formatVersion: 2,
        candidate: {
          id: made?.id,
          appId: app,
          version: 1,
          sourceTree: tree,
          basedOn: 0,
          previousCandidate: null,
        },
        release: {
          manifestHash: release.manifestHash,
          sourceTreeHash: release.manifest.sourceTreeHash,
          verificationReportHash: release.manifest.verificationReportHash,
          dataStoreBindings: release.manifest.dataStoreBindings,
          migrationEvidence: await sha256Hex(
            canonicalText(release.manifest.migrationEvidence)
          ),
          artifacts: {
            count: release.manifest.artifacts.length,
            readBack: await sha256Hex(
              canonicalText(
                release.manifest.artifacts.map(({ path, sha256, bytes }) => ({
                  path,
                  sha256,
                  bytes,
                }))
              )
            ),
          },
        },
        selected: { appTests: [], workflowTests: [] },
        // As it was verified: no permission, not yet approved, no policy.
        authority: {
          permissions: await sha256Hex(canonicalText([])),
          permissionCount: 0,
          approved: null,
          screenPolicy: null,
        },
        environment: {
          compilerVersion,
          sdkProtocolVersion,
          platformRelease: env.CF_VERSION_METADATA?.id ?? null,
        },
        rollback: { to: null, eligible: false },
      });
      expect({
        current: activated.currentVersion,
        state: made?.state,
        attempt: made?.attempt,
        lease: made?.lease,
        report: report?.report,
        hash: [report?.hash, made?.reportHash],
      }).toStrictEqual({
        current: 1,
        state: "active",
        attempt: 1,
        lease: null,
        report: expected,
        hash: [await sha256Hex(expected), await sha256Hex(expected)],
      });
      const events = await allEvents();
      const moves = events
        .filter(
          ({ action, detail }) =>
            action === "app.candidate.moved" && detail?.candidate === made?.id
        )
        .map(({ detail }) => [detail?.from, detail?.to]);
      expect(moves).toStrictEqual([
        ["frozen", "checking"],
        ["checking", "building"],
        ["building", "verifying"],
        ["verifying", "verified"],
      ]);
    });

    it("reports the App and workflow tests its verification ran", async () => {
      const { owner, app } = await appWith({
        ...helloFiles(),
        "tests/fixtures/people.json": JSON.stringify({
          principals: { reader: { role: "user" } },
        }),
        "tests/hello.test.ts": `import { appTest } from "@grasp-os/sdk/testing";
import { api } from "#grasp";

export default appTest({
  fixtures: "people",
  tests: {
    "says hello": async (t) => {
      const reader = await t.as("reader");
      t.equal(await reader.query(api.hello.hello, {}), "hello");
    },
  },
});
`,
        ...workflowFiles(
          "count",
          '  return await step.do("one", { description: "One" }, async () => 1);',
          { one: 1 }
        ),
      });
      await activateVersion(env, owner, app, 1);
      const [made] = await candidatesOf(app);
      const row = await drizzle(env.DB)
        .select()
        .from(appCandidateReports)
        .where(eq(appCandidateReports.candidateId, made?.id ?? ""))
        .get();
      expect(
        z
          .object({
            selected: z.object({
              appTests: z.array(z.string()),
              workflowTests: z.array(z.string()),
            }),
          })
          .parse(JSON.parse(row?.report ?? "{}")).selected
      ).toStrictEqual({
        appTests: ["tests/hello.test.ts"],
        workflowTests: ["count"],
      });
    });

    it("refuses a candidate whose sealed artifact changed in storage, reading it back itself", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      await committed(owner, app, helloFiles("two"));
      await activateVersion(env, owner, app, 1);
      // Sealed, then one of its artifacts changed before it is verified.
      await sealRelease(env, { app, version: 2, by: owner });
      const { manifest } = await loadRelease(env, app, 2);
      const entry = manifest.artifacts.find(({ path }) =>
        path.startsWith("modules/")
      );
      const key = artifactKey(entry?.sha256 ?? "");
      const stored = await env.FILES.get(key);
      const forged = `${(await stored?.text()) ?? ""} `;
      await env.FILES.put(key, forged);
      const refused = await failure(
        async () => await activateVersion(env, owner, app, 2)
      );
      const [, second] = await candidatesOf(app);
      expect({
        refused,
        outcome: [second?.state, second?.outcome],
        current: await currentOf(app),
      }).toStrictEqual({
        refused: "version.artifact_corrupt",
        outcome: ["rejected", "version.artifact_corrupt"],
        current: 1,
      });
    });

    it("refuses to make a verified candidate current once an artifact of its release changed in storage", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      await committed(owner, app, helloFiles("two"));
      await activateVersion(env, owner, app, 1);
      // Verified, with its release read back whole.
      const verified = await verifiedCandidate(owner, app, 2);
      const { manifest } = await loadRelease(env, app, 2);
      const entry = manifest.artifacts.find(({ path }) =>
        path.startsWith("modules/")
      );
      const key = artifactKey(entry?.sha256 ?? "");
      await appendByte(key);
      // The isolate's cache of verified releases is warm from the load above.
      const refused = await failure(
        async () => await activateCandidate(env, owner, verified)
      );
      expect({
        refused,
        current: await currentOf(app),
        state: await fieldOf(verified.id, "state"),
        outcome: await fieldOf(verified.id, "outcome"),
      }).toStrictEqual({
        refused: "version.artifact_corrupt",
        current: 1,
        state: "rejected",
        outcome: "version.artifact_corrupt",
      });
    });

    it("reads artifacts back without vouching for them to later loads", async () => {
      const { owner, app } = await appWith(helloFiles());
      await activateVersion(env, owner, app, 1);
      const [made] = await candidatesOf(app);
      const report = await drizzle(env.DB)
        .select()
        .from(appCandidateReports)
        .where(eq(appCandidateReports.candidateId, made?.id ?? ""))
        .get();
      const manifestRow = await env.DB.prepare(
        "SELECT manifest FROM sdk_release_manifests WHERE app_id = ? AND version = 1"
      )
        .bind(app)
        .first<{ manifest: string }>();
      const { artifacts } = z
        .object({
          artifacts: z.array(
            z.object({ path: z.string(), sha256: z.string() })
          ),
        })
        .parse(JSON.parse(manifestRow?.manifest ?? "{}"));
      const entry = artifacts.find(({ path }) => path.startsWith("modules/"));
      const key = artifactKey(entry?.sha256 ?? "");
      const stored = await env.FILES.get(key);
      await env.FILES.put(key, `${(await stored?.text()) ?? ""} `);
      expect({
        reported: report?.report.includes('"readBack"'),
        load: await failure(async () => await loadRelease(env, app, 1)),
      }).toStrictEqual({
        reported: true,
        load: "version.artifact_corrupt",
      });
    });

    it("reports whether the version it replaces could run again", async () => {
      const kept = await appWith(helloFiles("one"));
      await committed(kept.owner, kept.app, helloFiles("two"));
      await activateVersion(env, kept.owner, kept.app, 1);
      await activateVersion(env, kept.owner, kept.app, 2);
      const revoked = await appWith(helloFiles("one"));
      await committed(revoked.owner, revoked.app, helloFiles("two"));
      await activateVersion(env, revoked.owner, revoked.app, 1);
      await revokeRelease(
        env,
        await person("admin"),
        { app: revoked.app, version: 1 },
        "Leaks data"
      );
      await activateVersion(env, revoked.owner, revoked.app, 2);
      // Its release flagged runnable, but an artifact of it gone bad in
      // storage: read back, it couldn't run again.
      const damaged = await appWith(helloFiles("one"));
      await committed(damaged.owner, damaged.app, helloFiles("two"));
      await activateVersion(env, damaged.owner, damaged.app, 1);
      await sealRelease(env, {
        app: damaged.app,
        version: 2,
        by: damaged.owner,
      });
      const first = await loadRelease(env, damaged.app, 1);
      const next = await loadRelease(env, damaged.app, 2);
      const keptHashes = new Set(next.manifest.artifacts.map((a) => a.sha256));
      const own = first.manifest.artifacts.find(
        ({ path, sha256 }) =>
          path.startsWith("modules/") && !keptHashes.has(sha256)
      );
      const ownKey = artifactKey(own?.sha256 ?? "");
      await appendByte(ownKey);
      await activateVersion(env, damaged.owner, damaged.app, 2);
      const rollbackOf = async (app: AppId) => {
        const [, second] = await candidatesOf(app);
        const row = await drizzle(env.DB)
          .select()
          .from(appCandidateReports)
          .where(eq(appCandidateReports.candidateId, second?.id ?? ""))
          .get();
        return z
          .object({
            rollback: z.object({
              to: z.number().nullable(),
              eligible: z.boolean(),
            }),
          })
          .parse(JSON.parse(row?.report ?? "{}")).rollback;
      };
      expect({
        kept: await rollbackOf(kept.app),
        revoked: await rollbackOf(revoked.app),
        damaged: await rollbackOf(damaged.app),
      }).toStrictEqual({
        kept: { to: 1, eligible: true },
        revoked: { to: 1, eligible: false },
        damaged: { to: 1, eligible: false },
      });
    });

    it("keeps every report and what a candidate pins, and moves it forward only", async () => {
      const { owner, app } = await appWith(helloFiles());
      await activateVersion(env, owner, app, 1);
      const [made] = await candidatesOf(app);
      const id = made?.id ?? "";
      const frozen = await freezeCandidate(env, owner, app, 1, 1);
      expect({
        reportChanged: await aborted(
          "UPDATE app_candidate_reports SET report = '{}' WHERE candidate_id = ?",
          id
        ),
        reportDeleted: await aborted(
          "DELETE FROM app_candidate_reports WHERE candidate_id = ?",
          id
        ),
        versionChanged: await aborted(
          "UPDATE app_candidates SET version = 2 WHERE id = ?",
          id
        ),
        treeChanged: await aborted(
          "UPDATE app_candidates SET source_tree = 'other' WHERE id = ?",
          id
        ),
        baseChanged: await aborted(
          "UPDATE app_candidates SET based_on = 7 WHERE id = ?",
          id
        ),
        reportHashChanged: await aborted(
          "UPDATE app_candidates SET report_hash = ? WHERE id = ?",
          "0".repeat(64),
          id
        ),
        movedBack: await aborted(
          "UPDATE app_candidates SET state = 'verified' WHERE id = ?",
          id
        ),
        endedAfterActive: await aborted(
          "UPDATE app_candidates SET state = 'rejected' WHERE id = ?",
          id
        ),
        deleted: await aborted("DELETE FROM app_candidates WHERE id = ?", id),
        reportForFrozen: await aborted(
          "INSERT INTO app_candidate_reports (candidate_id, report, hash, created_at) VALUES (?, '{}', ?, 0)",
          frozen.id,
          "0".repeat(64)
        ),
        currentByHand: await aborted(
          "UPDATE apps SET current_version = 2 WHERE id = ?",
          app
        ),
        createdVerified: await aborted(
          `INSERT INTO app_candidates (id, app_id, version, source_tree, based_on, state, created_by, created_at, updated_at)
         VALUES (?, ?, 1, 'tree', 0, 'verified', 'someone', 0, 0)`,
          crypto.randomUUID(),
          app
        ),
      }).toStrictEqual(
        Object.fromEntries(
          [
            "reportChanged",
            "reportDeleted",
            "versionChanged",
            "treeChanged",
            "baseChanged",
            "reportHashChanged",
            "movedBack",
            "endedAfterActive",
            "deleted",
            "reportForFrozen",
            "currentByHand",
            "createdVerified",
          ].map((key) => [key, expect.stringContaining("SQLITE_CONSTRAINT")])
        )
      );
    });

    it("refuses a row written already current, new or replacing an App, whoever writes", async () => {
      const { owner, app } = await appWith(helloFiles());
      await activateVersion(env, owner, app, 1);
      await committed(owner, app, helloFiles("two"));
      const forged = crypto.randomUUID();
      expect({
        inserted: madeCurrentRefusal(
          await aborted(
            `INSERT INTO apps (id, name, description, owner_id, current_version, created_at)
           SELECT ?, 'Forged', '', owner_id, 1, 0 FROM apps WHERE id = ?`,
            forged,
            app
          )
        ),
        replaced: madeCurrentRefusal(
          await aborted(
            `INSERT OR REPLACE INTO apps (id, name, description, owner_id, current_version, created_at)
           SELECT id, name, description, owner_id, 2, created_at FROM apps WHERE id = ?`,
            app
          )
        ),
        forgedRow: await env.DB.prepare("SELECT id FROM apps WHERE id = ?")
          .bind(forged)
          .first(),
        current: await currentOf(app),
      }).toStrictEqual({
        inserted: "refused",
        replaced: "refused",
        forgedRow: null,
        current: 1,
      });
    });

    it("refuses to verify a candidate without its report, whoever writes", async () => {
      const { owner, app } = await appWith(helloFiles());
      const frozen = await freezeCandidate(env, owner, app, 1, null);
      await env.DB.prepare(
        "UPDATE app_candidates SET state = 'checking' WHERE id = ?"
      )
        .bind(frozen.id)
        .run();
      await env.DB.prepare(
        "UPDATE app_candidates SET state = 'building' WHERE id = ?"
      )
        .bind(frozen.id)
        .run();
      await env.DB.prepare(
        "UPDATE app_candidates SET state = 'verifying' WHERE id = ?"
      )
        .bind(frozen.id)
        .run();
      await expect(
        aborted(
          "UPDATE app_candidates SET state = 'verified', report_hash = ? WHERE id = ?",
          "0".repeat(64),
          frozen.id
        )
      ).resolves.toContain("SQLITE_CONSTRAINT");
    });

    it("makes current only over the version it was based on, ending a stale one rejected", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      await committed(owner, app, helloFiles("two"));
      await committed(owner, app, helloFiles("three"));
      await activateVersion(env, owner, app, 1);
      const stale = await verifiedCandidate(owner, app, 2);
      await activateVersion(env, owner, app, 3);
      expect({
        refused: await failure(
          async () => await activateCandidate(env, owner, stale)
        ),
        current: await currentOf(app),
        state: await fieldOf(stale.id, "state"),
        outcome: await fieldOf(stale.id, "outcome"),
      }).toStrictEqual({
        refused: "app.conflict",
        current: 3,
        state: "rejected",
        outcome: "app.conflict",
      });
    });

    it("refuses the database a version made current over a base its candidate wasn't verified over", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      await committed(owner, app, helloFiles("two"));
      await committed(owner, app, helloFiles("three"));
      await activateVersion(env, owner, app, 1);
      const stale = await verifiedCandidate(owner, app, 2);
      await activateVersion(env, owner, app, 3);
      await expect(
        aborted("UPDATE apps SET current_version = 2 WHERE id = ?", app)
      ).resolves.toContain("SQLITE_CONSTRAINT");
      expect({
        current: await currentOf(app),
        state: await fieldOf(stale.id, "state"),
      }).toStrictEqual({ current: 3, state: "verified" });
    });

    it("refuses a caller's expected version that isn't current", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      await committed(owner, app, helloFiles("two"));
      await activateVersion(env, owner, app, 1);
      expect({
        wrong: await failure(
          async () => await activateVersion(env, owner, app, 2, null)
        ),
        right: await currentAfter(activateVersion(env, owner, app, 2, 1)),
      }).toStrictEqual({ wrong: "app.conflict", right: 2 });
    });

    it("leaves a verified candidate to be made current after a person commits, as its checks are done", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      const verified = await verifiedCandidate(owner, app, 1);
      await committed(owner, app, helloFiles("two"));
      const made = await activateCandidate(env, owner, verified);
      expect({
        current: made.currentVersion,
        state: await fieldOf(verified.id, "state"),
      }).toStrictEqual({ current: 1, state: "active" });
    });

    it("checks a candidate verified by an earlier release again before making it current", async () => {
      const { owner, app } = await appWith(helloFiles());
      await sealRelease(env, { app, version: 1, by: owner });
      const { tree } = await findVersion(env, app, 1);
      // Verified by a compiler this release doesn't run.
      const earlier = crypto.randomUUID();
      const report = canonicalText({
        environment: { compilerVersion: "0.0.0-earlier", sdkProtocolVersion },
      });
      const hash = await sha256Hex(report);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO app_candidates (id, app_id, version, source_tree, based_on, state, created_by, created_at, updated_at)
           VALUES (?, ?, 1, ?, 0, 'frozen', ?, 0, 0)`
        ).bind(earlier, app, tree, owner.userId),
        ...["checking", "building", "verifying"].map((state) =>
          env.DB.prepare(
            "UPDATE app_candidates SET state = ? WHERE id = ?"
          ).bind(state, earlier)
        ),
        env.DB.prepare(
          "INSERT INTO app_candidate_reports (candidate_id, report, hash, created_at) VALUES (?, ?, ?, 0)"
        ).bind(earlier, report, hash),
        env.DB.prepare(
          "UPDATE app_candidates SET state = 'verified', report_hash = ? WHERE id = ?"
        ).bind(hash, earlier),
      ]);
      const made = await activateVersion(env, owner, app, 1);
      const all = await candidatesOf(app);
      expect({
        current: made.currentVersion,
        outcomes: all.map(({ id, state, outcome }) => [
          id === earlier ? "earlier" : "again",
          state,
          outcome,
        ]),
      }).toStrictEqual({
        current: 1,
        outcomes: [
          ["earlier", "rejected", "app.candidate_environment"],
          ["again", "active", null],
        ],
      });
    });

    it("lets an activation that claimed its candidate finish before a newer release retires it", async () => {
      // An older and a newer Worker overlap in a rollout; the newer one
      // retires what the older verified. Landing after the older one's
      // claim (and so after any store it switched), the retirement waits,
      // and the activation completes.
      const { owner, app } = await appWith(helloFiles());
      const verified = await verifiedCandidate(owner, app, 1);
      let retirement = "";
      const racing = racingDb(async () => {
        retirement = await failure(
          async () =>
            await activateCandidate(
              { ...env, DB: otherCompilerDb() },
              owner,
              verified
            )
        );
      }, /^update "apps" set "current_version"/iu);
      const activated = await activateCandidate(
        { ...env, DB: racing },
        owner,
        verified
      );
      // Landing first, it retires the candidate, and nothing switches.
      const other = await appWith(helloFiles());
      const retired = await verifiedCandidate(other.owner, other.app, 1);
      const newer = await failure(
        async () =>
          await activateCandidate(
            { ...env, DB: otherCompilerDb() },
            other.owner,
            retired
          )
      );
      const older = await failure(
        async () => await activateCandidate(env, other.owner, retired)
      );
      const after = await candidate(verified.id);
      expect({
        retirement,
        current: activated.currentVersion,
        state: after?.state,
        lease: after?.lease,
        retiredFirst: [
          newer,
          older,
          await fieldOf(retired.id, "state"),
          await currentOf(other.app),
        ],
      }).toStrictEqual({
        retirement: "app.candidate_busy",
        current: 1,
        state: "active",
        lease: null,
        retiredFirst: [
          "app.candidate_environment",
          "app.conflict",
          "rejected",
          null,
        ],
      });
    });

    it("stops a run whose candidate a commit superseded at its next move", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      const frozen = await freezeCandidate(env, owner, app, 1, null);
      const refused = await failure(
        async () =>
          await runCandidate(env, owner, frozen, async (building) => {
            // A person commits while the version is checked.
            await committed(owner, app, helloFiles("two"));
            await building();
          })
      );
      expect({
        refused,
        state: await fieldOf(frozen.id, "state"),
        report: await reportCount(frozen.id),
      }).toStrictEqual({
        refused: "app.candidate_superseded",
        state: "superseded",
        report: 0,
      });
    });

    it("stores no report for a run that lost its candidate just before verifying it", async () => {
      const { owner, app } = await appWith(helloFiles());
      const frozen = await freezeCandidate(env, owner, app, 1, null);
      // Another run takes it over just before this one's move to verified.
      const racing = racingDb(
        async () =>
          await env.DB.prepare(
            "UPDATE app_candidates SET lease = 'other', lease_until = ? WHERE id = ?"
          )
            .bind(Date.now() + 60_000, frozen.id)
            .run(),
        /insert into "app_candidate_reports"/iu
      );
      const refused = await failure(
        async () =>
          await runCandidate(
            { ...env, DB: racing },
            owner,
            frozen,
            sealing(owner, app, 1)
          )
      );
      expect({
        refused,
        state: await fieldOf(frozen.id, "state"),
        reports: await reportCount(frozen.id),
      }).toStrictEqual({
        refused: "app.candidate_busy",
        state: "verifying",
        reports: 0,
      });
    });

    it("freezes anew when the open candidate it found ended before it read it", async () => {
      const { owner, app } = await appWith(helloFiles());
      const open = await freezeCandidate(env, owner, app, 1, null);
      // The open one ends just after this freeze's insert lost to it.
      let ended = false;
      const endsAfterInsert = new Proxy(env.DB, {
        get: (target, property) => {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              const results = await target.batch(statements);
              if (!ended) {
                ended = true;
                await target
                  .prepare(
                    "UPDATE app_candidates SET state = 'rejected', outcome = 'app.conflict' WHERE id = ?"
                  )
                  .bind(open.id)
                  .run();
              }
              return results;
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      });
      const frozen = await freezeCandidate(
        { ...env, DB: endsAfterInsert },
        owner,
        app,
        1,
        null
      );
      expect({
        another: frozen.id !== open.id,
        state: frozen.state,
      }).toStrictEqual({ another: true, state: "frozen" });
    });

    it("freezes a version once while it is open, and runs it once at a time", async () => {
      const { owner, app } = await appWith(helloFiles());
      const first = await freezeCandidate(env, owner, app, 1, null);
      const again = await freezeCandidate(env, owner, app, 1, null);
      const held = Promise.withResolvers<boolean>();
      const inside = Promise.withResolvers<boolean>();
      const running = runCandidate(env, owner, first, async (building) => {
        inside.resolve(true);
        await held.promise;
        await sealing(owner, app, 1)(building);
      });
      await inside.promise;
      const second = await failure(
        async () =>
          await runCandidate(env, owner, again, sealing(owner, app, 1))
      );
      held.resolve(true);
      const done = await running;
      expect({
        same: again.id === first.id,
        second,
        state: done.state,
        attempt: done.attempt,
      }).toStrictEqual({
        same: true,
        second: "app.candidate_busy",
        state: "verified",
        attempt: 1,
      });
    });

    it("takes over a candidate whose run died once its lease expired, and lets go of one an error left", async () => {
      const { owner, app } = await appWith(helloFiles());
      const frozen = await freezeCandidate(env, owner, app, 1, null);
      // An error no code names: the run lets the candidate go where it was.
      const crashed = await failure(
        async () =>
          await runCandidate(env, owner, frozen, async () => {
            await Promise.reject(new Error("The isolate went away"));
          })
      );
      const afterCrash = await candidate(frozen.id);
      // A run that died holding it: its lease stands until it expires.
      await env.DB.prepare(
        "UPDATE app_candidates SET lease = 'dead', lease_until = ? WHERE id = ?"
      )
        .bind(Date.now() + 60_000, frozen.id)
        .run();
      const whileHeld = await failure(
        async () =>
          await runCandidate(env, owner, frozen, sealing(owner, app, 1))
      );
      await env.DB.prepare(
        "UPDATE app_candidates SET lease_until = ? WHERE id = ?"
      )
        .bind(Date.now() - 1, frozen.id)
        .run();
      const done = await runCandidate(
        env,
        owner,
        frozen,
        sealing(owner, app, 1)
      );
      expect({
        crashed,
        afterCrash: [afterCrash?.state, afterCrash?.lease, afterCrash?.attempt],
        whileHeld,
        done: [done.state, done.attempt],
      }).toStrictEqual({
        crashed: "Error: The isolate went away",
        afterCrash: ["checking", null, 1],
        whileHeld: "app.candidate_busy",
        done: ["verified", 2],
      });
    });

    it("blocks a candidate after its last attempt, and leaves the current version as it was", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      await committed(owner, app, helloFiles("two"));
      await activateVersion(env, owner, app, 1);
      const frozen = await freezeCandidate(env, owner, app, 2, 1);
      await env.DB.prepare("UPDATE app_candidates SET attempt = ? WHERE id = ?")
        .bind(maxCandidateAttempts, frozen.id)
        .run();
      expect({
        refused: await failure(
          async () =>
            await runCandidate(env, owner, frozen, sealing(owner, app, 2))
        ),
        state: await fieldOf(frozen.id, "state"),
        current: await currentOf(app),
      }).toStrictEqual({
        refused: "app.candidate_attempts",
        state: "operationally_blocked",
        current: 1,
      });
    });

    it("ends each failure in its outcome, links the repair, and leaves the current version as it was", async () => {
      const { owner, app } = await appWith(helloFiles("one"));
      await activateVersion(env, owner, app, 1);
      // A defect of its code: a type error.
      const broken = await committed(owner, app, {
        "operations/hello.ts": `import { v } from "@grasp-os/sdk";
import { query } from "#grasp/server";

export const hello = query({
  args: {},
  returns: v.string(),
  handler: () => 42,
});
`,
      });
      const repairable = await failure(
        async () => await activateVersion(env, owner, app, broken)
      );
      const repaired = await committed(owner, app, helloFiles("fixed"));
      // Unsealed, nothing seals it here: outside its code.
      const { setCurrentVersion } = await import("../src/apps.ts");
      const blocked = await failure(
        async () => await setCurrentVersion(env, owner, app, repaired)
      );
      // A builder who lost the App before the run: no repair of the code
      // changes that.
      const other = await person("builder");
      await addMember(env, owner, app, {
        type: "person",
        id: other.userId,
        role: "builder",
      });
      const frozen = await freezeCandidate(env, other, app, repaired, 1);
      await removeMember(env, owner, app, {
        type: "person",
        id: other.userId,
      });
      const rejected = await failure(
        async () =>
          await runCandidate(env, other, frozen, sealing(other, app, repaired))
      );
      const [, ...ended] = await candidatesOf(app);
      expect({
        codes: [repairable, blocked, rejected],
        outcomes: ended.map(({ state, outcome }) => [state, outcome]),
        repairOf: ended[1]?.previousCandidate === ended[0]?.id,
        current: await currentOf(app),
      }).toStrictEqual({
        codes: ["version.build_failed", "version.not_sealed", "app.not_found"],
        outcomes: [
          ["repairable_failed", "version.build_failed"],
          ["operationally_blocked", "version.not_sealed"],
          ["rejected", "app.not_found"],
        ],
        repairOf: true,
        current: 1,
      });
    });

    it("rejects a candidate whose runner was demoted to a user of the App", async () => {
      const { owner, app } = await appWith(helloFiles());
      const other = await person("builder");
      await addMember(env, owner, app, {
        type: "person",
        id: other.userId,
        role: "builder",
      });
      const frozen = await freezeCandidate(env, other, app, 1, null);
      await addMember(env, owner, app, {
        type: "person",
        id: other.userId,
        role: "user",
      });
      expect({
        refused: await failure(
          async () =>
            await runCandidate(env, other, frozen, sealing(other, app, 1))
        ),
        state: await fieldOf(frozen.id, "state"),
        outcome: await fieldOf(frozen.id, "outcome"),
      }).toStrictEqual({
        refused: "role.forbidden",
        state: "rejected",
        outcome: "role.forbidden",
      });
    });

    it("is made current only by someone who still builds the App", async () => {
      const { owner, app } = await appWith(helloFiles());
      const other = await person("builder");
      await addMember(env, owner, app, {
        type: "person",
        id: other.userId,
        role: "builder",
      });
      const verified = await verifiedCandidate(other, app, 1);
      await removeMember(env, owner, app, { type: "person", id: other.userId });
      expect({
        refused: await failure(
          async () => await activateCandidate(env, other, verified)
        ),
        current: await currentOf(app),
        state: await fieldOf(verified.id, "state"),
      }).toStrictEqual({
        refused: "app.not_found",
        current: null,
        state: "verified",
      });
    });
  }
);
