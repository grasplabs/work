import { env } from "cloudflare:workers";
import { z } from "zod";

import { admitBuild, buildSeqOf } from "../src/build-admission.ts";
import type { BuildLease, BuildOwner } from "../src/build-admission.ts";
import { configuredLimits } from "./quota-limits.ts";

// What the tests of fair build admission share (fair-build-admission.test.ts,
// fair-build-stalled-renewal.test.ts).

/** Sets the quota limits to the deployment's, with `limits` lowered. */
export const policyWith = (limits: Record<string, number>): void => {
  env.TEST_QUOTA_LIMITS = { ...configuredLimits, ...limits };
};

/** A job of `person`'s (someone new, unless named) on the App `app`. */
export const jobOf = (
  app: string,
  person = `person-${crypto.randomUUID()}`
): BuildOwner => ({
  job: crypto.randomUUID(),
  subject: person,
  resource: app,
});

/** A fresh App's key. */
export const anApp = (): string => `app-${crypto.randomUUID()}`;

/** The sequence of a job's check in `round`, at `attempt`. */
export const checkAt = (round = 1, attempt = 1): number =>
  buildSeqOf("check", round, attempt);

/** What `admit` answered. */
type Answer =
  | { lease: BuildLease }
  | { waiting: string; joined: boolean; retryAfterSeconds: number }
  | { refused: string };

/** The code of a refusal, or what else was thrown. */
const codeOf = (error: unknown): string =>
  z.object({ code: z.string() }).safeParse(error).data?.code ?? String(error);

/** Admits `owner`'s step at `seq`, as a job's step asks. */
export const admit = async (
  owner: BuildOwner,
  seq = checkAt(),
  waitedMs = 0
): Promise<Answer> => {
  try {
    const admitted = await admitBuild(env, owner, {
      seq,
      waited: 0,
      waitedMs,
    });
    if ("lease" in admitted) {
      return { lease: admitted.lease };
    }
    return {
      waiting: admitted.wait.waitingFor,
      joined: admitted.wait.joined,
      retryAfterSeconds: admitted.wait.retryAfterSeconds,
    };
  } catch (error) {
    return { refused: codeOf(error) };
  }
};

/** What `admit` answered, as a word: `ok`, `wait:<share>`, or the refusal. */
export const shown = (answer: Answer): string => {
  if ("lease" in answer) {
    return "ok";
  }
  return "waiting" in answer ? `wait:${answer.waiting}` : answer.refused;
};

/** Admits each of `owners` in turn, answering as `shown`. */
export const admitEach = async (...owners: BuildOwner[]): Promise<string[]> => {
  const answers: string[] = [];
  for (const owner of owners) {
    // oxlint-disable-next-line no-await-in-loop -- in order: the queue's
    answers.push(shown(await admit(owner)));
  }
  return answers;
};

/** The lease `answer` holds, settled. */
export const settle = async (answer: Answer): Promise<void> => {
  if (!("lease" in answer)) {
    throw new Error(`Not admitted: ${shown(answer)}`);
  }
  await answer.lease.settle();
};

/** Moves `column` of `table`'s rows of job `job` `ms` into the past. */
export const aged = async (
  table: "build_leases" | "build_admission_queue",
  column: string,
  job: string,
  ms: number
): Promise<void> => {
  await env.DB.prepare(
    `UPDATE ${table} SET ${column} = ${column} - ? WHERE job_id = ?`
  )
    .bind(ms, job)
    .run();
};

/** The leases held now, in all. */
export const leasesHeld = async (): Promise<number> =>
  (await env.DB.prepare(
    "SELECT count(*) AS held FROM build_leases WHERE settled_at IS NULL AND admitted_at + reserved_ms > ?"
  )
    .bind(Date.now())
    .first<number>("held")) ?? 0;

/** Writes a commit's fence for the lease of `job`'s step at `seq`: whether the database took it. */
export const fenced = async (job: string, seq: number): Promise<string> => {
  try {
    await env.DB.prepare(
      "INSERT INTO build_commit_fences (job_id, seq) VALUES (?, ?)"
    )
      .bind(job, seq)
      .run();
    await env.DB.prepare("DELETE FROM build_commit_fences WHERE job_id = ?")
      .bind(job)
      .run();
    return "fenced";
  } catch {
    return "refused";
  }
};
