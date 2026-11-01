import type { ReleaseManifest } from "@grasp-os/shared/release";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { cloudflareApi } from "../src/cloudflare/api.ts";
import { clientRuns } from "../src/db/schema.ts";
import {
  allocateClientResources,
  clientInventory,
  renderClientWorker,
} from "../src/hosting/inventory.ts";
import type { ClientResource } from "../src/hosting/inventory.ts";
import { ensureClientResources } from "../src/hosting/provision.ts";
import {
  claimRun,
  holdsClient,
  releaseRun,
  stillHolds,
  takeAttempt,
} from "../src/runners.ts";
import type { AccountState, ApiCall } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { db, destination, placedClient, release, staff } from "./hosting.ts";

const token = "test-deployer-token-0123456789";
const cloudflare = mockCloudflareApi(token);
const api = cloudflareApi({ token, retryDelayMs: 0 });

const isCreate = (call: ApiCall): boolean =>
  call.method === "POST" &&
  (call.path.endsWith("/d1/database") || call.path.endsWith("/r2/buckets"));

/** A client placed in a new destination on `account`, its resources allocated from `manifest`, and a provisioning run holding it. */
const allocated = async (account: AccountState, manifest: ReleaseManifest) => {
  const destinationId = await destination({ accountId: account.id });
  const { clientId, placement } = await placedClient(destinationId);
  await allocateClientResources(db, staff, {
    clientId,
    manifest,
    operationId: "op",
  });
  const runId = await claimRun(
    db,
    staff,
    clientId,
    null,
    { action: "client.provision", clientId },
    { kind: "provision_placed", runId: `${clientId}-p1` }
  );
  if (runId === undefined) {
    throw new Error("The run wasn't claimed");
  }
  return { clientId, placement, held: { clientId, runId } };
};

/** The databases and buckets `inventory` records, as the account should hold them. */
const expected = (inventory: readonly ClientResource[]) => ({
  d1: inventory
    .filter(({ kind }) => kind === "d1_database")
    .map(({ physicalName, providerId, jurisdiction }) => ({
      name: physicalName,
      uuid: providerId,
      jurisdiction,
    })),
  buckets: inventory
    .filter(({ kind }) => kind === "r2_bucket")
    .map(({ physicalName, providerId, jurisdiction }) => ({
      name: physicalName,
      providerId,
      jurisdiction,
    })),
});

const held = (account: AccountState) => ({
  d1: account.d1
    .map(({ name, uuid, jurisdiction }) => ({ name, uuid, jurisdiction }))
    .toSorted((a, b) => a.name.localeCompare(b.name)),
  buckets: account.buckets
    .map(({ name, jurisdiction }) => ({ name, providerId: name, jurisdiction }))
    .toSorted((a, b) => a.name.localeCompare(b.name)),
});

/** Whether no resource of `clientId`'s is observed yet. */
const unobserved = async (clientId: string): Promise<boolean> => {
  const inventory = await clientInventory(db, clientId);
  return inventory.every(({ providerId }) => providerId === null);
};

const errorOf = async (task: Promise<unknown>): Promise<unknown> =>
  await task.then(
    () => null,
    (error: unknown) => error
  );

describe("provisioning a client's resources", () => {
  it("creates each database and bucket once, under its own name, for two clients in one account", async () => {
    const account = cloudflare.addAccount();
    const manifest = await release();
    const destinationId = await destination({ accountId: account.id });
    const runs = [];
    for (const _ of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- two clients, in order
      const { clientId, placement } = await placedClient(destinationId);
      // oxlint-disable-next-line no-await-in-loop -- two clients, in order
      await allocateClientResources(db, staff, {
        clientId,
        manifest,
        operationId: "op",
      });
      // oxlint-disable-next-line no-await-in-loop -- two clients, in order
      const runId = await claimRun(
        db,
        staff,
        clientId,
        null,
        { action: "client.provision", clientId },
        {
          kind: "provision_placed",
          runId: `${clientId}-p${crypto.randomUUID().slice(0, 8)}`,
        }
      );
      runs.push({ placement, held: { clientId, runId: runId ?? "" } });
    }
    const inventories: ClientResource[][] = [];
    for (const run of runs) {
      // oxlint-disable-next-line no-await-in-loop -- one client at a time
      inventories.push(await ensureClientResources(api, db, staff, run.held));
    }

    const both = inventories.flat();
    const wanted = expected(both);
    expect(held(account)).toStrictEqual({
      d1: wanted.d1.toSorted((a, b) => a.name.localeCompare(b.name)),
      buckets: wanted.buckets.toSorted((a, b) => a.name.localeCompare(b.name)),
    });
    // Three databases and two buckets each, none shared.
    expect([account.d1.length, account.buckets.length]).toStrictEqual([6, 4]);
    // Each client's Workers now render onto its own resources.
    for (const [index, run] of runs.entries()) {
      for (const worker of Object.values(manifest.workers)) {
        expect(() =>
          renderClientWorker(worker, run.placement, inventories[index] ?? [])
        ).not.toThrow();
      }
    }

    // Running it again calls nothing that creates.
    const before = cloudflare.calls.length;
    await ensureClientResources(
      api,
      db,
      staff,
      runs[0]?.held ?? { clientId: "", runId: "" }
    );
    expect(cloudflare.calls.slice(before).filter(isCreate)).toStrictEqual([]);
  });

  it("resumes after a create whose answer was lost, or that never arrived, without a duplicate", async () => {
    const account = cloudflare.addAccount();
    const { held: run } = await allocated(account, await release());
    cloudflare.failNext(isCreate, "lost");
    await expect(ensureClientResources(api, db, staff, run)).rejects.toThrow(
      "failed (no response)"
    );
    cloudflare.failNext(isCreate, "network");
    await expect(ensureClientResources(api, db, staff, run)).rejects.toThrow(
      "failed (no response)"
    );

    const inventory = await ensureClientResources(api, db, staff, run);
    const wanted = expected(inventory);
    expect(held(account)).toStrictEqual({
      d1: wanted.d1.toSorted((a, b) => a.name.localeCompare(b.name)),
      buckets: wanted.buckets.toSorted((a, b) => a.name.localeCompare(b.name)),
    });
  });

  it("never adopts a resource no run of the client asked for, though its name matches", async () => {
    const account = cloudflare.addAccount();
    const { clientId, held: run } = await allocated(account, await release());
    const allocatedRows = await clientInventory(db, clientId);
    const first = allocatedRows.find(({ kind }) => kind === "d1_database");
    const squatter = {
      uuid: crypto.randomUUID(),
      name: first?.physicalName ?? "",
      jurisdiction: "eu",
    };
    account.d1.push(squatter);

    await expect(
      errorOf(ensureClientResources(api, db, staff, run))
    ).resolves.toMatchObject({ code: "unowned_resource" });
    const after = await clientInventory(db, clientId);
    expect(
      after.find(({ role }) => role === first?.role)?.providerId
    ).toBeNull();
    expect(account.d1).toStrictEqual([squatter]);
  });

  it("stops a runner that lost the client, and its successor finishes without a duplicate", async () => {
    const account = cloudflare.addAccount();
    const { clientId, held: stale } = await allocated(account, await release());
    let successor = "";
    // Another run takes the client over while the first one's create is in flight.
    cloudflare.beforeAnswering(isCreate, async () => {
      successor =
        (await claimRun(
          db,
          staff,
          clientId,
          stale.runId,
          { action: "client.provision", clientId },
          {
            kind: "provision_placed",
            runId: `${clientId}-p${crypto.randomUUID().slice(0, 8)}`,
          }
        )) ?? "";
    });
    await expect(
      errorOf(ensureClientResources(api, db, staff, stale))
    ).resolves.toMatchObject({ code: "runner_replaced" });
    // What the stale run created stays unrecorded until a holder observes it.
    await expect(unobserved(clientId)).resolves.toBeTruthy();

    const inventory = await ensureClientResources(api, db, staff, {
      clientId,
      runId: successor,
    });
    const wanted = expected(inventory);
    expect(held(account)).toStrictEqual({
      d1: wanted.d1.toSorted((a, b) => a.name.localeCompare(b.name)),
      buckets: wanted.buckets.toSorted((a, b) => a.name.localeCompare(b.name)),
    });
    await expect(
      errorOf(ensureClientResources(api, db, staff, stale))
    ).resolves.toMatchObject({ code: "runner_replaced" });
  });

  it("refuses a resource the provider reports outside the recorded jurisdiction", async () => {
    const account = cloudflare.addAccount();
    account.d1Reports = "fedramp";
    const { clientId, held: run } = await allocated(account, await release());
    await expect(
      errorOf(ensureClientResources(api, db, staff, run))
    ).resolves.toMatchObject({ code: "resource_outside_jurisdiction" });
    await expect(unobserved(clientId)).resolves.toBeTruthy();
  });

  it("creates nothing in a workerd destination, which its operator sets up", async () => {
    const destinationId = await destination({
      kind: "workerd",
      accountId: null,
      namespace: null,
    });
    const { clientId } = await placedClient(destinationId);
    const runId = await claimRun(
      db,
      staff,
      clientId,
      null,
      { action: "client.provision", clientId },
      {
        kind: "provision_placed",
        runId: `${clientId}-p${crypto.randomUUID().slice(0, 8)}`,
      }
    );
    const before = cloudflare.calls.length;
    await expect(
      errorOf(
        ensureClientResources(api, db, staff, { clientId, runId: runId ?? "" })
      )
    ).resolves.toMatchObject({ code: "destination_unsupported" });
    expect(cloudflare.calls).toHaveLength(before);
  });

  it("keeps a client with the retry once an attempt that timed out finishes late, and lets the retry release it", async () => {
    const account = cloudflare.addAccount();
    const { held: run } = await allocated(account, await release());
    const step = { attemptKey: "provision-step" };
    await takeAttempt(db, { ...run, ...step, attempt: 1 });
    // The first attempt timed out, and its retry took the client.
    await takeAttempt(db, { ...run, ...step, attempt: 2 });

    const lateTake = await takeAttempt(db, { ...run, ...step, attempt: 1 });
    // The first attempt finishes late, and releases what it held.
    await releaseRun(db, run.clientId, run.runId, 1, step.attemptKey);
    const kept = {
      first: await holdsClient(db, run.clientId, run.runId, 1, step.attemptKey),
      retry: await holdsClient(db, run.clientId, run.runId, 2, step.attemptKey),
    };
    await releaseRun(db, run.clientId, run.runId, 2, step.attemptKey);

    expect({
      lateTake,
      kept,
      released: await holdsClient(db, run.clientId, run.runId),
    }).toStrictEqual({
      lateTake: false,
      kept: { first: false, retry: true },
      released: false,
    });
  });

  it("keeps a client from an earlier run's attempt under the same runner id, as a rollout's fleet client's round 2 counts from 1 again", async () => {
    const account = cloudflare.addAccount();
    const { held: claim } = await allocated(account, await release());
    const { clientId, runId } = claim;
    // Round 1's run takes the client for its step's attempt 1, which then
    // times out and goes on; the round fails, and its client is released.
    const round1 = { clientId, runId, attempt: 1, attemptKey: "round-1-run" };
    await takeAttempt(db, round1);
    await releaseRun(db, clientId, runId);
    // Staff retry: round 2's run claims it under the same runner id, the
    // rollout's, and takes it for its own step's attempt 1.
    await claimRun(
      db,
      staff,
      clientId,
      null,
      { action: "rollout.client_start", clientId },
      { kind: "rollout", runId }
    );
    const round2 = { clientId, runId, attempt: 1, attemptKey: "round-2-run" };
    const taken = await takeAttempt(db, round2);

    // Round 1's attempt goes on: every check and write of it is refused.
    const lateTake = await takeAttempt(db, round1);
    const [written] = await db
      .update(clientRuns)
      .set({ claimedAt: new Date() })
      .where(and(eq(clientRuns.clientId, clientId), stillHolds(round1)))
      .returning({ clientId: clientRuns.clientId });
    await releaseRun(db, clientId, runId, 1, round1.attemptKey);

    expect({
      taken,
      lateTake,
      old: await holdsClient(db, clientId, runId, 1, round1.attemptKey),
      written: written ?? null,
      round2: await holdsClient(db, clientId, runId, 1, round2.attemptKey),
    }).toStrictEqual({
      taken: true,
      lateTake: false,
      old: false,
      written: null,
      round2: true,
    });
  });
});
