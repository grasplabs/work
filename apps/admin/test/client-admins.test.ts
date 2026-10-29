import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { clientAdmins, defaultAdminReadOptions } from "../src/clients/admin.ts";
import type { ClientAdmin } from "../src/clients/admin.ts";
import {
  fetchClientAdmin,
  fetchClientAdmins,
} from "../src/clients/functions.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { mockAccess } from "./access.ts";
import type { AccountState } from "./cloudflare-api-kit.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { emptyAdminSnapshot } from "./cloudflare-api.ts";
import { callServerFn } from "./pages.ts";
import { livePlacedClient, placedRelease } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-admins-5c1e70";
const cloudflare = mockCloudflareApi(token);
// After the fake API: Access's keys are served, the rest goes to the fake.
mockAccess();

const db = adminDatabase(env.DB);
const staff = { email: "ops@grasp.test", sub: "sub-ops" };

/** A release a placed client runs, imported. */
const importedRelease = async (notes: string): Promise<string> =>
  await placedRelease(notes);

/**
 * A client recorded as provisioning leaves it, on a new account in the
 * fake. Clients are read in the order of their ids, so `order` places it
 * among the test's others.
 */
const recordClient = async (
  status: "provisioning",
  order = ""
): Promise<{ clientId: string; account: AccountState }> => {
  const clientId = `client-${order}${crypto.randomUUID().slice(0, 8)}`;
  const account = cloudflare.addAccount(`Acme ${clientId}`);
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        status,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return { clientId, account };
};

/** A live placed client running `releaseId`, as its operation made it. */
const liveClient = async (releaseId: string, order = "") => {
  const clientId = `client-${order}${crypto.randomUUID().slice(0, 8)}`;
  const { account } = await livePlacedClient(cloudflare, 1, releaseId, {
    id: clientId,
    signIn: null,
  });
  return { clientId, account };
};

/** Client `clientId`'s entry in `read`. */
const entryOf = (
  read: ClientAdmin[],
  clientId: string
): ClientAdmin | undefined => read.find(({ client }) => client.id === clientId);

/** Everything the admin's D1 holds of `clientIds`' reads, column by column as stored. */
const storedReads = async (
  clientIds: readonly string[]
): Promise<Record<string, unknown>[]> => {
  const { results } = await env.DB.prepare(
    `SELECT * FROM client_admin_reads WHERE client_id IN (${clientIds.map(() => "?").join(", ")})`
  )
    .bind(...clientIds)
    .all();
  return results;
};

describe("every client's admin snapshot", () => {
  useStoreSecrets({ deployer: token });
  // Only each test's own clients have a core: an earlier test's accounts
  // are gone from the fake.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });

  it("gives every client, one whose core doesn't answer as unreachable, and after it answered once, since when", async () => {
    const release = await importedRelease("feat(core): the admin's read");
    const acme = await liveClient(release);
    const down = await liveClient(release);
    acme.account.admin = {
      ...emptyAdminSnapshot("Acme"),
      told: true,
      mapped: ["Sales"],
    };
    down.account.unhealthy = 1000;

    const first = await clientAdmins(env, staff);
    down.account.unhealthy = 0;
    const second = await clientAdmins(env, staff);
    down.account.unhealthy = 1000;
    const third = await clientAdmins(env, staff);
    const answeredAt = entryOf(second, down.clientId);

    expect({
      first: {
        acme: entryOf(first, acme.clientId),
        down: entryOf(first, down.clientId),
      },
      second: answeredAt?.state,
      third: entryOf(third, down.clientId),
    }).toMatchObject({
      first: {
        acme: {
          client: { id: acme.clientId, name: `Acme ${acme.clientId}` },
          state: "answered",
          snapshot: {
            company: { name: "Acme" },
            told: true,
            mapped: ["Sales"],
          },
        },
        down: {
          client: { id: down.clientId, status: "active" },
          state: "unreachable",
          lastAnsweredAt: null,
          error: "core_error",
        },
      },
      second: "answered",
      third: {
        state: "unreachable",
        lastAnsweredAt:
          answeredAt?.state === "answered" ? answeredAt.at : "never",
        error: "core_error",
      },
    });
  });

  it("answers the rest when one core takes too long, that one as timed out", async () => {
    const release = await importedRelease("feat(core): a slow core");
    const quick = await liveClient(release);
    const slow = await liveClient(release);
    const held = Promise.withResolvers<boolean>();
    slow.account.adminHeld = async () => {
      await held.promise;
    };

    const read = await clientAdmins(env, staff, {
      ...defaultAdminReadOptions,
      timeoutMs: 200,
    });
    held.resolve(true);

    expect({
      quick: entryOf(read, quick.clientId)?.state,
      slow: entryOf(read, slow.clientId),
    }).toMatchObject({
      quick: "answered",
      slow: { state: "unreachable", lastAnsweredAt: null, error: "timeout" },
    });
  });

  it("asks only a few cores at once, and gives a client read after others that took too long its own time, not what's left of theirs", async () => {
    const release = await importedRelease("feat(core): a queue of slow cores");
    const held = Promise.withResolvers<boolean>();
    const hang = async () => {
      await held.promise;
    };
    // Read first, filling every turn until their time is up.
    const slow = [
      await liveClient(release, "0"),
      await liveClient(release, "1"),
    ];
    for (const { account } of slow) {
      account.adminHeld = hang;
    }
    // Read once a turn frees, it answers a little after: in time only if
    // its time starts when its read does.
    const late = await liveClient(release, "z");
    late.account.adminHeld = async () => {
      await scheduler.wait(50);
    };

    const read = await clientAdmins(env, staff, {
      concurrency: slow.length,
      timeoutMs: 250,
    });
    held.resolve(true);

    expect({
      atOnce: cloudflare.peakAdminReads(),
      slow: slow.map(({ clientId }) => entryOf(read, clientId)),
      late: entryOf(read, late.clientId)?.state,
    }).toMatchObject({
      atOnce: slow.length,
      slow: [
        { state: "unreachable", error: "timeout" },
        { state: "unreachable", error: "timeout" },
      ],
      late: "answered",
    });
  });

  it("tells a core that refuses the read, as one does once its company ended Grasp's staff access, from one whose answer isn't a snapshot, and never follows one that redirects", async () => {
    const release = await importedRelease("feat(core): refusing cores");
    const ended = await liveClient(release);
    ended.account.admin = "ended";
    const garbled = await liveClient(release);
    garbled.account.admin = "garbled";
    const moved = await liveClient(release);
    moved.account.admin = emptyAdminSnapshot("Moved");
    moved.account.redirectsTo = "https://elsewhere.example";

    const read = await clientAdmins(env, staff);

    expect({
      ended: entryOf(read, ended.clientId),
      garbled: entryOf(read, garbled.clientId),
      moved: entryOf(read, moved.clientId),
      // The signed request and its router secret went nowhere else.
      redirected: cloudflare.redirected(),
    }).toMatchObject({
      ended: { state: "unreachable", error: "refused" },
      garbled: { state: "unreachable", error: "invalid_answer" },
      moved: { state: "unreachable", error: "core_error" },
      redirected: [],
    });
  });

  it("marks a client not deployed yet, and one whose core is from before the snapshot, without leaving either out", async () => {
    const release = await importedRelease("feat(core): older cores");
    const older = await liveClient(release);
    older.account.admin = "absent";
    const waiting = await recordClient("provisioning");

    const read = await clientAdmins(env, staff);

    expect({
      older: entryOf(read, older.clientId),
      waiting: entryOf(read, waiting.clientId),
    }).toMatchObject({
      older: { state: "unreachable", error: "not_served" },
      waiting: {
        client: { status: "provisioning" },
        state: "unreachable",
        lastAnsweredAt: null,
        error: "not_deployed",
      },
    });
  });

  it("asks each core signed with the key its auth secret gives for the admin, naming the staff member Access let in", async () => {
    const release = await importedRelease("feat(core): signed for");
    const acme = await liveClient(release);

    const read = await callServerFn(fetchClientAdmins, undefined, {
      email: "ada@grasp.test",
    });

    expect({
      // The fake core answers only a request signed as core checks it.
      state: entryOf(read, acme.clientId)?.state,
      readers: acme.account.adminReaders,
    }).toStrictEqual({ state: "answered", readers: ["ada@grasp.test"] });
  });

  it("reads one client alone for its page, and every other client without it", async () => {
    const release = await importedRelease("feat(core): one page");
    const acme = await liveClient(release);
    const globex = await liveClient(release);

    const one = await callServerFn(fetchClientAdmin, {
      clientId: acme.clientId,
    });
    const rest = await callServerFn(fetchClientAdmins, {
      except: [acme.clientId],
    });
    const unknown = await callServerFn(fetchClientAdmin, {
      clientId: "no-such-client",
    });

    expect({
      one: one === null ? null : [one.client.id, one.state],
      rest: {
        acme: entryOf(rest, acme.clientId)?.state,
        globex: entryOf(rest, globex.clientId)?.state,
      },
      unknown,
      asked: {
        acme: acme.account.adminReaders.length,
        globex: globex.account.adminReaders.length,
      },
    }).toStrictEqual({
      one: [acme.clientId, "answered"],
      rest: { acme: undefined, globex: "answered" },
      unknown: null,
      asked: { acme: 1, globex: 1 },
    });
  });

  it("refuses the read for anyone Access doesn't vouch for, or sent from another site's page, asking no core and keeping nothing", async () => {
    const release = await importedRelease("feat(core): refused");
    const acme = await liveClient(release);

    await expect(
      callServerFn(fetchClientAdmins, undefined, { email: null })
    ).rejects.toThrow("The server function answered 403");
    await expect(
      callServerFn(fetchClientAdmins, undefined, {
        from: "https://elsewhere.test",
      })
    ).rejects.toThrow("The server function answered 403");
    expect({
      readers: acme.account.adminReaders,
      kept: await storedReads([acme.clientId]),
    }).toStrictEqual({ readers: [], kept: [] });
  });

  it("reads a client added after an earlier read, without a restart", async () => {
    const release = await importedRelease("feat(core): a new client");
    const acme = await liveClient(release);
    const before = await callServerFn(fetchClientAdmins, undefined, {
      email: staff.email,
    });
    const added = await liveClient(release);

    const after = await callServerFn(fetchClientAdmins, undefined, {
      email: staff.email,
    });

    expect({
      before: entryOf(before, added.clientId),
      after: [acme.clientId, added.clientId].map(
        (clientId) => entryOf(after, clientId)?.state
      ),
    }).toStrictEqual({
      before: undefined,
      after: ["answered", "answered"],
    });
  });

  it("keeps what the read asked last says of a client, whichever of two reads at once lands last", async () => {
    const release = await importedRelease("feat(core): two reads at once");
    const acme = await liveClient(release);
    const arrived = Promise.withResolvers<boolean>();
    const dropped = Promise.withResolvers<boolean>();
    acme.account.adminHeld = async () => {
      arrived.resolve(true);
      await dropped.promise;
      throw new Error("The connection dropped");
    };

    // The first read's request is under way when the second is asked;
    // its failure lands after the second's answer.
    const first = clientAdmins(env, staff);
    await arrived.promise;
    acme.account.adminHeld = undefined;
    await scheduler.wait(10);
    const second = await clientAdmins(env, staff);
    dropped.resolve(true);
    const late = await first;
    const answered = entryOf(second, acme.clientId);
    const [kept] = await storedReads([acme.clientId]);

    expect({
      late: entryOf(late, acme.clientId),
      kept,
    }).toMatchObject({
      late: { state: "unreachable", error: "no_answer" },
      kept: {
        last_answered_at:
          answered?.state === "answered" ? Date.parse(answered.at) : "never",
        error: null,
      },
    });
  });

  it("keeps only when each core answered and why it didn't, nothing of what it answered", async () => {
    const release = await importedRelease("feat(core): nothing kept");
    const acme = await liveClient(release);
    const down = await liveClient(release);
    acme.account.admin = {
      ...emptyAdminSnapshot("Acme Secret Name"),
      company: {
        name: "Acme Secret Name",
        timeZone: "Europe/Berlin",
        signInDomains: ["acme.test"],
        signIn: ["microsoft"],
        admins: ["ada@acme.test"],
      },
    };
    down.account.unhealthy = 1000;

    const read = await clientAdmins(env, staff);
    const answered = entryOf(read, acme.clientId);
    const stored = await storedReads([acme.clientId, down.clientId]);

    expect(
      Object.fromEntries(
        // When it was asked is the read's own clock: only its type is told.
        stored.map((row) => [
          row.client_id,
          { ...row, asked_at: typeof row.asked_at },
        ])
      )
    ).toStrictEqual({
      [down.clientId]: {
        client_id: down.clientId,
        last_answered_at: null,
        error: "core_error",
        asked_at: "number",
      },
      [acme.clientId]: {
        client_id: acme.clientId,
        last_answered_at:
          answered?.state === "answered" ? Date.parse(answered.at) : null,
        error: null,
        asked_at: "number",
      },
    });
  });
});
