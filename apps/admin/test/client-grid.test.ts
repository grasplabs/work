import { clientDispatchNamespace } from "@grasp-os/shared/router";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  clientGrid,
  defaultLiveOptions,
  gridLive,
} from "../src/clients/grid.ts";
import type { GridRow, LiveOptions } from "../src/clients/grid.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-grid-4b7d21";
const tenantToken = "test-tenant-admin-token-grid-8e1c53";
const cloudflare = mockCloudflareApi(token, tenantToken);
const db = adminDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A release a placed client runs, imported. */
const importedRelease = async (notes: string): Promise<string> =>
  await placedRelease(notes);

/** A client recorded as provisioning leaves it, on a new account in the fake. */
const recordClient = async (
  status: "provisioning" | "active"
): Promise<{ clientId: string; account: AccountState }> => {
  const account = cloudflare.addAccount();
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        accountId: account.id,
        ring: 2,
        status,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return { clientId, account };
};

/** An active client placed in a destination of its own, live on `releaseId`. */
const liveClient = async (releaseId: string) =>
  await livePlacedClient(cloudflare, 2, releaseId);

/** Client `clientId`'s row in `grid`. */
const rowOf = (grid: GridRow[], clientId: string): GridRow | undefined =>
  grid.find(({ id }) => id === clientId);

/** How many analytics requests the fake got in this test. */
const analyticsCalls = (): number =>
  cloudflare.calls.filter(({ path }) => path === "/graphql").length;

/** How many calls the fake got for `account`'s Workers in this test. */
const callsFor = (account: AccountState): number =>
  cloudflare.calls.filter(({ path }) =>
    path.startsWith(`/accounts/${account.id}/workers`)
  ).length;

/** Reading live columns as the grid does, answers not kept between tests. */
const uncached: LiveOptions = { ...defaultLiveOptions, cache: false };

/** Some usage, for an account the analytics report. */
const someUsage = {
  monthRequests: 100,
  monthCpuTimeUs: 1000,
  monthAiCost: 0,
  dayRequests: 0,
  dayErrors: 0,
};

describe("the client grid", () => {
  useStoreSecrets({ deployer: token, tenant: tenantToken });
  // Only each test's own clients are live: an earlier test's accounts are
  // gone from the fake.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("shows each client's release, ring and its operation's latest run from what the admin recorded, reading no account", async () => {
    const release = await importedRelease("feat(core): on the grid");
    const acme = await liveClient(release);
    const waiting = await recordClient("provisioning");
    const calls = cloudflare.calls.length;

    const grid = await clientGrid(env);

    expect({
      acme: rowOf(grid, acme.clientId),
      waiting: rowOf(grid, waiting.clientId),
      calls: cloudflare.calls.length - calls,
    }).toMatchObject({
      acme: {
        status: "active",
        ring: 2,
        release,
        hostname: `${acme.clientId}.grasp.test`,
        lastDeploy: { releaseId: release, status: "done" },
      },
      waiting: { status: "provisioning", lastDeploy: null },
      calls: 0,
    });
  });

  it("reads a live placed client's drift, shared secrets, health and onboarding, and nothing for one that isn't live", async () => {
    const release = await importedRelease("feat(core): live on the grid");
    const acme = await liveClient(release);
    const waiting = await recordClient("provisioning");

    const live = await gridLive(env, new Date(), uncached);

    expect({
      acme: live[acme.clientId],
      waiting: live[waiting.clientId],
      // A placed client has no account of its own to read usage from.
      analyticsCalls: analyticsCalls(),
    }).toStrictEqual({
      acme: {
        drift: "in_sync",
        sharedSecretsCurrent: true,
        reach: "reachable",
        day: null,
        costUsd: null,
        onboarding: {
          stage: "none",
          day: null,
          days: null,
          known: 0,
          needs: 0,
        },
      },
      waiting: undefined,
      analyticsCalls: 0,
    });
  });

  it("reaches a core in the clients' dispatch namespace through it, by the script its hostname's entry names, and no other", async () => {
    const release = await importedRelease("feat(core): in the namespace");
    const acme = await liveClient(release);
    const host = `${acme.clientId}.grasp.test`;
    const entry = await env.ROUTER_HOSTS.get(host, "json");
    const { generation } = z.object({ generation: z.int() }).parse(entry);
    // Its core moved into the namespace, its hostname's entry naming it there.
    const script = [...acme.account.scripts.keys()].find((name) =>
      name.endsWith("core")
    );
    const state = acme.account.scripts.get(script ?? "");
    if (script === undefined || state === undefined) {
      throw new Error("The deploy left no core script");
    }
    acme.account.namespaces.set(
      clientDispatchNamespace,
      new Map([[script, state]])
    );
    acme.account.scripts.delete(script);
    await env.ROUTER_HOSTS.put(
      host,
      JSON.stringify({ clientId: acme.clientId, script, generation })
    );
    const namespace = cloudflare.dispatcher(
      acme.account.id,
      clientDispatchNamespace
    );
    vi.spyOn(env.DISPATCHER, "get").mockImplementation(
      (name) =>
        // SAFETY: a stand-in user Worker: only `fetch`, which the admin calls.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        namespace.get(name) as Fetcher
    );

    const reached = await gridLive(env, new Date(), uncached);
    // Then its entry names a script the namespace doesn't have.
    await env.ROUTER_HOSTS.put(
      host,
      JSON.stringify({
        clientId: acme.clientId,
        script: "grasp-gone",
        generation,
      })
    );
    const gone = await gridLive(env, new Date(), uncached);

    const dispatched = cloudflare.dispatched();
    expect({
      reached: reached[acme.clientId]?.reach,
      gone: gone[acme.clientId]?.reach,
      // To its own script, at its hostname, and never anywhere else.
      reachedIt: dispatched.some(
        ({ script: to, url }) => to === script && new URL(url).host === host
      ),
      onlyIt: dispatched.every(({ script: to }) => to === script),
    }).toStrictEqual({
      reached: "reachable",
      gone: "unreachable",
      reachedIt: true,
      onlyIt: true,
    });
  });

  it("reads every live client's usage in as few analytics requests as it can, and keeps an account left out, or a failed request, to its own clients", async () => {
    // Recorded as active, never deployed: analytics read accounts, not deploys.
    const recorded = [];
    for (let index = 0; index < 21; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      recorded.push(await recordClient("active"));
    }
    // The grid reads clients by id: 10 accounts to a request, then 10, then 1.
    const byId = recorded.toSorted((a, b) =>
      a.clientId.localeCompare(b.clientId)
    );
    const [unreported, idle] = byId;
    const alone = byId.at(-1);
    for (const { account } of byId.slice(1)) {
      account.usage = someUsage;
    }
    // The request for the last account alone fails outright.
    cloudflare.failNext(
      ({ path, body }) =>
        path === "/graphql" &&
        JSON.stringify(body).includes(alone?.account.id ?? "none"),
      400
    );

    const live = await gridLive(env, new Date(), uncached);

    expect({
      analyticsCalls: analyticsCalls(),
      unreported: live[unreported?.clientId ?? ""]?.costUsd,
      idle: live[idle?.clientId ?? ""],
      alone: live[alone?.clientId ?? ""]?.costUsd,
      others: byId
        .slice(1, -1)
        .every(({ clientId }) => live[clientId]?.costUsd !== null),
    }).toMatchObject({
      analyticsCalls: 3,
      unreported: null,
      // Asked of, answered none: no requests, which isn't unknown.
      idle: { day: { requests: 0, errors: 0 }, costUsd: { workers: 5, ai: 0 } },
      alone: null,
      others: true,
    });
  });

  it("reads a few clients at a time, stops one that takes too long, aborting its requests, keeps each whole answer a minute, and reads one with anything unknown again", async () => {
    const release = await importedRelease("feat(core): many live");
    const all = [];
    for (let index = 0; index < 4; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one deploy at a time
      const client = await liveClient(release);
      client.account.usage = someUsage;
      all.push(client);
    }
    const [slow, unread, ...whole] = all;
    // An unknown answer for a client that answers, kept a moment ago as
    // the admin kept them before: never served.
    const [stale] = whole;
    const kept = await caches.open("grid-live");
    await kept.put(
      `https://grid-live.admin.invalid/${encodeURIComponent(stale?.clientId ?? "")}`,
      Response.json(
        {
          drift: "unknown",
          sharedSecretsCurrent: null,
          reach: "unknown",
          day: null,
          costUsd: null,
          onboarding: null,
        },
        { headers: { "cache-control": "max-age=60" } }
      )
    );
    // The slow client's account doesn't answer until the test lets it.
    const held = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      ({ path }) =>
        path.startsWith(`/accounts/${slow?.account.id ?? ""}/workers`),
      async () => {
        await held.promise;
      }
    );
    // Another's account refuses one Worker's deployments listing, once.
    cloudflare.failNext(
      ({ path }) =>
        path.startsWith(
          `/accounts/${unread?.account.id ?? ""}/workers/scripts/`
        ) && path.endsWith("/deployments"),
      400
    );
    const options: LiveOptions = {
      ...defaultLiveOptions,
      concurrency: 2,
      rowDeadlineMs: 200,
      cache: true,
    };

    const first = await gridLive(env, new Date(), options);
    const peak = cloudflare.peakAccounts();
    const aborted = cloudflare.abortedCalls();
    // Both accounts answer from here on.
    held.resolve(true);
    const callsBefore = whole.map(({ account }) => callsFor(account));
    const again = await gridLive(env, new Date(), options);
    const callsAfter = whole.map(({ account }) => callsFor(account));

    expect({
      peak,
      // Its stalled request was aborted, not left running past the deadline.
      aborted: aborted > 0,
      first: {
        slow: first[slow?.clientId ?? ""],
        unread: first[unread?.clientId ?? ""],
        whole: whole.map(({ clientId }) => first[clientId]?.reach),
      },
      again: {
        // Not kept while unknown: read again, now that they answer.
        slow: again[slow?.clientId ?? ""],
        unread: again[unread?.clientId ?? ""],
        whole: whole.map(({ clientId }) => again[clientId]?.reach),
      },
      // Kept: the second read asked their accounts nothing.
      calls: callsAfter.map(
        (count, index) => count - (callsBefore[index] ?? 0)
      ),
    }).toMatchObject({
      peak: 2,
      aborted: true,
      first: {
        slow: {
          drift: "unknown",
          sharedSecretsCurrent: null,
          reach: "unknown",
          day: null,
          costUsd: null,
          onboarding: null,
        },
        unread: { drift: "unknown", reach: "reachable" },
        whole: whole.map(() => "reachable"),
      },
      again: {
        slow: { drift: "in_sync", reach: "reachable" },
        unread: { drift: "in_sync", reach: "reachable" },
        whole: whole.map(() => "reachable"),
      },
      calls: whole.map(() => 0),
    });
  });

  it("keeps the usage of analytics requests that answered when another stalls past the deadline, aborting only that one", async () => {
    // Recorded as active, never deployed: analytics read accounts, not deploys.
    const recorded = [];
    for (let index = 0; index < 11; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      recorded.push(await recordClient("active"));
    }
    for (const { account } of recorded) {
      account.usage = someUsage;
    }
    // By id, 10 accounts to the first request and the last one alone to
    // the second, which never answers.
    const byId = recorded.toSorted((a, b) =>
      a.clientId.localeCompare(b.clientId)
    );
    const alone = byId.at(-1);
    const held = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      ({ path, body }) =>
        path === "/graphql" &&
        JSON.stringify(body).includes(alone?.account.id ?? "none"),
      async () => {
        await held.promise;
      }
    );

    const live = await gridLive(env, new Date(), {
      ...uncached,
      rowDeadlineMs: 200,
    });
    const aborted = cloudflare.abortedCalls();
    held.resolve(true);

    expect({
      answered: byId
        .slice(0, -1)
        .map(({ clientId }) => live[clientId]?.costUsd),
      stalled: live[alone?.clientId ?? ""]?.costUsd,
      aborted,
    }).toStrictEqual({
      answered: byId.slice(0, -1).map(() => ({ workers: 5, ai: 0 })),
      stalled: null,
      aborted: 1,
    });
  });

  it("reads the deployer's token once, so Secrets Store failing after that still leaves every client's live answers", async () => {
    const release = await importedRelease("feat(core): one token read");
    const acme = await liveClient(release);
    const globex = await liveClient(release);
    acme.account.usage = someUsage;
    globex.account.usage = someUsage;
    let reads = 0;
    // The first read answers as the store does; any after it fails, as a
    // store gone bad would.
    vi.spyOn(env.DEPLOYER_API_TOKEN, "get").mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? await Promise.resolve(token)
        : await Promise.reject(new Error("store unavailable"));
    });

    const live = await gridLive(env, new Date(), uncached);

    expect({
      reads,
      acme: live[acme.clientId],
      globex: live[globex.clientId],
    }).toMatchObject({
      reads: 1,
      acme: { drift: "in_sync", reach: "reachable" },
      globex: { drift: "in_sync", reach: "reachable" },
    });
  });

  it("reads a client's onboarding from its core, signed for, numbers only, says when its core can't be asked, and never follows one that redirects", async () => {
    const release = await importedRelease("feat(core): onboarding on the grid");
    const onboarding = await liveClient(release);
    const older = await liveClient(release);
    const moved = await liveClient(release);
    moved.account.onboarding = {
      stage: "interviews",
      day: 1,
      days: 14,
      known: 2,
      needs: 0,
    };
    moved.account.redirectsTo = "https://elsewhere.example";
    onboarding.account.onboarding = {
      stage: "interviews",
      day: 4,
      days: 14,
      known: 48,
      needs: 1,
    };
    older.account.onboarding = "absent";

    const live = await gridLive(env, new Date(), uncached);

    expect({
      onboarding: live[onboarding.clientId]?.onboarding,
      older: live[older.clientId]?.onboarding,
      moved: live[moved.clientId]?.onboarding,
      redirected: cloudflare.redirected(),
    }).toStrictEqual({
      onboarding: {
        stage: "interviews",
        day: 4,
        days: 14,
        known: 48,
        needs: 1,
      },
      older: "unreachable",
      // Unknown: what answers at the redirect's target isn't its core.
      moved: null,
      redirected: [],
    });
  });

  it("still answers when the cache can't keep what it read, or read it back", async () => {
    const release = await importedRelease("feat(core): no cache");
    const acme = await liveClient(release);
    const broken = await caches.open("broken-in-this-test");
    vi.spyOn(broken, "match").mockRejectedValue(new Error("cache down"));
    vi.spyOn(broken, "put").mockRejectedValue(new Error("cache down"));
    vi.spyOn(caches, "open").mockResolvedValue(broken);

    const live = await gridLive(env, new Date(), defaultLiveOptions);

    expect(live[acme.clientId]).toMatchObject({
      drift: "in_sync",
      reach: "reachable",
    });
  });

  it("shows a client whose core doesn't answer as unreachable, one changed outside the admin as drifted, and shared secrets as unknown, never behind, when its deployments can't be read", async () => {
    const release = await importedRelease("feat(core): trouble");
    const down = await liveClient(release);
    const changed = await liveClient(release);
    const unread = await liveClient(release);
    down.account.unhealthy = 100;
    // Someone deployed another version of each Worker by hand.
    for (const script of changed.account.scripts.values()) {
      script.deployments.unshift({
        id: crypto.randomUUID(),
        created_on: new Date().toISOString(),
        versions: [{ version_id: crypto.randomUUID(), percentage: 100 }],
        annotations: {},
      });
    }
    // Its account refuses one Worker's deployments listing.
    cloudflare.failNext(
      ({ path }) =>
        path.startsWith(`/accounts/${unread.account.id}/workers/scripts/`) &&
        path.endsWith("/deployments"),
      400
    );

    const live = await gridLive(env, new Date(), uncached);

    expect({
      down: live[down.clientId],
      changed: live[changed.clientId],
      unread: live[unread.clientId],
    }).toMatchObject({
      down: { reach: "unreachable", drift: "in_sync" },
      changed: { drift: "drifted" },
      unread: { drift: "unknown", sharedSecretsCurrent: null },
    });
  });
});
