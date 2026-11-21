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

/** Acme's page as `reads` has it, opened (`again` false) or read again; the frame's read failed. */
const opened = async (
  reads: ReturnType<typeof orgReads>,
  again: boolean
): Promise<OrgRead | undefined> => {
  const { read } = await readOrganization({
    reads,
    client,
    admins: Promise.resolve(null),
    again,
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
    reads.askAnew(client.id);
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
  it("asks its core only when staff asked anew, never because the router ran it again over a fresh answer", async () => {
    const reads = orgReads();
    const fresh = answered(1000);
    reads.remember(fresh);
    let asked = 0;
    const ask = async (): Promise<ClientAdmin | null> => {
      asked += 1;
      return await Promise.resolve(answered(0));
    };

    const rerun = await opened(reads, true);
    const askedOnRerun = asked;
    reads.askAnew(client.id);
    const underWay = reads.read(client.id, ask);
    const readAgain = await opened(reads, true);
    await underWay;

    expect({
      rerun: rerun?.admin,
      askedOnRerun,
      readAgain: readAgain?.admin.state,
      asked,
    }).toStrictEqual({
      rerun: fresh,
      askedOnRerun: 0,
      readAgain: "answered",
      asked: 1,
    });
  });
});
