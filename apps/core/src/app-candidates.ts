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
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import {
  appFor,
  changeEntry,
  findVersion,
  makeCurrent,
  verifyVersion,
  versionFiles,
} from "./apps.ts";
import {
  auditedBatch,
  outboxedEventWhere,
  outboxedIfChanged,
} from "./audit-outbox.ts";
import { appCandidateReports, appCandidates } from "./db/core/schema.ts";

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
//   were set (migration 0117).
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
const reportFormatVersion = 1;

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
  "app.conflict",
  "app.not_found",
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
  if (rejectedCodes.has(code) || code.startsWith("permission.")) {
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
  basedOn: number | null
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
    .orderBy(desc(appCandidates.createdAt), desc(appCandidates.id))
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
  // Ended by a commit, or another request, in between: this one's own.
  return open ?? (await candidateOf(env, id));
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
  candidate: CandidateRow
): Promise<Held | undefined> => {
  const lease = crypto.randomUUID();
  const now = new Date();
  const [row] = await drizzle(env.DB)
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
    .returning();
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
    // The report first: a candidate is verified only with it stored.
    [, moved] = await auditedBatch(env, db, [
      db
        .insert(appCandidateReports)
        .values({
          candidateId: id,
          report: report.text,
          hash: report.hash,
          createdAt: new Date(),
        })
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
 * The report of the verified candidate `row`: its identities, and for a
 * version of spec 8's layout its sealed release as loading reads it back,
 * every hash checked (`loadRelease`), with the evidence of its checks and
 * the store it binds. Only what core computed; no verdict.
 */
const reportOf = async (
  env: Env,
  row: CandidateRow,
  files: Record<string, string>
): Promise<string> => {
  const release = isAppLayout(files)
    ? await loadRelease(env, appIdSchema.parse(row.appId), row.version)
    : undefined;
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
      release === undefined
        ? null
        : {
            manifestHash: release.manifestHash,
            sourceTreeHash: release.manifest.sourceTreeHash,
            verificationReportHash: release.manifest.verificationReportHash,
            store: release.store,
          },
    environment: { compilerVersion, sdkProtocolVersion },
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
  await verifyVersion(env, app, version, files);
  const text = await reportOf(env, held.row, files);
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
  const held = await claim(env, candidate);
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

/**
 * Ends the verified `candidate` as rejected when its base is no longer
 * the version current: nothing makes it current any more.
 */
const rejectStale = async (
  env: Env,
  by: Identity,
  candidate: CandidateRow
): Promise<void> => {
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(appCandidates)
      .set({
        state: "rejected",
        outcome: "app.conflict",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appCandidates.id, candidate.id),
          eq(appCandidates.state, "verified"),
          sql`(SELECT coalesce(current_version, 0) FROM apps WHERE id = ${candidate.appId}) IS NOT ${candidate.basedOn}`
        )
      ),
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
          outcome: "app.conflict",
        }
      )
    ),
  ]);
};

/**
 * Makes the verified `candidate` current for `by` (`makeCurrent`):
 * over the version it was based on, while it is still verified with its
 * report. A candidate whose base is no longer current is ended as
 * rejected (`app.conflict`): a new one, based on what is current now,
 * verifies it again.
 */
export const activateCandidate = async (
  env: Env,
  by: Identity,
  candidate: CandidateRow
): Promise<App> => {
  if (candidate.reportHash === null) {
    throw appErrors.create("app.conflict");
  }
  try {
    return await makeCurrent(env, by, candidate.appId, candidate.version, {
      id: candidate.id,
      reportHash: candidate.reportHash,
      basedOn: candidate.basedOn === 0 ? null : candidate.basedOn,
    });
  } catch (error) {
    if (isExpectedError(error) && error.code === "app.conflict") {
      await rejectStale(env, by, candidate);
    }
    throw error;
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
  const candidate = await freezeCandidate(env, by, found.id, number, basedOn);
  const verified = await runCandidate(env, by, candidate, async (building) => {
    await seal?.(found.id, number, files, building);
  });
  return await activateCandidate(env, by, verified);
};
