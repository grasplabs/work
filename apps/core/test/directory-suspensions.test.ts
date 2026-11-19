import { authErrors } from "@grasp-os/shared/errors";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { signedInSession } from "../src/auth/identity.ts";
import { shareAudiencesAs } from "../src/brain-next.ts";
import { personalChatsOf, says } from "./agent-chat.ts";
import { grantReviewed } from "./apps.ts";
import { consentCode } from "./connect-providers.ts";
import { connectionIn, envOf, reached } from "./contexts.ts";
import { landingAt } from "./d1-landing.ts";
import {
  connectedDirectory,
  deletedFailAt,
  deletedLinksTo,
  directoryFailsAt,
  directoryHolds,
  directoryUser as user,
} from "./directory.ts";
import { mockIdp } from "./idp.ts";
import {
  endedRun,
  endLiveResourceRuns,
  greetingTasks,
  publishedWorkflow,
  startedBy,
} from "./json-workflow-apps.ts";
import type { Person } from "./json-workflow-apps.ts";
import { runClockTask } from "./maintenance.ts";
import { finished, sleeping, woken } from "./runs.ts";
import { acmeTenant, entraClient } from "./sign-in-config.ts";
import {
  auditedDuring,
  callAuth,
  entraPerson,
  onlyAdmins,
  openRpc,
  outcome,
  routed,
  signIn,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
  whoami,
  withSignIn,
} from "./sign-in.ts";
import {
  messageFrom,
  post,
  reached as teamsReached,
  teamsPerson,
  watched,
} from "./teams-door.ts";
import { connectDb } from "./test-env.ts";

// A member suspended once the directory lists their account as turned off,
// and lifted once it lists it on again (GRA-2056, slice 3a). It takes
// access away, so the tests start from the ways it could lock the wrong
// people out or let the wrong one in: everything that acts for someone,
// the company's last admin, an admin's own decision, a race mid-read, a
// read that failed. Only Microsoft Graph is faked.

const idp = mockIdp();
watched();
const dayMs = 24 * 60 * 60 * 1000;

let days = 0;
/** A time past every read so far by more than a day: a read is due then. */
const nextDay = (): Date => {
  days += 2;
  return new Date(Date.now() + days * dayMs);
};

/** The clock's daily read, run for the slot at `at`. */
const readAt = async (at: Date, changes: Partial<Env> = {}): Promise<void> => {
  await runClockTask("directory.people", changes, at);
};

/** Someone who signed in with Microsoft under `oid`, as a member in `role`. */
const memberWith = async (oid: string, role: Role = "user") => {
  const person = entraPerson(acmeTenant, "acme.test", { oid });
  const session = await signedIn(idp, "microsoft", person, {
    coreEnv: withSignIn({
      admins: [String(person.email)],
      entra: { tenantId: acmeTenant, clientId: entraClient.id },
    }),
  });
  const { userId } = await whoami(session);
  if (role !== "admin") {
    await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
      .bind(role, userId)
      .run();
  }
  return { oid, userId, name: String(person.name), person, session };
};

/** `session`'s person, as the workflow fixtures take them. */
const workflowPerson = async (
  signed: Awaited<ReturnType<typeof memberWith>>,
  session = signed.session
): Promise<Person> => {
  const { core, closed } = await openRpc(session);
  const read = await signedInSession(env, new Headers({ cookie: session }));
  if (read === undefined) {
    throw new Error("The session isn't signed in");
  }
  return {
    session,
    userId: signed.userId,
    person: signed.person,
    core,
    closed,
    api: core.authenticate(),
    acting: read.person,
  };
};

/** Who `session` is now, or the code a new connection is refused with. */
const nowSignedIn = async (session: string): Promise<string> => {
  try {
    const { role } = await whoami(session);
    return role;
  } catch (error) {
    return authErrors.codeOf(error) ?? String(error);
  }
};

/** How many sessions `userId` holds. */
const sessionsOf = async (userId: string) =>
  await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?")
    .bind(userId)
    .first<number>("n");

/** When `userId` was suspended, and by what; nulls for neither. */
const suspensionOf = async (userId: string) =>
  await env.DB.prepare(
    "SELECT suspended_at IS NOT NULL AS suspended, suspended_by AS suspendedBy FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ suspended: number; suspendedBy: string | null }>();

/** `a` before `b`, by text. */
const byText = (a: string, b: string): number => a.localeCompare(b);

/** The teams `userId` is in, with whether the read made each. */
const membershipsOf = async (userId: string) => {
  const { results } = await env.DB.prepare(
    `SELECT tm.team_id AS teamId,
        EXISTS (SELECT 1 FROM directory_memberships m WHERE m.membership_key = tm.membership_key) AS made
      FROM team_members tm WHERE tm.user_id = ?`
  )
    .bind(userId)
    .all<{ teamId: string; made: number }>();
  return results.toSorted((a, b) => byText(a.teamId, b.teamId));
};

/** The pins an admin put on `userId`. */
const pinsOf = async (userId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT team_id AS teamId, kept FROM team_pins WHERE user_id = ? ORDER BY team_id"
  )
    .bind(userId)
    .all<{ teamId: string; kept: number }>();
  return results;
};

/** The teams `personId` may share with: those of three or more who may act. */
const teamsOf = async (personId: string): Promise<string[]> => {
  const audiences = await shareAudiencesAs(env, personId);
  return audiences.teams.map(({ id }) => id);
};

const idSchema = z.object({ id: z.string() });

/** A members' team an admin made, by name. */
const teamNamed = async (session: string, name: string): Promise<string> => {
  const made = await callAuth("/organization/create-team", session, { name });
  return idSchema.parse(await made.json()).id;
};

/** An admin's hand add of `userId` to `teamId`. */
const addByHand = async (
  session: string,
  teamId: string,
  userId: string
): Promise<void> => {
  const added = await callAuth("/organization/add-team-member", session, {
    teamId,
    userId,
  });
  await added.body?.cancel();
};

describe(
  "a member the directory lists as turned off",
  { timeout: 60_000 },
  () => {
    afterEach(endLiveResourceRuns);

    it("fails the next step of a workflow run acting for them, and starts runs again once lifted", async () => {
      await connectedDirectory(idp);
      const signed = await memberWith(crypto.randomUUID(), "builder");
      const { oid } = signed;
      const builder = await workflowPerson(signed);
      const { id } = await publishedWorkflow(builder, greetingTasks("1 day"));
      const runId = await startedBy(builder, id);
      await sleeping(runId, "hold:task");
      await directoryHolds([user({ id: oid, accountEnabled: false })]);
      // Suspended while the run waits: its next step doesn't run.
      await readAt(nextDay());
      await woken(runId, "hold:task");
      await finished(runId);
      await directoryHolds([user({ id: oid })]);
      await readAt(nextDay());
      const again = await workflowPerson(
        signed,
        await signedIn(idp, "microsoft", signed.person)
      );
      const suspendedRun = await endedRun(again, id, runId);
      const { id: next } = await publishedWorkflow(again, greetingTasks());
      const nextRun = await endedRun(again, next, await startedBy(again, next));

      expect({
        suspended: {
          status: suspendedRun.status,
          code: suspendedRun.error?.code,
        },
        lifted: nextRun.status,
      }).toStrictEqual({
        suspended: { status: "failed", code: "permission.person_inactive" },
        lifted: "completed",
      });
    });

    it("is suspended at once, everywhere they act, with everything of theirs kept, and lifted when the directory lists them on again", async () => {
      const { admin } = await connectedDirectory(idp);
      const team = await teamNamed(admin.session, `Kept ${unique()}`);
      const ida = await memberWith(crypto.randomUUID(), "builder");
      const [ann, bob] = [
        await memberWith(crypto.randomUUID()),
        await memberWith(crypto.randomUUID()),
      ];
      for (const each of [ida, ann, bob]) {
        // oxlint-disable-next-line no-await-in-loop -- one hand add at a time
        await addByHand(admin.session, team, each.userId);
      }
      // An App of hers, with a binding granted, and its stub acting for her.
      const { core } = await openRpc(ida.session);
      const api = core.authenticate();
      const { id: appId } = await api.apps.create({ name: `App ${unique()}` });
      const app = { type: "app" as const, appId };
      const { id: asked } = await api.permissions.request({
        subject: app,
        object: { type: "connection", connectionId: "connection-outlook" },
        actions: ["mail.list"],
        binding: "OUTLOOK",
      });
      await grantReviewed(admin.api, asked);
      const authority = authoritySchema.parse({
        subject: app,
        onBehalfOf: ida.userId,
        mode: "workflow",
        appVersion: 1,
      });
      const stub = async () => {
        const held = await envOf(authority).catch(() => {});
        return await outcome(
          (held === undefined
            ? undefined
            : connectionIn(held, "OUTLOOK")
          )?.call("mail.list", {}) ?? envOf(authority)
        );
      };
      // Her own Microsoft connection.
      const { url } = await api.connections.start({
        provider: "microsoft",
        scope: "personal",
      });
      const authorization = new URL(url);
      await routed(
        `/api/connections/callback?${new URLSearchParams({
          code: consentCode(authorization, acmeTenant, ida.oid),
          state: authorization.searchParams.get("state") ?? "",
        }).toString()}`,
        { headers: { cookie: ida.session } }
      );
      const tokens = async () =>
        await connectDb()
          .prepare(
            "SELECT count(*) AS n FROM connection_tokens t JOIN connections c ON c.id = t.connection_id WHERE c.account_id = ?"
          )
          .bind(ida.oid)
          .first<number>("n");
      // Her own agent, in a chat of hers.
      const chats = await personalChatsOf(
        ida.userId,
        says("Answered."),
        says("Answered.")
      );
      const { ask } = await chats.newChat();
      const agent = async () => await outcome(ask("Anything new?"));
      const before = {
        agent: await agent(),
        memberships: await membershipsOf(ida.userId),
        pins: await pinsOf(ida.userId),
        stub: await stub(),
        audience: await teamsOf(ann.userId),
      };
      await directoryHolds([
        user({ id: ida.oid, accountEnabled: false }),
        user({ id: ann.oid }),
        user({ id: bob.oid }),
      ]);

      const events = await auditedDuring(async () => {
        await readAt(nextDay());
      });
      const teamsPersonOfIda = teamsPerson(ida.oid);
      await post(messageFrom(teamsPersonOfIda, { text: "Hello?" }));
      const { activities } = await teamsReached(teamsPersonOfIda.conversation);
      const signInAgain = await signIn(idp, "microsoft", ida.person);
      const suspended = {
        session: await nowSignedIn(ida.session),
        sessions: await sessionsOf(ida.userId),
        signIn: signInAgain.session,
        stub: await stub(),
        agent: await agent(),
        teams: activities.some((each) =>
          JSON.stringify(each).includes("no longer have access")
        ),
        audience: await teamsOf(ann.userId),
        memberships: await membershipsOf(ida.userId),
        pins: await pinsOf(ida.userId),
        app: await env.DB.prepare("SELECT count(*) AS n FROM apps WHERE id = ?")
          .bind(appId)
          .first<number>("n"),
        tokens: await tokens(),
        recorded: events
          .filter(({ action }) => action === "member.suspended")
          .map(({ actor, detail }) => ({ actor, detail })),
      };
      await directoryHolds([
        user({ id: ida.oid }),
        user({ id: ann.oid }),
        user({ id: bob.oid }),
      ]);
      const liftEvents = await auditedDuring(async () => {
        await readAt(nextDay());
      });
      const again = await signedIn(idp, "microsoft", ida.person);

      expect({
        suspended,
        lifted: {
          session: await nowSignedIn(again),
          stub: await stub(),
          agent: await agent(),
          audience: await teamsOf(ann.userId),
          memberships: await membershipsOf(ida.userId),
          pins: await pinsOf(ida.userId),
          recorded: liftEvents.filter(
            ({ action }) => action === "member.unsuspended"
          ).length,
        },
      }).toStrictEqual({
        suspended: {
          session: "auth.unauthenticated",
          sessions: 0,
          signIn: undefined,
          stub: "permission.person_inactive",
          agent: "permission.person_inactive",
          teams: true,
          audience: [],
          memberships: before.memberships,
          pins: before.pins,
          app: 1,
          tokens: 1,
          recorded: [
            {
              actor: { type: "system" },
              detail: { userId: ida.userId, via: "directory" },
            },
          ],
        },
        lifted: {
          session: "builder",
          stub: before.stub,
          agent: "ok",
          audience: before.audience,
          memberships: before.memberships,
          pins: before.pins,
          recorded: 1,
        },
      });
      expect({ stub: before.stub, agent: before.agent }).toStrictEqual({
        stub: reached,
        agent: "ok",
      });
      expect(before.audience).toStrictEqual([team]);
    });

    it("never leaves the company without an admin: two admins turned off in one read both stay, and that is recorded", async () => {
      await connectedDirectory(idp);
      const [ada, ben, cas] = [
        await memberWith(crypto.randomUUID(), "admin"),
        await memberWith(crypto.randomUUID(), "admin"),
        await memberWith(crypto.randomUUID()),
      ];
      await onlyAdmins(ada.userId, ben.userId);
      await directoryHolds([
        user({ id: ada.oid, accountEnabled: false }),
        user({ id: ben.oid, accountEnabled: false }),
        user({ id: cas.oid, accountEnabled: false }),
      ]);

      const events = await auditedDuring(async () => {
        await readAt(nextDay());
      });

      expect({
        ada: await suspensionOf(ada.userId),
        ben: await suspensionOf(ben.userId),
        cas: await suspensionOf(cas.userId),
        withheld: events
          .filter(({ action }) => action === "member.suspension_withheld")
          .map(({ detail }) => String(detail?.userId))
          .toSorted(byText),
      }).toStrictEqual({
        ada: { suspended: 0, suspendedBy: null },
        ben: { suspended: 0, suspendedBy: null },
        cas: { suspended: 1, suspendedBy: "directory" },
        withheld: [ada.userId, ben.userId].toSorted(byText),
      });
    });

    it("suspends an admin turned off while another admin stays, and not once that admin is removed just before the read's batch", async () => {
      await connectedDirectory(idp);
      const [dan, eve] = [
        await memberWith(crypto.randomUUID(), "admin"),
        await memberWith(crypto.randomUUID(), "admin"),
      ];
      await onlyAdmins(dan.userId, eve.userId);
      await directoryHolds([
        user({ id: dan.oid, accountEnabled: false }),
        user({ id: eve.oid }),
      ]);
      const { core } = await openRpc(dan.session);
      const danApi = core.authenticate();
      // Eve goes as the read runs: Dan is then the company's last admin.
      const { coreEnv, landed } = landingAt(
        /insert into "directory_reads"/u,
        "before",
        async () => {
          await danApi.members.remove(eve.userId);
        }
      );

      await readAt(nextDay(), { DB: coreEnv.DB });
      const lastAdmin = await suspensionOf(dan.userId);
      // With another admin who stays, he is suspended.
      const fay = await memberWith(crypto.randomUUID(), "admin");
      await directoryHolds([
        user({ id: dan.oid, accountEnabled: false }),
        user({ id: fay.oid }),
      ]);
      await readAt(nextDay());

      expect({
        landed: landed(),
        lastAdmin,
        withAnother: await suspensionOf(dan.userId),
      }).toStrictEqual({
        landed: true,
        lastAdmin: { suspended: 0, suspendedBy: null },
        withAnother: { suspended: 1, suspendedBy: "directory" },
      });
    });

    it("doesn't count on an admin it suspended earlier whom the directory no longer lists, nor lift them", async () => {
      await connectedDirectory(idp);
      const [gil, dan] = [
        await memberWith(crypto.randomUUID(), "admin"),
        await memberWith(crypto.randomUUID(), "admin"),
      ];
      await onlyAdmins(gil.userId, dan.userId);
      await directoryHolds([
        user({ id: gil.oid, accountEnabled: false }),
        user({ id: dan.oid }),
      ]);
      await readAt(nextDay());
      const first = await suspensionOf(gil.userId);
      // Gil is gone from the directory; Dan is turned off.
      await directoryHolds([user({ id: dan.oid, accountEnabled: false })]);

      const events = await auditedDuring(async () => {
        await readAt(nextDay());
      });

      expect({
        first,
        gil: await suspensionOf(gil.userId),
        dan: await suspensionOf(dan.userId),
        withheld: events
          .filter(({ action }) => action === "member.suspension_withheld")
          .map(({ detail }) => detail?.userId),
      }).toStrictEqual({
        first: { suspended: 1, suspendedBy: "directory" },
        gil: { suspended: 1, suspendedBy: "directory" },
        dan: { suspended: 0, suspendedBy: null },
        withheld: [dan.userId],
      });
    });

    it("lifts only the suspensions the read made", async () => {
      await connectedDirectory(idp);
      const [gus, hal] = [
        await memberWith(crypto.randomUUID()),
        await memberWith(crypto.randomUUID()),
      ];
      await directoryHolds([
        user({ id: gus.oid, accountEnabled: false }),
        user({ id: hal.oid }),
      ]);
      await readAt(nextDay());
      // A suspension the read didn't make (an admin's, one day).
      await env.DB.prepare(
        "UPDATE members SET suspended_at = ?, suspended_by = 'admin' WHERE user_id = ?"
      )
        .bind(Date.now(), hal.userId)
        .run();
      await directoryHolds([user({ id: gus.oid }), user({ id: hal.oid })]);

      await readAt(nextDay());

      expect({
        gus: await suspensionOf(gus.userId),
        hal: await suspensionOf(hal.userId),
      }).toStrictEqual({
        gus: { suspended: 0, suspendedBy: null },
        hal: { suspended: 1, suspendedBy: "admin" },
      });
    });

    it("stays in an admin's hands: listed as any member, their role changed, and removed", async () => {
      const { admin } = await connectedDirectory(idp);
      const una = await memberWith(crypto.randomUUID());
      await directoryHolds([user({ id: una.oid, accountEnabled: false })]);
      await readAt(nextDay());
      const listed = async () => {
        const all = await admin.api.members.list();
        const entry = all.find(({ userId }) => userId === una.userId);
        // Times as their type: they are the test's own.
        return (
          entry && {
            ...entry,
            joinedAt: typeof entry.joinedAt,
            suspension: entry.suspension && {
              ...entry.suspension,
              since: typeof entry.suspension.since,
            },
          }
        );
      };

      const whileSuspended = await listed();
      const roleChanged = await outcome(
        admin.api.members.setRole(una.userId, "builder")
      );
      const afterRoleChange = await listed();
      const removed = await outcome(admin.api.members.remove(una.userId));

      expect({
        whileSuspended,
        roleChanged,
        role: afterRoleChange?.role,
        removed,
        afterRemoval: await listed(),
        suspension: await suspensionOf(una.userId),
      }).toStrictEqual({
        // As any member, with their suspension and its reason.
        whileSuspended: {
          userId: una.userId,
          name: una.name,
          email: String(una.person.email),
          role: "user",
          joinedAt: "string",
          suspension: { since: "string", reason: "disabled" },
          keptActiveSince: null,
        },
        roleChanged: "ok",
        role: "builder",
        removed: "ok",
        afterRemoval: undefined,
        suspension: null,
      });
    });

    it("can't be erased while merely suspended, and is removed and erased as anyone else", async () => {
      const { admin } = await connectedDirectory(idp);
      const ivy = await memberWith(crypto.randomUUID());
      await directoryHolds([user({ id: ivy.oid, accountEnabled: false })]);
      await readAt(nextDay());

      const erasedFirst = await outcome(
        admin.api.members.erase(ivy.userId, ivy.name)
      );
      await admin.api.members.remove(ivy.userId);
      const erased = await admin.api.members.erase(ivy.userId, ivy.name);

      expect({
        erasedFirst,
        completed: erased.completedAt !== null,
      }).toStrictEqual({
        erasedFirst: "member.erase_not_removed",
        completed: true,
      });
    });

    it("can't be cleared by the member, nor set by an admin, through Better Auth's API", async () => {
      const { admin } = await connectedDirectory(idp);
      const jan = await memberWith(crypto.randomUUID());
      await directoryHolds([user({ id: jan.oid, accountEnabled: false })]);
      await readAt(nextDay());
      const { id: memberId } = (await env.DB.prepare(
        "SELECT id FROM members WHERE user_id = ?"
      )
        .bind(jan.userId)
        .first<{ id: string }>()) ?? { id: "" };

      const statuses: number[] = [];
      for (const [session, path] of [
        [jan.session, "/organization/update-member-role"],
        [admin.session, "/organization/update-member-role"],
        [admin.session, "/organization/update-member"],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one call at a time
        const response = await callAuth(path, session, {
          memberId,
          role: "user",
          suspendedAt: null,
          suspendedBy: null,
          data: { suspendedAt: null, suspendedBy: null },
        });
        // oxlint-disable-next-line no-await-in-loop -- one call at a time
        await response.body?.cancel();
        statuses.push(response.status);
      }

      expect({
        statuses,
        jan: await suspensionOf(jan.userId),
      }).toStrictEqual({
        statuses: [404, 404, 404],
        jan: { suspended: 1, suspendedBy: "directory" },
      });
    });

    it("is removed, not suspended, when an admin removes them just before the read's batch, and a sign-in landing there is ended by it", async () => {
      const { admin } = await connectedDirectory(idp);
      const [kim, lou] = [
        await memberWith(crypto.randomUUID()),
        { oid: crypto.randomUUID() },
      ];
      await directoryHolds([
        user({ id: kim.oid, accountEnabled: false }),
        user({ id: lou.oid, accountEnabled: false }),
      ]);
      let louSession = "";
      let louId = "";
      const { coreEnv, landed } = landingAt(
        /insert into "directory_reads"/u,
        "before",
        async () => {
          await admin.api.members.remove(kim.userId);
          const signed = await memberWith(lou.oid);
          louSession = signed.session;
          louId = signed.userId;
        }
      );

      await readAt(nextDay(), { DB: coreEnv.DB });

      expect({
        landed: landed(),
        kim: await suspensionOf(kim.userId),
        lou: await suspensionOf(louId),
        louSession: await nowSignedIn(louSession),
        louSessions: await sessionsOf(louId),
      }).toStrictEqual({
        landed: true,
        kim: null,
        lou: { suspended: 1, suspendedBy: "directory" },
        louSession: "auth.unauthenticated",
        louSessions: 0,
      });
    });

    it("suspends nobody when a page of the read fails", async () => {
      await connectedDirectory(idp);
      const mia = await memberWith(crypto.randomUUID());
      await directoryHolds([
        user({ id: mia.oid, accountEnabled: false }),
        ...Array.from({ length: 120 }, () => user()),
      ]);
      await directoryFailsAt(100);

      await readAt(nextDay());

      await expect(suspensionOf(mia.userId)).resolves.toStrictEqual({
        suspended: 0,
        suspendedBy: null,
      });
    });

    it("leaves a suspended member's teams as they are when their department moves", async () => {
      const { admin } = await connectedDirectory(idp);
      const [from, to] = [
        await teamNamed(admin.session, `From ${unique()}`),
        await teamNamed(admin.session, `To ${unique()}`),
      ];
      const names = await env.DB.prepare(
        "SELECT id, name FROM teams WHERE id IN (?, ?)"
      )
        .bind(from, to)
        .all<{ id: string; name: string }>();
      const nameOf = (id: string) =>
        names.results.find((team) => team.id === id)?.name ?? "";
      const ned = await memberWith(crypto.randomUUID());
      await directoryHolds([user({ id: ned.oid, department: nameOf(from) })]);
      await readAt(nextDay());
      // Already in the team their department moves to, by an admin's hand:
      // only the suspension keeps the read from taking them out of the other.
      await addByHand(admin.session, to, ned.userId);
      const placed = await membershipsOf(ned.userId);
      // Turned off, and moved: suspended, and left where they are.
      await directoryHolds([
        user({ id: ned.oid, department: nameOf(to), accountEnabled: false }),
      ]);
      await readAt(nextDay());
      const whileSuspended = await membershipsOf(ned.userId);
      // Back on, in the new department: moved as anyone is.
      await directoryHolds([user({ id: ned.oid, department: nameOf(to) })]);
      await readAt(nextDay());

      expect({
        placed,
        whileSuspended,
        lifted: await membershipsOf(ned.userId),
      }).toStrictEqual({
        placed,
        whileSuspended: placed,
        lifted: [{ teamId: to, made: 0 }],
      });
      expect(placed).toStrictEqual(
        [
          { teamId: from, made: 1 },
          { teamId: to, made: 0 },
        ].toSorted((a, b) => byText(a.teamId, b.teamId))
      );
    });
  }
);

/** The read's own failure, if its last read failed, and why its last applied one went without the deleted users. */
const readStatus = async () =>
  await env.DB.prepare(
    "SELECT failure, deleted_failure AS deletedFailure FROM directory_reads WHERE provider = 'microsoft-directory'"
  ).first<{ failure: string | null; deletedFailure: string | null }>();

/** Whether the directory keeps a row for `oid`, and whether it is on. */
const rowOf = async (oid: string) =>
  await env.DB.prepare(
    "SELECT enabled FROM directory_people WHERE account_id = ?"
  )
    .bind(oid)
    .first<number>("enabled");

// Slice 3b: missing from the read, and in Entra's deleted users, is a
// leaver; missing alone is nobody's proof.
describe("a member whose directory account was deleted", () => {
  it("is suspended, and lifted once restored; missing alone, listed too, or a guest suspends nobody", async () => {
    await connectedDirectory(idp);
    const [ada, bea, cy, dee] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    // Ada deleted; Bea missing, not deleted; Cy deleted yet listed (the
    // lists disagree for a while, and Graph's case with them); Dee
    // deleted, as a guest.
    await directoryHolds(
      [user({ id: cy.oid })],
      [
        { id: ada.oid.toUpperCase(), userType: "Member" },
        { id: cy.oid.toUpperCase(), userType: "Member" },
        { id: dee.oid, userType: "Guest" },
      ]
    );

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });
    const deleted = {
      ada: await suspensionOf(ada.userId),
      bea: await suspensionOf(bea.userId),
      cy: await suspensionOf(cy.userId),
      dee: await suspensionOf(dee.userId),
      adaSession: await nowSignedIn(ada.session),
      status: await readStatus(),
      read: events.find(({ action }) => action === "directory.people_read")
        ?.detail,
    };
    // Restored: listed again, turned on.
    await directoryHolds([user({ id: ada.oid }), user({ id: cy.oid })]);
    await readAt(nextDay());

    expect({
      deleted,
      restored: await suspensionOf(ada.userId),
    }).toStrictEqual({
      deleted: {
        ada: { suspended: 1, suspendedBy: "directory" },
        bea: { suspended: 0, suspendedBy: null },
        cy: { suspended: 0, suspendedBy: null },
        dee: { suspended: 0, suspendedBy: null },
        adaSession: "auth.unauthenticated",
        status: { failure: null, deletedFailure: null },
        read: {
          provider: "microsoft-directory",
          people: 1,
          disabled: 0,
          deleted: 1,
          tied: 2,
        },
      },
      restored: { suspended: 0, suspendedBy: null },
    });
  });

  it("keeps no row for the many deleted accounts nobody signed in with, and still suspends the one a member did", async () => {
    await connectedDirectory(idp);
    const mo = await memberWith(crypto.randomUUID());
    const strangers = Array.from({ length: 250 }, () => crypto.randomUUID());
    await directoryHolds(
      [],
      [...strangers.map((id) => ({ id })), { id: mo.oid }]
    );

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });
    const { results } = await env.DB.prepare(
      "SELECT account_id AS id FROM directory_people WHERE enabled = 0"
    ).all<{ id: string }>();

    expect({
      kept: results.map(({ id }) => id),
      deleted: events.find(({ action }) => action === "directory.people_read")
        ?.detail?.deleted,
      mo: await suspensionOf(mo.userId),
    }).toStrictEqual({
      kept: [mo.oid],
      deleted: 1,
      mo: { suspended: 1, suspendedBy: "directory" },
    });
  });

  it("never leaves the company without an admin when every admin is deleted", async () => {
    await connectedDirectory(idp);
    const [eve, fin] = [
      await memberWith(crypto.randomUUID(), "admin"),
      await memberWith(crypto.randomUUID(), "admin"),
    ];
    await onlyAdmins(eve.userId, fin.userId);
    await directoryHolds([], [{ id: eve.oid }, { id: fin.oid }]);

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });

    expect({
      eve: await suspensionOf(eve.userId),
      fin: await suspensionOf(fin.userId),
      withheld: events.filter(
        ({ action }) => action === "member.suspension_withheld"
      ).length,
    }).toStrictEqual({
      eve: { suspended: 0, suspendedBy: null },
      fin: { suspended: 0, suspendedBy: null },
      withheld: 2,
    });
  });

  it("applies nothing, people included, when a later page of the deleted users fails, even refused, or links elsewhere", async () => {
    await connectedDirectory(idp);
    const gus = await memberWith(crypto.randomUUID());
    // Someone the read would list, to show its people part isn't kept either.
    const ivo = crypto.randomUUID();
    const deleted = [
      { id: gus.oid },
      ...Array.from({ length: 120 }, () => ({ id: crypto.randomUUID() })),
    ];
    const attempt = async (fail: () => Promise<void>) => {
      await directoryHolds([user({ id: ivo })], deleted);
      await fail();
      await readAt(nextDay());
      return {
        status: await readStatus(),
        gus: await suspensionOf(gus.userId),
        ivo: await rowOf(ivo),
      };
    };

    expect({
      serverError: await attempt(async () => {
        await deletedFailAt(100);
      }),
      refusedLater: await attempt(async () => {
        await deletedFailAt(100, 403);
      }),
      emptyLater: await attempt(async () => {
        await deletedFailAt(100, 200, "");
      }),
      notJsonLater: await attempt(async () => {
        await deletedFailAt(100, 200, "<html>Sign in</html>");
      }),
      elsewhere: await attempt(async () => {
        await deletedLinksTo(
          "https://graph.example.test/v1.0/users?$skiptoken=1"
        );
      }),
    }).toStrictEqual({
      serverError: {
        status: { failure: "directory.provider_failed", deletedFailure: null },
        gus: { suspended: 0, suspendedBy: null },
        ivo: null,
      },
      refusedLater: {
        status: { failure: "directory.deleted_refused", deletedFailure: null },
        gus: { suspended: 0, suspendedBy: null },
        ivo: null,
      },
      emptyLater: {
        status: {
          failure: "directory.deleted_unsupported",
          deletedFailure: null,
        },
        gus: { suspended: 0, suspendedBy: null },
        ivo: null,
      },
      notJsonLater: {
        status: {
          failure: "directory.deleted_unsupported",
          deletedFailure: null,
        },
        gus: { suspended: 0, suspendedBy: null },
        ivo: null,
      },
      elsewhere: {
        status: { failure: "directory.provider_failed", deletedFailure: null },
        gus: { suspended: 0, suspendedBy: null },
        ivo: null,
      },
    });
  });

  it("goes on without them when their first page came but isn't a list, empty or not JSON, and says so", async () => {
    await connectedDirectory(idp);
    const attempt = async (body: string) => {
      const [jan, kai, lee] = [
        await memberWith(crypto.randomUUID()),
        await memberWith(crypto.randomUUID()),
        await memberWith(crypto.randomUUID()),
      ];
      await directoryHolds(
        [user({ id: jan.oid, accountEnabled: false }), user({ id: lee.oid })],
        [{ id: kai.oid }]
      );
      await deletedFailAt(0, 200, body);
      await readAt(nextDay());
      return {
        status: await readStatus(),
        jan: await suspensionOf(jan.userId),
        kai: await suspensionOf(kai.userId),
        lee: await rowOf(lee.oid),
      };
    };
    // The read as before 3b: people, ties and 3a's suspensions.
    const asBefore = {
      status: {
        failure: null,
        deletedFailure: "directory.deleted_unsupported",
      },
      jan: { suspended: 1, suspendedBy: "directory" },
      kai: { suspended: 0, suspendedBy: null },
      lee: 1,
    };

    expect({
      empty: await attempt(""),
      notJson: await attempt("<html>Sign in</html>"),
    }).toStrictEqual({ empty: asBefore, notJson: asBefore });
  });

  it("goes on without them when the deleted users are refused outright, says so, and reads them again next day", async () => {
    await connectedDirectory(idp);
    const [jan, kai, lee] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    // Jan turned off, Kai deleted (and so missing), Lee listed.
    const holds = async () => {
      await directoryHolds(
        [user({ id: jan.oid, accountEnabled: false }), user({ id: lee.oid })],
        [{ id: kai.oid }]
      );
    };
    await holds();
    await deletedFailAt(0, 403);

    const events = await auditedDuring(async () => {
      await readAt(nextDay());
    });
    const refused = {
      status: await readStatus(),
      jan: await suspensionOf(jan.userId),
      kai: await suspensionOf(kai.userId),
      lee: await rowOf(lee.oid),
      deleted: events.find(({ action }) => action === "directory.people_read")
        ?.detail?.deleted,
    };
    // The next day's read is answered: Kai's deletion is read then.
    await holds();
    await readAt(nextDay());

    expect({
      refused,
      nextDay: {
        status: await readStatus(),
        kai: await suspensionOf(kai.userId),
      },
    }).toStrictEqual({
      refused: {
        // The read as before 3b: people, ties and 3a's suspensions.
        status: { failure: null, deletedFailure: "directory.deleted_refused" },
        jan: { suspended: 1, suspendedBy: "directory" },
        kai: { suspended: 0, suspendedBy: null },
        lee: 1,
        deleted: 0,
      },
      nextDay: {
        status: { failure: null, deletedFailure: null },
        kai: { suspended: 1, suspendedBy: "directory" },
      },
    });
  });

  it("keeps nothing of an erased person the deleted users still hold", async () => {
    const { admin } = await connectedDirectory(idp);
    const hal = await memberWith(crypto.randomUUID());
    await admin.api.members.remove(hal.userId);
    await admin.api.members.erase(hal.userId, hal.name);
    await directoryHolds([], [{ id: hal.oid }]);

    await readAt(nextDay());

    expect({
      status: await readStatus(),
      row: await rowOf(hal.oid),
    }).toStrictEqual({
      status: { failure: null, deletedFailure: null },
      row: null,
    });
  });
});

/** When an admin's mark keeps `userId` active; null for none. */
const keptActiveOf = async (userId: string) =>
  await env.DB.prepare(
    "SELECT kept_active_at IS NOT NULL AS kept FROM members WHERE user_id = ?"
  )
    .bind(userId)
    .first<number>("kept");

/** The events of `events` recorded as `action`: who, on what, about whom. */
const recordedAs = (
  action: string,
  events: Awaited<ReturnType<typeof auditedDuring>>
) =>
  events
    .filter((event) => event.action === action)
    .map(({ actor, target, detail }) => ({
      actor: actor.type,
      by: "userId" in actor ? actor.userId : null,
      target: target?.type,
      detail,
    }));

/** How many sessions `userId` holds now. */
const sessionCount = async (userId: string) =>
  await env.DB.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ?")
    .bind(userId)
    .first<number>("n");

// GRA-2141: an admin lifts a suspension and keeps the member active; the
// read respects that until an admin lets the directory decide again.
describe("a suspension an admin lifts", () => {
  it("stays lifted through later reads, until an admin lets the directory decide, audited both ways", async () => {
    const { admin } = await connectedDirectory(idp);
    const ann = await memberWith(crypto.randomUUID());
    await directoryHolds([user({ id: ann.oid, accountEnabled: false })]);
    await readAt(nextDay());
    const listed = async () => {
      const everyone = await admin.api.members.list();
      return everyone.find(({ userId }) => userId === ann.userId);
    };
    const suspended = await listed();

    const lifting = await auditedDuring(async () => {
      await admin.api.members.liftSuspension(ann.userId);
    });
    const lifted = {
      suspension: await suspensionOf(ann.userId),
      kept: await keptActiveOf(ann.userId),
      sessions: await sessionCount(ann.userId),
      listed: await listed(),
    };
    // Still turned off in the directory: the next read leaves them active.
    await readAt(nextDay());
    const afterRead = await suspensionOf(ann.userId);
    const again = await signedIn(idp, "microsoft", ann.person);
    const signedInAgain = await nowSignedIn(again);
    const releasing = await auditedDuring(async () => {
      await admin.api.members.letDirectoryDecide(ann.userId);
    });
    const kept = await keptActiveOf(ann.userId);
    await readAt(nextDay());

    expect({
      suspended: suspended?.suspension?.reason,
      lifted: {
        ...lifted,
        listed: {
          suspension: lifted.listed?.suspension,
          kept: typeof lifted.listed?.keptActiveSince,
        },
      },
      lifting: recordedAs("member.suspension_lifted", lifting),
      afterRead,
      signedInAgain,
      releasing: recordedAs("member.kept_active_released", releasing),
      kept,
      decided: await suspensionOf(ann.userId),
    }).toStrictEqual({
      suspended: "disabled",
      lifted: {
        suspension: { suspended: 0, suspendedBy: null },
        kept: 1,
        // No session is minted: they sign in again.
        sessions: 0,
        listed: { suspension: null, kept: "string" },
      },
      lifting: [
        {
          actor: "person",
          by: admin.userId,
          target: "member",
          detail: { userId: ann.userId },
        },
      ],
      afterRead: { suspended: 0, suspendedBy: null },
      signedInAgain: "user",
      releasing: [
        {
          actor: "person",
          by: admin.userId,
          target: "member",
          detail: { userId: ann.userId },
        },
      ],
      kept: 0,
      decided: { suspended: 1, suspendedBy: "directory" },
    });
  });

  it("is lifted only by a company admin, never by Grasp staff, a builder, oneself, or for someone not suspended, removed or erased", async () => {
    const { admin } = await connectedDirectory(idp);
    const [bo, cy, di] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    await directoryHolds([
      user({ id: bo.oid, accountEnabled: false }),
      user({ id: cy.oid }),
      user({ id: di.oid, accountEnabled: false }),
    ]);
    await readAt(nextDay());
    const builder = await signedInApi(idp, "builder");
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    const staffApi = core.authenticate();
    await admin.api.members.remove(di.userId);
    await admin.api.members.erase(di.userId, di.name);

    expect({
      staff: await outcome(staffApi.members.liftSuspension(bo.userId)),
      staffRelease: await outcome(
        staffApi.members.letDirectoryDecide(bo.userId)
      ),
      builder: await outcome(builder.api.members.liftSuspension(bo.userId)),
      self: await outcome(admin.api.members.liftSuspension(admin.userId)),
      notSuspended: await outcome(admin.api.members.liftSuspension(cy.userId)),
      erased: await outcome(admin.api.members.liftSuspension(di.userId)),
      releaseNone: await admin.api.members.letDirectoryDecide(cy.userId),
      bo: await suspensionOf(bo.userId),
    }).toStrictEqual({
      staff: "role.forbidden",
      staffRelease: "role.forbidden",
      builder: "role.forbidden",
      self: "member.self",
      notSuspended: "member.not_suspended",
      erased: "member.not_found",
      releaseNone: { released: false },
      bo: { suspended: 1, suspendedBy: "directory" },
    });
  });

  it("can't be lifted by a suspended admin, for themselves or anyone", async () => {
    await connectedDirectory(idp);
    const [eli, fay, gil] = [
      await memberWith(crypto.randomUUID(), "admin"),
      await memberWith(crypto.randomUUID(), "admin"),
      await memberWith(crypto.randomUUID()),
    ];
    await onlyAdmins(eli.userId, fay.userId);
    // Eli's connection, opened while they could still act.
    const { core } = await openRpc(eli.session);
    const eliApi = core.authenticate();
    await directoryHolds([
      user({ id: eli.oid, accountEnabled: false }),
      user({ id: fay.oid }),
      user({ id: gil.oid, accountEnabled: false }),
    ]);
    await readAt(nextDay());

    const refused = {
      self: await outcome(eliApi.members.liftSuspension(eli.userId)),
      other: await outcome(eliApi.members.liftSuspension(gil.userId)),
    };

    expect({
      refused: Object.values(refused).every((code) => code !== "ok"),
      eli: await suspensionOf(eli.userId),
      gil: await suspensionOf(gil.userId),
    }).toStrictEqual({
      refused: true,
      eli: { suspended: 1, suspendedBy: "directory" },
      gil: { suspended: 1, suspendedBy: "directory" },
    });
  });

  it("holds against a read landing just before the lift, and one landing just after it", async () => {
    const { admin } = await connectedDirectory(idp);
    const [hal, ivy] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    await directoryHolds([
      user({ id: hal.oid, accountEnabled: false }),
      user({ id: ivy.oid, accountEnabled: false }),
    ]);
    await readAt(nextDay());
    // Hal: the next read applies its batch just before the lift's update.
    const before = landingAt(
      /update "members" set "suspended_at"/u,
      "before",
      async () => {
        await readAt(nextDay());
      }
    );
    const { core } = await openRpc(admin.session, { coreEnv: before.coreEnv });
    await core.authenticate().members.liftSuspension(hal.userId);
    // Ivy: the lift lands inside the next read, just before its batch.
    const after = landingAt(
      /insert into "directory_reads"/u,
      "before",
      async () => {
        await admin.api.members.liftSuspension(ivy.userId);
      }
    );
    await readAt(nextDay(), { DB: after.coreEnv.DB });

    expect({
      landed: [before.landed(), after.landed()],
      hal: await suspensionOf(hal.userId),
      halKept: await keptActiveOf(hal.userId),
      ivy: await suspensionOf(ivy.userId),
      ivyKept: await keptActiveOf(ivy.userId),
    }).toStrictEqual({
      landed: [true, true],
      hal: { suspended: 0, suspendedBy: null },
      halKept: 1,
      ivy: { suspended: 0, suspendedBy: null },
      ivyKept: 1,
    });
  });

  it("changes nothing when an admin removes them just before the lift", async () => {
    const { admin } = await connectedDirectory(idp);
    const jo = await memberWith(crypto.randomUUID());
    const other = await signedInApi(idp, "admin");
    await directoryHolds([user({ id: jo.oid, accountEnabled: false })]);
    await readAt(nextDay());
    const removing = landingAt(
      /update "members" set "suspended_at"/u,
      "before",
      async () => {
        await other.api.members.remove(jo.userId);
      }
    );
    const { core } = await openRpc(admin.session, {
      coreEnv: removing.coreEnv,
    });

    const lifted = await outcome(
      core.authenticate().members.liftSuspension(jo.userId)
    );

    expect({
      landed: removing.landed(),
      lifted,
      row: await suspensionOf(jo.userId),
    }).toStrictEqual({
      landed: true,
      lifted: "member.not_found",
      row: null,
    });
  });

  it("changes nothing when the admin lifting or releasing is removed just before", async () => {
    const { admin } = await connectedDirectory(idp);
    const [pia, quinn] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    const lifter = await signedInApi(idp, "admin");
    await directoryHolds([
      user({ id: pia.oid, accountEnabled: false }),
      user({ id: quinn.oid, accountEnabled: false }),
    ]);
    await readAt(nextDay());
    await admin.api.members.liftSuspension(quinn.userId);
    // The lifter's lift of Pia, and their release of Quinn, each with the
    // lifter removed by the other admin just before.
    const attempt = async (
      call: (api: typeof lifter.api) => Promise<unknown>
    ) => {
      const removed = landingAt(/update "members" set/u, "before", async () => {
        await admin.api.members.remove(lifter.userId);
      });
      const { core } = await openRpc(lifter.session, {
        coreEnv: removed.coreEnv,
      });
      const answered = await outcome(call(core.authenticate()));
      return { landed: removed.landed(), answered };
    };

    const lift = await attempt(async (api) => {
      await api.members.liftSuspension(pia.userId);
    });

    expect({
      lift,
      pia: await suspensionOf(pia.userId),
    }).toStrictEqual({
      lift: { landed: true, answered: "role.forbidden" },
      pia: { suspended: 1, suspendedBy: "directory" },
    });
    const releaser = await signedInApi(idp, "admin");
    const removedFirst = landingAt(
      /update "members" set "kept_active_at"/u,
      "before",
      async () => {
        await admin.api.members.remove(releaser.userId);
      }
    );
    const { core } = await openRpc(releaser.session, {
      coreEnv: removedFirst.coreEnv,
    });
    const release = await outcome(
      core.authenticate().members.letDirectoryDecide(quinn.userId)
    );
    expect({
      landed: removedFirst.landed(),
      release,
      quinnKept: await keptActiveOf(quinn.userId),
    }).toStrictEqual({
      landed: true,
      release: "role.forbidden",
      quinnKept: 1,
    });
  });

  it("keeps an admin it keeps active counted as one who stays, so another admin turned off is suspended", async () => {
    const { admin } = await connectedDirectory(idp);
    const [kim, lou] = [
      await memberWith(crypto.randomUUID(), "admin"),
      await memberWith(crypto.randomUUID(), "admin"),
    ];
    // Kim is suspended while Lou stays, then kept active by an admin.
    await directoryHolds([
      user({ id: kim.oid, accountEnabled: false }),
      user({ id: lou.oid }),
    ]);
    await readAt(nextDay());
    await admin.api.members.liftSuspension(kim.userId);
    await onlyAdmins(kim.userId, lou.userId);
    // Lou turned off too: Kim, kept active, is the admin who stays.
    await directoryHolds([
      user({ id: kim.oid, accountEnabled: false }),
      user({ id: lou.oid, accountEnabled: false }),
    ]);

    await readAt(nextDay());

    expect({
      kim: await suspensionOf(kim.userId),
      lou: await suspensionOf(lou.userId),
    }).toStrictEqual({
      kim: { suspended: 0, suspendedBy: null },
      lou: { suspended: 1, suspendedBy: "directory" },
    });
  });

  it("lists why each member is suspended: turned off, deleted, or no longer in the directory", async () => {
    const { admin } = await connectedDirectory(idp);
    const [mia, ned, oz] = [
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
      await memberWith(crypto.randomUUID()),
    ];
    // Mia turned off; Ned turned off, then deleted; Oz turned off, then
    // gone from the directory altogether (purged): all still suspended.
    await directoryHolds([
      user({ id: mia.oid, accountEnabled: false }),
      user({ id: ned.oid, accountEnabled: false }),
      user({ id: oz.oid, accountEnabled: false }),
    ]);
    await readAt(nextDay());
    await directoryHolds(
      [user({ id: mia.oid, accountEnabled: false })],
      [{ id: ned.oid }]
    );
    await readAt(nextDay());

    const everyone = await admin.api.members.list();
    const reasons = Object.fromEntries(
      everyone.flatMap(({ userId, suspension }) =>
        [mia, ned, oz].some((each) => each.userId === userId)
          ? [[userId, suspension?.reason]]
          : []
      )
    );

    expect(reasons).toStrictEqual({
      [mia.userId]: "disabled",
      [ned.userId]: "deleted",
      [oz.userId]: "unlisted",
    });
  });
});
