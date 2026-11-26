import { describe, expect, it } from "vite-plus/test";

import { readOrganization } from "../src/admin/org-loads.ts";
import { orgReads } from "../src/admin/org-reads.ts";
import type { AnsweredAdmin, OrgRead } from "../src/admin/org-reads.ts";
import type { ClientAdmin } from "../src/clients/admin.ts";
import type { GridRow } from "../src/clients/grid.ts";
import { emptyAdminSnapshot } from "./snapshots.ts";

const client: GridRow = {
  id: "acme",
  name: "Acme",
  status: "active",
  channel: "stable",
  hostname: "acme.grasp.test",
  release: null,
  pinnedReleaseId: null,
  lastDeploy: null,
  setup: null,
  rollout: { failed: null, behind: 0, channelStopped: null },
};

/** Acme's core answering, `agoMs` ago. */
const answered = (agoMs: number): AnsweredAdmin => ({
  client,
  state: "answered",
  snapshot: emptyAdminSnapshot("Acme"),
  at: new Date(Date.now() - agoMs).toISOString(),
  billing: { state: "not_linked" },
  crm: { state: "not_linked" },
});

/** Lets everything already started run as far as it can. */
const aTurn = async (): Promise<void> => {
  // A task runs only once every microtask queued before it has: by then
  // the page, which awaits nothing else, has decided.
  // oxlint-disable-next-line promise/avoid-new -- setTimeout has no promise form here
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

const timedOut: ClientAdmin = {
  client,
  state: "unreachable",
  lastAnsweredAt: null,
  error: "timeout",
};

/**
 * Acme's page as `reads` has it, come to (`onIt` false) or loaded again
 * while the tab shows it.
 */
const opened = async (
  reads: ReturnType<typeof orgReads>,
  onIt: boolean
): Promise<OrgRead | undefined> => {
  const { read } = await readOrganization({
    reads,
    client,
    onIt,
    preload: false,
  });
  return await read;
};

describe("an organization's page as read", () => {
  it("stays marked stale after reading it again failed, until a later read answers", async () => {
    const reads = orgReads();
    const first = answered(10_000);
    reads.remember(first, reads.ask());

    // Read again: its core times out (the page's read joins the one under way).
    const failing = Promise.withResolvers<ClientAdmin | null>();
    const underWay = reads.read(client.id, async () => await failing.promise);
    const readAgain = opened(reads, true);
    failing.resolve(timedOut);
    await underWay;
    const afterFailure = await readAgain;

    const reopened = await opened(reads, false);

    const later = answered(0);
    reads.remember(later, reads.ask());
    const afterAnswer = await opened(reads, false);

    expect({
      afterFailure: [afterFailure?.admin, afterFailure?.stale?.error],
      reopened: [reopened?.admin, reopened?.stale],
      afterAnswer: [afterAnswer?.admin, afterAnswer?.stale],
    }).toStrictEqual({
      afterFailure: [first, "timeout"],
      reopened: [first, afterFailure?.stale],
      afterAnswer: [later, null],
    });
  });
});

describe("an organization's page loaded again", () => {
  it("asks its core again while the tab shows it, but takes the fresh answer on coming to it", async () => {
    const reads = orgReads();
    const fresh = answered(1000);
    reads.remember(fresh, reads.ask());
    let asked = 0;
    const ask = async (): Promise<ClientAdmin | null> => {
      asked += 1;
      return await Promise.resolve(answered(0));
    };

    const cameTo = await opened(reads, false);
    const askedOnComing = asked;
    // Acme's page loads again where it is: after a change, Read again.
    reads.loadBegan();
    const underWay = reads.read(client.id, ask);
    const loadedAgain = await opened(reads, true);
    await underWay;

    expect({
      cameTo: cameTo?.admin,
      askedOnComing,
      loadedAgain: loadedAgain?.admin.state,
      asked,
      newer: loadedAgain !== undefined && loadedAgain.admin !== fresh,
    }).toStrictEqual({
      cameTo: fresh,
      askedOnComing: 0,
      loadedAgain: "answered",
      asked: 1,
      newer: true,
    });
  });

  it("asked anew, never joins a read begun before the load, and that read's answer, coming in last, never replaces the newer one", async () => {
    const reads = orgReads();
    let asked = 0;
    const ask = async (): Promise<ClientAdmin | null> => {
      asked += 1;
      return await Promise.resolve(answered(0));
    };
    // A slow read, begun before the change: Read again, a moment before.
    const slow = Promise.withResolvers<null>();
    const older = reads.read(
      client.id,
      async () => {
        await slow.promise;
        // Stamped as the Worker stamps it: when core's answer came in.
        return answered(0);
      },
      { anew: true }
    );
    // The change is through, and the router loads the page again.
    reads.loadBegan();
    // A read of every organization in it (Home's) takes the one under way, as any read does;
    const every = reads.read(client.id, ask);
    // the page's, asked anew, its core again, once: a second in that load joins it.
    const page = reads.read(client.id, ask, { anew: true });
    const second = reads.read(client.id, ask, { anew: true });
    const [pageAnswer, secondAnswer] = await Promise.all([page, second]);
    // The slow read answers last, with what its core held before the change.
    slow.resolve(null);
    const olderAnswer = await older;
    const kept = reads.fresh(client.id, Date.now());
    // Later, reading it again fails: the page shows the last answer, marked.
    const failedAgain = reads.settle(timedOut, Date.now());
    // Coming back to it within the minute.
    const cameBack = await opened(reads, false);

    expect({
      second: secondAnswer === pageAnswer,
      every: (await every) === olderAnswer,
      asked,
      kept: kept === pageAnswer,
      failedAgain: [failedAgain.admin === pageAnswer, failedAgain.stale?.error],
      cameBack: cameBack?.admin === pageAnswer,
    }).toStrictEqual({
      second: true,
      every: true,
      asked: 1,
      kept: true,
      failedAgain: [true, "timeout"],
      cameBack: true,
    });
  });

  it("coming to the page after a change, while a read asked since is under way, waits for that read", async () => {
    const reads = orgReads();
    reads.remember(answered(1000), reads.ask());
    // Staff change something; a read of it asked since: in a load the page wasn't in.
    reads.changed();
    const own = Promise.withResolvers<null>();
    const ownRead = reads.read(client.id, async () => {
      await own.promise;
      return answered(0);
    });
    const cameToOwn = opened(reads, false);
    await aTurn();
    own.resolve(null);
    const ownAnswer = await ownRead;
    const shownOwn = await cameToOwn;

    expect(shownOwn?.admin).toBe(ownAnswer);
  });
});

describe("an organization's answers kept", () => {
  it("keeps the answer asked later when one asked earlier comes in after it, as a slower read of every organization can", () => {
    const reads = orgReads();
    const earlier = reads.ask();
    const later = reads.ask();
    const newer = answered(0);
    reads.remember(newer, later);
    // Asked first, answered last: stamped later.
    reads.remember(answered(0), earlier);

    expect(reads.fresh(client.id, Date.now())).toBe(newer);
  });

  it("keeps nothing of a read asked before the organization was forgotten, as one offboarded", async () => {
    const reads = orgReads();
    const slow = Promise.withResolvers<null>();
    const underWay = reads.read(client.id, async () => {
      await slow.promise;
      return answered(0);
    });
    reads.forget(client.id);
    slow.resolve(null);
    await underWay;

    expect(reads.fresh(client.id, Date.now())).toBeUndefined();
  });
});
