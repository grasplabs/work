import type { WorkOverview } from "@grasp-os/brain-next/contract";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  alarmHostOf,
  brainStaffReport,
  erasePerson,
} from "../src/brain-next.ts";
import { inJurisdiction } from "../src/durable-objects.ts";

// Staff's totals of people's own stores tell nobody apart. A file of its
// own: the totals are sums over every person's store, so in a file whose
// other tests leave stores with work waiting, a store's alarm reporting
// between two reads here changes them, whoever holds what.

/** Reports `overview` as `person`'s own store's alarm does when its tick ends. */
const reportAs = async (
  person: string,
  overview: WorkOverview
): Promise<void> => {
  const host = await alarmHostOf(env, `person:${person}`);
  await host.report(overview);
};

/** Staff's totals of people's own stores. */
const ownTotals = async () => {
  const { ownStores } = await brainStaffReport(env);
  return ownStores;
};

describe("staff's totals of people's own stores", () => {
  it("tells staff the same totals of people's own stores whoever of them holds what", async () => {
    const [first, second] = [
      `person-${crypto.randomUUID()}`,
      `person-${crypto.randomUUID()}`,
    ];
    // An overview as a store that holds something reports it, with
    // `waiting` items and `parked` (one holding nothing has no row).
    const base = await inJurisdiction(env, env.BRAIN_STORE)
      .getByName(`person:${first}`)
      .workOverview();
    const holding = (waiting: number, parked: number) => ({
      ...base,
      holding: true,
      waiting:
        waiting === 0
          ? []
          : [
              {
                kind: "embed",
                count: waiting,
                oldestAddedAt: new Date(1_000_000),
              },
            ],
      parkedCount: parked,
    });
    const before = await ownTotals();
    await reportAs(first, holding(5, 2));
    await reportAs(second, holding(0, 0));
    const oneHoldsAll = await ownTotals();
    await reportAs(first, holding(0, 0));
    await reportAs(second, holding(5, 2));
    const theOtherHoldsAll = await ownTotals();
    for (const person of [first, second]) {
      // oxlint-disable-next-line no-await-in-loop -- one person at a time
      await erasePerson(env, { personId: person, reason: "person_erased" });
    }

    expect({
      added: {
        stores: oneHoldsAll.stores - before.stores,
        waiting: oneHoldsAll.waiting - before.waiting,
        parked: oneHoldsAll.parked - before.parked,
      },
      same: theOtherHoldsAll,
    }).toStrictEqual({
      added: { stores: 2, waiting: 5, parked: 2 },
      same: oneHoldsAll,
    });
  });
});
