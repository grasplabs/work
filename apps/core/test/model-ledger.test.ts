import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Admission, LedgerScope } from "../src/model-ledger.ts";
import { allEvents } from "./audit-events.ts";

// The model ledger on its own, through its Durable Object's RPC: what
// the gateway (models.ts) relies on when a request is admitted, settled,
// lost or repeated. Each test has a ledger of its own.

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

const admission = (
  reservedMicros: number,
  scopes: LedgerScope[] = [budget(100)],
  more: Partial<Admission> = {}
): Admission => ({
  id: crypto.randomUUID(),
  period: "2400-01",
  scopes,
  model: "workers-ai/test",
  price,
  reservedMicros,
  actor,
  reconcileAt: Date.now() + 60 * 60_000,
  ...more,
});

/** What `key`'s user scope spent and holds in 2400-01. */
const spendOf = async (ledger: ReturnType<typeof newLedger>, key = "ada") => {
  const read = await ledger.spendOf("2400-01", ["user"], 10);
  return read.user?.find((row) => row.key === key);
};

describe("the model ledger", () => {
  it("admits concurrent requests only while their reservations fit every scope together, and refuses the rest whole", async () => {
    const ledger = newLedger();
    const team = {
      scope: "deployment",
      key: "deployment",
      limitMicros: 1000,
      alertMicros: null,
      names: {},
    } as const;

    const admitted = await Promise.all(
      Array.from(
        { length: 10 },
        async () => await ledger.admit(admission(30, [team, budget(100)]))
      )
    );

    // The person's $100 micros fit three; the deployment had room for all.
    expect(admitted.filter(({ ok }) => ok)).toHaveLength(3);
    expect(admitted.filter(({ ok }) => !ok)).toStrictEqual(
      Array.from({ length: 7 }, () => ({ ok: false, scope: "user" }))
    );
    // Refused whole: the deployment holds only what the admitted reserved.
    const read = await ledger.spendOf("2400-01", ["deployment", "user"], 10);
    expect(read).toStrictEqual({
      deployment: [{ key: "deployment", spentMicros: 0, reservedMicros: 90 }],
      user: [{ key: "ada", spentMicros: 0, reservedMicros: 90 }],
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
});
