import { compilerVersion, isAppLayout } from "@grasp-os/compiler";
import { sdkProtocolVersion } from "@grasp-os/shared/app-releases";
import { appErrors, openCandidateStates } from "@grasp-os/shared/apps";
import type { App, CandidateState } from "@grasp-os/shared/apps";
import { createAuditEvent } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { artifactDigest, readBackRelease } from "./app-releases.ts";
import type { VerifiedObservations } from "./apps.ts";
import {
  appFor,
  changeEntry,
  findVersion,
  makeCurrent,
  releaseRunnable,
  verifyVersion,
  versionFiles,
} from "./apps.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import {
  appCandidateReports,
  appCandidates,
  appVersions,
  permissions,
  screenPolicies,
} from "./db/core/schema.ts";

// Candidates (spec 22.1, 22.2): one frozen version of an App on its way to
// being made current. A candidate pins the version, its source tree and
// the version it would replace (`based_on`), and moves forward only:
// frozen, checking and building (its release inspected, checked, built,
// sealed and read back, app-releases.ts), verifying (the gates whose
// answer doesn't change for its files, `verifyVersion`), verified (with
// a report), and active once it is made current (`makeCurrent`). Or
// it ends in an outcome: `repairable_failed` for a defect a repair of its
// code can fix, `operationally_blocked` for something outside its code in
// the way, `rejected` for a refusal no repair of the code changes, and
// `superseded` when a person commits a newer version (apps.ts). A repair
// is a new candidate; nothing ended or verified changes again.
//
// Threat model, and how each is closed:
//
// - A version made current without a verification, or with a report
//   changed after it: making it current requires, in the statement that
//   does it, the candidate verified with a report stored under the hash
//   it pins, and marks it active in the same batch (apps.ts,
//   `verifiedCandidateSql`). Triggers keep every report as written, and a
//   candidate's version, tree, base, repair link and report hash as they
//   were set (migration 0126).
// - A lost update: the candidate is made current only over the version it
//   was based on, compared and set as the version changes.
// - A run that lost its candidate goes on writing: every move compares and
//   sets the candidate's state and the lease of the run that moves it, so
//   a candidate superseded, ended, or taken over by another run after its
//   lease expired moves no further for this one. The triggers allow only
//   forward moves, one stage at a time, and none out of `active` or an
//   outcome, whoever writes.
// - Two runs, or a request made twice: one open candidate per version and
//   base (a unique index); freezing again finds it, and one run at a time
//   holds its lease.
// - A rollout's newer Worker retiring a candidate (verified by the older
//   one's compiler) after the older one switched a store for it, before
//   making it current: an activation claims its candidate before anything
//   switches, and retirement skips a claimed one (`claimActivation`).
// - A crash mid-stage: the lease expires and the next request takes it
//   over, one attempt more; each stage can run again (a sealed release is
//   found sealed, and the gates read only what they read before). After
//   `maxAttempts` the candidate is `operationally_blocked`.
// - A report that vouches for itself: it holds only identities and hashes
//   core computed, read back from the sealed release; the verdict is the
//   move to verified, which only core makes.
// - Someone without the right: only the App's builders freeze, run and
//   activate a candidate, checked again at each run and as it is made
//   current (`makeCurrent`); approvals stay as they were
//   (permissions.ts, `madeCurrent`).
// - A failure misreported: each expected refusal maps to its outcome
//   (`outcomeOf`); anything unexpected leaves the candidate where it was,
//   to be run again, and nothing touches the version current.

/** How long a run holds its candidate before another may take it over. */
export const candidateLeaseMs = 10 * 60_000;

/** The most runs one candidate gets before it is blocked. */
export const maxCandidateAttempts = 3;

/** The format of a candidate's report. */
const reportFormatVersion = 2;

/** A candidate, as core keeps it. */
export type CandidateRow = typeof appCandidates.$inferSelect;

/**
 * Refusals that something outside the version's code is in the way of:
 * busy or slow work, a release not sealed yet, a store unavailable or
 * still migrating.
 */
const blockedCodes: ReadonlySet<string> = new Set([
  "app.candidate_attempts",
  "data.store_unavailable",
  "migration.busy",
  "migration.pending",
  "migration.sample_busy",
  "operation.deadline_exceeded",
  "screen.build_slow",
  "version.seal_busy",
  "version.not_sealed",
  "version.seal_conflict",
  "version.tests_unavailable",
]);

/**
 * Refusals no repair of the version's code changes: authority, integrity,
 * a release revoked or unsupported, a store or migration given up on.
 */
const rejectedCodes: ReadonlySet<string> = new Set([
  "app.candidate_release_changed",
  "app.conflict",
  "app.not_found",
  "app.unreadable",
  "app.version_not_found",
  "migration.abandoned",
  "migration.metadata_corrupt",
  "version.artifact_corrupt",
  "version.format_unsupported",
  "version.manifest_corrupt",
  "version.mismatch",
  "version.protocol_unsupported",
  "version.revoked",
  "version.store_bound_elsewhere",
]);

/**
 * The outcome a run of a candidate ends in for `error`, or undefined for
 * an error no code names: that one leaves the candidate to run again.
 * Any other expected refusal is a defect of the version's code, which a
 * repair can fix.
 */
export const outcomeOf = (
  error: unknown
): { state: CandidateState; code: string } | undefined => {
  if (!isExpectedError(error)) {
    return undefined;
  }
  const { code } = error;
  if (blockedCodes.has(code)) {
    return { state: "operationally_blocked", code };
  }
  if (
    rejectedCodes.has(code) ||
    code.startsWith("permission.") ||
    code.startsWith("role.")
  ) {
    return { state: "rejected", code };
  }
  return { state: "repairable_failed", code };
};

const openStates: readonly CandidateState[] = openCandidateStates;

/** The candidate `id`, as it is now. */
const candidateOf = async (env: Env, id: string): Promise<CandidateRow> => {
  const row = await drizzle(env.DB)
    .select()
    .from(appCandidates)
    .where(eq(appCandidates.id, id))
    .get();
  if (row === undefined) {
    throw new Error(`Candidate ${id} isn't kept`);
  }
  return row;
};

/**
 * The open candidate for `version` of `app` based on `basedOn`, frozen
 * now for `by` if there is none: freezing it again finds the same one.
 */
export const freezeCandidate = async (
  env: Env,
  by: Identity,
  app: AppId,
  version: number,
  basedOn: number | null,
  /** Whether this is the one more try after an open candidate ended. */
  again = false
): Promise<CandidateRow> => {
  await appFor(env, by, app, "builder");
  const { tree } = await findVersion(env, app, version);
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = new Date();
  // A repair: the App's latest candidate, of a version before this one,
  // ended in a defect its code can fix.
  const repairs = await db
    .select({ id: appCandidates.id, state: appCandidates.state })
    .from(appCandidates)
    .where(
      and(eq(appCandidates.appId, app), lt(appCandidates.version, version))
    )
    // rowid breaks ties in insertion order: two freezes can share a
    // millisecond, and an ID is no order.
    .orderBy(desc(appCandidates.createdAt), desc(sql`rowid`))
    .limit(1)
    .get();
  await auditedBatch(env, db, [
    db
      .insert(appCandidates)
      .values({
        id,
        appId: app,
        version,
        sourceTree: tree,
        basedOn: basedOn ?? 0,
        previousCandidate:
          repairs?.state === "repairable_failed" ? repairs.id : null,
        state: "frozen",
        createdBy: by.userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
    outboxedIfChanged(
      db,
      changeEntry(by, "app.candidate.frozen", app, {
        candidate: id,
        version,
        tree,
        basedOn: basedOn ?? 0,
      })
    ),
  ]);
  const open = await db
    .select()
    .from(appCandidates)
    .where(
      and(
        eq(appCandidates.appId, app),
        eq(appCandidates.version, version),
        eq(appCandidates.basedOn, basedOn ?? 0),
        inArray(appCandidates.state, [...openStates])
      )
    )
    .get();
  if (open !== undefined) {
    return open;
  }
  // None open now: this one's own, ended by a commit in between, if it was
  // inserted; otherwise the open one it lost to ended meanwhile, so it is
  // frozen once more, and then refused as busy.
  const own = await db
    .select()
    .from(appCandidates)
    .where(eq(appCandidates.id, id))
    .get();
  if (own !== undefined) {
    return own;
  }
  if (again) {
    throw appErrors.create("app.candidate_busy");
  }
  return await freezeCandidate(env, by, app, version, basedOn, true);
};

/** A candidate a run holds: its row, and the run's lease token. */
interface Held {
  readonly row: CandidateRow;
  readonly lease: string;
}

/**
 * Takes `candidate`'s lease for a run, one attempt more: only while it is
 * open, not verified, and nobody holds it or their lease expired.
 * Undefined if it can't be taken.
 */
const claim = async (
  env: Env,
  by: Identity,
  candidate: CandidateRow
): Promise<Held | undefined> => {
  const lease = crypto.randomUUID();
  const now = new Date();
  const db = drizzle(env.DB);
  const [[row]] = await auditedBatch(env, db, [
    db
      .update(appCandidates)
      .set({
        lease,
        leaseUntil: new Date(now.getTime() + candidateLeaseMs),
        attempt: sql`${appCandidates.attempt} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(appCandidates.id, candidate.id),
          inArray(appCandidates.state, [
            "frozen",
            "checking",
            "building",
            "verifying",
          ]),
          or(isNull(appCandidates.lease), lt(appCandidates.leaseUntil, now))
        )
      )
      .returning(),
    // Who took it up, and where: a run resuming a stage another left is
    // on the record as such (its moves carry the attempt).
    outboxedIfChanged(
      db,
      changeEntry(
        by,
        "app.candidate.claimed",
        appIdSchema.parse(candidate.appId),
        {
          candidate: candidate.id,
          version: candidate.version,
          at: candidate.state,
        }
      )
    ),
  ]);
  return row === undefined ? undefined : { row, lease };
};

/** The refusal for a candidate a run lost: ended by now, or held by another. */
const lost = async (env: Env, id: string): Promise<Error> => {
  const now = await candidateOf(env, id);
  return now.state === "superseded"
    ? appErrors.create("app.candidate_superseded")
    : appErrors.create("app.candidate_busy");
};

/**
 * Moves the candidate `held` from `from` to `to`, while it is still there
 * and the run still holds it, with its audit event, and with `report`
 * stored first in the same batch, for a move to verified. Refused
 * (`lost`) when it was ended or taken over.
 */
const move = async (
  env: Env,
  by: Identity,
  held: Held,
  { from, to }: { from: CandidateState; to: CandidateState },
  {
    set = {},
    report,
  }: {
    set?: Partial<typeof appCandidates.$inferInsert>;
    report?: { text: string; hash: string };
  } = {}
): Promise<void> => {
  const db = drizzle(env.DB);
  const { id, appId, version } = held.row;
  const event = createAuditEvent(
    changeEntry(by, "app.candidate.moved", appIdSchema.parse(appId), {
      candidate: id,
      version,
      attempt: held.row.attempt,
      from,
      to,
      ...(typeof set.outcome === "string" ? { outcome: set.outcome } : {}),
    }),
    "core"
  );
  const update = db
    .update(appCandidates)
    .set({ ...set, state: to, updatedAt: new Date() })
    .where(
      and(
        eq(appCandidates.id, id),
        eq(appCandidates.state, from),
        eq(appCandidates.lease, held.lease)
      )
    )
    .returning({ id: appCandidates.id });
  const recorded = outboxedEventWhere(db, event, sql`changes() > 0`);
  let moved: { id: string }[];
  if (report === undefined) {
    [moved] = await auditedBatch(env, db, [update, recorded]);
  } else {
    // The report first, as a candidate is verified only with it stored,
    // and only while the move can land: a run that lost its candidate
    // stores no report for it.
    [, moved] = await auditedBatch(env, db, [
      db
        .insert(appCandidateReports)
        .select(
          sql`SELECT ${id}, ${report.text}, ${report.hash}, ${Date.now()}
            WHERE EXISTS (SELECT 1 FROM ${appCandidates}
              WHERE ${appCandidates.id} = ${id} AND ${appCandidates.state} = ${from}
                AND ${appCandidates.lease} = ${held.lease})`
        )
        .onConflictDoNothing(),
      update,
      recorded,
    ]);
  }
  if (moved.length === 0) {
    throw await lost(env, id);
  }
};

/** Ends the candidate `held` at `from` in `outcome`, letting its lease go. */
const end = async (
  env: Env,
  by: Identity,
  held: Held,
  from: CandidateState,
  outcome: { state: CandidateState; code: string }
): Promise<void> => {
  await move(
    env,
    by,
    held,
    { from, to: outcome.state },
    { set: { outcome: outcome.code, lease: null, leaseUntil: null } }
  );
};

/**
 * `end`, unless the run lost the candidate as it ended it: taken over or
 * superseded meanwhile, whoever has it decides, and the run's own refusal
 * is what its caller hears.
 */
const endUnlessLost = async (
  env: Env,
  by: Identity,
  held: Held,
  from: CandidateState,
  outcome: { state: CandidateState; code: string }
): Promise<void> => {
  try {
    await end(env, by, held, from, outcome);
  } catch (error) {
    if (!(isExpectedError(error) && error.code.startsWith("app.candidate_"))) {
      throw error;
    }
  }
};

/**
 * What held of the App's authority as `row` was verified: a hash of its
 * active permissions (each as granted), whether an admin approved the
 * version, and its screens' data policy. Evidence of what held then,
 * never a decision: making it current and every call read their own.
 */
const authorityOf = async (env: Env, row: CandidateRow) => {
  const db = drizzle(env.DB);
  const [granted, version, policy] = await Promise.all([
    db
      .select({
        id: permissions.id,
        objectType: permissions.objectType,
        objectId: permissions.objectId,
        resource: permissions.resource,
        actions: permissions.actions,
        binding: permissions.binding,
        grantedAt: permissions.grantedAt,
      })
      .from(permissions)
      .where(
        and(
          eq(permissions.subjectType, "app"),
          eq(permissions.subjectId, row.appId),
          eq(permissions.status, "active")
        )
      )
      .orderBy(permissions.id)
      .all(),
    db
      .select({ approved: appVersions.approved })
      .from(appVersions)
      .where(
        and(
          eq(appVersions.appId, row.appId),
          eq(appVersions.version, row.version)
        )
      )
      .get(),
    db
      .select({
        output: screenPolicies.output,
        generation: screenPolicies.generation,
      })
      .from(screenPolicies)
      .where(eq(screenPolicies.appId, row.appId))
      .get(),
  ]);
  return {
    permissions: await sha256Hex(
      canonicalText(
        granted.map((grant) => ({
          ...grant,
          grantedAt: grant.grantedAt?.getTime() ?? null,
        }))
      )
    ),
    permissionCount: granted.length,
    approved: version?.approved ?? null,
    screenPolicy: policy ?? null,
  };
};

/**
 * Whether `version` could be made current again: its release not
 * revoked and its store live (`releaseRunnable`), and, for one of spec 8's
 * layout, its release read back from storage, every artifact present and
 * as sealed (`readBackRelease`), as the database flags alone can't tell.
 */
const rollbackEligible = async (
  env: Env,
  app: AppId,
  version: number
): Promise<boolean> => {
  if (!(await releaseRunnable(env, app, version))) {
    return false;
  }
  if (!isAppLayout(await versionFiles(env, app, version))) {
    return true;
  }
  try {
    await readBackRelease(env, app, version);
    return true;
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * The report of the verified candidate `row`, whose gates observed
 * `observed`. Only what core computed, no verdict:
 * - its identities;
 * - for a version of spec 8's layout, its sealed manifest checked against
 *   what core recorded, with every artifact read back from storage and
 *   verified (`readBackRelease`), the evidence of its checks and its
 *   migrations, and the stores it binds;
 * - the tests the gates selected to run, each passing (`verifyVersion`);
 * - the App's authority as it was (`authorityOf`);
 * - the environment: compiler, SDK protocol and platform release;
 * - whether the version it replaces could run again: its release not
 *   revoked and its store live (`releaseRunnable`), and, for one of spec
 *   8's layout, read back from storage as this one is (`rollbackEligible`).
 */
const reportOf = async (
  env: Env,
  row: CandidateRow,
  files: Record<string, string>,
  observed: VerifiedObservations
): Promise<string> => {
  const app = appIdSchema.parse(row.appId);
  const sealed = isAppLayout(files)
    ? await readBackRelease(env, app, row.version)
    : undefined;
  const replaces = row.basedOn === 0 ? null : row.basedOn;
  return canonicalText({
    formatVersion: reportFormatVersion,
    candidate: {
      id: row.id,
      appId: row.appId,
      version: row.version,
      sourceTree: row.sourceTree,
      basedOn: row.basedOn,
      previousCandidate: row.previousCandidate,
    },
    release:
      sealed === undefined
        ? null
        : {
            manifestHash: sealed.hash,
            sourceTreeHash: sealed.manifest.sourceTreeHash,
            verificationReportHash: sealed.manifest.verificationReportHash,
            dataStoreBindings: sealed.manifest.dataStoreBindings,
            migrationEvidence: await sha256Hex(
              canonicalText(sealed.manifest.migrationEvidence)
            ),
            artifacts: {
              count: sealed.manifest.artifacts.length,
              readBack: await artifactDigest(sealed.manifest),
            },
          },
    // What the gates selected from the version's files, not a record of
    // what each runner executed: a runner that ran fewer, or none, refuses
    // the version rather than report, so every one named here passed.
    selected: {
      appTests: observed.appTests,
      workflowTests: observed.workflowTests,
    },
    authority: await authorityOf(env, row),
    environment: {
      compilerVersion,
      sdkProtocolVersion,
      // Recorded as evidence of where it was verified, and not compared
      // when it is made current, by design: a platform release changes
      // under a candidate without changing what it was verified against.
      // The compiler and SDK protocol are compared (`verifiedHere`).
      platformRelease: env.CF_VERSION_METADATA?.id ?? null,
    },
    rollback:
      replaces === null
        ? { to: null, eligible: false }
        : {
            to: replaces,
            eligible: await rollbackEligible(env, app, replaces),
          },
  });
};

/**
 * Runs the candidate `held` from where it is to verified: its release
 * sealed for a version of spec 8's layout (`seal`), then its gates
 * (`verifyVersion`), then its report. Each stage moves it on.
 */
const verify = async (
  env: Env,
  by: Identity,
  held: Held,
  seal: (building: () => Promise<void>) => Promise<void>
): Promise<CandidateRow> => {
  const { appId, version, state } = held.row;
  const app = appIdSchema.parse(appId);
  let at: CandidateState = state;
  if (at === "frozen") {
    await move(env, by, held, { from: "frozen", to: "checking" });
    at = "checking";
  }
  const files = await versionFiles(env, app, version);
  if (at === "checking") {
    let building = false;
    await seal(async () => {
      await move(env, by, held, { from: "checking", to: "building" });
      building = true;
    });
    // Sealed already, so nothing to build, or not of spec 8's layout.
    if (!building) {
      await move(env, by, held, { from: "checking", to: "building" });
    }
  } else if (at === "building") {
    // Taken over mid-build: sealing again finishes the seal, or finds it
    // sealed already.
    await seal(async () => {
      // Moved on already.
    });
  }
  if (at !== "verifying") {
    await move(env, by, held, { from: "building", to: "verifying" });
  }
  const observed = await verifyVersion(env, app, version, files);
  const text = await reportOf(env, held.row, files, observed);
  const hash = await sha256Hex(text);
  await move(
    env,
    by,
    held,
    { from: "verifying", to: "verified" },
    {
      set: { reportHash: hash, lease: null, leaseUntil: null },
      report: { text, hash },
    }
  );
  return await candidateOf(env, held.row.id);
};

/**
 * Runs `candidate` to verified for `by`, who must build the App: taking
 * its lease, one attempt more, and running its stages from where it is.
 * A refusal ends it in its outcome (`outcomeOf`) and is thrown as it
 * came; anything unexpected lets the lease go and is thrown, to run again.
 * Refused as busy while another run holds it, and as superseded once a
 * commit ended it.
 */
export const runCandidate = async (
  env: Env,
  by: Identity,
  candidate: CandidateRow,
  seal: (building: () => Promise<void>) => Promise<void>
): Promise<CandidateRow> => {
  if (candidate.state === "verified" || candidate.state === "active") {
    return candidate;
  }
  const held = await claim(env, by, candidate);
  if (held === undefined) {
    const now = await candidateOf(env, candidate.id);
    if (now.state === "verified" || now.state === "active") {
      return now;
    }
    throw await lost(env, candidate.id);
  }
  if (held.row.attempt > maxCandidateAttempts) {
    await end(env, by, held, held.row.state, {
      state: "operationally_blocked",
      code: "app.candidate_attempts",
    });
    throw appErrors.create("app.candidate_attempts");
  }
  try {
    await appFor(env, by, held.row.appId, "builder");
    return await verify(env, by, held, seal);
  } catch (error) {
    // A run that lost its candidate leaves it to whoever has it now.
    const outcome =
      isExpectedError(error) && error.code.startsWith("app.candidate_")
        ? undefined
        : outcomeOf(error);
    const now = await candidateOf(env, held.row.id);
    if (
      outcome !== undefined &&
      now.lease === held.lease &&
      openStates.includes(now.state) &&
      now.state !== "verified"
    ) {
      await endUnlessLost(env, by, held, now.state, outcome);
    } else if (now.lease === held.lease) {
      // Unexpected: let it go, to run again from where it stopped.
      await drizzle(env.DB)
        .update(appCandidates)
        .set({ lease: null, leaseUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(appCandidates.id, held.row.id),
            eq(appCandidates.lease, held.lease)
          )
        );
    }
    throw error;
  }
};

/** The environment and release a report records, as `reportOf` writes it. */
const reportedSchema = z.object({
  environment: z.object({
    compilerVersion: z.string(),
    sdkProtocolVersion: z.int(),
  }),
  release: z
    .object({
      manifestHash: z.string(),
      artifacts: z.object({ readBack: z.string() }),
    })
    .nullable(),
});

/**
 * What the report of the verified `candidate` records of its environment
 * and release, or undefined if it records neither as it should.
 */
const reportedOf = async (
  env: Env,
  candidate: CandidateRow
): Promise<z.infer<typeof reportedSchema> | undefined> => {
  const row = await drizzle(env.DB)
    .select({ report: appCandidateReports.report })
    .from(appCandidateReports)
    .where(eq(appCandidateReports.candidateId, candidate.id))
    .get();
  const reported = reportedSchema.safeParse(JSON.parse(row?.report ?? "null"));
  return reported.success ? reported.data : undefined;
};

/**
 * Whether the verified candidate was verified by the compiler and SDK
 * protocol this release runs: a candidate verified by an earlier release
 * is checked again before it is made current, never trusted across it.
 */
const verifiedHere = (reported: z.infer<typeof reportedSchema>): boolean =>
  reported.environment.compilerVersion === compilerVersion &&
  reported.environment.sdkProtocolVersion === sdkProtocolVersion;

/**
 * Refusals that the release `candidate` was verified on is no longer
 * what is stored: it ends the candidate, which a new one verifies again.
 */
const releaseChangedCodes: ReadonlySet<string> = new Set([
  "app.candidate_release_changed",
  "version.artifact_corrupt",
  "version.manifest_corrupt",
]);

/** Holds while nobody's activation claim on a candidate is live. */
const unclaimed = (now: Date): SQL | undefined =>
  or(isNull(appCandidates.lease), lt(appCandidates.leaseUntil, now));

/**
 * Ends the verified `candidate` as rejected, for `outcome`, unless an
 * activation claims it (`claimActivation`). Whether it ended.
 */
const retire = async (
  env: Env,
  by: Identity,
  candidate: CandidateRow,
  outcome: string,
  also?: SQL
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const now = new Date();
  const [retired] = await auditedBatch(env, db, [
    db
      .update(appCandidates)
      .set({ state: "rejected", outcome, updatedAt: now })
      .where(
        and(
          eq(appCandidates.id, candidate.id),
          eq(appCandidates.state, "verified"),
          unclaimed(now),
          also
        )
      )
      .returning({ id: appCandidates.id }),
    outboxedIfChanged(
      db,
      changeEntry(
        by,
        "app.candidate.moved",
        appIdSchema.parse(candidate.appId),
        {
          candidate: candidate.id,
          version: candidate.version,
          from: "verified",
          to: "rejected",
          outcome,
        }
      )
    ),
  ]);
  return retired.length > 0;
};

/**
 * Claims the verified `candidate` for one activation, until its lease
 * ends: a verified candidate holds no run's lease (`move` lets it go), so
 * its lease columns hold this claim. Undefined if it is no longer
 * verified, or another activation's claim is live.
 *
 * Why: making a version current switches a ready migration's store
 * first (`makeCurrent`), in a Durable Object that shares no transaction
 * with D1, and then makes it current in one batch that requires the
 * candidate still verified. During a rollout an older and a newer Worker
 * overlap; the newer one retires a candidate the older one verified
 * (`app.candidate_environment`). Landing between the older one's store
 * switch and its batch, that retirement would refuse the batch and leave
 * the version still current locked out of a store whose schema moved on.
 * A claim taken in one statement before the switch, which retirement
 * skips while it is live, closes that: retirement lands before the claim
 * (and the activation switches nothing) or waits until the batch made the
 * candidate active. The claim ends with that batch (it clears the lease)
 * or, if the activation fails, as it returns; a crashed activation's claim
 * expires.
 */
const claimActivation = async (
  env: Env,
  candidate: CandidateRow
): Promise<string | undefined> => {
  const lease = crypto.randomUUID();
  const now = new Date();
  const [claimed] = await drizzle(env.DB)
    .update(appCandidates)
    .set({
      lease,
      leaseUntil: new Date(now.getTime() + candidateLeaseMs),
      updatedAt: now,
    })
    .where(
      and(
        eq(appCandidates.id, candidate.id),
        eq(appCandidates.state, "verified"),
        unclaimed(now)
      )
    )
    .returning({ id: appCandidates.id });
  return claimed === undefined ? undefined : lease;
};

/** Lets the activation claim `lease` on `candidate` go, if it still holds. */
const releaseActivation = async (
  env: Env,
  candidate: CandidateRow,
  lease: string
): Promise<void> => {
  await drizzle(env.DB)
    .update(appCandidates)
    .set({ lease: null, leaseUntil: null, updatedAt: new Date() })
    .where(
      and(
        eq(appCandidates.id, candidate.id),
        eq(appCandidates.state, "verified"),
        eq(appCandidates.lease, lease)
      )
    );
};

/**
 * Ends the verified `candidate` as rejected when its base is no longer
 * the version current: nothing makes it current any more.
 */
const rejectStale = async (
  env: Env,
  by: Identity,
  candidate: CandidateRow
): Promise<void> => {
  await retire(
    env,
    by,
    candidate,
    "app.conflict",
    sql`(SELECT coalesce(current_version, 0) FROM apps WHERE id = ${candidate.appId}) IS NOT ${candidate.basedOn}`
  );
};

/**
 * Makes the verified `candidate` current for `by` (`makeCurrent`):
 * over the version it was based on, while it is still verified with its
 * report. A candidate whose base is no longer current is ended as
 * rejected (`app.conflict`), and so is one whose release, read back as it
 * is made current, is not the one its report names: a new one, based on
 * what is current now, verifies it again.
 */
export const activateCandidate = async (
  env: Env,
  by: Identity,
  candidate: CandidateRow
): Promise<App> => {
  if (candidate.reportHash === null) {
    throw appErrors.create("app.conflict");
  }
  const reported = await reportedOf(env, candidate);
  if (reported === undefined || !verifiedHere(reported)) {
    // Claimed by another activation, which goes on: this one waits.
    if (!(await retire(env, by, candidate, "app.candidate_environment"))) {
      throw appErrors.create("app.candidate_busy");
    }
    throw appErrors.create("app.candidate_environment");
  }
  const lease = await claimActivation(env, candidate);
  if (lease === undefined) {
    const now = await candidateOf(env, candidate.id);
    if (now.state === "verified") {
      throw appErrors.create("app.candidate_busy");
    }
    // Made current by another activation, or ended: `makeCurrent` answers
    // the one and refuses the other, as it would have unclaimed.
  }
  try {
    return await makeCurrent(env, by, candidate.appId, candidate.version, {
      id: candidate.id,
      reportHash: candidate.reportHash,
      basedOn: candidate.basedOn === 0 ? null : candidate.basedOn,
      release:
        reported.release === null
          ? null
          : {
              manifestHash: reported.release.manifestHash,
              artifactDigest: reported.release.artifacts.readBack,
            },
    });
  } catch (error) {
    if (isExpectedError(error) && error.code === "app.conflict") {
      if (lease !== undefined) {
        await releaseActivation(env, candidate, lease);
      }
      await rejectStale(env, by, candidate);
    } else if (isExpectedError(error) && releaseChangedCodes.has(error.code)) {
      // What was verified is not what is stored: never made current.
      if (lease !== undefined) {
        await releaseActivation(env, candidate, lease);
      }
      await retire(env, by, candidate, error.code);
    }
    throw error;
  } finally {
    if (lease !== undefined) {
      await releaseActivation(env, candidate, lease);
    }
  }
};

/** What a caller may expect is current: a version, or null for none. */
const expectedSchema = z.int().min(1).nullable();

/** How `activateThroughCandidate` seals, given its move to building. */
export type Sealer = (
  app: AppId,
  version: number,
  files: Record<string, string>,
  building: () => Promise<void>
) => Promise<void>;

/**
 * Makes `version` of `app` the one that runs, for one of its builders,
 * through a candidate: frozen over the version current now, or over
 * `expected` when the caller says what it expects is current
 * (`app.conflict` when it isn't), sealed by `seal` if given, verified and
 * made current only over that version. A version current already is
 * answered as it is.
 */
export const activateThroughCandidate = async (
  env: Env,
  by: Identity,
  app: unknown,
  version: unknown,
  { expected, seal }: { expected?: unknown; seal?: Sealer } = {}
): Promise<App> => {
  const found = await appFor(env, by, app, "builder");
  const { version: number } = await findVersion(env, found.id, version);
  if (found.currentVersion === number) {
    return found;
  }
  const basedOn =
    expected === undefined
      ? found.currentVersion
      : appErrors.parse("app.invalid", expectedSchema, expected);
  if (basedOn !== found.currentVersion) {
    throw appErrors.create("app.conflict");
  }
  const files = await versionFiles(env, found.id, number);
  const verified = async (): Promise<CandidateRow> =>
    await runCandidate(
      env,
      by,
      await freezeCandidate(env, by, found.id, number, basedOn),
      async (building) => {
        await seal?.(found.id, number, files, building);
      }
    );
  try {
    return await activateCandidate(env, by, await verified());
  } catch (error) {
    // Verified by an earlier release and retired for it: checked again,
    // once, by this one.
    if (isExpectedError(error) && error.code === "app.candidate_environment") {
      return await activateCandidate(env, by, await verified());
    }
    throw error;
  }
};
