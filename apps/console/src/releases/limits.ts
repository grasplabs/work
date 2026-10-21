/**
 * Whether a release may reach a client given the platform limits it raises
 * (@grasp-os/shared/release): every limit higher in the release than in
 * what the client runs needs evidence for the client's runtime profile,
 * carried by a release the client passes through on the way.
 *
 * It reads only the console's own records: each release's limits and
 * evidence as the import verified them (src/releases/import.ts), and what
 * the client runs as the console last deployed it. A manifest's word about
 * its predecessor counts for nothing here, so a manifest that names the
 * wrong one at import still can't take a client past an unevidenced raise.
 *
 * - From release A to C, the releases built after A, up to C, count: B's
 *   raise, which C kept, is vouched for by B's evidence. Of those, the one
 *   that raised the limit last must cover the client's profile
 *   (`uncoveredRaise`), so a limit lowered and raised again needs evidence
 *   from the release that raised it again.
 * - Back to an older release (a pin), every release up to it counts: what
 *   raised its limits when it was new.
 * - A client that runs nothing yet is compared with the oldest release the
 *   console holds that records limits, so a raise from before its first
 *   deploy needs evidence for its profile too. When that's the release
 *   itself, with its predecessor's limits as the import checked them.
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

import type { ConsoleDatabase } from "../db/act.ts";
import { clientWorkers, releases } from "../db/schema.ts";
import { DeployError } from "../deploy/errors.ts";

/** A release's limits, read out of its stored manifest; null when it records none. */
const limitsOf = sql<
  string | null
>`json_extract(${releases.manifest}, '$.platformLimits')`;
const previousOf = sql<
  string | null
>`json_extract(${releases.manifest}, '$.previousRelease')`;
const evidenceOf = sql<
  string | null
>`json_extract(${releases.manifest}, '$.limitEvidence')`;

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
  db: ConsoleDatabase,
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

/** What client `clientId`'s Workers run, as the console last deployed them. */
const runningReleases = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<RecordedRelease[]> => {
  const rows = await db
    .selectDistinct(recorded)
    .from(clientWorkers)
    .innerJoin(releases, eq(releases.id, clientWorkers.releaseId))
    .where(eq(clientWorkers.clientId, clientId));
  return rows.map(toRecorded);
};

/** The oldest release built by `upTo` that records limits, if any. */
const oldestRecorded = async (
  db: ConsoleDatabase,
  upTo: Date
): Promise<RecordedRelease | undefined> => {
  const [row] = await db
    .select(recorded)
    .from(releases)
    .where(and(lte(releases.builtAt, upTo), isNotNull(limitsOf)))
    .orderBy(asc(releases.builtAt), asc(releases.id))
    .limit(1);
  return row === undefined ? undefined : toRecorded(row);
};

/**
 * The first limit release `releaseId` raises over what client `clientId`
 * runs that no evidence covers on `profile`, or undefined when it may
 * reach the client (see the header comment). Throws
 * `release_not_imported` when the release isn't imported, or records no
 * limits (a manifest from before they were recorded).
 */
export const uncoveredLimitRaise = async (
  db: ConsoleDatabase,
  clientId: string,
  releaseId: string,
  profile: RuntimeProfile
): Promise<LimitRaise | undefined> => {
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
  if (target.limits === null) {
    throw new DeployError(
      "release_not_imported",
      `Release ${releaseId} records no platform limits`
    );
  }
  const running = await runningReleases(db, clientId);
  const others = running.filter((release) => release.id !== releaseId);
  const bases = others.filter((release) => release.limits !== null);
  // Nothing deployed yet, or a release from before limits were recorded:
  // from the oldest release that records them.
  if (running.length === 0 || bases.length < others.length) {
    const oldest = await oldestRecorded(db, target.builtAt);
    if (oldest === undefined || oldest.id === releaseId) {
      // The console's first release: over its predecessor, as imported.
      const previous = parsed(previousReleaseSchema, row.previous);
      const raise =
        previous === null
          ? undefined
          : uncoveredRaise(
              previous.platformLimits,
              target.limits,
              parsed(z.array(limitEvidenceSchema), row.evidence) ?? [],
              profile
            );
      if (raise !== undefined) {
        return raise;
      }
    } else {
      bases.push(oldest);
    }
  }
  for (const base of bases) {
    // oxlint-disable-next-line no-await-in-loop -- one release, as a rule
    const evidence = await evidenceBetween(
      db,
      base.builtAt < target.builtAt ? base.builtAt : null,
      target.builtAt
    );
    const raise = uncoveredRaise(
      base.limits ?? {},
      target.limits,
      evidence,
      profile
    );
    if (raise !== undefined) {
      return raise;
    }
  }
  return undefined;
};
