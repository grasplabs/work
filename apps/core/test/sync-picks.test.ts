import type { ConnectionBrainAudience } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { personOf } from "../src/connections.ts";
import { readSyncPlaces } from "../src/sync-picks.ts";
import { chooseAudience } from "./brain-audiences.ts";
import { consentCode, stephenGoogleUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { signInConfig } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

// The places of a shared connection an admin picks to sync into the Brain
// (sync-picks.ts), through core's RPC and the real connect, with Google
// mocked behind it. These start from the ways it can fail: someone other
// than the company's own admins listing or picking places, Grasp staff
// among them; a page shown only the first read of a long listing, so a
// save would drop every pick it didn't show; a connection that syncs no
// picked places answered as if it did.

const idp = mockIdp();

/** Signing people in and connecting can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Has the fake Google hold a shared drive `drive`, named as its ID. */
const driveHeld = async (drive: string): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker");
  }
  await providers.fetch(stephenGoogleUrl, {
    method: "POST",
    body: JSON.stringify({ drive, files: [] }),
  });
};

/** A Google account `admin` connects for the company, which reads files. */
const sharedGoogle = async (
  admin: Awaited<ReturnType<typeof signedInApi>>
): Promise<string> => {
  const subject = `shared-${unique()}`;
  const { url } = await admin.api.connections.start({
    provider: "google",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(
      authorization,
      signInConfig.google.hostedDomain,
      subject,
      "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive.readonly"
    ),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const listed = await admin.api.connections.list();
  const connection = listed.find(
    ({ accountName }) => accountName === `${subject}@acme.test`
  );
  if (connection === undefined) {
    throw new Error("Expected the shared Google connection");
  }
  return connection.id;
};

/** A connection in connect's registry: a shared Composio one, or `owner`'s own. */
const composioConnection = async (
  owner: string | null = null
): Promise<string> => {
  const id = `connection-hubspot-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'hubspot', ?, ?, 'active', 'composio', 'hubspot', ?, ?)"
    )
    .bind(id, owner === null ? "shared" : "personal", owner, now, now)
    .run();
  return id;
};

describe("picking a shared connection's places to sync", setUpTime, () => {
  it("shows an admin every place, over as many reads as the listing takes, and keeps what they pick", async () => {
    const admin = await signedInApi(idp, "admin");
    const connectionId = await sharedGoogle(admin);
    // More shared drives than one read of connect lists (Google answering
    // one a page): the page must see them all before it saves.
    const prefix = `drive-${unique()}`;
    const ours = Array.from({ length: 60 }, (_, index) => `${prefix}-${index}`);
    for (const drive of ours) {
      // oxlint-disable-next-line no-await-in-loop -- one drive after another, in Google's order
      await driveHeld(drive);
    }

    const before = await admin.api.connections.syncPlaces(connectionId);
    await admin.api.connections.pickSyncPlaces({
      connectionId,
      feed: "shared-drives",
      from: before?.picks ?? [],
      places: [ours[0] ?? "", ours[59] ?? ""],
      acknowledged: { kind: "nobody" },
    });
    const after = await admin.api.connections.syncPlaces(connectionId);

    const pickedOfOurs = (read: typeof after) =>
      (read?.choices ?? [])
        .filter(({ place }) => place.startsWith(prefix))
        .map(({ place, title, picked }) => ({ place, title, picked }));
    expect({
      feed: before?.feed,
      before: pickedOfOurs(before).filter(({ picked }) => picked),
      seen: pickedOfOurs(before).length,
      after: pickedOfOurs(after).filter(({ picked }) => picked),
    }).toStrictEqual({
      feed: "shared-drives",
      before: [],
      seen: 60,
      after: [
        { place: ours[0], title: ours[0], picked: true },
        { place: ours[59], title: ours[59], picked: true },
      ],
    });
  });

  it("ticks every box from the one set of picks a save starts from, when the picks change while the listing is read", async () => {
    const admin = await signedInApi(idp, "admin");
    const connectionId = await sharedGoogle(admin);
    // More shared drives than one read of connect lists: the listing takes
    // several reads, and the last drive comes in a later one.
    const prefix = `drive-${unique()}`;
    const ours = Array.from({ length: 60 }, (_, index) => `${prefix}-${index}`);
    for (const drive of ours) {
      // oxlint-disable-next-line no-await-in-loop -- one drive after another, in Google's order
      await driveHeld(drive);
    }
    const [first, last] = [ours[0] ?? "", ours[59] ?? ""];
    const held = await admin.api.connections.syncPlaces(connectionId);
    await admin.api.connections.pickSyncPlaces({
      connectionId,
      feed: "shared-drives",
      from: held?.picks ?? [],
      places: [first],
      acknowledged: { kind: "nobody" },
    });
    // Another admin moves the pick to the last drive once the listing's
    // first read has answered.
    let changed = false;
    const syncPlaceChoices = async (
      request: Parameters<Env["CONNECT"]["syncPlaceChoices"]>[0]
    ) => {
      const answer = await env.CONNECT.syncPlaceChoices(request);
      if (!changed) {
        changed = true;
        await admin.api.connections.pickSyncPlaces({
          connectionId,
          feed: "shared-drives",
          from: [first],
          places: [last],
          acknowledged: { kind: "nobody" },
        });
      }
      return answer;
    };
    const racing = new Proxy(env.CONNECT, {
      get: (target, key) => {
        if (key === "syncPlaceChoices") {
          return syncPlaceChoices;
        }
        const value: unknown = Reflect.get(target, key);
        // An RPC stub's method, called on the stub: never its `bind`,
        // which the stub would take for a method of connect's.
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
    const identity: Identity = {
      userId: admin.userId,
      email: String(admin.person.email),
      name: "Admin",
      role: "admin",
      teams: [],
      staff: false,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const read = await readSyncPlaces(
      { ...env, CONNECT: racing },
      identity,
      async () => await personOf(env, identity),
      connectionId
    );
    expect({
      changed,
      from: read?.picks,
      ticked: (read?.choices ?? [])
        .filter(({ place, picked }) => picked && place.startsWith(prefix))
        .map(({ place }) => place),
    }).toStrictEqual({ changed: true, from: [first], ticked: [first] });
  });

  it("answers no places for a connection that syncs none, and lets nobody but the company's admins list or pick", async () => {
    const [admin, member, { userId: owner }] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const [shared, personal] = await Promise.all([
      composioConnection(),
      composioConnection(owner),
    ]);
    const pick = {
      connectionId: shared,
      feed: "shared-drives",
      from: [],
      places: ["sales"],
      acknowledged: { kind: "nobody" } as const,
    };

    // Refused in core, before connect: recorded here, one event each.
    const memberRefused: string[] = [];
    const refusals = await auditedDuring(async () => {
      memberRefused.push(
        await outcome(member.api.connections.syncPlaces(shared)),
        await outcome(member.api.connections.pickSyncPlaces(pick))
      );
    });

    expect({
      memberRefused,
      recorded: refusals
        .filter(({ action }) => action === "connection.sync_places")
        .map(({ actor, target, detail }) => ({
          actor: "userId" in actor ? actor.userId : actor.type,
          target: target?.id,
          detail,
        })),
    }).toStrictEqual({
      memberRefused: ["role.forbidden", "role.forbidden"],
      recorded: Array.from({ length: 2 }, () => ({
        actor: member.userId,
        target: shared,
        detail: { outcome: "refused", reason: "role.forbidden" },
      })),
    });
    expect({
      shared: await admin.api.connections.syncPlaces(shared),
      personal: await admin.api.connections.syncPlaces(personal),
      // Picks only on a connection whose connector syncs picked places.
      pickedOnToolkit: await outcome(
        admin.api.connections.pickSyncPlaces(pick)
      ),
      staffLists: await outcome(staff.connections.syncPlaces(shared)),
      staffPicks: await outcome(staff.connections.pickSyncPlaces(pick)),
      // A place that steps out of one path segment never leaves core.
      outOfPlace: await outcome(
        admin.api.connections.pickSyncPlaces({ ...pick, places: ["../me"] })
      ),
    }).toStrictEqual({
      shared: null,
      personal: null,
      pickedOnToolkit: "sync.not_found",
      staffLists: "role.forbidden",
      staffPicks: "role.forbidden",
      outOfPlace: "sync.invalid",
    });
  });

  it("picks a place only once the admin confirmed who will read everything in it now, and records each refusal", async () => {
    const admin = await signedInApi(idp, "admin");
    const connectionId = await sharedGoogle(admin);
    const prefix = `drive-${unique()}`;
    const zero = `${prefix}-0`;
    const one = `${prefix}-1`;
    await driveHeld(zero);
    await driveHeld(one);
    await chooseAudience(admin.api, connectionId, { kind: "everyone" });
    const save = async (
      places: string[],
      acknowledged?: ConnectionBrainAudience
    ): Promise<string> => {
      const page = await admin.api.connections.syncPlaces(connectionId);
      return await outcome(
        admin.api.connections.pickSyncPlaces({
          connectionId,
          feed: "shared-drives",
          from: page?.picks ?? [],
          places,
          ...(acknowledged === undefined ? {} : { acknowledged }),
        })
      );
    };
    const picksNow = async () => {
      const page = await admin.api.connections.syncPlaces(connectionId);
      return page?.picks ?? [];
    };

    const outcomes: Record<string, string> = {};
    const picks: Record<string, string[]> = {};
    const refusals = await auditedDuring(async () => {
      outcomes.unconfirmed = await save([zero]);
      // Confirmed for the audience the page showed before it was widened.
      outcomes.stale = await save([zero], { kind: "nobody" });
      picks.refused = await picksNow();
      outcomes.confirmed = await save([zero], { kind: "everyone" });
      // Another place needs confirming again; un-picking needs none.
      outcomes.another = await save([zero, one]);
      outcomes.both = await save([zero, one], { kind: "everyone" });
      outcomes.unpicked = await save([one]);
      picks.after = await picksNow();
    });

    expect({
      outcomes,
      picks,
      recorded: refusals
        .filter(({ action }) => action === "connection.sync_places")
        .map(({ actor, target, detail }) => ({
          actor: "userId" in actor ? actor.userId : actor.type,
          target: target?.id,
          detail,
        })),
    }).toStrictEqual({
      outcomes: {
        unconfirmed: "sync.unacknowledged",
        stale: "sync.unacknowledged",
        confirmed: "ok",
        another: "sync.unacknowledged",
        both: "ok",
        unpicked: "ok",
      },
      picks: { refused: [], after: [one] },
      recorded: Array.from({ length: 3 }, () => ({
        actor: admin.userId,
        target: connectionId,
        detail: {
          feed: "shared-drives",
          outcome: "refused",
          reason: "sync.unacknowledged",
        },
      })),
    });
  });

  it("refuses a save from a page another admin's pick made stale, and keeps that pick", async () => {
    const [first, second] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "admin"),
    ]);
    const connectionId = await sharedGoogle(first);
    const prefix = `drive-${unique()}`;
    const zero = `${prefix}-0`;
    const one = `${prefix}-1`;
    await driveHeld(zero);
    await driveHeld(one);
    // Both admins open the page.
    const firstPage = await first.api.connections.syncPlaces(connectionId);
    const secondPage = await second.api.connections.syncPlaces(connectionId);
    // The second picks drive 1.
    await second.api.connections.pickSyncPlaces({
      connectionId,
      feed: "shared-drives",
      from: secondPage?.picks ?? [],
      places: [one],
      acknowledged: { kind: "nobody" },
    });
    // The first, on the page from before, ticks drive 0 and saves.
    const stale = await outcome(
      first.api.connections.pickSyncPlaces({
        connectionId,
        feed: "shared-drives",
        from: firstPage?.picks ?? [],
        places: [zero],
        acknowledged: { kind: "nobody" },
      })
    );
    const now = await first.api.connections.syncPlaces(connectionId);
    expect({
      stale,
      picks: [...(now?.picks ?? [])].toSorted(),
    }).toStrictEqual({ stale: "sync.picks_changed", picks: [one] });
  });
});
