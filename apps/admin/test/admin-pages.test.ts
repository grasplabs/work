import { env } from "cloudflare:workers";
import { ne } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  fetchClientAdmins,
  fetchClientGrid,
} from "../src/clients/functions.ts";
import { clientDeploys, clients } from "../src/db/schema.ts";
import { pinClient } from "../src/rollout/channels.ts";
import { mockAccess } from "./access.ts";
import {
  cloudflare,
  token,
  db,
  staff,
  recordClient,
  liveClient,
} from "./admin-frame.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { callServerFn } from "./pages.ts";
import { placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";
import { emptyAdminSnapshot, readySnapshot } from "./snapshots.ts";

// What the admin's frame and overview read: the grid, and every client's
// core as the staff member. What they show of it is in the component
// tests (src/admin/overview.test.tsx); an organization's page in
// admin-pages-organization.test.ts and its sections in
// admin-pages-sections.test.ts.

mockCloudflareApi(token, cloudflare);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const caller = { email: staff.email };

describe("what the admin's frame reads", () => {
  useStoreSecrets({ deployer: token });
  // Only each test's own clients are listed: an earlier test's accounts
  // are gone from the fake, and the overview counts every client.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(ne(clients.status, "offboarded"));
  });

  it("reads every organization, each core once as the staff member: one down as unreachable, one being set up as not deployed", async () => {
    const acme = await liveClient();
    acme.core.admin = emptyAdminSnapshot("Acme");
    const down = await liveClient();
    down.core.unhealthy = 1000;
    const waiting = await recordClient("provisioning");

    const grid = await callServerFn(fetchClientGrid, undefined, caller);
    const admins = await callServerFn(fetchClientAdmins, undefined, caller);

    expect({
      grid: grid
        .map(({ id, status }) => ({ id, status }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
      admins: admins
        .map((admin) => ({
          id: admin.client.id,
          state: admin.state,
          error: admin.state === "unreachable" ? admin.error : null,
        }))
        .toSorted((a, b) => a.id.localeCompare(b.id)),
      readers: acme.core.adminReaders,
    }).toStrictEqual({
      grid: [
        { id: acme.clientId, status: "active" },
        { id: down.clientId, status: "active" },
        { id: waiting.clientId, status: "provisioning" },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
      admins: [
        { id: acme.clientId, state: "answered", error: null },
        { id: down.clientId, state: "unreachable", error: "core_error" },
        { id: waiting.clientId, state: "unreachable", error: "not_deployed" },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
      readers: [staff.email],
    });
  });

  it("reads a live organization's failed deploy nobody retried, and how many releases behind its pin it runs", async () => {
    const failing = await liveClient();
    failing.core.admin = readySnapshot("Failing");
    // Its deploy of a newer release failed, and nobody retried it.
    const next = await placedRelease("feat(core): failed to deploy");
    const now = new Date();
    await db.insert(clientDeploys).values({
      clientId: failing.clientId,
      releaseId: next,
      runId: `run-${crypto.randomUUID()}`,
      status: "failed",
      error: "attempt_lost: core",
      startedAt: now,
      endedAt: now,
    });
    // Three releases on, pinned to the last: three behind.
    await placedRelease("feat(core): one on");
    const last = await placedRelease("feat(core): three on");
    await pinClient(env, staff, {
      clientId: failing.clientId,
      releaseId: last,
    });
    const current = await liveClient();

    const grid = await callServerFn(fetchClientGrid, undefined, caller);
    const rolloutOf = (clientId: string) =>
      grid.find(({ id }) => id === clientId)?.rollout;

    expect({
      failing: rolloutOf(failing.clientId),
      current: rolloutOf(current.clientId),
    }).toStrictEqual({
      failing: {
        failed: { releaseId: next, error: "attempt_lost: core" },
        behind: 3,
        channelStopped: null,
      },
      current: { failed: null, behind: 0, channelStopped: null },
    });
  });
});
