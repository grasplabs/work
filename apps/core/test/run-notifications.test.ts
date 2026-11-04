import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { refusal, signedInApi } from "./sign-in.ts";

// A failed run tells the person it acted for, in the product. The ways it
// can fail come first: someone else is told of it, or nobody is; a
// workflow failing every minute buries the person in notifications; a
// notification outlives the person's access to its App, or is made for
// someone no longer in the organization; it goes
// unrecorded; the list reads the whole table.

const idp = mockIdp();

/** Signing people in and running workflows can be slow on CI. */
const slow = { timeout: 60_000 };

describe("failed runs", slow, () => {
  it("refuse marking read what no list showed", async () => {
    const owner = await signedInApi(idp, "builder");
    await expect(
      Promise.all([
        refusal(owner.api.notifications.markRead([], "yesterday")),
        refusal(
          owner.api.notifications.markRead(
            Array.from({ length: 51 }, () => crypto.randomUUID()),
            new Date().toISOString()
          )
        ),
      ])
    ).resolves.toMatchObject([
      { code: "notification.invalid" },
      { code: "notification.invalid" },
    ]);
  });

  it("are listed and read by the person's own index, with no sort of their own", async () => {
    const owner = await signedInApi(idp, "builder");
    const queries = await recordedQueries(async () => {
      await owner.api.notifications.list();
      await owner.api.notifications.list({
        at: new Date().toISOString(),
        id: crypto.randomUUID(),
      });
      await owner.api.notifications.markRead(
        [crypto.randomUUID()],
        new Date().toISOString()
      );
    });
    const plans = await Promise.all(
      queries
        .filter(({ query }) => query.includes('"notifications"'))
        .map(async (recorded) => await planOf(recorded))
    );

    expect({
      lists: plans.length,
      byIndex: plans.map((plan) =>
        plan.some((step) => /SEARCH notifications USING/u.test(step))
      ),
      scans: plans.flat().filter((step) => fullScan.test(step)),
      sorts: plans.flat().filter((step) => step.includes("TEMP B-TREE")),
    }).toStrictEqual({
      // A page, its unread count, an older page and its count, marking
      // read and dropping old ones.
      lists: 6,
      byIndex: [true, true, true, true, true, true],
      scans: [],
      sorts: [],
    });
  });
});
