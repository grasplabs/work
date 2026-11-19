import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  consentDirectory,
  directoryHolds,
  directoryUser as user,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import { runClockTask } from "./maintenance.ts";
import { otherTenant } from "./sign-in-config.ts";
import {
  outcome,
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

/** An Entra account's subject, new to every test. */
const account = (): string => `directory-${crypto.randomUUID()}`;

/** Where the browser came back to: the page, and the connection it names. */
const landed = (back: URL) => ({
  page: back.pathname,
  connection: back.searchParams.get("connection"),
  error: back.searchParams.get("connectionError"),
});

describe("connecting the directory again from Settings", () => {
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
        page: "/integrations",
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
    const after = account();
    const { back } = await consentDirectory(admin, {
      returnTo: settings,
      subject: after,
    });
    await directoryHolds([user()]);
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
