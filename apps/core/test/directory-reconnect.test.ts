import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { consentCode } from "./connect-providers.ts";
import {
  connectedGoogleDirectory,
  consentDirectory,
  directoryFailsAt,
  directoryGrants,
  directoryGroup,
  directoryGroupsHold,
  directoryHolds,
  directoryUser as user,
  googleDirectoryHolds,
  googleDirectoryRefuses,
  googleDirectoryUser,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { acmeTenant, otherTenant } from "./sign-in-config.ts";
import {
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
  openRpc,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Connecting the directory again after the onboarding (GRA-2171), from
// Settings › Members, where a failing daily read is shown: the same flow
// the company step starts, coming back to Settings instead, which never
// reads or saves a roster. Only Microsoft's side is faked; core, connect
// and sign-in are the real ones. The ways it could go wrong come first:
// someone other than the client's admin connecting it, another tenant's
// directory, and the connection it replaces keeping live tokens.

const idp = mockIdp();
const dayMs = 24 * 60 * 60 * 1000;
const settings = "/settings/members";

let days = 0;
/** A time past every read so far by more than a day: a read is due then. */
const nextDay = (): Date => {
  days += 2;
  return new Date(Date.now() + days * dayMs);
};

/** The clock's daily read, run for the slot at `at`. */
const readAt = async (at: Date): Promise<void> => {
  await runClockTask("directory.people", {}, at);
};

/** Where the Microsoft directory's read stands, and through which connection. */
const read = async () =>
  await env.DB.prepare(
    "SELECT connection_id AS connectionId, failure, people FROM directory_reads WHERE provider = 'microsoft-directory'"
  ).first<{
    connectionId: string;
    failure: string | null;
    people: number | null;
  }>();

/** The directory connection of the Entra account `subject`, as connect keeps it. */
const connectionOf = async (subject: string) => {
  const row = await connectDb()
    .prepare(
      "SELECT id, status, (SELECT count(*) FROM connection_tokens WHERE connection_id = connections.id) AS tokens FROM connections WHERE provider = 'microsoft-directory' AND account_id = ?"
    )
    .bind(subject)
    .first<{ id: string; status: string; tokens: number }>();
  if (row === null) {
    throw new Error(`No directory connection of ${subject}`);
  }
  return row;
};

/** The Google directory's live connections, by ID. */
const liveGoogle = async (): Promise<string[]> => {
  const { results } = await connectDb()
    .prepare(
      "SELECT id FROM connections WHERE provider = 'google-directory' AND status = 'active' ORDER BY id"
    )
    .all<{ id: string }>();
  return results.map(({ id }) => id);
};

/** An Entra account's subject, new to every test. */
const account = (): string => `directory-${crypto.randomUUID()}`;

/** The tokens connect keeps for connection `id`: which grant, and which generation of it. */
const tokensOf = async (id: string) =>
  await connectDb()
    .prepare(
      "SELECT sealed, generation, granted_scopes AS granted FROM connection_tokens WHERE connection_id = ?"
    )
    .bind(id)
    .first<{ sealed: string; generation: number; granted: string }>();

/** What Entra granted a directory connection made before Grasp asked for its groups. */
const beforeGroups = "openid profile email User.Read User.Read.All";

/**
 * `admin` connecting SharePoint and OneDrive from Settings, consenting as
 * the Entra account `subject`: where the browser came back to.
 */
const consentDocuments = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  subject: string
): Promise<URL> => {
  const { url } = await admin.api.onboarding.connectDocumentPlaces(
    "microsoft",
    settings
  );
  const authorization = new URL(url);
  const response = await routed(
    `/api/connections/callback?${new URLSearchParams({
      code: consentCode(authorization, acmeTenant, subject),
      state: authorization.searchParams.get("state") ?? "",
    }).toString()}`,
    { headers: { cookie: admin.session } }
  );
  return new URL(response.headers.get("location") ?? "");
};

/** Where the browser came back to: the page, and the connection it names. */
const landed = (back: URL) => ({
  page: back.pathname,
  connection: back.searchParams.get("connection"),
  error: back.searchParams.get("connectionError"),
});

describe("connecting the directory again from Settings", () => {
  // First: before any directory is connected here.
  it("records nothing for a company that never connected a directory", async () => {
    await readAt(nextDay());
    await expect(read()).resolves.toBeNull();
  });

  it("refuses a member, Grasp's staff, a suspended admin and another tenant's account, and leaves the connection as it was", async () => {
    const admin = await signedInApi(idp, "admin");
    const held = account();
    await consentDirectory(admin, { returnTo: settings, subject: held });
    const member = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = staffCore.authenticate();
    const suspended = await signedInApi(idp, "admin");
    await env.DB.prepare(
      "UPDATE members SET suspended_at = ?, suspended_by = 'directory' WHERE user_id = ?"
    )
      .bind(Date.now(), suspended.userId)
      .run();
    const elsewhere = await consentDirectory(admin, {
      returnTo: settings,
      subject: account(),
      tenant: otherTenant,
    });

    const { status: heldStatus } = await connectionOf(held);

    expect({
      member: await outcome(
        member.api.onboarding.connectDirectory("microsoft", settings)
      ),
      staff: await outcome(
        staff.onboarding.connectDirectory("microsoft", settings)
      ),
      suspended: await outcome(
        suspended.api.onboarding.connectDirectory("microsoft", settings)
      ),
      elsewhere: landed(elsewhere.back),
      held: heldStatus,
    }).toStrictEqual({
      member: "role.forbidden",
      staff: "role.forbidden",
      suspended: "auth.unauthenticated",
      elsewhere: {
        page: "/connectors",
        connection: null,
        error: "connection.wrong_account",
      },
      held: "active",
    });
  });

  it("with the same account, mends a read that failed for a grant that ran out, under the same connection", async () => {
    const admin = await signedInApi(idp, "admin");
    const subject = account();
    await consentDirectory(admin, { returnTo: settings, subject });
    await directoryHolds([user(), user()]);
    await readAt(nextDay());
    const { id } = await connectionOf(subject);
    // As connect marks a connection whose grant ran out (tokens.ts `markDead`).
    await connectDb().batch([
      connectDb()
        .prepare("UPDATE connections SET status = 'needs_reauth' WHERE id = ?")
        .bind(id),
      connectDb()
        .prepare("DELETE FROM connection_tokens WHERE connection_id = ?")
        .bind(id),
    ]);
    const at = nextDay();
    await readAt(at);
    const failed = await read();

    const { back } = await consentDirectory(admin, {
      returnTo: settings,
      subject,
    });
    await readAt(new Date(at.getTime() + 15 * 60 * 1000));

    expect({
      failed: failed?.failure,
      landed: landed(back),
      after: await read(),
    }).toStrictEqual({
      failed: "directory.inactive",
      landed: { page: settings, connection: id, error: null },
      after: { connectionId: id, failure: null, people: 2 },
    });
  });

  it("with another account, stops the connection it replaces, its tokens gone, and reads through the new one", async () => {
    const admin = await signedInApi(idp, "admin");
    const before = account();
    await consentDirectory(admin, { returnTo: settings, subject: before });
    await directoryHolds([user()]);
    const after = account();
    const { back } = await consentDirectory(admin, {
      returnTo: settings,
      subject: after,
    });
    await readAt(nextDay());
    const replacing = await connectionOf(after);
    const replaced = await connectionOf(before);
    const now = await read();

    expect({
      landed: landed(back),
      replaced,
      replacing: replacing.status,
      read: now?.connectionId,
    }).toStrictEqual({
      landed: { page: settings, connection: replacing.id, error: null },
      replaced: {
        id: replaced.id,
        status: "disconnected",
        tokens: 0,
      },
      replacing: "active",
      read: replacing.id,
    });
  });

  it("says a directory disconnected since its last read isn't connected, and connecting it again mends it", async () => {
    const admin = await signedInApi(idp, "admin");
    const subject = account();
    await consentDirectory(admin, { returnTo: settings, subject });
    await directoryHolds([user()]);
    await readAt(nextDay());
    const { id } = await connectionOf(subject);
    // As Integrations disconnects it; the clock's next quarter hour, a
    // day before the next read is due, says so.
    await admin.api.connections.disconnect(id);
    await readAt(new Date(Date.now() + 15 * 60 * 1000));
    const unconnected = await read();
    const { back } = await consentDirectory(admin, {
      returnTo: settings,
      subject,
    });
    await readAt(nextDay());
    const mended = await read();

    expect({
      unconnected: unconnected?.failure,
      landed: landed(back).page,
      mended: mended?.failure,
    }).toStrictEqual({
      unconnected: "directory.not_connected",
      landed: settings,
      mended: null,
    });
  });

  it("with the same account on a working connection, renews it in place, and one made before the groups were asked for then reads them", async () => {
    const admin = await signedInApi(idp, "admin");
    const subject = account();
    await consentDirectory(admin, { returnTo: settings, subject });
    const { id } = await connectionOf(subject);
    // As connect kept a connection made before the groups' scope, and as
    // Entra renews it: with what was granted then.
    await connectDb()
      .prepare(
        "UPDATE connection_tokens SET granted_scopes = ?, access_expires_at = 0 WHERE connection_id = ?"
      )
      .bind(beforeGroups, id)
      .run();
    const finance = directoryGroup({
      displayName: `Finance ${crypto.randomUUID()}`,
    });
    await directoryGroupsHold([finance]);
    await directoryGrants(beforeGroups);
    let lacking: string;
    try {
      lacking = await outcome(admin.api.directoryGroups.search("Finance"));
    } finally {
      await directoryGrants(null);
    }
    const before = await tokensOf(id);

    const { back } = await consentDirectory(admin, {
      returnTo: settings,
      subject,
    });
    const renewed = await connectionOf(subject);
    const after = await tokensOf(id);
    const found = await admin.api.directoryGroups.search("Finance");

    expect({
      lacking,
      landed: landed(back),
      renewed: renewed.status,
      newTokens: after?.sealed !== before?.sealed,
      later: (after?.generation ?? 0) > (before?.generation ?? 0),
      found: found.groups.some((group) => group.id === finance.id),
    }).toStrictEqual({
      lacking: "directory.groups_not_granted",
      landed: { page: settings, connection: id, error: null },
      renewed: "active",
      newTokens: true,
      later: true,
      found: true,
    });
  });

  it("with the same account, refuses a grant narrower than the one the connection holds, and leaves its tokens working", async () => {
    const admin = await signedInApi(idp, "admin");
    const subject = account();
    await consentDirectory(admin, { returnTo: settings, subject });
    const { id } = await connectionOf(subject);
    const before = await tokensOf(id);
    // Everything a new connection must hold, without User.Read it held.
    await directoryGrants(
      "openid profile email offline_access User.Read.All Group.ReadBasic.All"
    );
    let narrower: URL;
    try {
      ({ back: narrower } = await consentDirectory(admin, {
        returnTo: settings,
        subject,
      }));
    } finally {
      await directoryGrants(null);
    }
    await directoryHolds([user(), user(), user()]);
    await readAt(nextDay());
    const now = await read();

    expect({
      landed: landed(narrower),
      tokens: await tokensOf(id),
      read: { connectionId: now?.connectionId, failure: now?.failure },
    }).toStrictEqual({
      landed: {
        page: "/connectors",
        connection: null,
        error: "connection.scopes_refused",
      },
      tokens: before,
      read: { connectionId: id, failure: null },
    });
  });

  it("still refuses the same account again on a working connection that isn't the directory's", async () => {
    const admin = await signedInApi(idp, "admin");
    const subject = `documents-${crypto.randomUUID()}`;
    const first = await consentDocuments(admin, subject);
    const again = await consentDocuments(admin, subject);

    expect({
      first: first.searchParams.has("connection"),
      again: landed(again),
    }).toStrictEqual({
      first: true,
      again: {
        page: "/connectors",
        connection: null,
        error: "connection.already_connected",
      },
    });
  });

  it("never stops another directory's connection: Google's leaves Microsoft's as it was", async () => {
    const admin = await signedInApi(idp, "admin");
    const microsoft = account();
    await consentDirectory(admin, { returnTo: settings, subject: microsoft });
    const google = await connectedGoogleDirectory(idp);
    const { status } = await connectionOf(microsoft);

    expect({
      google: google.back.searchParams.has("connection"),
      microsoft: status,
    }).toStrictEqual({ google: true, microsoft: "active" });
  });

  it("keeps a working Google directory when an admin signs in with an account that can't read it, or Google throttles the check, and says why", async () => {
    await googleDirectoryHolds([googleDirectoryUser()]);
    await connectedGoogleDirectory(idp);
    const working = await liveGoogle();
    const outcomes: Record<string, ReturnType<typeof landed>> = {};
    for (const [why, status] of [
      ["notAdmin", 403],
      ["throttled", 429],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
      await googleDirectoryRefuses(status);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
        const { back } = await connectedGoogleDirectory(idp);
        outcomes[why] = landed(back);
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- one sign-in at a time
        await googleDirectoryHolds([googleDirectoryUser()]);
      }
    }
    await runClockTask("directory.people", {}, nextDay());
    const google = await env.DB.prepare(
      "SELECT connection_id AS connectionId, failure FROM directory_reads WHERE provider = 'google-directory'"
    ).first<{ connectionId: string; failure: string | null }>();

    expect({
      outcomes,
      live: await liveGoogle(),
      read: google,
    }).toStrictEqual({
      outcomes: {
        notAdmin: {
          // Started on the setup's company step: back there, with why.
          page: "/setup",
          connection: null,
          error: "connection.directory_unreadable",
        },
        throttled: {
          page: "/setup",
          connection: null,
          error: "connection.directory_unchecked",
        },
      },
      live: working,
      read: { connectionId: working[0], failure: null },
    });
  });

  it("renews a connection in place without checking it against older ones, even while the directory fails to answer", async () => {
    const admin = await signedInApi(idp, "admin");
    const renewed = account();
    await consentDirectory(admin, { returnTo: settings, subject: renewed });
    // An older connection still live beside it: this one made "later",
    // so the one connected next neither replaces it nor is replaced.
    await connectDb()
      .prepare(
        "UPDATE connections SET created_at = created_at + 3600000 WHERE provider = 'microsoft-directory' AND account_id = ?"
      )
      .bind(renewed)
      .run();
    const older = account();
    await consentDirectory(admin, { returnTo: settings, subject: older });
    const { id } = await connectionOf(renewed);
    await directoryFailsAt(0);
    let again: URL;
    try {
      ({ back: again } = await consentDirectory(admin, {
        returnTo: settings,
        subject: renewed,
      }));
    } finally {
      await directoryHolds([user()]);
    }
    const [{ status }, beside] = [
      await connectionOf(renewed),
      await connectionOf(older),
    ];

    expect({
      landed: landed(again),
      status,
      older: beside.status,
    }).toStrictEqual({
      landed: { page: settings, connection: id, error: null },
      status: "active",
      older: "active",
    });
  });

  // Last: it leaves a connection made "later" than any after it.
  it("never stops a connection made after the one it finishes, as another admin's at the same moment", async () => {
    const admin = await signedInApi(idp, "admin");
    const later = account();
    await consentDirectory(admin, { returnTo: settings, subject: later });
    // Another admin's flow, finished after this one began storing.
    await connectDb()
      .prepare(
        "UPDATE connections SET created_at = created_at + 3600000 WHERE provider = 'microsoft-directory' AND account_id = ?"
      )
      .bind(later)
      .run();
    const earlier = account();
    await consentDirectory(admin, { returnTo: settings, subject: earlier });

    const [made, finished] = [
      await connectionOf(later),
      await connectionOf(earlier),
    ];

    expect({ later: made.status, earlier: finished.status }).toStrictEqual({
      later: "active",
      earlier: "active",
    });
  });
});
