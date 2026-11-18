import { describe, expect, it } from "vite-plus/test";

import { consentCode, stephenGoogleUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { signInConfig } from "./sign-in-config.ts";
import {
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
      places: [ours[0] ?? "", ours[59] ?? ""],
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
      places: ["sales"],
    };

    expect({
      shared: await admin.api.connections.syncPlaces(shared),
      personal: await admin.api.connections.syncPlaces(personal),
      // Picks only on a connection whose connector syncs picked places.
      pickedOnToolkit: await outcome(
        admin.api.connections.pickSyncPlaces(pick)
      ),
      memberLists: await outcome(member.api.connections.syncPlaces(shared)),
      memberPicks: await outcome(member.api.connections.pickSyncPlaces(pick)),
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
      memberLists: "role.forbidden",
      memberPicks: "role.forbidden",
      staffLists: "role.forbidden",
      staffPicks: "role.forbidden",
      outOfPlace: "sync.invalid",
    });
  });
});
