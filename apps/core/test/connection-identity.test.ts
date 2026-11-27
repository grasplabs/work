import { guestRole } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { sessionEndedCloseCode } from "../src/rpc.ts";
import { newTeam } from "./admin-teams.ts";
import { mockIdp } from "./idp.ts";
import {
  callAuth,
  openRpc,
  outcome,
  signedInApi,
  signedInWithRole,
  untilConnected,
  whoami,
} from "./sign-in.ts";

// What an open connection does as an admin changes who someone is: it
// hears it from the person's object (person-connections.ts), told by the
// change (identity-changes.ts), and reads its session at once. Each test
// holds the clock still, so nothing here is found by a reading running out
// (session-check.ts `sessionRecheckMs`): a removed person's idle tab
// closes, and a changed role or team answers from the next call. Starts
// from the ways it can fail: a removal, a role or team taken away, a guest
// removed, each reaching a tab that is open and idle.

const idp = mockIdp();

/** Holds the date still for the test, so no reading ages. */
const heldClock = (): Disposable => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  return {
    [Symbol.dispose]: () => {
      vi.useRealTimers();
    },
  };
};

describe("an open connection, as an admin changes who its person is", () => {
  it("closes at once when they are removed from the organization, idle as it is", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await member.api.whoami();
    await untilConnected(member.userId, 1);
    using _clock = heldClock();

    await admin.api.members.remove(member.userId);

    await expect(member.closed).resolves.toBe(sessionEndedCloseCode);
    await expect(outcome(whoami(member.session))).resolves.toBe(
      "auth.unauthenticated"
    );
  });

  it("closes at once when an admin ends their sessions", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await member.api.whoami();
    await untilConnected(member.userId, 1);
    using _clock = heldClock();

    await admin.api.members.revokeSessions(member.userId);

    await expect(member.closed).resolves.toBe(sessionEndedCloseCode);
  });

  it("answers as the new role from its next call, staying open", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "builder");
    await expect(member.api.whoami()).resolves.toMatchObject({
      role: "builder",
    });
    await untilConnected(member.userId, 1);
    using _clock = heldClock();

    await admin.api.members.setRole(member.userId, "user");

    await vi.waitFor(async () => {
      await expect(member.api.whoami()).resolves.toMatchObject({
        role: "user",
      });
    });
  });

  it("answers with the teams they are in now from its next call, joined or left", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    await expect(member.api.whoami()).resolves.toMatchObject({ teams: [] });
    await untilConnected(member.userId, 1);
    using _clock = heldClock();

    const team = await newTeam(admin, [member]);
    await vi.waitFor(async () => {
      await expect(member.api.whoami()).resolves.toMatchObject({
        teams: [expect.objectContaining({ id: team })],
      });
    });
    const left = await callAuth(
      "/organization/remove-team-member",
      admin.session,
      { teamId: team, userId: member.userId }
    );
    expect(left.ok).toBeTruthy();

    await vi.waitFor(async () => {
      await expect(member.api.whoami()).resolves.toMatchObject({ teams: [] });
    });
  });

  it("closes a guest's at once when they are removed", async () => {
    const admin = await signedInApi(idp, "admin");
    const guest = await signedInWithRole(idp, "user");
    await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
      .bind(guestRole, guest.userId)
      .run();
    const connection = await openRpc(guest.session);
    using session = connection.core.authenticate();
    await expect(session.whoami()).resolves.toMatchObject({ guest: true });
    await untilConnected(guest.userId, 1);
    using _clock = heldClock();

    await admin.api.members.remove(guest.userId);

    await expect(connection.closed).resolves.toBe(sessionEndedCloseCode);
  });

  it("leaves someone else's open, whoever is removed", async () => {
    const admin = await signedInApi(idp, "admin");
    const leaving = await signedInApi(idp, "user");
    const staying = await signedInApi(idp, "user");
    await staying.api.whoami();
    await untilConnected(staying.userId, 1);
    using _clock = heldClock();

    await admin.api.members.remove(leaving.userId);
    await expect(leaving.closed).resolves.toBe(sessionEndedCloseCode);

    await expect(staying.api.whoami()).resolves.toMatchObject({
      userId: staying.userId,
    });
  });
});
