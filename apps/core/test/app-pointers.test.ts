import { connectErrors } from "@grasp-os/shared/connect";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Company apps through Composio, by class (GRA-725): the chat's agent
// reads in an app only where an admin pointed it, for its person, within
// the resources the pointer names; its changes there follow the company's
// classes and wait for its person's press. These start from the ways it
// can fail: a read in an app nobody pointed it at, or by someone the
// pointer doesn't take in; a read of another resource; a change that runs
// without its press, or while its class is off; a pointer at a native or
// unknown connection, or changed by someone who isn't the company's own
// admin (Grasp staff included), or without a trace.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

type Admin = Awaited<ReturnType<typeof signedInApi>>;

const message = (code: Parameters<typeof connectErrors.create>[0]) =>
  connectErrors.create(code).message;

/**
 * A mail app whose admin allowed searching it (a read whose resource is
 * the query) and sending from it, pointed at for nobody yet.
 */
const mailApp = async (admin: Admin) => {
  const mail = await mailConnection(
    [],
    ["mail.send", { name: "mail.search", read: true, resource: "query" }]
  );
  await admin.api.connections.pointApp({
    connectionId: mail.id,
    resources: [],
    audience: { who: "nobody" },
  });
  return mail;
};

/**
 * A chat of `personId`'s whose code searches the app for `invoice` and
 * `salary` and sends a mail from it, through `MAIL`, which the admin
 * granted its agent for, then says how each call ended.
 */
const chatUsing = async (
  admin: Admin,
  personId: string,
  connectionId: string
) => {
  const chat = await chatOf(
    personId,
    codeStep(
      `export default async (self, env) => {
        const tried = async (action, input) => { try { const { pending } = await env.connections.call("MAIL", action, input); return pending === null ? "done" : "held"; } catch (error) { return error.message; } };
        return {
          invoice: await tried("mail.search", { query: "invoice" }),
          salary: await tried("mail.search", { query: "salary" }),
          send: await tried("mail.send", { to: "ben@acme.test", subject: "Status" }),
        };
      };`
    ),
    says("Done.")
  );
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "connection", connectionId },
    actions: ["mail.search", "mail.send"],
    binding: "MAIL",
  });
  return async () => {
    await chat.ask("Look in the app.");
    const [result] = await codeResults(chat.stub, chat.chat.id);
    return result?.text;
  };
};

const answer = (answers: { invoice: string; salary: string; send: string }) =>
  `Returned:\n${JSON.stringify(answers)}`;

/** A team of the company's, with `userIds` in it. */
const teamOf = async (...userIds: string[]): Promise<string> => {
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Sales', 'organization', ?)"
    ).bind(team, Date.now()),
    ...userIds.map((userId) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, userId, Date.now())
    ),
  ]);
  return team;
};

describe("a company app", setUpTime, () => {
  it("isn't read by the chat's agent until an admin points it there, and its sends wait for the person's press", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const mail = await mailApp(admin);

    const before = await chatUsing(admin, person.userId, mail.id);
    await expect(before()).resolves.toBe(
      answer({
        invoice: message("connect.app_not_pointed"),
        salary: message("connect.app_not_pointed"),
        send: "held",
      })
    );

    await admin.api.connections.pointApp({
      connectionId: mail.id,
      resources: [],
      audience: { who: "everyone" },
    });
    const after = await chatUsing(admin, person.userId, mail.id);
    await expect(after()).resolves.toBe(
      answer({ invoice: "done", salary: "done", send: "held" })
    );
    // Held for the person: nothing sent yet.
    await expect(mail.did()).resolves.toMatchObject({ sent: [] });
  });

  it("is read only within the resources it is pointed at, by the people it takes in", async () => {
    const admin = await signedInApi(idp, "admin");
    const named = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const mail = await mailApp(admin);
    await admin.api.connections.pointApp({
      connectionId: mail.id,
      resources: ["invoice"],
      audience: { who: "teams", teams: [await teamOf(named.userId)] },
    });

    const theirs = await chatUsing(admin, named.userId, mail.id);
    await expect(theirs()).resolves.toBe(
      answer({
        invoice: "done",
        salary: message("connect.resource_not_pointed"),
        send: "held",
      })
    );
    const others = await chatUsing(admin, outside.userId, mail.id);
    await expect(others()).resolves.toBe(
      answer({
        invoice: message("connect.app_not_pointed"),
        salary: message("connect.app_not_pointed"),
        send: "held",
      })
    );
    // Only the search the pointer names reached the app.
    await expect(mail.searched()).resolves.toStrictEqual(["invoice"]);
  });

  it("refuses a change while its class is off for the company", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const mail = await mailApp(admin);
    await admin.api.connections.setToolClass("reach-others", { who: "nobody" });

    const chat = await chatUsing(admin, person.userId, mail.id);
    await expect(chat()).resolves.toBe(
      answer({
        invoice: message("connect.app_not_pointed"),
        salary: message("connect.app_not_pointed"),
        send: message("connect.class_off"),
      })
    );
  });

  it("is pointed at by the company's admins only, never by Grasp staff, and only a company app's connection", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const mail = await mailApp(admin);
    const pointer = {
      connectionId: mail.id,
      resources: ["invoice"],
      audience: { who: "everyone" as const },
    };

    expect({
      member: await outcome(member.api.connections.pointApp(pointer)),
      memberReads: await outcome(member.api.connections.appPointers()),
      staff: await outcome(staff.connections.pointApp(pointer)),
      unknown: await outcome(
        admin.api.connections.pointApp({
          ...pointer,
          connectionId: crypto.randomUUID(),
        })
      ),
      unknownTeam: await outcome(
        admin.api.connections.pointApp({
          ...pointer,
          audience: { who: "teams", teams: [crypto.randomUUID()] },
        })
      ),
    }).toStrictEqual({
      member: "role.forbidden",
      memberReads: "role.forbidden",
      staff: "role.forbidden",
      unknown: "connection.invalid",
      unknownTeam: "connection.invalid",
    });

    const events = await auditedDuring(async () => {
      await admin.api.connections.pointApp(pointer);
      // The same again: nothing changes, nothing is recorded.
      await admin.api.connections.pointApp(pointer);
    });
    expect(
      events
        .filter(({ action }) => action === "connection.app.pointed")
        .map(({ actor, target, detail }) => ({ actor, target, detail }))
    ).toStrictEqual([
      {
        actor: { type: "person", userId: admin.userId },
        target: { type: "connection", id: mail.id },
        detail: {
          connectionId: mail.id,
          who: "everyone",
          resources: JSON.stringify(["invoice"]),
        },
      },
    ]);
    const pointers = await admin.api.connections.appPointers();
    expect(
      pointers.find(({ connectionId }) => connectionId === mail.id)
    ).toMatchObject({
      resources: ["invoice"],
      audience: { who: "everyone" },
      changedBy: admin.userId,
    });
  });
});
