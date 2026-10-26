import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  boardPageOf,
  call,
  codeOf,
  dayMs,
  estimated,
  idSchema,
  listed,
  opened,
  revisionOf,
  saveWorkflow,
  seedMap,
  seedRuns,
  seedSignals,
  take,
  valueOf,
} from "./board-page.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, unique } from "./sign-in.ts";

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
const { setUp } = boardPageOf(idp);

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
});
