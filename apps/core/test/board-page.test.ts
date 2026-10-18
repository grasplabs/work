import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { OperationResult } from "@grasp-os/shared/operations";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { builtins, fingerprintOf, release } from "../src/builtins.ts";
import { grantReviewed, release as releaseFiles } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { calledAs } from "./sealed-apps.ts";
import { auditedDuring, signedInApi, unique } from "./sign-in.ts";

// The board page, the built-in App (apps/core/blueprints/board-page/):
// it takes snapshots of the workflow map's numbers, in its own store, shows
// the newest, and saves its narrative and the decision it asks for,
// keeping what the snapshot froze. A snapshot freezes each workflow's
// hours as drawn, designed and as it runs, read from the map (an `app`
// resource an admin binds to a workflow map), and the improvement signals
// of the App workflows the map links to, read from the platform's
// statistics (bound to the permission an admin grants). These tests go in
// through the Apps' functions, as their screens call them, and start from
// the ways it can fail: a number that isn't what the map and the runs say
// (a run outside the window counted, the designed version taken for the
// drawn one); a later save, run or day of signals changing a snapshot
// taken before it; a save of the narrative changing what it froze; a
// signal's subject (a person) or another App's signals frozen; part of a
// snapshot frozen; and someone who isn't one of its builders taking or
// writing one, or a snapshot taken from a map nobody bound.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const dayMs = 24 * 60 * 60 * 1000;

/** What `person` gets calling `app`'s `path` (a `kind`) with `input`. */
const call = async (
  person: Person,
  app: AppId,
  path: string,
  kind: "query" | "mutation" | "action",
  input: unknown = {}
): Promise<OperationResult> =>
  await calledAs(
    await person.api.whoami(),
    app,
    { contractId: path, kind },
    input
  );

/** What a call answered; a refusal fails the test, saying why. */
const valueOf = (result: OperationResult): unknown => {
  if (!result.ok) {
    throw new Error(
      `Refused: ${result.error.code} ${result.error.message} ${JSON.stringify(result.error.details ?? null)}`
    );
  }
  return result.value;
};

/** Why a call was refused, or `ok`. */
const codeOf = (result: OperationResult): string =>
  result.ok ? "ok" : result.error.code;

const estimated = (value: number) => ({ value, basis: "estimated" as const });
const observed = (value: number) => ({ value, basis: "observed" as const });

const idSchema = z.string().min(1);

const snapshotSchema = z.looseObject({
  _rev: z.number(),
  take: z.string(),
  title: z.string(),
  date: z.string(),
  maturity: z.number(),
  figures: z.number(),
  signals: z.array(z.looseObject({ workflow: z.string(), kind: z.string() })),
  decisionNeeded: z.string(),
  narrative: z.string(),
});

const figureSchema = z.object({
  workflow: z.string(),
  title: z.string(),
  team: z.string().nullable(),
  state: z.string(),
  drawn: z.unknown(),
  designed: z.unknown(),
  unavailable: z.boolean(),
  running: z.unknown(),
});

/** An App created from the built-in `blueprint` by `admin`. */
const fromBuiltin = async (admin: Person, blueprint: string) => {
  await builtins(env).ensureInstalled(await fingerprintOf(release));
  const made = await admin.api.apps.blueprints.create(blueprint, {
    name: `Ours ${unique()}`,
  });
  await admin.api.apps.versions.setCurrent(made.app.id, 1);
  return { app: appIdSchema.parse(made.app.id), permissions: made.permissions };
};

/**
 * An admin's board page and workflow map: the page's `map` bound to the
 * map unless `bindMap` is false, and its `statistics` to the statistics
 * permission it asks for, granted, unless `bindStatistics` is false.
 */
const setUp = async ({
  bindMap = true,
  bindStatistics = true,
}: { bindMap?: boolean; bindStatistics?: boolean } = {}) => {
  const admin = await signedInApi(idp, "admin");
  const board = await fromBuiltin(admin, "board-page");
  const { app: map } = await fromBuiltin(admin, "workflow-map");
  if (bindMap) {
    await admin.api.resourceBindings.approve({
      app: board.app,
      alias: "map",
      target: { kind: "app", appId: map },
      reviewed: { version: 1 },
    });
  }
  const [permission] = board.permissions;
  if (bindStatistics && permission !== undefined) {
    await grantReviewed(admin.api, permission.id);
    await admin.api.resourceBindings.approve({
      app: board.app,
      alias: "statistics",
      target: { kind: "statistics", permissionId: permission.id },
      reviewed: { version: 1 },
    });
  }
  return { admin, app: board.app, map };
};

const workflowFile = `import { workflow, z } from "@grasp-os/sdk/workflow";

export default workflow(
  "pay",
  { input: z.unknown(), params: {} },
  async (step) => await step.do("count", { description: "Count" }, async () => 1)
);
`;

const workflowTestsFile = `import { workflowTests } from "@grasp-os/sdk/testing";

import pay from "./pay.ts";

export default workflowTests(pay, [{ name: "counts", mocks: { count: 1 }, expect: { output: 1 } }]);
`;

/** An App whose running version has the workflow `pay`, released by `admin`. */
const payablesApp = async (admin: Person): Promise<AppId> => {
  const { id } = await admin.api.apps.create({ name: `Payables ${unique()}` });
  await releaseFiles(admin, id, {
    "workflows/pay.ts": workflowFile,
    "workflows/pay.workflow-tests.ts": workflowTestsFile,
  });
  return appIdSchema.parse(id);
};

/** `count` runs of `app`'s workflow `pay`, started `ago` milliseconds back. */
const seedRuns = async (
  app: AppId,
  count: number,
  ago: number
): Promise<void> => {
  const at = Date.now() - ago;
  await env.DB.batch(
    Array.from({ length: count }, () =>
      env.DB.prepare(
        "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'pay', 1, NULL, 'completed', ?, ?)"
      ).bind(`run-${unique()}-${unique()}`, app, at, at)
    )
  );
};

/**
 * Each seeded computation starts after the one before, so the latest wins,
 * and all within the last hour: a read counts none started after its now.
 */
let computations = 0;

/**
 * A finished computation of improvement signals, the latest, with
 * `signals` as `[app, workflow, kind, subject, value]`.
 */
const seedSignals = async (
  signals: [string, string, string, string, number][]
): Promise<void> => {
  computations += 1;
  const id = `computation-${unique()}`;
  const startedAt = Date.now() - 60 * 60_000 + computations * 1000;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO improvement_signal_computations (id, day, started_at, finished_at) VALUES (?, ?, ?, ?)"
    ).bind(
      id,
      new Date(startedAt).toISOString().slice(0, 10),
      startedAt,
      startedAt
    ),
    ...signals.map(([app, workflow, kind, subject, value]) =>
      env.DB.prepare(
        "INSERT INTO improvement_signals (computation, app_id, workflow_id, kind, subject, value, evidence) VALUES (?, ?, ?, ?, ?, ?, '{}')"
      ).bind(id, app, workflow, kind, subject, value)
    ),
  ]);
};

/** Saves a workflow in the map, as its screen does, answering its ID. */
const saveWorkflow = async (
  admin: Person,
  map: AppId,
  fields: Record<string, unknown>,
  from: { id: string; revision: number } | null = null
): Promise<string> =>
  z.object({ id: idSchema }).parse(
    valueOf(
      await call(admin, map, "map.save", "mutation", {
        id: from?.id ?? null,
        expectedRevision: from?.revision ?? null,
        team: null,
        parameters: [],
        gain: null,
        notes: "",
        ...fields,
      })
    )
  ).id;

/** A map workflow's revision now. */
const revisionOf = async (
  admin: Person,
  map: AppId,
  id: string
): Promise<number> =>
  z
    .object({ current: z.looseObject({ _rev: z.number() }) })
    .parse(valueOf(await call(admin, map, "map.open", "query", { id }))).current
    ._rev;

/**
 * A team, a drawn workflow and a designed one linked to `pay` of a new
 * App, saved through the map.
 */
const seedMap = async (admin: Person, map: AppId) => {
  const team = idSchema.parse(
    valueOf(
      await call(admin, map, "teams.add", "mutation", {
        title: `Finance ${unique()}`,
      })
    )
  );
  const book = await saveWorkflow(admin, map, {
    title: "Book receipts",
    state: "drawn",
    team,
    steps: [
      {
        name: "Book it",
        numbers: {
          frequency: estimated(40),
          minutes: observed(6),
          people: estimated(1),
        },
      },
    ],
  });
  // Drawn at 10 hours a week, then designed, then linked to `pay`.
  const pay = await saveWorkflow(admin, map, {
    title: "Pay invoices",
    state: "drawn",
    steps: [
      {
        name: "Match",
        numbers: {
          frequency: estimated(30),
          minutes: estimated(10),
          people: estimated(2),
        },
      },
    ],
  });
  await saveWorkflow(
    admin,
    map,
    {
      title: "Pay invoices",
      state: "designed",
      steps: [
        {
          name: "Match",
          kind: "automated",
          numbers: { frequency: observed(30), minutes: observed(0) },
        },
        {
          name: "Approve",
          numbers: { frequency: estimated(30), minutes: estimated(5) },
        },
      ],
    },
    { id: pay, revision: await revisionOf(admin, map, pay) }
  );
  const payables = await payablesApp(admin);
  valueOf(
    await call(admin, map, "map.link", "mutation", {
      id: pay,
      expectedRevision: await revisionOf(admin, map, pay),
      app: { appId: payables, workflowId: "pay" },
    })
  );
  return { team, book, pay, payables };
};

/** A snapshot's maturity, unless a test says another. */
const defaultTake = { maturity: 1 };

/** An ID as long as an App's or a workflow's may be. */
const longId = (prefix: string): string => prefix.padEnd(256, "x");

/** Takes a snapshot as `person`. */
const take = async (
  person: Person,
  app: AppId,
  input: Record<string, unknown> = defaultTake
): Promise<OperationResult> =>
  await call(person, app, "snapshots.take", "action", input);

/** A snapshot and its figures, by workflow. */
const opened = async (person: Person, app: AppId, id: string) => {
  const snapshot = snapshotSchema.parse(
    valueOf(await call(person, app, "snapshots.get", "query", { id }))
  );
  const page = z
    .object({ items: z.array(z.looseObject(figureSchema.shape)) })
    .parse(
      valueOf(
        await call(person, app, "snapshots.figures", "query", {
          take: snapshot.take,
          pagination: { pageSize: 100 },
        })
      )
    );
  const figures = new Map(
    page.items.map((item) => {
      const figure = figureSchema.parse(item);
      return [figure.workflow, figure];
    })
  );
  return { snapshot, figures };
};

/** The snapshots listed, newest first, by ID. */
const listed = async (person: Person, app: AppId): Promise<string[]> =>
  z
    .object({ items: z.array(z.looseObject({ id: z.string() })) })
    .parse(
      valueOf(
        await call(person, app, "snapshots.list", "query", { pagination: {} })
      )
    )
    .items.map(({ id }) => id);

describe("the board page", { timeout: 90_000 }, () => {
  it("freezes each workflow's hours drawn, designed and as it runs, and its App workflow's signals", async () => {
    const { admin, app, map } = await setUp();
    const { team, book, pay, payables } = await seedMap(admin, map);
    // Another App a workflow links to: counted in the same reads.
    const { payables: another } = await seedMap(admin, map);
    // 30 runs in the window: 7 a week. One before it doesn't count.
    await seedRuns(payables, 30, dayMs);
    await seedRuns(payables, 1, 40 * dayMs);
    await seedSignals([
      [payables, "pay", "failing_step", "match", 3],
      [payables, "pay", "waiting_for_person", "person:someone", 7_200_000],
      [payables, "pay", "waiting_for_person", "role:admin", 3_600_000],
      ["another-app", "pay", "failing_step", "match", 9],
    ]);

    let taken = "";
    const events = await auditedDuring(async () => {
      taken = idSchema.parse(
        valueOf(
          await take(admin, app, {
            maturity: 2,
            decisionNeeded: " Automate paying invoices next quarter? ",
          })
        )
      );
    });
    const { snapshot, figures } = await opened(admin, app, taken);
    const teamTitle = z
      .array(z.looseObject({ _id: z.string(), title: z.string() }))
      .parse(valueOf(await call(admin, map, "teams.list", "query")))
      .find(({ _id }) => _id === team)?.title;
    expect({
      title: snapshot.title,
      maturity: snapshot.maturity,
      decisionNeeded: snapshot.decisionNeeded,
      figures: snapshot.figures,
      book: figures.get(book),
      pay: figures.get(pay),
      signals: snapshot.signals.filter(({ workflow }) => workflow === pay),
      // One read of the runs and one of the signals, for every App linked.
      reads: events
        .filter(({ action }) => action === "statistics.read")
        .map(({ provenance }) => ({
          payables: provenance.includes(payables),
          another: provenance.includes(another),
        })),
    }).toStrictEqual({
      title: `Snapshot ${snapshot.date}`,
      maturity: 2,
      decisionNeeded: "Automate paying invoices next quarter?",
      figures: 4,
      // 40 times × 6 minutes: 4 hours, some numbers estimated.
      book: {
        workflow: book,
        title: "Book receipts",
        team: teamTitle,
        state: "drawn",
        drawn: { version: 1, hoursPerWeek: 4, basis: "estimated" },
        designed: null,
        unavailable: false,
        running: null,
      },
      pay: {
        workflow: pay,
        title: "Pay invoices",
        team: null,
        state: "designed",
        // 30 × 10 minutes × 2 people, as last drawn.
        drawn: { version: 1, hoursPerWeek: 10, basis: "estimated" },
        // 30 × 5 minutes, as designed, and linked: version 3.
        designed: { version: 3, hoursPerWeek: 2.5, basis: "estimated" },
        unavailable: false,
        // 7 runs a week × 5 minutes: 35 minutes.
        running: {
          appId: payables,
          workflowId: "pay",
          runs: 30,
          hoursPerWeek: 0.6,
        },
      },
      // Each kind's highest, with no subject, and none of another App's.
      signals: [
        { workflow: pay, kind: "waiting_for_person", value: 7_200_000 },
        { workflow: pay, kind: "failing_step", value: 3 },
      ],
      reads: [
        { payables: true, another: true },
        { payables: true, another: true },
      ],
    });
  });

  it("marks a workflow of an App it can't read, or of none bound, unavailable, never as not running", async () => {
    const { admin, app, map } = await setUp();
    const { pay, payables } = await seedMap(admin, map);
    await seedRuns(payables, 30, dayMs);
    // A designed workflow linked to an App that no longer exists: read in
    // the same chunk as `payables`.
    const gone = await saveWorkflow(admin, map, {
      title: "Gone",
      state: "drawn",
      steps: [],
    });
    await saveWorkflow(
      admin,
      map,
      {
        title: "Gone",
        state: "designed",
        steps: [
          {
            name: "Do it",
            numbers: { frequency: estimated(10), minutes: estimated(6) },
          },
        ],
      },
      { id: gone, revision: await revisionOf(admin, map, gone) }
    );
    valueOf(
      await call(admin, map, "map.link", "mutation", {
        id: gone,
        expectedRevision: await revisionOf(admin, map, gone),
        app: { appId: crypto.randomUUID(), workflowId: "pay" },
      })
    );
    const taken = idSchema.parse(valueOf(await take(admin, app)));
    const { figures } = await opened(admin, app, taken);
    // A page whose statistics no admin bound: nothing it reads runs.
    const unbound = await setUp({ bindStatistics: false });
    const linked = await seedMap(unbound.admin, unbound.map);
    await seedRuns(linked.payables, 30, dayMs);
    const takenUnbound = idSchema.parse(
      valueOf(await take(unbound.admin, unbound.app))
    );
    const { figures: unboundFigures } = await opened(
      unbound.admin,
      unbound.app,
      takenUnbound
    );
    expect({
      pay: z
        .object({ running: z.object({ runs: z.number() }) })
        .parse(figures.get(pay)).running.runs,
      gone: figures.get(gone),
      unbound: {
        unavailable: unboundFigures.get(linked.pay)?.unavailable,
        running: unboundFigures.get(linked.pay)?.running,
      },
    }).toStrictEqual({
      pay: 30,
      gone: {
        workflow: gone,
        title: "Gone",
        team: null,
        state: "designed",
        drawn: { version: 1, hoursPerWeek: 0, basis: "estimated" },
        designed: { version: 3, hoursPerWeek: 1, basis: "estimated" },
        unavailable: true,
        running: null,
      },
      unbound: { unavailable: true, running: null },
    });
  });

  it("refuses to freeze figures it can't read whole, and lists nothing", async () => {
    const { admin, app, map } = await setUp();
    const { payables } = await seedMap(admin, map);
    // 501 workflows of a linked App ran: more groups than a snapshot reads.
    const bulk = `bulk-${unique()}-`;
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501) INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) SELECT ?1 || i, ?2, 'w' || i, 1, NULL, 'completed', ?3, ?3 FROM n"
    )
      .bind(bulk, payables, Date.now())
      .run();
    try {
      expect({
        taken: codeOf(await take(admin, app)),
        listed: await listed(admin, app),
      }).toStrictEqual({ taken: "board.figures_incomplete", listed: [] });
    } finally {
      await env.DB.prepare("DELETE FROM workflow_runs WHERE id LIKE ?")
        .bind(`${bulk}%`)
        .run();
    }
  });

  it("keeps what a snapshot froze when the workflows, runs and signals change later, and when its narrative is written", async () => {
    const { admin, app, map } = await setUp();
    const { book, payables } = await seedMap(admin, map);
    await seedRuns(payables, 30, dayMs);
    await seedSignals([[payables, "pay", "failing_step", "match", 3]]);
    const taken = idSchema.parse(valueOf(await take(admin, app)));
    const before = await opened(admin, app, taken);

    // Later: the drawn workflow is redrawn, more runs start, a new day's
    // signals come in.
    await saveWorkflow(
      admin,
      map,
      {
        title: "Book receipts",
        state: "drawn",
        steps: [
          {
            name: "Book it",
            numbers: { frequency: estimated(1), minutes: estimated(1) },
          },
        ],
      },
      { id: book, revision: await revisionOf(admin, map, book) }
    );
    await seedRuns(payables, 60, dayMs);
    await seedSignals([[payables, "pay", "failing_step", "match", 30]]);
    const later = await opened(admin, app, taken);
    // Its narrative and decision written; from its first revision again,
    // someone else's came first.
    const write = async (expectedRevision: number, narrative: string) =>
      codeOf(
        await call(admin, app, "snapshots.write", "mutation", {
          id: taken,
          expectedRevision,
          decisionNeeded: "Hire a bid writer?",
          narrative,
        })
      );
    const written = await write(before.snapshot._rev, "Tenders take hours.");
    const stale = await write(before.snapshot._rev, "Mine.");
    const after = await opened(admin, app, taken);
    const {
      _rev: _before,
      _updatedAt: _beforeUpdated,
      narrative: _noNarrative,
      decisionNeeded: _noDecision,
      ...frozen
    } = before.snapshot;
    const {
      _rev: _after,
      _updatedAt: _afterUpdated,
      narrative,
      decisionNeeded,
      ...kept
    } = after.snapshot;
    expect({
      later: later.snapshot,
      laterFigures: [...later.figures.values()],
      written,
      stale,
      after: { narrative, decisionNeeded },
      kept,
      keptFigures: [...after.figures.values()],
    }).toStrictEqual({
      later: before.snapshot,
      laterFigures: [...before.figures.values()],
      written: "ok",
      stale: "data.conflict",
      after: {
        narrative: "Tenders take hours.",
        decisionNeeded: "Hire a bid writer?",
      },
      kept: frozen,
      keptFigures: [...before.figures.values()],
    });
  });

  it("lists the snapshot taken last first, however many were taken that day", async () => {
    const { admin, app } = await setUp();
    const first = idSchema.parse(valueOf(await take(admin, app)));
    const second = idSchema.parse(valueOf(await take(admin, app)));
    const third = idSchema.parse(valueOf(await take(admin, app)));
    await expect(listed(admin, app)).resolves.toStrictEqual([
      third,
      second,
      first,
    ]);
  });

  it("is read by everyone it is shared with, taken and written by its builders alone, refused before anything is read for anyone else", async () => {
    const { admin, app, map } = await setUp();
    await seedMap(admin, map);
    const taken = idSchema.parse(valueOf(await take(admin, app)));
    const { snapshot } = await opened(admin, app, taken);
    const member = await signedInApi(idp, "user");
    await admin.api.apps.members.add(app, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = codeOf(await take(member, app));
    });
    expect({
      take: refused,
      // Neither the map nor the statistics were read for them.
      read: events.filter(
        ({ action }) =>
          action === "statistics.read" || action.startsWith("app.function")
      ).length,
      write: codeOf(
        await call(member, app, "snapshots.write", "mutation", {
          id: taken,
          expectedRevision: snapshot._rev,
          decisionNeeded: "",
          narrative: "Theirs.",
        })
      ),
      writable: valueOf(await call(member, app, "access.writable", "action")),
      listed: await listed(member, app),
      opened: await opened(member, app, taken).then(
        (read) => read.snapshot.narrative
      ),
      level: codeOf(await take(admin, app, { maturity: 6 })),
    }).toStrictEqual({
      take: "data.access_denied",
      read: 0,
      write: "data.write_denied",
      writable: false,
      listed: [taken],
      opened: "",
      level: "contract.invalid_args",
    });
  });

  it("freezes and shows workflows at their longest, a page at a time within what a query answers", async () => {
    const { admin, app, map } = await setUp({ bindStatistics: false });
    const team = idSchema.parse(
      valueOf(
        await call(admin, map, "teams.add", "mutation", {
          title: "€".repeat(200),
        })
      )
    );
    // Each written as the map's screen would: drawn, designed, linked.
    const worst = async (index: number): Promise<void> => {
      const fields = {
        title: `${index}`.padEnd(200, "€"),
        team,
        steps: [
          {
            name: "Do it",
            numbers: { frequency: estimated(10), minutes: estimated(6) },
          },
        ],
      };
      const id = await saveWorkflow(admin, map, {
        ...fields,
        state: "drawn",
      });
      await saveWorkflow(
        admin,
        map,
        { ...fields, state: "designed" },
        { id, revision: await revisionOf(admin, map, id) }
      );
      valueOf(
        await call(admin, map, "map.link", "mutation", {
          id,
          expectedRevision: await revisionOf(admin, map, id),
          app: { appId: longId(`app${index}-`), workflowId: longId("w-") },
        })
      );
    };
    for (let index = 0; index < 60; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one workflow at a time
      await worst(index);
    }
    const mapPage = await call(admin, map, "figures.list", "query", {
      pagination: { pageSize: 100 },
    });
    const taken = idSchema.parse(valueOf(await take(admin, app)));
    const snapshot = snapshotSchema.parse(
      valueOf(await call(admin, app, "snapshots.get", "query", { id: taken }))
    );
    const figuresPage = await call(admin, app, "snapshots.figures", "query", {
      take: snapshot.take,
      pagination: { pageSize: 100 },
    });
    const items = (result: OperationResult) =>
      z.object({ items: z.array(z.unknown()) }).parse(valueOf(result)).items
        .length;
    expect({
      mapPage: items(mapPage),
      figures: snapshot.figures,
      figuresPage: items(figuresPage),
    }).toStrictEqual({ mapPage: 50, figures: 60, figuresPage: 50 });
  });

  it("takes no snapshot of a map nobody bound it to", async () => {
    const { admin, app } = await setUp({ bindMap: false });
    expect({
      taken: codeOf(await take(admin, app)),
      listed: await listed(admin, app),
    }).toStrictEqual({ taken: "resource.unavailable", listed: [] });
  });
});
