/**
 * Runs over the last 30 days. Each run is a real one: started through
 * core's API by the person it names, run by the engine, its decision
 * answered through the API by the person who decides. Only its times are
 * then moved back, in core's local D1, as core's tests write it: no API
 * starts a run in the past, and the dashboard counts runs by the day they
 * started.
 */
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type { PersonKey } from "./company.ts";
import type { Answer, Draw, RunPlan, WorkflowSeed } from "./engines.ts";
import type { Session } from "./local.ts";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

/** How far back the history goes. */
const historyDays = 30;

/** How many runs start at once: the local engine takes more, slowly. */
const startsAtOnce = 6;

/** How long a run may take to end, or to wait for its decision. */
const settleTimeoutMs = 60_000;
const pollMs = 250;

/** The modulus of the Park–Miller generator: the prime 2^31 - 1. */
const modulus = 2_147_483_647;

/**
 * Numbers that look random and are the same on every seed: a Park–Miller
 * generator, started from the workflow's name.
 */
export const drawFor = (name: string): Draw => {
  let state = 1;
  for (const char of name) {
    state = (state * 31 + (char.codePointAt(0) ?? 0)) % modulus;
  }
  // Zero would stay zero.
  state = state === 0 ? 1 : state;
  const random = (): number => {
    state = (state * 48_271) % modulus;
    return (state - 1) / (modulus - 1);
  };
  return {
    next: random,
    pick: <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      if (item === undefined) {
        throw new Error("Nothing to pick from");
      }
      return item;
    },
    between: (min, max) => min + Math.floor(random() * (max - min + 1)),
  };
};

/** Saturday or Sunday, in UTC. */
const isWeekend = (time: number): boolean => {
  const day = new Date(time).getUTCDay();
  return day === 0 || day === 6;
};

/** Seven in the morning, Amsterdam time (UTC in winter, near enough). */
const scheduleHourUtc = 5;

/**
 * When each of a workflow's runs started: spread over the last 30 days,
 * oldest first, on working days in working hours; the ones still waiting
 * for a decision within the last day and a half, so their deadlines are
 * still ahead; a scheduled workflow's on the Mondays its schedule ran.
 */
const startTimes = (
  workflow: WorkflowSeed,
  plans: RunPlan[],
  draw: Draw,
  now: number
): number[] => {
  const today = now - (now % dayMs);
  if (workflow.scheduled === true) {
    const mondays = Array.from(
      { length: historyDays },
      (_, back) => today - back * dayMs
    ).filter(
      // Mondays whose run has started: not this morning's, before 7:00.
      (day) =>
        new Date(day).getUTCDay() === 1 && day + scheduleHourUtc * hourMs < now
    );
    return plans.map(
      (_, index) =>
        (mondays[plans.length - 1 - index] ?? today - index * 7 * dayMs) +
        scheduleHourUtc * hourMs +
        draw.between(0, 3) * 1000
    );
  }
  // The working days of the window, oldest first.
  const days = Array.from(
    { length: historyDays },
    (_, index) => today - (historyDays - 1 - index) * dayMs
  ).filter((day) => !isWeekend(day));
  return plans.map(({ answer }, index) => {
    if (answer === "open") {
      return now - draw.between(2, 36) * hourMs;
    }
    const day = days[Math.floor((index * days.length) / plans.length)] ?? today;
    const time = day + draw.between(7 * 60, 16 * 60) * minuteMs;
    // Today's runs started before now.
    return Math.min(time, now - draw.between(5, 90) * minuteMs);
  });
};

/** One run the seed started, and where it should be in time. */
interface Started {
  id: string;
  workflow: WorkflowSeed;
  plan: RunPlan;
  at: number;
  /** How long after the decision opened it was answered. */
  answerAfter: number;
}

/** A run as core's D1 keeps it, as far as the seed reads it. */
const runRowSchema = z.object({
  status: z.string(),
  created_at: z.number(),
  ended_at: z.number().nullable(),
});

/** A decision as core's D1 keeps it, as far as the seed reads it. */
const decisionRowSchema = z.object({
  id: z.string(),
  opened_at: z.number(),
  expires_at: z.number(),
  decided_at: z.number().nullable(),
});

/** Runs `work` on each item, at most `limit` at a time. */
const eachLimited = async <T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>
): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- each worker takes one at a time
        await work(item);
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
};

const wait = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form here
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const ended = (status: string): boolean =>
  ["completed", "failed", "cancelled"].includes(status);

/**
 * Waits until every run has ended, or waits for a decision: core's own
 * record of it, read from its D1.
 */
const settled = async (db: DatabaseSync, runs: readonly Started[]) => {
  const run = db.prepare(
    "SELECT status, created_at, ended_at FROM workflow_runs WHERE id = ?"
  );
  const open = db.prepare(
    "SELECT id FROM workflow_decisions WHERE run_id = ? AND status = 'open'"
  );
  const deadline = Date.now() + settleTimeoutMs;
  for (;;) {
    const pending = runs.filter(({ id }) => {
      const row = runRowSchema.optional().parse(run.get(id));
      return !(
        row !== undefined &&
        (ended(row.status) || open.get(id) !== undefined)
      );
    });
    if (pending.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${pending.length} runs neither ended nor waited for a decision in time, ${pending[0]?.id} among them`
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- polling core's record
    await wait(pollMs);
  }
};

const answered = (
  answer: Answer | undefined
): answer is Exclude<Answer, "open"> =>
  answer !== undefined && answer !== "open";

/**
 * Moves each run, its decision and what it told people back to when the
 * plan has it start, keeping how long each part took: seconds for the
 * engine's own steps, and for a decision the hours someone took to
 * answer, never past now.
 */
const backdate = (
  db: DatabaseSync,
  runs: readonly Started[],
  now: number
): void => {
  const runOf = db.prepare(
    "SELECT status, created_at, ended_at FROM workflow_runs WHERE id = ?"
  );
  const decisionsOf = db.prepare(
    "SELECT id, opened_at, expires_at, decided_at FROM workflow_decisions WHERE run_id = ?"
  );
  const moveRun = db.prepare(
    `UPDATE workflow_runs SET created_at = ?, ended_at = ?,
       started_by = CASE WHEN ? THEN NULL ELSE started_by END,
       failure = CASE WHEN failure IS NULL THEN NULL ELSE json_set(failure, '$.failedAt', ?) END
     WHERE id = ?`
  );
  const moveDecision = db.prepare(
    "UPDATE workflow_decisions SET opened_at = ?, expires_at = ?, decided_at = ? WHERE id = ?"
  );
  const moveNotifications = db.prepare(
    "UPDATE notifications SET created_at = ?, updated_at = ? WHERE run_id = ?"
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const { id, workflow, at, answerAfter } of runs) {
      const run = runRowSchema.optional().parse(runOf.get(id));
      if (run === undefined) {
        continue;
      }
      const shift = (time: number): number => at + (time - run.created_at);
      let endedAt = run.ended_at === null ? null : shift(run.ended_at);
      const decisions = z.array(decisionRowSchema).parse(decisionsOf.all(id));
      for (const decision of decisions) {
        const openedAt = shift(decision.opened_at);
        // An open decision keeps the deadline the engine waits until, so
        // it can be answered for as long as its run waits; an answered
        // one's moves with it.
        const expiresAt =
          decision.decided_at === null
            ? decision.expires_at
            : openedAt + (decision.expires_at - decision.opened_at);
        let decidedAt: number | null = null;
        if (decision.decided_at !== null) {
          decidedAt = Math.min(
            openedAt + answerAfter,
            openedAt + (now - openedAt) * 0.8
          );
          // The run went on once it was answered.
          if (run.ended_at !== null) {
            endedAt = decidedAt + (run.ended_at - decision.decided_at);
          }
        }
        moveDecision.run(openedAt, expiresAt, decidedAt, decision.id);
      }
      moveRun.run(
        at,
        endedAt,
        workflow.scheduled === true ? 1 : 0,
        new Date(endedAt ?? at).toISOString(),
        id
      );
      if (endedAt !== null) {
        moveNotifications.run(endedAt, endedAt, id);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

/**
 * Starts every workflow's runs on `app`, the engine `engine`, answers the
 * decisions the plans answer, and moves them all back in time. Returns
 * how many it started.
 */
export const seedRuns = async ({
  app,
  engine,
  workflows,
  sessions,
  db,
}: {
  app: string;
  engine: string;
  workflows: readonly WorkflowSeed[];
  sessions: ReadonlyMap<PersonKey, Session>;
  db: DatabaseSync;
}): Promise<number> => {
  const sessionOf = (key: PersonKey): Session => {
    const session = sessions.get(key);
    if (session === undefined) {
      throw new Error(`Nobody signed in as ${key}`);
    }
    return session;
  };
  const now = Date.now();
  const planned = workflows.flatMap((workflow) => {
    // By name, not ID: the same runs on every new stack.
    const draw = drawFor(`${engine}:${workflow.id}`);
    const plans = workflow.runs(draw);
    const times = startTimes(workflow, plans, draw, now);
    return plans.map((plan, index) => {
      const at = times[index] ?? now;
      const { dateInput } = workflow;
      return {
        workflow,
        plan:
          dateInput === undefined
            ? plan
            : {
                ...plan,
                input: {
                  ...plan.input,
                  [dateInput]: new Date(at).toISOString().slice(0, 10),
                },
              },
        at,
        answerAfter: draw.between(20, 26 * 60) * minuteMs,
      };
    });
  });

  const started: Started[] = [];
  await eachLimited(planned, startsAtOnce, async (run) => {
    const { id } = await sessionOf(run.plan.by).api.workflows.start(
      app,
      run.workflow.id,
      run.plan.input
    );
    started.push({ ...run, id });
  });
  await settled(db, started);

  const decisionOf = db.prepare(
    "SELECT id FROM workflow_decisions WHERE run_id = ? AND status = 'open'"
  );
  await eachLimited(started, startsAtOnce, async ({ id, plan }) => {
    const { answer } = plan;
    const decision = decisionRowSchema
      .pick({ id: true })
      .optional()
      .parse(decisionOf.get(id));
    if (!answered(answer) || decision === undefined) {
      return;
    }
    await sessionOf(answer.by).api.decisions.answer(decision.id, {
      approved: answer.approved,
      ...(answer.comment === undefined
        ? {}
        : { payload: { comment: answer.comment } }),
    });
  });
  await settled(
    db,
    started.filter(({ plan }) => answered(plan.answer))
  );

  backdate(db, started, now);
  return started.length;
};
