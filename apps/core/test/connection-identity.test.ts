import { chatIdSchema } from "@grasp-os/shared/ids";
import { guestRole } from "@grasp-os/shared/roles";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { draftWatch, workspace } from "../src/durable-objects.ts";
import { staffAfterGoMs } from "../src/onboarding/gate.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { sessionEndedCloseCode } from "../src/rpc.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { newTeam } from "./admin-teams.ts";
import { mockIdp } from "./idp.ts";
import { notesApp } from "./preview-drafts.ts";
import { signInConfig } from "./sign-in-config.ts";
import {
  callAuth,
  countingSessionReads,
  openRpc,
  signedIn,
  staffPerson,
  withSignIn,
  outcome,
  signedInApi,
  signedInWithRole,
  untilConnected,
  whoami,
} from "./sign-in.ts";
import { startedChat } from "./started-chats.ts";

// What an open connection does as an admin changes who someone is: it
// hears it from the person's object (person-connections.ts), told by the
// change (identity-changes.ts), and reads its session at once. Each test
// holds the clock still, so nothing here is found by a reading running out
// (session-check.ts `sessionRecheckMs`): a removed person's idle tab
// closes, and a changed role or team answers from the next call. Starts
// from the ways it can fail: a removal, a role or team taken away, a guest
// removed, each reaching a tab that is open and idle.

const idp = mockIdp();

const hour = 60 * 60 * 1000;

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

  it("tells nobody else's connection, whoever is removed: theirs reads nothing", async () => {
    const admin = await signedInApi(idp, "admin");
    const leaving = await signedInApi(idp, "user");
    const staying = await signedInApi(idp, "user");
    const reads = { sessions: 0 };
    const connection = await openRpc(staying.session, {
      coreEnv: { ...env, DB: countingSessionReads(env.DB, reads) },
    });
    await untilConnected(staying.userId, 2);
    using _clock = heldClock();
    const before = reads.sessions;

    await admin.api.members.remove(leaving.userId);
    await expect(leaving.closed).resolves.toBe(sessionEndedCloseCode);
    // Their own person's object was told: had theirs been, it would have
    // read by now.
    await workspace(env, personalWorkspaceId(leaving.userId)).identityChanged();

    expect({
      read: reads.sessions - before,
      open: await Promise.race([
        connection.closed.then(() => false),
        scheduler.wait(100).then(() => true),
      ]),
    }).toStrictEqual({ read: 0, open: true });
  });

  it("answers with their teams now from its next call when a team they were in is deleted", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const team = await newTeam(admin, [member]);
    await expect(member.api.whoami()).resolves.toMatchObject({
      teams: [expect.objectContaining({ id: team })],
    });
    await untilConnected(member.userId, 1);
    using _clock = heldClock();

    const removed = await callAuth("/organization/remove-team", admin.session, {
      teamId: team,
    });
    expect(removed.ok).toBeTruthy();

    await vi.waitFor(async () => {
      await expect(member.api.whoami()).resolves.toMatchObject({ teams: [] });
    });
  });

  it("closes Grasp staff's at once when the company's admin ends their access", async () => {
    const admin = await signedInApi(idp, "admin");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staff = await openRpc(staffSession);
    const { userId } = await staff.core.authenticate().whoami();
    await untilConnected(userId, 1);
    onTestFinished(async () => {
      await env.DB.prepare(
        "UPDATE onboarding_gate SET staff_ended_at = NULL"
      ).run();
    });
    using _clock = heldClock();

    await admin.api.onboardingGate.endStaffAccess();

    await expect(staff.closed).resolves.toBe(sessionEndedCloseCode);
  });

  it("closes Grasp staff's as their window closes, with nothing told", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staff = await openRpc(staffSession, {
      coreEnv: withSignIn({
        staff: {
          ...signInConfig.staff,
          until: new Date(Date.now() + hour).toISOString(),
        },
      }),
    });
    await staff.core.authenticate().whoami();

    await vi.advanceTimersByTimeAsync(hour);

    await expect(staff.closed).resolves.toBe(sessionEndedCloseCode);
  });

  it("closes Grasp staff's of the onboarding scope seven days after the go, before their window would", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    onTestFinished(async () => {
      vi.useRealTimers();
      await env.DB.prepare("UPDATE onboarding_gate SET opened_at = NULL").run();
    });
    const scoped = withSignIn({
      staff: { ...signInConfig.staff, scope: "onboarding" },
    });
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson(), {
      coreEnv: scoped,
    });
    // Grasp's go was given seven days ago, all but an hour.
    await env.DB.prepare(
      "INSERT INTO onboarding_gate (id, threshold, opened_at) VALUES ('gate', 80, ?) ON CONFLICT (id) DO UPDATE SET opened_at = excluded.opened_at"
    )
      .bind(Date.now() - staffAfterGoMs + hour)
      .run();
    const staff = await openRpc(staffSession, { coreEnv: scoped });
    await staff.core.authenticate().whoami();

    await vi.advanceTimersByTimeAsync(hour);

    await expect(staff.closed).resolves.toBe(sessionEndedCloseCode);
  });

  it("answers as a lowered role, and with a team left, once its reading is a few seconds old, the telling lost", async () => {
    const admin = await signedInApi(idp, "builder");
    const member = await signedInApi(idp, "builder");
    const team = await newTeam(await signedInApi(idp, "admin"), [member]);
    await untilConnected(member.userId, 1);
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await member.api.whoami();
    // Changed with nothing told, as tellings lost on their way.
    await env.DB.batch([
      env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?").bind(
        member.userId
      ),
      env.DB.prepare(
        "DELETE FROM team_members WHERE user_id = ? AND team_id = ?"
      ).bind(member.userId, team),
    ]);
    const within = await member.api.whoami();

    vi.setSystemTime(Date.now() + sessionRecheckMs);

    expect({
      within: { role: within.role, teams: within.teams.length },
      after: await member.api.whoami(),
      admin: admin.userId === member.userId,
    }).toMatchObject({
      within: { role: "builder", teams: 1 },
      after: { role: "user", teams: [] },
      admin: false,
    });
  });

  it("keeps the connection open when its socket to the person's object can't open at first, and opens it once it can", async () => {
    const person = await signedInWithRole(idp, "user");
    const object = workspace(env, personalWorkspaceId(person.userId));
    const failing = { now: true };
    // The object refuses the socket at first, as one mid-deploy might.
    await runInDurableObject(object, (instance) => {
      // SAFETY: an object's prototype holds its methods.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const methods = Object.getPrototypeOf(instance) as {
        fetch: (request: Request) => Response;
      };
      const original = methods.fetch;
      methods.fetch = function fetch(this: unknown, request: Request) {
        if (failing.now) {
          throw new Error("Overloaded for now.");
        }
        return Reflect.apply(original, this, [request]);
      };
      onTestFinished(() => {
        methods.fetch = original;
      });
    });
    const connection = await openRpc(person.session);
    using session = connection.core.authenticate();
    await expect(session.whoami()).resolves.toMatchObject({
      userId: person.userId,
    });

    failing.now = false;

    await untilConnected(person.userId, 1);
  });

  it("pushes nothing more of a followed draft or chat once the session ended with the telling lost and its reading aged", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const chat = await startedChat(builder, "Followed");
    await untilConnected(builder.userId, 1);
    const drafts: number[] = [];
    const chats: unknown[] = [];
    await builder.api.drafts.watch({ kind: "app", id: app }, (revision) => {
      drafts.push(revision);
    });
    await builder.api.chats.watch(chat.id, null, (update) => {
      chats.push(update);
    });
    await vi.waitFor(() => {
      expect(chats.length).toBeGreaterThan(0);
    });
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const seen = { drafts: drafts.length, chats: chats.length };
    // Ended with nothing told, as a telling lost on its way.
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
      .bind(builder.userId)
      .run();
    vi.setSystemTime(Date.now() + sessionRecheckMs);

    // The draft is written and the chat's agent starts working: both
    // would be pushed.
    await draftWatch(env, { kind: "app", id: app }).revised(99);
    await runInDurableObject(
      workspace(env, personalWorkspaceId(builder.userId)),
      (instance) => {
        instance.turnRunning(chatIdSchema.parse(chat.id), true);
      }
    );
    await scheduler.wait(500);

    expect({ drafts: drafts.length, chats: chats.length }).toStrictEqual(seen);
  });
});
