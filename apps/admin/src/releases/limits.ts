/**
 * Whether a release may reach a client given the platform limits it raises
 * (@grasp-os/shared/release): every limit higher in the release than in
 * what the client runs needs evidence for the client's runtime profile,
 * carried by a release the client passes through on the way.
 *
 * It reads only the admin's own records: each release's limits (from its
 * manifest) and evidence (from its evidence file) as the import verified
 * them (src/releases/import.ts), and what the client runs as the admin
 * last deployed it. An evidence file's word about its predecessor counts
 * for nothing here, so one that names the wrong one at import still can't
 * take a client past an unevidenced raise.
 *
 * - From release A to C, the releases built after A, up to C, count: B's
 *   raise, which C kept, is vouched for by B's evidence. Of those, the one
 *   that raised the limit last must cover the client's profile
 *   (`uncoveredRaise`), so a limit lowered and raised again needs evidence
 *   from the release that raised it again.
 * - Back to an older release (a pin), every release up to it counts: what
 *   raised its limits when it was new.
 * - A client that runs nothing yet is compared with what the oldest release
 *   the admin holds that records limits raised its limits over (its
 *   predecessor's, as the import checked them), so every raise from before
 *   its first deploy, the oldest release's own included, needs evidence
 *   for its profile too.
 * - The history the evidence comes from must be whole: every release each
 *   release on the way names as the one before it, back to where the
 *   client starts, is imported (`release_history_incomplete` otherwise).
 *   A release whose raise wasn't imported can't hide behind older
 *   evidence for the same limit. The files' word only adds refusals here:
 *   what counts as raised still comes from the admin's own records.
 */
import {
  limitEvidenceSchema,
  platformLimitsSchema,
  previousReleaseSchema,
  uncoveredRaise,
} from "@grasp-os/shared/release";
import type {
  LimitEvidence,
  LimitRaise,
  PlatformLimits,
  RuntimeProfile,
} from "@grasp-os/shared/release";
import { and, asc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import type { AdminDatabase } from "../db/act.ts";
import { clientWorkers, releases } from "../db/schema.ts";
import { DeployError } from "../deploy/errors.ts";

/** At most this many releases are walked back through, so a cycle in the records ends. */
const maxHistory = 10_000;

/** A release's limits, read out of its stored manifest; null when it records none. */
const limitsOf = sql<
  string | null
>`json_extract(${releases.manifest}, '$.platformLimits')`;
/** What its evidence file says it raised them over, and the evidence. */
const previousOf = sql<
  string | null
>`json_extract(${releases.limitEvidence}, '$.previousRelease')`;
const evidenceOf = sql<
  string | null
>`json_extract(${releases.limitEvidence}, '$.limitEvidence')`;

const parsed = <T>(schema: z.ZodType<T>, json: string | null): T | null =>
  json === null ? null : schema.parse(JSON.parse(json));

interface RecordedRelease {
  id: string;
  builtAt: Date;
  limits: PlatformLimits | null;
}

const recorded = {
  id: releases.id,
  builtAt: releases.builtAt,
  limits: limitsOf,
};

const toRecorded = (row: {
  id: string;
  builtAt: Date;
  limits: string | null;
}): RecordedRelease => ({
  id: row.id,
  builtAt: row.builtAt,
  limits: parsed(platformLimitsSchema, row.limits),
});

/**
 * The evidence the releases built in `(after, upTo]` carry, from the first
 * when `after` is null: oldest release first, as `uncoveredRaise` takes it.
 */
const evidenceBetween = async (
  db: AdminDatabase,
  after: Date | null,
  upTo: Date
): Promise<LimitEvidence[]> => {
  const rows = await db
    .select({ evidence: evidenceOf })
    .from(releases)
    .where(
      and(
        lte(releases.builtAt, upTo),
        after === null ? undefined : gt(releases.builtAt, after),
        sql`json_array_length(${evidenceOf}) > 0`
      )
    )
    .orderBy(asc(releases.builtAt), asc(releases.id));
  return rows.flatMap(
    ({ evidence }) => parsed(z.array(limitEvidenceSchema), evidence) ?? []
  );
};

/** What client `clientId`'s Workers run, as the admin last deployed them. */
const runningReleases = async (
  db: AdminDatabase,
  clientId: string
): Promise<RecordedRelease[]> => {
  const rows = await db
    .selectDistinct(recorded)
    .from(clientWorkers)
    .innerJoin(releases, eq(releases.id, clientWorkers.releaseId))
    .where(eq(clientWorkers.clientId, clientId));
  return rows.map(toRecorded);
};

/**
 * The oldest release built by `upTo` that records limits, if any, with
 * the limits of the release before it as the import checked them (null
 * for the first release that records limits).
 */
const oldestRecorded = async (
  db: AdminDatabase,
  upTo: Date
): Promise<
  (RecordedRelease & { before: PlatformLimits | null }) | undefined
> => {
  const [row] = await db
    .select({ ...recorded, previous: previousOf })
    .from(releases)
    .where(and(lte(releases.builtAt, upTo), isNotNull(limitsOf)))
    .orderBy(asc(releases.builtAt), asc(releases.id))
    .limit(1);
  return row === undefined
    ? undefined
    : {
        ...toRecorded(row),
        before:
          parsed(previousReleaseSchema, row.previous)?.platformLimits ?? null,
      };
};

/**
 * Throws `release_history_incomplete` unless every release that release
 * `releaseId` (built `upTo`) and those before it name as the one before
 * them is imported, walking back until one built by `from`, or one that
 * names none. Two reads, whatever the length of the history: the
 * releases built between, then the one it stops at.
 */
const assertWholeHistory = async (
  db: AdminDatabase,
  releaseId: string,
  upTo: Date,
  from: Date
): Promise<void> => {
  const between = await db
    .select({ id: releases.id, previous: previousOf })
    .from(releases)
    .where(and(gt(releases.builtAt, from), lte(releases.builtAt, upTo)));
  const previousOfId = new Map(
    between.map(({ id, previous }) => [
      id,
      parsed(previousReleaseSchema, previous)?.releaseId ?? null,
    ])
  );
  let current = releaseId;
  for (let walked = 0; walked < maxHistory; walked += 1) {
    if (!previousOfId.has(current)) {
      // Not built after `from`: imported and built by then ends the walk.
      // oxlint-disable-next-line no-await-in-loop -- once, as the walk ends
      const [stop] = await db
        .select({ builtAt: releases.builtAt })
        .from(releases)
        .where(eq(releases.id, current));
      if (stop === undefined || stop.builtAt > from) {
        throw new DeployError(
          "release_history_incomplete",
          `Release ${current}, on the way to ${releaseId}, isn't imported: import it first`
        );
      }
      return;
    }
    const before = previousOfId.get(current) ?? null;
    if (before === null) {
      return;
    }
    current = before;
  }
  throw new DeployError(
    "release_history_incomplete",
    `The releases before ${releaseId} don't end`
  );
};

/** The first limit raise no evidence covers, of a client running releases by id. */
export type LimitRaiseCheck = (
  running: readonly string[]
) => Promise<LimitRaise | undefined>;

/**
 * Checks release `releaseId` for clients on `profile`: for what a client
 * runs (its Workers' releases, by id), the first limit it raises over
 * that which no evidence covers, or undefined when it may reach the
 * client (see the header comment). Everything is read once and kept, so
 * a rollout checks its every client within a handful of reads: one per
 * distinct release its clients run, and per distinct start of their
 * history. Throws `release_not_imported` when the release isn't imported,
 * and `release_without_limits` when it records no limits (a manifest from
 * before they were recorded).
 */
export const limitRaiseCheck = async (
  db: AdminDatabase,
  releaseId: string,
  profile: RuntimeProfile
): Promise<LimitRaiseCheck> => {
  const [row] = await db
    .select({ ...recorded, previous: previousOf, evidence: evidenceOf })
    .from(releases)
    .where(eq(releases.id, releaseId));
  if (row === undefined) {
    throw new DeployError(
      "release_not_imported",
      `Release ${releaseId} isn't imported`
    );
  }
  const target = toRecorded(row);
  const targetLimits = target.limits;
  if (targetLimits === null) {
    throw new DeployError(
      "release_without_limits",
      `Release ${releaseId} records no platform limits: it was built before they were, and isn't made live`
    );
  }
  const oldest = await oldestRecorded(db, target.builtAt);
  // Where the history evidence is read from starts: from what a client
  // runs, or from the oldest release the admin holds, which may name one
  // before it the admin never had.
  const start = oldest?.builtAt ?? target.builtAt;
  /** Release `id` as recorded; undefined when it isn't imported. */
  const readRecorded = async (
    id: string
  ): Promise<RecordedRelease | undefined> => {
    const [found] = await db
      .select(recorded)
      .from(releases)
      .where(eq(releases.id, id));
    return found === undefined ? undefined : toRecorded(found);
  };
  const releaseRows = new Map<string, Promise<RecordedRelease | undefined>>();
  const recordedOf = async (id: string) => {
    const known = releaseRows.get(id) ?? readRecorded(id);
    releaseRows.set(id, known);
    return await known;
  };
  const histories = new Map<number, Promise<void>>();
  const wholeFrom = async (from: Date) => {
    const known =
      histories.get(from.getTime()) ??
      assertWholeHistory(db, releaseId, target.builtAt, from);
    histories.set(from.getTime(), known);
    await known;
  };
  const evidences = new Map<number | null, Promise<LimitEvidence[]>>();
  const evidenceFrom = async (after: Date | null) => {
    const key = after?.getTime() ?? null;
    const known =
      evidences.get(key) ?? evidenceBetween(db, after, target.builtAt);
    evidences.set(key, known);
    return await known;
  };
  // The admin's first release, over its predecessor as imported.
  const firstRaise = (): LimitRaise | undefined => {
    const previous = parsed(previousReleaseSchema, row.previous);
    return previous === null
      ? undefined
      : uncoveredRaise(
          previous.platformLimits,
          targetLimits,
          parsed(z.array(limitEvidenceSchema), row.evidence) ?? [],
          profile
        );
  };
  const raiseOver = async (
    runningIds: readonly string[]
  ): Promise<LimitRaise | undefined> => {
    const read = await Promise.all(runningIds.map(recordedOf));
    const running = read.filter((release) => release !== undefined);
    const others = running.filter((release) => release.id !== releaseId);
    const bases: { limits: PlatformLimits; after: Date | null }[] = others
      .filter((release) => release.limits !== null)
      .map((release) => ({
        limits: release.limits ?? {},
        after: release.builtAt < target.builtAt ? release.builtAt : null,
      }));
    // Nothing deployed yet, or a release from before limits were recorded:
    // from what the oldest release that records them raised them over.
    if (running.length === 0 || bases.length < others.length) {
      if (oldest === undefined || oldest.id === releaseId) {
        const raise = firstRaise();
        if (raise !== undefined) {
          return raise;
        }
      } else {
        // Its own raise counts too: from the limits before it, with every
        // release's evidence from the first.
        bases.push({
          limits: oldest.before ?? oldest.limits ?? {},
          after: null,
        });
      }
    }
    for (const base of bases) {
      // oxlint-disable-next-line no-await-in-loop -- one release, as a rule
      await wholeFrom(base.after ?? start);
      // oxlint-disable-next-line no-await-in-loop -- one release, as a rule
      const evidence = await evidenceFrom(base.after);
      const raise = uncoveredRaise(
        base.limits,
        targetLimits,
        evidence,
        profile
      );
      if (raise !== undefined) {
        return raise;
      }
    }
    return undefined;
  };
  const answers = new Map<string, Promise<LimitRaise | undefined>>();
  return async (running) => {
    const key = [...new Set(running)].toSorted().join(",");
    const known = answers.get(key) ?? raiseOver([...new Set(running)]);
    answers.set(key, known);
    return await known;
  };
};

/**
 * The first limit release `releaseId` raises over what client `clientId`
 * runs that no evidence covers on `profile`, or undefined when it may
 * reach the client (`limitRaiseCheck`).
 */
export const uncoveredLimitRaise = async (
  db: AdminDatabase,
  clientId: string,
  releaseId: string,
  profile: RuntimeProfile
): Promise<LimitRaise | undefined> => {
  const check = await limitRaiseCheck(db, releaseId, profile);
  const running = await runningReleases(db, clientId);
  return await check(running.map(({ id }) => id));
};
