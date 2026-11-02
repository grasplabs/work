import { describe, expect, it } from "vite-plus/test";

import { readOrganization } from "../src/admin/org-loads.ts";
import { orgReads } from "../src/admin/org-reads.ts";
import type { AnsweredAdmin, OrgRead } from "../src/admin/org-reads.ts";
import type { ClientAdmin } from "../src/clients/admin.ts";
import type { GridRow } from "../src/clients/grid.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";

const client: GridRow = {
  id: "acme",
  name: "Acme",
  status: "active",
  ring: 0,
  hostname: "acme.grasp.test",
  release: null,
  pinnedReleaseId: null,
  lastDeploy: null,
  setup: null,
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
