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

const timedOut: ClientAdmin = {
  client,
  state: "unreachable",
  lastAnsweredAt: null,
  error: "timeout",
};

/**
 * Acme's page as `reads` has it, come to (`onIt` false) or loaded again
 * while the tab shows it; the frame's read failed.
 */
const opened = async (
  reads: ReturnType<typeof orgReads>,
  onIt: boolean
): Promise<OrgRead | undefined> => {
  const { read } = await readOrganization({
    reads,
    client,
    admins: Promise.resolve(null),
    onIt,
    preload: false,
  });
  return await read;
};

describe("an organization's page as read", () => {
  it("stays marked stale after reading it again failed, until a later read answers", async () => {
    const reads = orgReads();
    const first = answered(10_000);
    reads.remember(first);

    // Read again: its core times out (the page's read joins the one under way).
    const failing = Promise.withResolvers<ClientAdmin | null>();
    const underWay = reads.read(client.id, async () => await failing.promise);
    const readAgain = opened(reads, true);
    failing.resolve(timedOut);
    await underWay;
    const afterFailure = await readAgain;

    const reopened = await opened(reads, false);

    const later = answered(0);
    reads.remember(later);
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
    reads.remember(fresh);
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

  it("asked anew, never joins a read begun before the load, though it is still under way: its answer may be from before the change", async () => {
    const reads = orgReads();
    const before = answered(2000);
    const after = answered(0);
    let asked = 0;
    const ask = async (): Promise<ClientAdmin | null> => {
      asked += 1;
      return await Promise.resolve(after);
    };
    // A slow read, begun before the change: Read again, a moment before.
    const slow = Promise.withResolvers<ClientAdmin | null>();
    const older = reads.read(client.id, async () => await slow.promise, {
      anew: true,
    });
    // The change is through, and the router loads the page again.
    reads.loadBegan();
    // The frame's read in it takes the one under way, as any read does;
    const framed = reads.read(client.id, ask);
    // the page's, asked anew, its core again, once: a second in that load joins it.
    const page = reads.read(client.id, ask, { anew: true });
    const second = reads.read(client.id, ask, { anew: true });
    // The slow read answers, with what its core held before the change.
    slow.resolve(before);
    const [pageAnswer, secondAnswer] = await Promise.all([page, second]);

    expect({
      page: pageAnswer,
      second: secondAnswer,
      framed: await framed,
      older: await older,
      asked,
      kept: reads.fresh(client.id, Date.now()),
    }).toStrictEqual({
      page: after,
      second: after,
      framed: before,
      older: before,
      asked: 1,
      kept: after,
    });
  });
});

describe("an organization's answers kept", () => {
  it("keeps the later answer when an older one arrives after it, as the frame's slower read can", () => {
    const reads = orgReads();
    const newer = answered(0);
    reads.remember(newer);
    reads.remember(answered(5000));

    expect(reads.fresh(client.id, Date.now())).toBe(newer);
  });
});
