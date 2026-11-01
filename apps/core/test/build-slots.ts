import { env } from "cloudflare:workers";
import { z } from "zod";

import { admitBuild, buildSeqOf } from "../src/build-admission.ts";
import type { BuildLease } from "../src/build-admission.ts";

// What the tests of the limit on build jobs building at once share
// (build-slots.test.ts, build-stalled-renewal.test.ts).

/** A new job's ID. */
export const aJob = (): string => crypto.randomUUID();

/** The sequence of a job's check in `round`, at `attempt`. */
export const checkAt = (round = 1, attempt = 1): number =>
  buildSeqOf("check", round, attempt);

/** What `admit` answered. */
type Answer = { lease: BuildLease } | { wait: number } | { refused: string };

/** The code of a refusal, or what else was thrown. */
const codeOf = (error: unknown): string =>
  z.object({ code: z.string() }).safeParse(error).data?.code ?? String(error);

/** Admits job `job`'s step at `seq`, as a job's step asks. */
export const admit = async (
  job: string,
  seq = checkAt(),
  waitedMs = 0
): Promise<Answer> => {
  try {
    const admitted = await admitBuild(env, job, { seq, waitedMs });
    return "lease" in admitted
      ? { lease: admitted.lease }
      : { wait: admitted.retryAfterSeconds };
  } catch (error) {
    return { refused: codeOf(error) };
  }
};

/** What `admit` answered, as a word: `ok`, `wait`, or the refusal. */
export const shown = (answer: Answer): string => {
  if ("lease" in answer) {
    return "ok";
  }
  return "wait" in answer ? "wait" : answer.refused;
};

/** The lease `answer` holds: throws if it holds none. */
export const leaseOf = (answer: Answer): BuildLease => {
  if (!("lease" in answer)) {
    throw new Error(`Not admitted: ${shown(answer)}`);
  }
  return answer.lease;
};

/** Moves `column` of job `job`'s leases `ms` into the past. */
export const aged = async (
  column: string,
  job: string,
  ms: number
): Promise<void> => {
  await env.DB.prepare(
    `UPDATE build_leases SET ${column} = ${column} - ? WHERE job_id = ?`
  )
    .bind(ms, job)
    .run();
};

/** Whether job `job` holds a lease now: unsettled, and not ended. */
export const holds = async (job: string): Promise<boolean> =>
  ((await env.DB.prepare(
    "SELECT count(*) AS held FROM build_leases WHERE job_id = ? AND settled_at IS NULL AND admitted_at + reserved_ms > ?"
  )
    .bind(job, Date.now())
    .first<number>("held")) ?? 0) > 0;

/** The leases held now, in all. */
export const leasesHeld = async (): Promise<number> =>
  (await env.DB.prepare(
    "SELECT count(*) AS held FROM build_leases WHERE settled_at IS NULL AND admitted_at + reserved_ms > ?"
  )
    .bind(Date.now())
    .first<number>("held")) ?? 0;
