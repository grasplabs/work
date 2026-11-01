import { clientsNamespace } from "@grasp-os/shared/names";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
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
const cloudflare = mockCloudflareApi(token);
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

/** How many calls the fake got for `account`'s Workers in this test. */
const callsFor = (account: AccountState): number =>
  cloudflare.calls.filter(({ path }) =>
    path.startsWith(`/accounts/${account.id}/workers`)
  ).length;

/** Reading live columns as the grid does, answers not kept between tests. */
const uncached: LiveOptions = { ...defaultLiveOptions, cache: false };

/** The account a call to the API is about, from its path. */
const accountPath = /^\/accounts\/(?<id>[^/]+)\//u;

describe("the client grid", () => {
  useStoreSecrets({ deployer: token });
  // Only each test's own clients are live: an earlier test's accounts are
  // gone from the fake.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });
  afterEach(() => {
    vi.useRealTimers();
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

    const live = await gridLive(env, uncached);

    expect({
      acme: live[acme.clientId],
      waiting: live[waiting.clientId],
    }).toStrictEqual({
      acme: {
        drift: "in_sync",
        sharedSecretsCurrent: true,
        reach: "reachable",
        onboarding: {
          stage: "none",
          day: null,
          days: null,
          known: 0,
          needs: 0,
        },
      },
      waiting: undefined,
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
      clientsNamespace("production"),
      new Map([[script, state]])
    );
    acme.account.scripts.delete(script);
    await env.ROUTER_HOSTS.put(
      host,
      JSON.stringify({ clientId: acme.clientId, script, generation })
    );
    const namespace = cloudflare.dispatcher(
      acme.account.id,
      clientsNamespace("production")
    );
    vi.spyOn(env.DISPATCHER, "get").mockImplementation(
      (name) =>
        // SAFETY: a stand-in user Worker: only `fetch`, which the admin calls.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        namespace.get(name) as Fetcher
    );

    const reached = await gridLive(env, uncached);
    // Then its entry names a script the namespace doesn't have.
    await env.ROUTER_HOSTS.put(
      host,
      JSON.stringify({
        clientId: acme.clientId,
        script: "grasp-gone",
        generation,
      })
    );
    const gone = await gridLive(env, uncached);

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

  it("reads a few clients at a time, stops one that takes too long, aborting its requests, keeps each whole answer a minute, and reads one with anything unknown again", async () => {
    const release = await importedRelease("feat(core): many live");
    const all = [];
    for (let index = 0; index < 4; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one deploy at a time
      const client = await liveClient(release);
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
          onboarding: null,
        },
        { headers: { "cache-control": "max-age=60" } }
      )
    );
    // The slow client's account doesn't answer until the test lets it.
    const held = Promise.withResolvers<boolean>();
    const slowArrived = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      ({ path }) =>
        path.startsWith(`/accounts/${slow?.account.id ?? ""}/workers`),
      async () => {
        slowArrived.resolve(true);
        await held.promise;
      }
    );
    // The fake answers every other call at once, so two clients' reads
    // overlap only if one is held open: the first call of another of
    // these accounts waits until a second account's call has arrived (the
    // slow one's, or another's), whichever order the clients are read in.
    // Two reads at a time hold two accounts at once; one at a time never
    // lets the second arrive, and the held row fails its deadline.
    const accountOf = (path: string): string | undefined =>
      accountPath.exec(path)?.groups?.id;
    const others = new Set(
      [unread, ...whole].map((client) => client?.account.id)
    );
    let firstOther: string | undefined;
    const secondArrived = Promise.withResolvers<boolean>();
    cloudflare.beforeAnswering(
      ({ path }) => {
        firstOther = accountOf(path);
        return others.has(firstOther);
      },
      async () => {
        await Promise.race([slowArrived.promise, secondArrived.promise]);
      }
    );
    cloudflare.beforeAnswering(
      ({ path }) => {
        const account = accountOf(path);
        return others.has(account) && account !== firstOther;
      },
      async () => {
        secondArrived.resolve(true);
        await secondArrived.promise;
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

    // The deadlines run on a clock the test moves: on the real one, a
    // client that answers but is read slowly on a busy machine would run
    // out of time too.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reading = gridLive(env, options);
    // Every other client read, each deadline cleared as it answered: the
    // slow client's, waiting on its account, is the only one left.
    // (Not `vi.waitFor`: under fake timers it moves the clock as it polls.)
    await slowArrived.promise;
    while (vi.getTimerCount() !== 1) {
      // oxlint-disable-next-line no-await-in-loop -- until the others are read
      await scheduler.wait(1);
    }
    await vi.advanceTimersByTimeAsync(options.rowDeadlineMs);
    const first = await reading;
    const peak = cloudflare.peakAccounts();
    const aborted = cloudflare.abortedCalls();
    // Both accounts answer from here on.
    held.resolve(true);
    const callsBefore = whole.map(({ account }) => callsFor(account));
    const again = await gridLive(env, options);
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

  it("reads the deployer's token once, so Secrets Store failing after that still leaves every client's live answers", async () => {
    const release = await importedRelease("feat(core): one token read");
    const acme = await liveClient(release);
    const globex = await liveClient(release);
    let reads = 0;
    // The first read answers as the store does; any after it fails, as a
    // store gone bad would.
    vi.spyOn(env.DEPLOYER_API_TOKEN, "get").mockImplementation(async () => {
      reads += 1;
      return reads === 1
        ? await Promise.resolve(token)
        : await Promise.reject(new Error("store unavailable"));
    });

    const live = await gridLive(env, uncached);

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

    const live = await gridLive(env, uncached);

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

    const live = await gridLive(env, defaultLiveOptions);

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

    const live = await gridLive(env, uncached);

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
