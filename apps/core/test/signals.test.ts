import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { refreshDailySignals } from "../src/daily-signals.ts";
import { allEvents } from "./audit-events.ts";
import { runMinuteTasks, runQuarterHourTasks } from "./maintenance.ts";

// Improvement signals, computed once a day: how a day's computation is
// claimed by the clock. What each signal says is tested with what it is
// computed from (workflow-run-signals.test.ts, workflow-decisions.test.ts).

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

/**
 * Each computation's day: a day after the last test's, from tomorrow on, at
 * noon UTC. Signals are computed per UTC day, so a test that moves an hour
 * or so on from `now` stays on its day whatever time the suite runs.
 */
let days = 0;
const nextDay = (): Date => {
  days += 1;
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  return new Date(today.getTime() + days * dayMs);
};

/** The computations of `day` there are, finished or not. */
const claimsOf = async (day: Date): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS claims FROM improvement_signal_computations WHERE day = ?"
  )
    .bind(day.toISOString().slice(0, 10))
    .first<{ claims: number }>();
  return row?.claims ?? 0;
};

/** A claim of `day`'s computation, started `ago` before `day`, unfinished. */
const seedClaim = async (day: Date, ago: number): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO improvement_signal_computations (id, day, started_at) VALUES (?, ?, ?)"
  )
    .bind(
      crypto.randomUUID(),
      day.toISOString().slice(0, 10),
      day.getTime() - ago
    )
    .run();
};

/** How many computations the audit log recorded for `day`. */
const computationsOf = async (day: Date): Promise<number> => {
  const events = await allEvents();
  return events.filter(
    ({ action, detail }) =>
      action === "improvement.signals.computed" &&
      detail.day === day.toISOString().slice(0, 10)
  ).length;
};

describe("improvement signals", () => {
  it("leave a day alone while another computation's claim on it is recent", async () => {
    const now = nextDay();
    // Claimed 16 minutes ago: longer than between clock runs, within the lease.
    await env.DB.prepare(
      "INSERT INTO improvement_signal_computations (id, day, started_at) VALUES (?, ?, ?)"
    )
      .bind(
        crypto.randomUUID(),
        now.toISOString().slice(0, 10),
        now.getTime() - 16 * 60 * 1000
      )
      .run();

    await refreshDailySignals(env, now);

    await expect(computationsOf(now)).resolves.toBe(0);
  });

  it("are computed once when two clock runs claim the same day at once", async () => {
    const now = nextDay();

    await Promise.all([
      refreshDailySignals(env, now),
      refreshDailySignals(env, now),
    ]);

    await expect(computationsOf(now)).resolves.toBe(1);
  });

  it("stop claiming a day after a few failed attempts, and drop earlier days' unfinished claims", async () => {
    const earlier = nextDay();
    const now = nextDay();
    await seedClaim(earlier, hourMs);
    // Three attempts of the day, each lapsed long ago.
    await seedClaim(now, 3 * hourMs);
    await seedClaim(now, 2 * hourMs);
    await seedClaim(now, hourMs);

    await refreshDailySignals(env, now);

    expect({
      computed: await computationsOf(now),
      claims: { earlier: await claimsOf(earlier), now: await claimsOf(now) },
    }).toStrictEqual({ computed: 0, claims: { earlier: 0, now: 3 } });
  });

  it("are computed by the clock's quarter-hour tasks, not its every-minute ones", async () => {
    const today = new Date();

    await runMinuteTasks();
    const everyMinute = await computationsOf(today);
    await runQuarterHourTasks();

    expect({ everyMinute, signals: await computationsOf(today) }).toStrictEqual(
      {
        everyMinute: 0,
        signals: 1,
      }
    );
  });
});
