import { connectErrors } from "@grasp-os/shared/connect";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { codeResults, codeStep, chatOf, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { consentCode } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// Pointing Stephen, the chat's agent, at a shared mailbox, for named
// people (GRA-724). These start from the ways it can fail: a shared
// mailbox read without a pointer, or by someone it doesn't name; a sort
// run without its person's press; a pointer changed by someone who isn't
// the company's own admin (Grasp staff included), or without a trace; an
// address in another case counting as another mailbox; the right to
// shared mailboxes asked while nothing is pointed at.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

type Admin = Awaited<ReturnType<typeof signedInApi>>;

const notPointed = connectErrors.create("connect.mailbox_not_pointed").message;

/** A shared Microsoft 365 mailbox, as an admin connects it. */
const connectShared = async (admin: Admin) => {
  const subject = `team-${crypto.randomUUID()}`;
  const { url } = await admin.api.connections.start({
    provider: "microsoft",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, subject),
    state: authorization.searchParams.get("state") ?? "",
  });
  await routed(`/api/connections/callback?${query.toString()}`, {
    headers: { cookie: admin.session },
  });
  const mailbox = `${subject}@acme.test`;
  const listed = await admin.api.connections.list();
  const connection = listed.find(({ accountName }) => accountName === mailbox);
  if (connection === undefined) {
    throw new Error("Expected the shared connection");
  }
  return { id: connection.id, mailbox };
};

/** A team of the company's, with `userIds` in it. */
const teamOf = async (...userIds: string[]): Promise<string> => {
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Service', 'organization', ?)"
    ).bind(team, Date.now()),
    ...userIds.map((userId) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, userId, Date.now())
    ),
  ]);
  return team;
};

/**
 * A chat of `personId`'s whose code lists the shared mailbox and moves a
 * message in it to the archive, through `MAIL`, which the admin granted
 * its agent both for, then says what each call answered, or why it was
 * refused.
 */
const chatSorting = async (
  admin: Admin,
  personId: string,
  mailbox: string,
  connectionId: string
) => {
  const chat = await chatOf(
    personId,
    codeStep(
      `export default async (self, env) => {
        const tried = async (action, input) => { try { const { pending } = await env.connections.call("MAIL", action, input); return pending === null ? "done" : "held"; } catch (error) { return error.message; } };
        return {
          list: await tried("mail.list", { mailbox: ${JSON.stringify(mailbox.toUpperCase())} }),
          move: await tried("mail.move", { mailbox: ${JSON.stringify(mailbox)}, message: "m-1", destination: "archive" }),
        };
      };`
    ),
    says("Done.")
  );
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "connection", connectionId },
    actions: ["mail.list", "mail.move"],
    binding: "MAIL",
  });
  return async () => {
    await chat.ask("Sort the shared inbox.");
    const [result] = await codeResults(chat.stub, chat.chat.id);
    return result?.text;
  };
};

const answer = (answers: { list: string; move: string }) =>
  `Returned:\n${JSON.stringify(answers)}`;

/** The rights a person's own consent asks Microsoft for. */
const askedRights = async (person: Admin) => {
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  return new URL(url).searchParams.get("scope")?.split(" ") ?? [];
};

describe("a shared mailbox", setUpTime, () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM shared_mailbox_pointers").run();
  });

  it("is refused to the chat's agent until an admin points it there, and only for the people named, who sort it from a press", async () => {
    const admin = await signedInApi(idp, "admin");
    const named = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const { id, mailbox } = await connectShared(admin);

    const before = await chatSorting(admin, named.userId, mailbox, id);
    await expect(before()).resolves.toBe(
      answer({ list: notPointed, move: notPointed })
    );

    // Named in another case: the same mailbox.
    await admin.api.connections.pointSharedMailbox(mailbox.toUpperCase(), {
      who: "teams",
      teams: [await teamOf(named.userId)],
    });
    const theirs = await chatSorting(admin, named.userId, mailbox, id);
    // The sort waits for its person's press: nothing moved yet.
    await expect(theirs()).resolves.toBe(
      answer({ list: "done", move: "held" })
    );
    const others = await chatSorting(admin, outside.userId, mailbox, id);
    await expect(others()).resolves.toBe(
      answer({ list: notPointed, move: notPointed })
    );

    // Pointed at for nobody again: refused again.
    await admin.api.connections.pointSharedMailbox(mailbox, { who: "nobody" });
    const after = await chatSorting(admin, named.userId, mailbox, id);
    await expect(after()).resolves.toBe(
      answer({ list: notPointed, move: notPointed })
    );
  });

  it("asks Microsoft for shared mailboxes' rights only once one is pointed at", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");

    const before = await askedRights(person);
    await admin.api.connections.pointSharedMailbox("invoices@acme.test", {
      who: "everyone",
    });
    const after = await askedRights(person);

    expect({
      before: before.includes("Mail.ReadWrite.Shared"),
      after: after.includes("Mail.ReadWrite.Shared"),
      // Sending from it comes with Reach others, which is off.
      sendsShared: after.includes("Mail.Send.Shared"),
    }).toStrictEqual({ before: false, after: true, sendsShared: false });
  });

  it("is pointed at by the company's admins only, never by Grasp staff, and each change is audited once", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const refused = await Promise.all([
      outcome(
        member.api.connections.pointSharedMailbox("invoices@acme.test", {
          who: "everyone",
        })
      ),
      outcome(
        staff.connections.pointSharedMailbox("invoices@acme.test", {
          who: "everyone",
        })
      ),
      outcome(
        admin.api.connections.pointSharedMailbox("not an address", {
          who: "everyone",
        })
      ),
      outcome(
        admin.api.connections.pointSharedMailbox("invoices@acme.test", {
          who: "teams",
          teams: [crypto.randomUUID()],
        })
      ),
      outcome(member.api.connections.sharedMailboxes()),
    ]);
    expect(refused).toStrictEqual([
      "role.forbidden",
      "role.forbidden",
      "connection.invalid",
      "connection.invalid",
      "role.forbidden",
    ]);

    const events = await auditedDuring(async () => {
      await admin.api.connections.pointSharedMailbox("Invoices@acme.test", {
        who: "everyone",
      });
      // The same again: nothing changes, nothing is recorded.
      await admin.api.connections.pointSharedMailbox("invoices@acme.test", {
        who: "everyone",
      });
    });
    expect(
      events
        .filter(({ action }) => action === "connection.mailbox.pointed")
        .map(({ actor, target, detail }) => ({ actor, target, detail }))
    ).toStrictEqual([
      {
        actor: { type: "person", userId: admin.userId },
        target: { type: "shared_mailbox", id: "invoices@acme.test" },
        detail: { mailbox: "invoices@acme.test", who: "everyone" },
      },
    ]);
    await expect(
      admin.api.connections.sharedMailboxes()
    ).resolves.toMatchObject([
      {
        mailbox: "invoices@acme.test",
        audience: { who: "everyone" },
        changedBy: admin.userId,
      },
    ]);
  });
});
