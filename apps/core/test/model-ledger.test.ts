import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Admission, LedgerScope } from "../src/model-ledger.ts";
import { allEvents } from "./audit-events.ts";

// The model ledger on its own, through its Durable Object's RPC: what
// the gateway (models.ts) relies on when a request is admitted, settled,
// lost or repeated. Each test has a ledger of its own.

/** A run lineage's scope, by its root run, counted with no budget. */
const lineageOf = (root: string): LedgerScope => ({
  scope: "run",
  key: root,
  limitMicros: null,
  alertMicros: null,
  limitRequests: 100,
  names: { run: root },
});

/** Values in order, as their JSON sorts. */
const byJson = (one: unknown, other: unknown): number =>
  JSON.stringify(one).localeCompare(JSON.stringify(other));

/** A ledger no other test uses. */
const newLedger = () => env.MODEL_LEDGER.getByName(crypto.randomUUID());

/** A micro a token, in and out, so a request's micros are its tokens. */
const price = {
  version: "test",
  input: 1_000_000,
  output: 1_000_000,
  cacheRead: 1_000_000,
  cacheWrite: 1_000_000,
};

const actor = { type: "person", userId: "ada" } as const;

/** A person's budget of `limit` micros, alerting at half of it. */
const budget = (limit: number, key = "ada"): LedgerScope => ({
  scope: "user",
  key,
  limitMicros: limit,
  alertMicros: limit / 2,
  names: { user: key },
});

/**
 * Ada's shares of the requests in flight, room enough that none fills in
 * these tests, for a call of its own (fair-model-admission.test.ts tests
 * the shares).
 */
const roomyFair = (): Admission["fair"] => ({
  place: crypto.randomUUID(),
  subject: "ada",
  resource: null,
  shares: {
    client: 1000,
    person: 1000,
    app: 1000,
    queuedPerPerson: 1000,
    queuedPerApp: 1000,
  },
});

/** How long after its deadline the gateway has a request come due (models.ts). */
const graceMs = 5 * 60_000;

/**
 * A request of `reservedMicros`, due in an hour unless `more` says when,
 * its deadline the gateway's grace before that.
 */
const admission = (
  reservedMicros: number,
  scopes: LedgerScope[] = [budget(100)],
  more: Partial<Admission> = {}
): Admission => {
  const reconcileAt = more.reconcileAt ?? Date.now() + 60 * 60_000;
  return {
    id: crypto.randomUUID(),
    period: "2400-01",
    scopes,
    model: "mistral/test",
    price,
    reservedMicros,
    actor,
    deadline: reconcileAt - graceMs,
    fair: roomyFair(),
    ...more,
    reconcileAt,
  };
};

/** Overwrites `column` of the requests `ids`, as another release might have stored them. */
const corrupt = async (
  ledger: ReturnType<typeof newLedger>,
  column: "scopes" | "actor" | "prices",
  value: string,
  ...ids: string[]
): Promise<void> => {
  await runInDurableObject(ledger, (_instance, state) => {
    for (const id of ids) {
      state.storage.sql.exec(
        `UPDATE requests SET ${column} = ? WHERE id = ?`,
        value,
        id
      );
    }
  });
};

/**
 * Points request `id`'s recorded scopes at a person with no spend, as a
 * release that stored them otherwise might have: every charge of it
 * throws.
 */
const strayed = async (
  ledger: ReturnType<typeof newLedger>,
  id: string
): Promise<void> => {
  await runInDurableObject(ledger, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE request_scopes SET key = 'nobody' WHERE request_id = ?",
      id
    );
  });
};

/** The ledger's requests, most reserved first. */
const rowsOf = async (ledger: ReturnType<typeof newLedger>) =>
  await runInDurableObject(ledger, (_instance, state) =>
    state.storage.sql
      .exec<{ id: string; state: string; reconcileAt: number }>(
        "SELECT id, state, reconcile_at AS reconcileAt FROM requests ORDER BY reserved_micros DESC"
      )
      .toArray()
  );

/** What `key`'s user scope spent and holds in 2400-01. */
const spendOf = async (ledger: ReturnType<typeof newLedger>, key = "ada") => {
  const read = await ledger.spendOf("2400-01", ["user"], 10);
  return read.user?.find((row) => row.key === key);
};

describe("the model ledger", () => {
  it("releases exactly what a request reserved on each scope, as recorded when admitted, whatever rule it settles under", async () => {
    const ledger = newLedger();
    const platform: LedgerScope = {
      scope: "platform",
      key: "platform",
      limitMicros: null,
      alertMicros: null,
      names: {},
    };
    const route = {
      transport: "connect",
      provider: "openai",
      region: "eu",
      credential: "platform",
      feature: "conversion",
    } as const;
    const now = admission(50, [platform, lineageOf("root")], { route });
    await ledger.admit(now);
    const used = { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 };

    await ledger.settle(now.id, { by: "usage", tokens: used });

    const run = await ledger.spendOf("2400-01", ["run"], 10);
    const grasp = await ledger.spendOf("2400-01", ["platform"], 10);
    expect({
      // Nothing left held on the run, and none of Grasp's money spent there.
      run: run.run?.map(({ spentMicros, reservedMicros }) => ({
        spentMicros,
        reservedMicros,
      })),
      grasp: grasp.platform?.map(({ spentMicros, reservedMicros }) => ({
        spentMicros,
        reservedMicros,
      })),
    }).toStrictEqual({
      run: [{ spentMicros: 0, reservedMicros: 0 }],
      grasp: [{ spentMicros: 30, reservedMicros: 0 }],
    });
  });

  it("sums what Grasp's own features cost by an index of its requests' months, never a scan of every request kept", async () => {
    const ledger = newLedger();

    const plan = await runInDurableObject(ledger, async (instance, state) => {
      const exec = vi.spyOn(state.storage.sql, "exec");
      await instance.platformSpend(["2400-01", "2399-12"]);
      const [query = "", ...rest] = exec.mock.calls.at(-1) ?? [];
      const values: unknown[] = rest;
      exec.mockRestore();
      return state.storage.sql
        .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...values)
        .toArray()
        .map(({ detail }) => detail);
    });

    expect({
      scansRequests: plan.some((step) => /^SCAN requests\b/u.test(step)),
      byIndex: plan.some((step) =>
        step.includes("USING INDEX requests_credential_period")
      ),
    }).toStrictEqual({ scansRequests: false, byIndex: true });
  });

  it("admits concurrent requests only while their reservations fit every scope together, and refuses the rest whole", async () => {
    const ledger = newLedger();
    const team = {
      scope: "deployment",
      key: "deployment",
      limitMicros: 1000,
      alertMicros: null,
      names: {},
    } as const;

    const reconcileAt = Date.now() + 60 * 60_000;

    const admitted = await Promise.all(
      Array.from(
        { length: 10 },
        async () =>
          await ledger.admit(
            admission(30, [team, budget(100)], { reconcileAt })
          )
      )
    );

    // The person's $100 micros fit three; the deployment had room for all.
    // The three hold it while under way: room is hoped back by their
    // deadline.
    expect(admitted.filter(({ ok }) => ok)).toHaveLength(3);
    expect(admitted.filter(({ ok }) => !ok)).toStrictEqual(
      Array.from({ length: 7 }, () => ({
        ok: false,
        scope: "user",
        heldBy: ["user"],
        heldUntil: reconcileAt - graceMs,
      }))
    );
    // Refused whole: the deployment holds only what the admitted reserved.
    const read = await ledger.spendOf("2400-01", ["deployment", "user"], 10);
    expect(read).toStrictEqual({
      deployment: [{ key: "deployment", spentMicros: 0, reservedMicros: 90 }],
      user: [{ key: "ada", spentMicros: 0, reservedMicros: 90 }],
    });
  });

  it("counts a run lineage's requests and spend across months, and gives back the count of a request never sent", async () => {
    const ledger = newLedger();
    const lineage = {
      scope: "run",
      key: "root",
      limitMicros: 100,
      alertMicros: null,
      limitRequests: 2,
      names: { run: "root" },
    } as const;
    const first = admission(10, [lineage]);
    const unsent = admission(10, [lineage], { period: "2400-02" });

    const counted = [
      await ledger.admit(first),
      await ledger.admit(unsent),
      // Two requests made: none left, in any month.
      await ledger.admit(admission(10, [lineage], { period: "2400-03" })),
    ];
    await ledger.settle(unsent.id, { by: "unsent" });
    const afterUnsent = await ledger.admit(
      admission(10, [lineage], { period: "2400-04" })
    );
    await ledger.settle(first.id, {
      by: "usage",
      tokens: { input: 60, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    // Months on, its spend holds: 60 of 100 micros spent, 10 held.
    const roomless = await ledger.admit(
      admission(50, [{ ...lineage, key: "root", limitRequests: 5 }], {
        period: "2400-05",
      })
    );

    expect({ counted, afterUnsent, roomless }).toStrictEqual({
      counted: [
        { ok: true },
        { ok: true },
        { ok: false, scope: "run", requests: true },
      ],
      afterUnsent: { ok: true },
      roomless: { ok: false, scope: "run" },
    });
  });

  it("charges what a request used at its pinned prices, once, however often it is settled", async () => {
    const ledger = newLedger();
    const request = admission(80, [budget(1000)], {
      price: { ...price, output: 2_000_000, version: "pinned" },
    });
    await expect(ledger.admit(request)).resolves.toStrictEqual({ ok: true });

    const tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
    await expect(
      ledger.settle(request.id, { by: "usage", tokens })
    ).resolves.toStrictEqual({ state: "settled", chargedMicros: 20 });
    // A second settlement, of any kind, answers the first.
    await expect(
      ledger.settle(request.id, { by: "refused" })
    ).resolves.toStrictEqual({ state: "settled", chargedMicros: 20 });
    await expect(
      ledger.settle(request.id, {
        by: "usage",
        tokens: { ...tokens, input: 900 },
      })
    ).resolves.toStrictEqual({ state: "settled", chargedMicros: 20 });
    await expect(spendOf(ledger)).resolves.toStrictEqual({
      key: "ada",
      spentMicros: 20,
      reservedMicros: 0,
    });
  });

  it("answers an admission repeated after its answer was lost without reserving twice, and refuses its ID for another request", async () => {
    const ledger = newLedger();
    const request = admission(40);

    await expect(ledger.admit(request)).resolves.toStrictEqual({ ok: true });
    await expect(ledger.admit(request)).resolves.toStrictEqual({ ok: true });
    await expect(
      ledger.admit({ ...request, reservedMicros: 1 })
    ).resolves.toStrictEqual({ ok: false, reused: true });
    await expect(spendOf(ledger)).resolves.toMatchObject({
      reservedMicros: 40,
    });
  });

  it("releases a request the provider refused or that was never sent, and nothing else", async () => {
    const ledger = newLedger();
    const [refused, unsent, unknown] = [
      admission(30),
      admission(30),
      admission(30),
    ];
    for (const request of [refused, unsent, unknown]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit(request);
    }

    await expect(
      Promise.all([
        ledger.settle(refused.id, { by: "refused" }),
        ledger.settle(unsent.id, { by: "unsent" }),
        ledger.settle(unknown.id, { by: "unknown" }),
        ledger.settle(crypto.randomUUID(), { by: "unsent" }),
      ])
    ).resolves.toStrictEqual([
      { state: "settled", chargedMicros: 0 },
      { state: "settled", chargedMicros: 0 },
      { state: "unknown" },
      { state: "missing" },
    ]);
    // The unknown one stays held in full: no room for a fourth of 80.
    await expect(spendOf(ledger)).resolves.toMatchObject({
      spentMicros: 0,
      reservedMicros: 30,
    });
    await expect(ledger.admit(admission(80))).resolves.toStrictEqual({
      ok: false,
      scope: "user",
    });
  });

  it("charges in full each reservation that came due unsettled or with its usage lost, on its alarm, and audits each", async () => {
    const ledger = newLedger();
    // Due in a moment: once both were admitted and one settled as lost.
    const soon = Date.now() + 1000;
    // One whose gateway died before settling it, one whose usage was lost,
    // and one not yet due.
    const [abandoned, lost, later] = [
      admission(30, [budget(1000, "ben")], { reconcileAt: soon }),
      admission(20, [budget(1000, "ben")], { reconcileAt: soon }),
      admission(10, [budget(1000, "ben")]),
    ];
    for (const request of [abandoned, lost, later]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit(request);
    }
    await ledger.settle(lost.id, { by: "unknown" });

    await scheduler.wait(soon - Date.now() + 100);
    // Its alarm has gone, or goes now.
    await runDurableObjectAlarm(ledger);
    await expect(spendOf(ledger, "ben")).resolves.toStrictEqual({
      key: "ben",
      spentMicros: 50,
      reservedMicros: 10,
    });
    // A late usage report can't lower what reconciliation charged.
    await expect(
      ledger.settle(lost.id, {
        by: "usage",
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      })
    ).resolves.toStrictEqual({ state: "settled", chargedMicros: 20 });
    const events = await allEvents();
    const reconciled = events.filter(
      ({ action, detail }) =>
        action === "model.spend.reconciled" &&
        [abandoned.id, lost.id].includes(String(detail.request))
    );
    expect(
      reconciled
        .map(({ detail }) => [detail.request, detail.lost, detail.charged])
        .toSorted((one, other) => Number(one[2]) - Number(other[2]))
    ).toStrictEqual([
      [lost.id, "usage", 0.00002],
      [abandoned.id, "settlement", 0.00003],
    ]);
  });

  it("lets only reconciliation close a request whose usage was lost, and answers a replayed admission only while its request is open", async () => {
    const ledger = newLedger();
    const lost = admission(30);
    const settled = admission(20);
    await ledger.admit(lost);
    await ledger.admit(settled);
    await ledger.settle(lost.id, { by: "unknown" });
    await ledger.settle(settled.id, { by: "refused" });

    await expect(
      Promise.all([
        ledger.settle(lost.id, {
          by: "usage",
          tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
        ledger.settle(lost.id, { by: "refused" }),
        ledger.settle(lost.id, { by: "unsent" }),
      ])
    ).resolves.toStrictEqual([
      { state: "unknown" },
      { state: "unknown" },
      { state: "unknown" },
    ]);
    await expect(
      Promise.all([ledger.admit(lost), ledger.admit(settled)])
    ).resolves.toStrictEqual([
      { ok: false, reused: true },
      { ok: false, reused: true },
    ]);
    await expect(spendOf(ledger)).resolves.toMatchObject({
      spentMicros: 0,
      reservedMicros: 30,
    });
  });

  it("refuses a request with no price against a budget, and counts it where nothing limits it", async () => {
    const ledger = newLedger();
    const free = { ...price, input: 0, output: 0, version: "free" };
    const counted = {
      scope: "deployment",
      key: "deployment",
      limitMicros: null,
      alertMicros: null,
      names: {},
    } as const;

    await expect(
      Promise.all([
        ledger.admit(admission(0, [budget(100)], { price: free })),
        ledger.admit(
          admission(0, [budget(100)], { price: { ...price, output: 0 } })
        ),
        ledger.admit(admission(0, [counted], { price: free })),
      ])
    ).resolves.toStrictEqual([
      { ok: false, unpriced: true },
      { ok: false, unpriced: true },
      { ok: true },
    ]);
  });

  it("quarantines a request whose scopes can't be read, audited and still held, and reconciles the rest", async () => {
    const ledger = newLedger();
    const soon = Date.now() + 1000;
    const [broken, stray, nameless, fine, settling] = [
      admission(30, [budget(1000, "dan")], { reconcileAt: soon }),
      admission(25, [budget(1000, "dan")], { reconcileAt: soon }),
      admission(15, [budget(1000, "dan")], { reconcileAt: soon }),
      admission(20, [budget(1000, "dan")], { reconcileAt: soon }),
      admission(5, [budget(1000, "dan")]),
    ];
    for (const request of [broken, stray, nameless, fine, settling]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit(request);
    }
    // Rows written by a release that stored them otherwise: scopes that
    // aren't JSON, a scope with no spend to settle against, and an actor
    // that isn't one.
    await corrupt(ledger, "scopes", "not JSON", broken.id, settling.id);
    await strayed(ledger, stray.id);
    await corrupt(ledger, "actor", "not JSON", nameless.id);
    await expect(
      ledger.settle(settling.id, { by: "refused" })
    ).resolves.toStrictEqual({ state: "quarantined" });

    await scheduler.wait(soon - Date.now() + 100);
    await runDurableObjectAlarm(ledger);
    const rows = await rowsOf(ledger);
    const events = await allEvents();
    expect({
      states: rows.map(({ id, state }) => [id, state]),
      // Set aside for now, not quarantined: its scopes can be read.
      strayLater:
        (rows.find(({ id }) => id === stray.id)?.reconcileAt ?? 0) > soon,
      dan: await spendOf(ledger, "dan"),
      quarantined: events
        .filter(({ action }) => action === "model.spend.quarantined")
        .map(({ detail }) => detail.request)
        .filter((id) => id === broken.id || id === settling.id)
        .toSorted(byJson),
      // Reconciled all the same, in the system's name.
      nameless: events.find(
        ({ action, detail }) =>
          action === "model.spend.reconciled" && detail.request === nameless.id
      )?.actor,
    }).toStrictEqual({
      states: [
        [broken.id, "quarantined"],
        [stray.id, "dispatched"],
        [fine.id, "settled"],
        [nameless.id, "settled"],
        [settling.id, "quarantined"],
      ],
      strayLater: true,
      // Their reservations stay held: what they hold can't be told.
      dan: { key: "dan", spentMicros: 35, reservedMicros: 30 + 25 + 5 },
      quarantined: [broken.id, settling.id].toSorted(byJson),
      nameless: { type: "system" },
    });
  });

  it("charges in full a request whose prices can't be read, and needs none to release one", async () => {
    const ledger = newLedger();
    const [used, refused] = [
      admission(30, [budget(1000, "eve")]),
      admission(20, [budget(1000, "eve")]),
    ];
    await ledger.admit(used);
    await ledger.admit(refused);
    await corrupt(ledger, "prices", "not JSON", used.id, refused.id);

    await expect(
      Promise.all([
        ledger.settle(used.id, {
          by: "usage",
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        }),
        ledger.settle(refused.id, { by: "refused" }),
      ])
    ).resolves.toStrictEqual([
      { state: "settled", chargedMicros: 30 },
      { state: "settled", chargedMicros: 0 },
    ]);
    await expect(spendOf(ledger, "eve")).resolves.toStrictEqual({
      key: "eve",
      spentMicros: 30,
      reservedMicros: 0,
    });
  });

  it("delivers a quarantine's audit event at once, not only when an alert comes with it", async () => {
    const ledger = newLedger();
    const broken = admission(10, [budget(1000, "jo")]);
    await ledger.admit(broken);
    await corrupt(ledger, "scopes", "not JSON", broken.id);

    await ledger.settle(broken.id, { by: "refused" });
    // No alarm runs: the event reaches the log from the settlement itself.
    let delivered = false;
    for (let tries = 0; tries < 20 && !delivered; tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- waits for the background drain
      const events = await allEvents();
      delivered = events.some(
        ({ action, detail }) =>
          action === "model.spend.quarantined" && detail.request === broken.id
      );
      if (!delivered) {
        // oxlint-disable-next-line no-await-in-loop -- waits for the background drain
        await scheduler.wait(100);
      }
    }
    expect(delivered).toBeTruthy();
  });

  it("refuses an admission under an older quota policy than one it already admitted under, reserving and counting nothing", async () => {
    const ledger = newLedger();
    const run = lineageOf(`root-${crypto.randomUUID()}`);
    const newer = admission(10, [{ ...run, limitRequests: 2 }], {
      policyGeneration: 7,
    });
    // Read before generation 7 was recorded, with the limit it had then.
    const older = admission(10, [run], { policyGeneration: 6 });

    const admitted = [
      await ledger.admit(newer),
      await ledger.admit(older),
      // A request with no lineage carries no generation: never refused for it.
      await ledger.admit(
        admission(10, [budget(1000, `ivo-${crypto.randomUUID()}`)])
      ),
      await ledger.admit(
        admission(10, [{ ...run, limitRequests: 2 }], { policyGeneration: 7 })
      ),
      await ledger.admit(
        admission(10, [{ ...run, limitRequests: 2 }], { policyGeneration: 8 })
      ),
    ];
    const generations = await runInDurableObject(ledger, (_instance, state) =>
      state.storage.sql
        .exec<{ id: string; generation: number | null }>(
          "SELECT id, policy_generation AS generation FROM requests WHERE id IN (?, ?)",
          newer.id,
          older.id
        )
        .toArray()
    );
    const spent = await ledger.spendOf("2400-01", ["run"], 10);
    expect({
      admitted,
      lineage: spent.run,
      generations,
    }).toStrictEqual({
      admitted: [
        { ok: true },
        { ok: false, policyBehind: true, highest: 7 },
        { ok: true },
        { ok: true },
        // Two of its two requests made, under the newest policy too.
        { ok: false, scope: "run", requests: true },
      ],
      lineage: [{ key: run.key, spentMicros: 0, reservedMicros: 20 }],
      generations: [{ id: newer.id, generation: 7 }],
    });
  });

  it("refuses an admission with more scopes than the gateway counts, reserving nothing", async () => {
    const ledger = newLedger();
    const scopes: LedgerScope[] = [
      { ...budget(1000, "max"), scope: "deployment", key: "deployment" },
      { ...budget(1000, "max"), scope: "workflow", key: "flow" },
      budget(1000, "max"),
      { ...budget(1000, "max"), scope: "run", key: "run" },
      { ...budget(1000, "max"), scope: "binding", key: "binding" },
      { ...budget(1000, "max"), scope: "binding_day", key: "binding-day" },
    ];
    const fits = admission(10, scopes);
    const tooMany = admission(10, [...scopes, budget(1000, "nia")]);

    const refused = await ledger.admit(tooMany).then(
      () => "admitted",
      () => "refused"
    );
    const admitted = await ledger.admit(fits);
    expect({
      refused,
      admitted: admitted.ok,
      nia: await spendOf(ledger, "nia"),
    }).toStrictEqual({ refused: "refused", admitted: true, nia: undefined });
  });

  it("refuses an admission naming a person's limit itself, which only the ledger sets from what admins set", async () => {
    const ledger = newLedger();
    await ledger.setPersonLimit(
      { type: "person", userId: "ada" },
      { monthlyMicros: 10, messagesAnHour: null },
      null,
      actor
    );
    const ownLimit = admission(50, [
      budget(1000),
      {
        scope: "person",
        key: "ada",
        limitMicros: 1000,
        alertMicros: null,
        names: {},
      },
    ]);

    const refused = await ledger.admit(ownLimit).then(
      () => "admitted",
      () => "refused"
    );
    const held = await ledger.admit(
      admission(50, [budget(1000)], { person: { key: "ada", teams: [] } })
    );
    expect({ refused, held }).toStrictEqual({
      refused: "refused",
      held: { ok: false, scope: "person" },
    });
  });

  it("settles every scope a request reserved against, as its admission recorded them, even one its JSON leaves out, and holds one with no record", async () => {
    const ledger = newLedger();
    const key = `una-${crypto.randomUUID()}`;
    const workflow = {
      scope: "workflow",
      key: `flow-${crypto.randomUUID()}`,
      limitMicros: null,
      alertMicros: null,
      names: {},
    } as const;
    const left = admission(30, [budget(1000, key), workflow]);
    const unrecorded = admission(10, [budget(1000, key)]);
    await ledger.admit(left);
    await ledger.admit(unrecorded);
    // Its JSON lost the workflow, the record of the other is gone.
    await corrupt(
      ledger,
      "scopes",
      JSON.stringify([budget(1000, key)]),
      left.id
    );
    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM request_scopes WHERE request_id = ?",
        unrecorded.id
      );
    });
    const used = { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 };

    const settled = [
      await ledger.settle(left.id, { by: "usage", tokens: used }),
      await ledger.settle(unrecorded.id, { by: "usage", tokens: used }),
    ];
    const read = await ledger.spendOf("2400-01", ["user", "workflow"], 10);

    expect({ settled, user: read.user, workflow: read.workflow }).toStrictEqual(
      {
        settled: [
          { state: "settled", chargedMicros: 4 },
          { state: "quarantined" },
        ],
        // The unrecorded request still holds its 10.
        user: [{ key, spentMicros: 4, reservedMicros: 10 }],
        workflow: [{ key: workflow.key, spentMicros: 4, reservedMicros: 0 }],
      }
    );
  });

  it("quarantines a request that keeps failing to reconcile, after three tries, audited and held", async () => {
    const ledger = newLedger();
    const failing = admission(25, [budget(1000, "hal")], {
      reconcileAt: Date.now() + 1000,
    });
    await ledger.admit(failing);
    // Its scopes can be read, but name a scope with no spend to settle
    // against: every charge throws.
    await strayed(ledger, failing.id);
    const states: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // As if its next try came due.
      // oxlint-disable-next-line no-await-in-loop -- one try after another
      await runInDurableObject(ledger, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE requests SET reconcile_at = ? WHERE id = ?",
          Date.now() - 1,
          failing.id
        );
      });
      // oxlint-disable-next-line no-await-in-loop -- one try after another
      await runDurableObjectAlarm(ledger);
      // oxlint-disable-next-line no-await-in-loop -- one try after another
      const [row] = await rowsOf(ledger);
      states.push(row?.state ?? "gone");
    }
    await runDurableObjectAlarm(ledger);
    const events = await allEvents();

    expect({
      states,
      audited: events.some(
        ({ action, detail }) =>
          action === "model.spend.quarantined" && detail.request === failing.id
      ),
    }).toStrictEqual({
      states: ["dispatched", "dispatched", "quarantined"],
      audited: true,
    });
  });

  it("ends an alarm run when no request of a full page can make progress", async () => {
    const ledger = newLedger();
    const soon = Date.now() + 1000;
    const stuck = Array.from({ length: 100 }, () =>
      admission(1, [budget(1000, "ivy")], { reconcileAt: soon })
    );
    for (const request of stuck) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit(request);
    }
    // Every charge throws, and nothing about a request can be written:
    // no try can be counted or put off.
    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE requests SET scopes = ?",
        JSON.stringify([budget(1000, "nobody")])
      );
      state.storage.sql.exec(
        "CREATE TRIGGER stuck BEFORE UPDATE ON requests BEGIN SELECT RAISE(ABORT, 'stuck'); END"
      );
    });

    await scheduler.wait(soon - Date.now() + 100);
    const ran = await Promise.race([
      (async () => {
        await runDurableObjectAlarm(ledger);
        return "ended";
      })(),
      (async () => {
        await scheduler.wait(15_000);
        return "still running";
      })(),
    ]);
    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER stuck");
    });
    expect(ran).toBe("ended");
  });

  it("refuses a request whose tiers have no price against a budget", async () => {
    const ledger = newLedger();
    const { version: _version, ...rates } = price;
    const tier = { ...rates, inputTokensAbove: 100 };
    await expect(
      Promise.all([
        ledger.admit(
          admission(1, [budget(100)], {
            price: { ...price, tiers: [{ ...tier, output: 0 }] },
          })
        ),
        ledger.admit(
          admission(1, [budget(100)], {
            price: { ...price, tiers: [{ ...tier, input: 0 }] },
          })
        ),
        ledger.admit(
          admission(1, [budget(100)], { price: { ...price, tiers: [tier] } })
        ),
      ])
    ).resolves.toStrictEqual([
      { ok: false, unpriced: true },
      { ok: false, unpriced: true },
      { ok: true },
    ]);
  });

  it("alerts admins once per scope, month and threshold, however many requests reach it", async () => {
    const ledger = newLedger();
    const key = `cara-${crypto.randomUUID()}`;
    const requests = Array.from({ length: 4 }, () =>
      admission(10, [budget(40, key)])
    );
    for (const request of requests) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit(request);
    }
    await Promise.all(
      requests.map(
        async ({ id }) =>
          await ledger.settle(id, {
            by: "usage",
            tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
          })
      )
    );
    // A limit lowered below the spend alerts once more, at its own value.
    const lowered = { ...budget(30, key), alertMicros: 15 };
    await ledger.admit(admission(1, [lowered]));
    await ledger.admit(admission(1, [lowered]));
    // Its alarm delivers what its outbox holds.
    await runDurableObjectAlarm(ledger);

    const events = await allEvents();
    const alerts = events.filter(
      ({ action, detail }) =>
        action.startsWith("model.budget.") && detail.user === key
    );
    expect(
      alerts.map(({ action, detail }) => [action, detail.threshold])
    ).toStrictEqual([
      ["model.budget.alert", 0.00002],
      ["model.budget.exhausted", 0.00004],
      ["model.budget.alert", 0.000015],
      ["model.budget.exhausted", 0.00003],
    ]);
  });

  it("refuses as out of budget when any full scope has no room even once the requests under way finish, in whichever order the scopes come", async () => {
    const ledger = newLedger();
    const team: LedgerScope = {
      scope: "deployment",
      key: "deployment",
      limitMicros: 100,
      alertMicros: null,
      names: {},
    };
    // Ben's request is under way, holding 60 of the deployment's 100; Ada
    // spent 80 of her own 100.
    await ledger.admit(admission(60, [team, budget(1000, "ben")]));
    const spent = admission(80, [budget(100)]);
    await ledger.admit(spent);
    await ledger.settle(spent.id, {
      by: "usage",
      tokens: { input: 80, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    // 50 more: the deployment would have room once Ben's is in; Ada never.
    await expect(
      Promise.all([
        ledger.admit(admission(50, [team, budget(100)])),
        ledger.admit(admission(50, [budget(100), team])),
      ])
    ).resolves.toStrictEqual([
      { ok: false, scope: "user" },
      { ok: false, scope: "user" },
    ]);
  });

  it("counts as spent what a request holds past its deadline, in the grace before it comes due, and what a quarantined one holds", async () => {
    const ledger = newLedger();
    // Past its deadline, not yet due: cut off, so charged in full when due.
    const late = admission(60, [budget(100, "cy")], {
      deadline: Date.now() - 1000,
      reconcileAt: Date.now() + graceMs,
    });
    // Its scopes can't be read once it settles: held for a person.
    const held = admission(60, [budget(100, "di")]);
    await ledger.admit(late);
    await ledger.admit(held);
    await corrupt(ledger, "scopes", "not json", held.id);
    await expect(
      ledger.settle(held.id, {
        by: "usage",
        tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      })
    ).resolves.toStrictEqual({ state: "quarantined" });

    await expect(
      Promise.all([
        ledger.admit(admission(50, [budget(100, "cy")])),
        ledger.admit(admission(50, [budget(100, "di")])),
      ])
    ).resolves.toStrictEqual([
      { ok: false, scope: "user" },
      { ok: false, scope: "user" },
    ]);
  });

  it("hopes room back across several full scopes by the latest of each scope's soonest deadline", async () => {
    const ledger = newLedger();
    const team: LedgerScope = {
      scope: "deployment",
      key: "deployment",
      limitMicros: 100,
      alertMicros: null,
      names: {},
    };
    const now = Date.now();
    const at = (minutes: number) => ({
      reconcileAt: now + minutes * 60_000 + graceMs,
    });
    // The deployment's room is held by two of Ben's, the soonest in 10
    // minutes; Ada's by one of hers in 20.
    await ledger.admit(admission(40, [team, budget(1000, "ben")], at(10)));
    await ledger.admit(admission(40, [team, budget(1000, "ben")], at(30)));
    await ledger.admit(admission(60, [budget(100)], at(20)));

    await expect(
      ledger.admit(admission(50, [team, budget(100)]))
    ).resolves.toStrictEqual({
      ok: false,
      scope: "deployment",
      heldBy: ["deployment", "user"],
      heldUntil: now + 20 * 60_000,
    });
  });
});
