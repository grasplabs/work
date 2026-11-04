import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import type { ImprovementSignal } from "@grasp-os/shared/signals";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import type { z } from "zod";

import { auditLog } from "../src/audit-log.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { refreshDailySignals } from "../src/daily-signals.ts";
import { published } from "./apps.ts";
import { allEvents, logHead } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { runMinuteTasks, runQuarterHourTasks } from "./maintenance.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Improvement signals from runs, decisions and the audit log, computed
// once a day. Each test seeds its own App's runs, decisions and events,
// computes the signals as of a day of its own (later than the last
// test's), and reads them through the API: as an admin, who sees them
// whole, unless the test is about what builders see.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

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

/** A builder with an App of their own. */
const builderWithApp = async (): Promise<Person & { app: string }> => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: `Signals ${unique()}` });
  await published(id);
  return { ...builder, app: id };
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

/** Appends events to the deployment's log, as draining an outbox does. */
const logged = async (
  ...entries: Partial<z.input<typeof auditEventSchema>>[]
): Promise<string[]> => {
  const events: AuditEvent[] = entries.map((entry) =>
    auditEventSchema.parse({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source: "core",
      actor: { type: "system" },
      action: "model.call",
      ...entry,
    })
  );
  await auditLog(env).append(events);
  return events.map(({ id }) => id);
};

/** When the log received the event `id`, appended after position `after`. */
const receivedAtOf = async (id: string, after: number): Promise<string> => {
  let page = await auditLog(env).entries(after);
  while (page.length > 0) {
    const found = page.find(({ event }) => event.includes(id));
    if (found !== undefined) {
      return found.receivedAt;
    }
    // Pages are read one after another.
    // oxlint-disable-next-line no-await-in-loop
    page = await auditLog(env).entries(page.at(-1)?.seq);
  }
  throw new Error(`The log has no event ${id}`);
};

/** A workflow run's actor in the audit log. */
const runActor = (app: string, workflow: string, run: string) => ({
  type: "workflow" as const,
  appId: app,
  workflowId: workflow,
  runId: run,
});

/** A Knowledge search that found nothing, by `actor`. */
const emptySearch = (
  actor: z.input<typeof auditEventSchema>["actor"],
  queryKey: string,
  collection?: string
) => ({
  actor,
  action: "knowledge.search.empty",
  ...(collection === undefined
    ? {}
    : { target: { type: "collection", id: collection } }),
  detail: { terms: 3, queryKey, sensitive: false },
});

/** The signals of `kind` in `list`, without the App (the tests' own). */
const ofKind = <Kind extends ImprovementSignal["kind"]>(
  signals: readonly ImprovementSignal[],
  kind: Kind
) =>
  signals
    .filter(
      (signal): signal is Extract<ImprovementSignal, { kind: Kind }> =>
        signal.kind === kind
    )
    .map(({ app: _app, ...signal }) => signal);

/**
 * Unanswered questions without when each was last asked, which the log
 * sets as it receives them; and whether every one was since `since`.
 */
const questions = (signals: readonly ImprovementSignal[], since: number) => {
  const found = signals.filter(
    (
      signal
    ): signal is Extract<ImprovementSignal, { kind: "unanswered_question" }> =>
      signal.kind === "unanswered_question"
  );
  return {
    recent: found.every(({ evidence }) => Date.parse(evidence.lastAt) >= since),
    questions: found.map(
      ({ evidence: { lastAt: _lastAt, ...evidence }, ...signal }) => ({
        ...signal,
        evidence,
      })
    ),
  };
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
  it("group Knowledge searches that found nothing by their key, an App's with the App and people's, through the agent too, with the deployment", async () => {
    const { api, app } = await builderWithApp();
    const admin = await signedInApi(idp, "admin");
    const now = nextDay();
    const asked = `key-${unique()}`;
    const once = `key-${unique()}`;
    const people = `key-${unique()}`;
    const since = Date.now();
    const head = await logHead();
    // Its askers take turns, each search received a second after the one
    // before (the log's clock, moved on here).
    const turns = [
      emptySearch(runActor(app, "triage", "run-a"), asked, "collection-a"),
      emptySearch(runActor(app, "triage", "run-b"), asked),
      emptySearch(runActor(app, "triage", "run-a"), asked, "collection-b"),
    ];
    const received: string[] = [];
    vi.useFakeTimers({ toFake: ["Date"], now: since });
    try {
      for (const turn of turns) {
        vi.setSystemTime(Date.now() + 1000);
        // One after another, each at its own time.
        // oxlint-disable-next-line no-await-in-loop
        received.push(...(await logged(turn)));
      }
    } finally {
      vi.useRealTimers();
    }
    const [lastAsked = ""] = received.slice(-1);
    // Someone asks, then asks again through the chat agent, as do two
    // others: three askers, the agent asking for each of them.
    const [someone, second, third] = [
      `person-${unique()}`,
      `person-${unique()}`,
      `person-${unique()}`,
    ];
    const throughAgent = (userId: string) =>
      emptySearch(
        { type: "agent", agentId: chatAgentId, onBehalfOf: userId },
        people
      );
    await logged(
      emptySearch({ type: "app", appId: app, part: "screen" }, once),
      emptySearch({ type: "person", userId: someone }, people),
      throughAgent(someone),
      throughAgent(second),
      throughAgent(third)
    );

    await refreshDailySignals(env, now);
    const [mine, everyone] = await Promise.all([
      api.signals.list({ app }),
      admin.api.signals.list(),
    ]);

    const own = questions(mine.signals, since);
    const askedLast = ofKind(mine.signals, "unanswered_question").find(
      ({ subject }) => subject === asked
    )?.evidence.lastAt;
    expect({
      // The latest search of any of its askers'.
      askedLast: askedLast === (await receivedAtOf(lastAsked, head)),
      mine: {
        ...own,
        questions: own.questions.map(({ app: _app, ...signal }) => signal),
      },
      people: questions(
        everyone.signals.filter(({ subject }) => subject === people),
        since
      ),
    }).toStrictEqual({
      askedLast: true,
      mine: {
        recent: true,
        questions: [
          {
            kind: "unanswered_question",
            workflow: "triage",
            subject: asked,
            value: 3,
            evidence: {
              searches: 3,
              askers: 2,
              terms: 3,
              collections: ["collection-a", "collection-b"],
            },
          },
          {
            kind: "unanswered_question",
            workflow: null,
            subject: once,
            value: 1,
            evidence: { searches: 1, askers: 1, terms: 3, collections: [] },
          },
        ],
      },
      people: {
        recent: true,
        questions: [
          {
            kind: "unanswered_question",
            app: null,
            workflow: null,
            subject: people,
            value: 4,
            evidence: { searches: 4, askers: 3, terms: 3, collections: [] },
          },
        ],
      },
    });
  });

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
