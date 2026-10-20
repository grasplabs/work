import {
  streamRetentionMs,
  streamTombstoneMs,
} from "@grasp-os/shared/operation-limits";
import type { Identity } from "@grasp-os/shared/rpc";
import { dataErrors } from "@grasp-os/shared/stores";
import type { ReceiptStanding } from "@grasp-os/shared/stores";
import {
  idempotencyKeySchema,
  maxSubmissionsPerApp,
  maxSubmissionsPerPerson,
  submissionRetentionDays,
  submissionTombstoneDays,
} from "@grasp-os/shared/submissions";
import type {
  ScreenSubmission,
  ScreenSubmissionStatus,
  ScreenSubmissionsApi,
} from "@grasp-os/shared/submissions";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionInvocation, invocationName } from "./action-invocation.ts";
import { readFunctionRequest } from "./app-functions.ts";
import type { FunctionRequest } from "./app-functions.ts";
import type { Release } from "./app-releases.ts";
import { appFor } from "./apps.ts";
import { openStore } from "./data-stores.ts";
import { screenSubmissions } from "./db/core/schema.ts";
import { operationContractId } from "./operations.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// Cross-screen receipt recovery (spec 10.7.8): the host's index of the
// keyed mutations and actions a person's screens sent, so the trusted
// shell can tell them, after a reload or from any page, how each one
// whose answer may never have reached them came out. Core writes a row as
// it admits the call (`noteScreenSubmission`), and the screen's client
// acknowledges an answer that settled it (`screenSubmissionReceived`);
// core deletes the row only once its receipt says it settled. A row left
// is a submission whose answer the screen never had, or one not settled
// yet. What it came to is read from its receipt each time it is listed.
// Threat model, and how each is closed:
//
// - Reading another person's submissions: a row is keyed by the person
//   whose authenticated call core admitted, never by anything the frame
//   or the request says, and listing, acknowledging and dismissing act on
//   the caller's own rows only.
// - Leaking an untrusted or revoked build's values: the index keeps the
//   call's descriptor and key, never its input, its result or a hash of
//   either, and a status says only how it came out (a failure by its
//   category). Nothing it answers depends on the build's trust, so
//   nothing crosses that its delivery would refuse.
// - App code hiding its own unsettled writes: an acknowledgement comes
//   from untrusted code, so it only ever forgets a row whose receipt says
//   it settled (`saved`, `failed`, `not_saved`), never one `pending`,
//   `uncertain` or `expired`; it is refused from a build whose delivery is
//   refused now, and counted against the person's requests (the frame's
//   `received`, screens-rpc.ts). A frame forgets only its own person's
//   rows of its own App. The client acknowledges only an answer of the
//   host's own that the call ran, never a fence: a build revoked under a
//   committed change refuses its answer, and the row stays.
// - Recovery running work again: a status is read from the receipt by a
//   look that claims nothing and starts nothing (`receiptStanding`, the
//   invocation's `standing`); nothing here sends a call.
// - Forging rows: only core's admission of a screen's call writes one,
//   after the call was read, resolved against the App's release as a
//   public function of its kind, and its key checked; nothing else can.
// - Flooding, and one App crowding out another: a row is noted only while
//   the person holds fewer than `maxSubmissionsPerApp` of that App and
//   `maxSubmissionsPerPerson` in all, read as it is inserted. No
//   unsettled row is ever evicted, so no flood removes a submission that
//   is still pending or uncertain, its own App's or another's. A cap full
//   of settled rows whose acknowledgement was lost would stop indexing
//   for good: then one settled row goes for each new one, one that saved
//   nothing before one that failed, and a saved one last: the App's own
//   when the App is full, any App's otherwise (`pruneSettled`). Each row
//   expires with its receipt's retention and tombstone; the sweep removes
//   expired rows.
// - Stale access: a row of an App the person can no longer open isn't
//   listed, and a key grants nothing: the receipt looked up is the one
//   scoped to the person, as their own call's.
// - Failure shown as success: a status comes only from the host's own
//   receipt. Unknown is `uncertain`, a gone receipt or store `expired`,
//   a receipt that never committed `not_saved`; none is ever `saved`. A
//   receipt that can't be read now is left out until the next listing.

/** How long after it is noted a submission with no receipt yet is pending. */
const admissionGraceMs = 60_000;

/** How many receipts a listing reads at once. */
const lookupsAtOnce = 8;

const dayMs = 24 * 60 * 60_000;

/** How long a row of each kind is kept: its receipt's retention and tombstone. */
const keptMs = {
  mutation: (submissionRetentionDays + submissionTombstoneDays) * dayMs,
  action: streamRetentionMs + streamTombstoneMs,
} as const;

/**
 * How long a receipt of each kind is kept with its outcome, before only a
 * tombstone, then nothing, is left of it.
 */
const receiptKeptMs = {
  mutation: submissionRetentionDays * dayMs,
  action: streamRetentionMs,
} as const;

/** The kinds of call that keep a receipt under their key. */
type SubmittedKind = keyof typeof keptMs;

const submitted = (kind: string): kind is SubmittedKind =>
  kind === "mutation" || kind === "action";

/** The statuses an acknowledgement may forget: settled, by the receipt. */
const settled: ReadonlySet<ScreenSubmissionStatus> = new Set([
  "saved",
  "failed",
  "not_saved",
]);

/**
 * The store and contract ID a mutation's receipt is scoped by in
 * `release`, as its claim scopes it (operations.ts `runMutation`); null
 * for an action, or a release with no store.
 */
const receiptPlace = async (
  release: Release,
  call: FunctionRequest
): Promise<{ storeId: string | null; storeContractId: string | null }> => {
  const operation = Object.hasOwn(
    release.app.operations,
    call.reference.contractId
  )
    ? release.app.operations[call.reference.contractId]
    : undefined;
  if (
    call.reference.kind !== "mutation" ||
    release.store === null ||
    operation === undefined
  ) {
    return { storeId: null, storeContractId: null };
  }
  return {
    storeId: release.store.storeId,
    storeContractId: await operationContractId(operation),
  };
};

type Row = typeof screenSubmissions.$inferSelect;

/** A receipt nobody claimed: pending just after it was noted, else nothing ran. */
const unclaimed = (row: Row, now: number): ScreenSubmissionStatus => {
  if (now - row.createdAt.getTime() < admissionGraceMs) {
    return "pending";
  }
  // Past when its receipt would have been kept from (the row's expiry
  // less its kind's keeping, which a re-sent action never moves on), a
  // receipt gone says nothing of whether it ran: it expired.
  const firstNoted = row.expiresAt.getTime() - keptMs[row.kind];
  return now - firstNoted > receiptKeptMs[row.kind] ? "expired" : "not_saved";
};

/**
 * Where `row`'s mutation stands, by its receipt in the store it was noted
 * with. Throws when the receipt can't be read now, but for a store that
 * is gone, whose receipt never can be again (`expired`).
 */
const mutationStatus = async (
  env: Env,
  row: Row,
  now: number
): Promise<ScreenSubmissionStatus> => {
  if (row.storeId === null || row.storeContractId === null) {
    return "not_saved";
  }
  let standing: ReceiptStanding;
  try {
    const store = await openStore(env, row.storeId);
    // Scoped as the call's own claim was (operations.ts `runMutation`).
    standing = await store.receiptStanding({
      scope: {
        principal: row.personId,
        resource: row.appId,
        binding: null,
        contractId: row.storeContractId,
        contractVersion: 1,
        operationKind: "mutation",
      },
      key: ["call", row.idempotencyKey],
    });
  } catch (error) {
    if (dataErrors.codeOf(error) === "data.store_unavailable") {
      return "expired";
    }
    throw error;
  }
  if (standing.state === "committed") {
    return "saved";
  }
  // Just noted, and not answered yet: its attempt may still be on its way
  // to claiming the receipt, whatever an earlier attempt's claim says, so
  // pending, and never pruned, until it is known (a re-send after an
  // earlier claim's deadline read that claim as `not_saved` until then).
  if (
    row.failedCategory === null &&
    now - row.createdAt.getTime() < admissionGraceMs
  ) {
    return "pending";
  }
  // Core answered an attempt as failed. Failed while the receipt is still
  // that attempt's own claim; an attempt that claimed it since may still
  // commit, so pending until that claim's deadline.
  if (row.failedCategory !== null && standing.state !== "expired") {
    return standing.state === "claimed" &&
      (row.failedFence === null || standing.fence !== row.failedFence) &&
      standing.deadline > now
      ? "pending"
      : "failed";
  }
  if (standing.state === "claimed") {
    return standing.deadline > now ? "pending" : "not_saved";
  }
  if (standing.state === "expired") {
    return "expired";
  }
  return unclaimed(row, now);
};

/**
 * Where `row`'s action stands, by its invocation. Its object is named by
 * the fingerprint the row was noted with, as the call named it
 * (action-invocation.ts `invocationName`): a key used again across a
 * publish that changed the function's contract names another invocation,
 * and a row of its own (the index's key holds the fingerprint).
 */
const actionStatus = async (
  env: Env,
  row: Row,
  now: number
): Promise<{ status: ScreenSubmissionStatus; failure: string | null }> => {
  const name = await invocationName(
    row.personId,
    row.appId,
    {
      reference: { contractId: row.contractId, fingerprint: row.fingerprint },
    },
    row.idempotencyKey,
    false
  );
  const standing = await actionInvocation(env, name).standing(row.personId);
  if (standing.state === "running") {
    return { status: "pending", failure: null };
  }
  if (standing.state === "succeeded") {
    return { status: "saved", failure: null };
  }
  if (standing.state === "failed") {
    return standing.category === "uncertain"
      ? { status: "uncertain", failure: null }
      : { status: "failed", failure: standing.category };
  }
  if (standing.state === "expired") {
    return { status: "expired", failure: null };
  }
  return { status: unclaimed(row, now), failure: null };
};

/** Where `row` stands, as its receipt says; throws when it can't be read now. */
const statusOf = async (
  env: Env,
  row: Row
): Promise<Pick<ScreenSubmission, "status" | "failure">> => {
  const now = Date.now();
  if (row.kind === "action") {
    return await actionStatus(env, row, now);
  }
  const status = await mutationStatus(env, row, now);
  return {
    status,
    failure: status === "failed" ? row.failedCategory : null,
  };
};

/** The categories of an answer that says a call ran and failed. */
const ranAndFailed: ReadonlySet<string> = new Set(["domain", "source"]);

/** Of those, the codes that say it ran nothing after all, to try again. */
const ranNothing: ReadonlySet<string> = new Set([
  "mutation.concurrent_change",
  "query.concurrent_change",
  "submission.superseded",
]);

/**
 * Records what core answered `request`, a screen's keyed mutation of
 * `app`, when that says it ran and failed: its handler's failure commits
 * nothing and leaves its receipt claimed, so the row would read pending
 * until the claim's deadline. From core's own answer, never the frame's,
 * and only for `attempt`, the attempt under its key it answers, with
 * `fence`, the receipt claim that attempt held (null when it claimed
 * none).
 * Never throws: the screen gets core's answer whatever this keeps.
 */
export const noteScreenAnswer = async (
  env: Env,
  by: Pick<Identity, "userId">,
  app: string,
  request: unknown,
  result: unknown,
  { attempt, fence }: { attempt: number; fence: number | null }
): Promise<void> => {
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== false ||
    !("error" in result) ||
    typeof result.error !== "object" ||
    result.error === null
  ) {
    return;
  }
  const { error } = result;
  const category =
    "category" in error && typeof error.category === "string"
      ? error.category
      : undefined;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  if (
    category === undefined ||
    !ranAndFailed.has(category) ||
    ranNothing.has(code)
  ) {
    return;
  }
  let call: FunctionRequest;
  try {
    call = readFunctionRequest(request);
  } catch {
    return;
  }
  const key = idempotencyKeySchema.safeParse(call.idempotencyKey);
  if (call.reference.kind !== "mutation" || !key.success) {
    return;
  }
  try {
    await drizzle(env.DB)
      .update(screenSubmissions)
      .set({ failedCategory: category, failedFence: fence })
      .where(
        and(
          eq(screenSubmissions.personId, by.userId),
          eq(screenSubmissions.appId, app),
          eq(screenSubmissions.kind, "mutation"),
          eq(screenSubmissions.contractId, call.reference.contractId),
          eq(screenSubmissions.fingerprint, call.reference.fingerprint),
          eq(screenSubmissions.idempotencyKey, key.data),
          // Only for the attempt it answers: a late answer of an earlier
          // one says nothing of a newer attempt.
          eq(screenSubmissions.attempt, attempt)
        )
      );
  } catch {
    // Recovery is a convenience: the row reads pending, then not_saved,
    // and the screen still gets core's answer.
  }
};

/**
 * Forgets `request`, a screen's call of `app` whose answer the client of
 * `by`'s screen got: its row, only once its receipt says it settled. A
 * request that isn't a keyed call, or names no row of theirs, forgets
 * nothing; nor does one whose receipt can't be read now.
 */
export const screenSubmissionReceived = async (
  env: Env,
  by: Pick<Identity, "userId">,
  app: string,
  request: unknown
): Promise<void> => {
  let call: FunctionRequest;
  try {
    call = readFunctionRequest(request);
  } catch {
    return;
  }
  const key = idempotencyKeySchema.safeParse(call.idempotencyKey);
  if (!(submitted(call.reference.kind) && key.success)) {
    return;
  }
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(screenSubmissions)
    .where(
      and(
        eq(screenSubmissions.personId, by.userId),
        eq(screenSubmissions.appId, app),
        eq(screenSubmissions.kind, call.reference.kind),
        eq(screenSubmissions.contractId, call.reference.contractId),
        eq(screenSubmissions.fingerprint, call.reference.fingerprint),
        eq(screenSubmissions.idempotencyKey, key.data)
      )
    )
    .get();
  if (row === undefined) {
    return;
  }
  let status: ScreenSubmissionStatus;
  try {
    ({ status } = await statusOf(env, row));
  } catch {
    return;
  }
  if (settled.has(status)) {
    // Only the attempt it read: one sent again meanwhile stays.
    await db
      .delete(screenSubmissions)
      .where(
        and(
          eq(screenSubmissions.id, row.id),
          eq(screenSubmissions.attempt, row.attempt)
        )
      );
  }
};

/**
 * The statuses of `rows`, `lookupsAtOnce` at a time; null for one
 * whose receipt can't be read now.
 */
const statusesOf = async (
  env: Env,
  rows: readonly Row[]
): Promise<(Pick<ScreenSubmission, "status" | "failure"> | null)[]> => {
  const statuses: (Pick<ScreenSubmission, "status" | "failure"> | null)[] = [];
  for (let start = 0; start < rows.length; start += lookupsAtOnce) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time, bounded
    const batch = await Promise.all(
      rows
        .slice(start, start + lookupsAtOnce)
        .map(
          async (
            row
          ): Promise<Pick<ScreenSubmission, "status" | "failure"> | null> => {
            try {
              return await statusOf(env, row);
            } catch {
              return null;
            }
          }
        )
    );
    statuses.push(...batch);
  }
  return statuses;
};

/** The SQL that notes one attempt of a submission, answering its attempt number. */
const noteSql = (
  values: {
    readonly person: string;
    readonly app: string;
    readonly kind: SubmittedKind;
    readonly contractId: string;
    readonly fingerprint: string;
    readonly version: number;
    readonly path: string;
    readonly storeId: string | null;
    readonly storeContractId: string | null;
    readonly key: string;
    /** Whether a re-send takes this attempt's expiry (`noteScreenSubmission`). */
    readonly freshExpiry: boolean;
  },
  now: number
) => sql`INSERT INTO screen_submissions
    (id, person_id, app_id, kind, contract_id, fingerprint, app_version,
     path, store_id, store_contract_id, idempotency_key, created_at,
     expires_at, attempt)
  SELECT ${crypto.randomUUID()}, ${values.person}, ${values.app},
    ${values.kind}, ${values.contractId}, ${values.fingerprint},
    ${values.version}, ${values.path}, ${values.storeId},
    ${values.storeContractId}, ${values.key}, ${now},
    ${now + keptMs[values.kind]}, 1
  WHERE ((SELECT COUNT(*) FROM screen_submissions
        WHERE person_id = ${values.person} AND app_id = ${values.app}) < ${maxSubmissionsPerApp}
      AND (SELECT COUNT(*) FROM screen_submissions
        WHERE person_id = ${values.person}) < ${maxSubmissionsPerPerson})
    -- The same key sent again takes its row, past the caps too.
    OR EXISTS (SELECT 1 FROM screen_submissions
      WHERE person_id = ${values.person} AND app_id = ${values.app}
        AND kind = ${values.kind} AND contract_id = ${values.contractId}
        AND fingerprint = ${values.fingerprint}
        AND idempotency_key = ${values.key})
  ON CONFLICT (person_id, app_id, kind, contract_id, fingerprint,
    idempotency_key)
  -- A new attempt under it: when it was noted, where its receipt is and how
  -- long it is kept are this attempt's; an earlier attempt's failure, and
  -- any answer still to come of one, no longer say how it stands.
  DO UPDATE SET failed_category = NULL,
    failed_fence = NULL,
    attempt = attempt + 1,
    created_at = excluded.created_at,
    app_version = excluded.app_version,
    path = excluded.path,
    store_id = excluded.store_id,
    store_contract_id = excluded.store_contract_id,
    -- A mutation's new claim keeps its receipt longer, and so the row, as
    -- does an action's fresh run; an action's invocation that is there
    -- keeps its own schedule, which a re-send never moves on.
    expires_at = CASE WHEN ${values.freshExpiry}
      THEN excluded.expires_at ELSE screen_submissions.expires_at END
  RETURNING attempt`;

/**
 * Which settled rows go first when room is made (`pruneSettled`): one that
 * saved nothing, then one that failed, and a saved one last, whose change
 * the person may never have seen confirmed; the oldest first among each.
 */
const evictedFirst: Readonly<Record<string, number>> = {
  not_saved: 0,
  failed: 1,
  saved: 2,
};

/**
 * Whether a re-send of `call` under `key` takes its own expiry: a
 * mutation's always, as its new claim keeps the receipt longer; an
 * action's only when no invocation of it is kept (one that never
 * started, or one gone past its keeping), as a fresh run starts with its
 * own keeping. A look at the invocation, which starts nothing.
 */
const freshExpiry = async (
  env: Env,
  person: string,
  app: string,
  call: FunctionRequest,
  key: string
): Promise<boolean> => {
  if (call.reference.kind !== "action") {
    return true;
  }
  const name = await invocationName(person, app, call, key, false);
  const standing = await actionInvocation(env, name).standing(person);
  return standing.state === "none";
};

/**
 * Forgets one row of `person`'s App `app` (of every App, without one)
 * whose receipt says it settled, its acknowledgement lost: just the room a
 * new submission needs under a cap, and never more. Reads them
 * `lookupsAtOnce` at a time; unsettled rows always stay. Answers whether
 * a row went.
 */
const pruneSettled = async (
  env: Env,
  person: string,
  app?: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(screenSubmissions)
    .where(
      and(
        eq(screenSubmissions.personId, person),
        app === undefined ? undefined : eq(screenSubmissions.appId, app)
      )
    )
    .orderBy(asc(screenSubmissions.createdAt), asc(sql`rowid`));
  const statuses = await statusesOf(env, rows);
  const candidates = rows.flatMap((row, index) => {
    const status = statuses[index]?.status;
    return status !== undefined && settled.has(status)
      ? [{ row, rank: evictedFirst[status] ?? 0, index }]
      : [];
  });
  candidates.sort(
    (left, right) => left.rank - right.rank || left.index - right.index
  );
  const [first] = candidates;
  if (first === undefined) {
    return false;
  }
  // Only the attempt it read: one sent again meanwhile stays.
  const [gone] = await db
    .delete(screenSubmissions)
    .where(
      and(
        eq(screenSubmissions.id, first.row.id),
        eq(screenSubmissions.attempt, first.row.attempt)
      )
    )
    .returning({ id: screenSubmissions.id });
  return gone !== undefined;
};

/**
 * Notes `call`, a screen's mutation or action of `release`'s App, resolved
 * to the public function at `path`, as `by`'s submission under its key,
 * before it runs, and answers which attempt under its key it is: while
 * the person holds fewer than `maxSubmissionsPerApp` of the App and
 * `maxSubmissionsPerPerson` in all. At a cap, one row whose receipt
 * settled is forgotten (`pruneSettled`), the App's own when the App is
 * full, else one of any App, and it is tried once more; no unsettled row
 * ever goes. The same key noted again takes its
 * row, as a new attempt. A call without a key, or of another kind, is
 * noted nothing. Never throws: a submission that can't be noted still
 * runs, and only its recovery after a reload is lost.
 */
export const noteScreenSubmission = async (
  env: Env,
  by: Pick<Identity, "userId">,
  release: Release,
  call: FunctionRequest,
  path: string
): Promise<number | undefined> => {
  const { kind, contractId, fingerprint } = call.reference;
  const key = idempotencyKeySchema.safeParse(call.idempotencyKey);
  if (!(submitted(kind) && key.success)) {
    return undefined;
  }
  const app = release.manifest.resourceId;
  const db = drizzle(env.DB);
  try {
    const { storeId, storeContractId } = await receiptPlace(release, call);
    const values = {
      freshExpiry: await freshExpiry(env, by.userId, app, call, key.data),
      person: by.userId,
      app,
      kind,
      contractId,
      fingerprint,
      version: release.manifest.resourceVersion,
      path,
      storeId,
      storeContractId,
      key: key.data,
    };
    const noted = async (): Promise<number | undefined> => {
      const [row] = await db.all<{ attempt: number }>(
        noteSql(values, Date.now())
      );
      return row?.attempt;
    };
    const attempt = await noted();
    if (attempt !== undefined) {
      return attempt;
    }
    // Whichever cap holds it back decides where a settled row goes: the
    // App's own when the App is full (which frees the person's cap too),
    // else one of any App, so an App full of its own never takes another's.
    const [held] = await db
      .select({ count: sql<number>`count(*)` })
      .from(screenSubmissions)
      .where(
        and(
          eq(screenSubmissions.personId, by.userId),
          eq(screenSubmissions.appId, app)
        )
      );
    const appFull = (held?.count ?? 0) >= maxSubmissionsPerApp;
    const pruned = appFull
      ? await pruneSettled(env, by.userId, app)
      : await pruneSettled(env, by.userId);
    return pruned ? await noted() : undefined;
  } catch {
    // Recovery is a convenience; the call itself goes on.
    return undefined;
  }
};

/**
 * `by`'s screen submissions whose answer may never have reached their
 * screen, newest first, with where each stands; those of Apps they can no
 * longer open left out, and those whose receipt can't be read now, until
 * the next listing.
 */
export const listScreenSubmissions = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams">
): Promise<ScreenSubmission[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(screenSubmissions)
    .where(
      and(
        eq(screenSubmissions.personId, by.userId),
        sql`${screenSubmissions.expiresAt} > ${Date.now()}`
      )
    )
    .orderBy(desc(screenSubmissions.createdAt), desc(sql`rowid`))
    .limit(maxSubmissionsPerPerson);
  const apps = [...new Set(rows.map(({ appId }) => appId))];
  const opens = new Set<string>();
  for (const app of apps) {
    // oxlint-disable-next-line no-await-in-loop -- one role check per App
    const opened = await appFor(env, by, app, "user").then(
      () => true,
      () => false
    );
    if (opened) {
      opens.add(app);
    }
  }
  const visible = rows.filter(({ appId }) => opens.has(appId));
  const statuses = await statusesOf(env, visible);
  return visible.flatMap((row, index) => {
    const standing = statuses[index];
    return standing === null || standing === undefined
      ? []
      : [
          {
            id: row.id,
            app: row.appId,
            kind: row.kind,
            operation: row.contractId,
            status: standing.status,
            failure: standing.failure,
            createdAt: row.createdAt.toISOString(),
          },
        ];
  });
};

/** Forgets `by`'s submission `id`; anyone else's, or none, forgets nothing. */
export const dismissScreenSubmission = async (
  env: Env,
  by: Pick<Identity, "userId">,
  id: unknown
): Promise<void> => {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) {
    return;
  }
  await drizzle(env.DB)
    .delete(screenSubmissions)
    .where(
      and(
        eq(screenSubmissions.id, id),
        eq(screenSubmissions.personId, by.userId)
      )
    );
};

/** Removes the rows whose receipts are gone by `now`: the cron's sweep. */
export const sweepScreenSubmissions = async (
  env: Env,
  now: Date
): Promise<void> => {
  await drizzle(env.DB)
    .delete(screenSubmissions)
    .where(lte(screenSubmissions.expiresAt, now));
};

/** The signed-in person's screen submissions, over `/rpc`. */
export class ScreenSubmissionsRpc
  extends CoreRpcTarget
  implements ScreenSubmissionsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<ScreenSubmission[]> {
    return await withPerson(this.#check, async (person) =>
      person.staff ? [] : await listScreenSubmissions(this.#env, person)
    );
  }

  async dismiss(id: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await dismissScreenSubmission(this.#env, person, id);
    });
  }
}
