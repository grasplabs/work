import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Admission, LedgerScope } from "../src/model-ledger.ts";
import { allEvents } from "./audit-events.ts";

// The model ledger on its own, through its Durable Object's RPC: what
// the gateway (models.ts) relies on when a request is admitted, settled,
// lost or repeated. Each test has a ledger of its own.

/** A run lineage's scope, by its root run. */
const lineageOf = (root: string, limitRequests = 100): LedgerScope => ({
  scope: "run",
  key: root,
  limitRequests,
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

/** A person's scope. */
const person = (key = "ada"): LedgerScope => ({ scope: "user", key });

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
 * A request that can cost at most `reservedMicros`, due in an hour unless
 * `more` says when, its deadline the gateway's grace before that.
 */
const admission = (
  reservedMicros: number,
  scopes: LedgerScope[] = [person()],
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

/** Makes every change to the ledger's spend fail, as a broken store would. */
const breakSpend = async (
  ledger: ReturnType<typeof newLedger>
): Promise<void> => {
  await runInDurableObject(ledger, (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER broken_spend BEFORE UPDATE ON spend BEGIN SELECT RAISE(ABORT, 'broken'); END"
    );
  });
};

/** The ledger's requests, most costly first. */
const rowsOf = async (ledger: ReturnType<typeof newLedger>) =>
  await runInDurableObject(ledger, (_instance, state) =>
    state.storage.sql
      .exec<{ id: string; state: string; reconcileAt: number }>(
        "SELECT id, state, reconcile_at AS reconcileAt FROM requests ORDER BY reserved_micros DESC"
      )
      .toArray()
  );

/** What `key`'s user scope spent in 2400-01. */
const spendOf = async (ledger: ReturnType<typeof newLedger>, key = "ada") => {
  const read = await ledger.spendOf("2400-01", ["user"], 10);
  return read.user?.find((row) => row.key === key);
};

describe("the model ledger", () => {
  it("counts a request on Grasp's key as Grasp's money, and only as a request of the run it is made in", async () => {
    const ledger = newLedger();
    const route = {
      transport: "connect",
      provider: "openai",
      region: "eu",
      credential: "platform",
      feature: "conversion",
    } as const;
    const now = admission(
      50,
      [{ scope: "platform", key: "platform" }, lineageOf("root")],
      { route }
    );
    await ledger.admit(now);
    const used = { input: 30, output: 0, cacheRead: 0, cacheWrite: 0 };

    await ledger.settle(now.id, { by: "usage", tokens: used });

    const read = await ledger.spendOf("2400-01", ["run", "platform"], 10);
    expect(read).toStrictEqual({
      run: [{ key: "root", spentMicros: 0 }],
      platform: [{ key: "platform", spentMicros: 30 }],
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

  it("admits concurrent requests however much they could cost, counting each in every scope", async () => {
    const ledger = newLedger();
    const deployment = { scope: "deployment", key: "deployment" } as const;

    const admitted = await Promise.all(
      Array.from(
        { length: 10 },
        async () =>
          await ledger.admit(admission(1_000_000, [deployment, person()]))
      )
    );

    expect(admitted.filter(({ ok }) => ok)).toHaveLength(10);
  });

  it("counts a run lineage's requests across months, and gives back the count of a request never sent", async () => {
    const ledger = newLedger();
    const lineage = lineageOf("root", 2);
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
    // Months on, its spend is the lineage's whole life's.
    const read = await ledger.spendOf("2400-05", ["run"], 10);

    expect({ counted, afterUnsent, run: read.run }).toStrictEqual({
      counted: [
        { ok: true },
        { ok: true },
        { ok: false, scope: "run", requests: true },
      ],
      afterUnsent: { ok: true },
      run: [{ key: "root", spentMicros: 60 }],
    });
  });

  it("charges what a request used at its pinned prices, once, however often it is settled", async () => {
    const ledger = newLedger();
    const request = admission(80, [person()], {
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
    });
  });

  it("answers an admission repeated after its answer was lost without counting it twice, and refuses its ID for another request", async () => {
    const ledger = newLedger();
    const lineage = lineageOf("root", 2);
    const request = admission(40, [lineage]);

    const answers = [
      await ledger.admit(request),
      await ledger.admit(request),
      await ledger.admit({ ...request, reservedMicros: 1 }),
      // Counted once: the lineage has one request left.
      await ledger.admit(admission(40, [lineage])),
      await ledger.admit(admission(40, [lineage])),
    ];
    expect(answers).toStrictEqual([
      { ok: true },
      { ok: true },
      { ok: false, reused: true },
      { ok: true },
      { ok: false, scope: "run", requests: true },
    ]);
  });

  it("charges nothing for a request the provider refused or that was never sent, and leaves one whose usage was lost to reconciliation", async () => {
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
    await expect(spendOf(ledger)).resolves.toMatchObject({ spentMicros: 0 });
  });

  it("charges the most it can cost each request that came due unsettled or with its usage lost, on its alarm, and audits each", async () => {
    const ledger = newLedger();
    // Due in a moment: once both were admitted and one settled as lost.
    const soon = Date.now() + 1000;
    // One whose gateway died before settling it, one whose usage was lost,
    // and one not yet due.
    const [abandoned, lost, later] = [
      admission(30, [person("ben")], { reconcileAt: soon }),
      admission(20, [person("ben")], { reconcileAt: soon }),
      admission(10, [person("ben")]),
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
    await expect(spendOf(ledger)).resolves.toMatchObject({ spentMicros: 0 });
  });

  it("admits a request with no price, and charges it nothing", async () => {
    const ledger = newLedger();
    const free = { ...price, input: 0, output: 0, version: "free" };
    const request = admission(0, [person("fay")], { price: free });

    const admitted = await ledger.admit(request);
    const settled = await ledger.settle(request.id, {
      by: "usage",
      tokens: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
    });

    expect({ admitted, settled }).toStrictEqual({
      admitted: { ok: true },
      settled: { state: "settled", chargedMicros: 0 },
    });
  });

  it("quarantines a request whose scopes can't be read, audited and charged nothing, and reconciles the rest", async () => {
    const ledger = newLedger();
    const soon = Date.now() + 1000;
    const [broken, nameless, fine, settling] = [
      admission(30, [person("dan")], { reconcileAt: soon }),
      admission(15, [person("dan")], { reconcileAt: soon }),
      admission(20, [person("dan")], { reconcileAt: soon }),
      admission(5, [person("dan")]),
    ];
    for (const request of [broken, nameless, fine, settling]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit(request);
    }
    // Rows written by a release that stored them otherwise: scopes that
    // aren't JSON, and an actor that isn't one.
    await corrupt(ledger, "scopes", "not JSON", broken.id, settling.id);
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
      dan: await spendOf(ledger, "dan"),
      quarantined: events
        .filter(({ action }) => action === "model.spend.quarantined")
        .filter(
          ({ detail }) =>
            detail.request === broken.id || detail.request === settling.id
        )
        .map(({ detail }) => detail)
        .toSorted(byJson),
      // Reconciled all the same, in the system's name.
      nameless: events.find(
        ({ action, detail }) =>
          action === "model.spend.reconciled" && detail.request === nameless.id
      )?.actor,
    }).toStrictEqual({
      states: [
        [broken.id, "quarantined"],
        [fine.id, "settled"],
        [nameless.id, "settled"],
        [settling.id, "quarantined"],
      ],
      dan: { key: "dan", spentMicros: 35 },
      quarantined: [broken.id, settling.id]
        .map((request) => ({
          request,
          model: "mistral/test",
          period: "2400-01",
        }))
        .toSorted(byJson),
      nameless: { type: "system" },
    });
  });

  it("charges the most it can cost a request whose prices can't be read, and needs none to settle a refused one", async () => {
    const ledger = newLedger();
    const [used, refused] = [
      admission(30, [person("eve")]),
      admission(20, [person("eve")]),
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
    });
  });

  it("delivers a quarantine's audit event at once, from the settlement itself", async () => {
    const ledger = newLedger();
    const broken = admission(10, [person("jo")]);
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

  it("refuses an admission with more scopes than the gateway counts, counting nothing", async () => {
    const ledger = newLedger();
    const scopes: LedgerScope[] = [
      { scope: "deployment", key: "deployment" },
      { scope: "workflow", key: "flow" },
      person("max"),
      lineageOf("run"),
      { scope: "binding", key: "binding" },
    ];
    const fits = admission(10, scopes);
    const tooMany = admission(10, [...scopes, person("nia")]);

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

  it("quarantines a request that keeps failing to reconcile, after three tries, audited", async () => {
    const ledger = newLedger();
    const failing = admission(25, [person("hal")], {
      reconcileAt: Date.now() + 1000,
    });
    await ledger.admit(failing);
    // Its scopes can be read, but its spend can't be written: every
    // charge throws.
    await breakSpend(ledger);
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
      admission(1, [person("ivy")], { reconcileAt: soon })
    );
    for (const request of stuck) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit(request);
    }
    // Every charge throws, and nothing about a request can be written:
    // no try can be counted or put off.
    await breakSpend(ledger);
    await runInDurableObject(ledger, (_instance, state) => {
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
});
