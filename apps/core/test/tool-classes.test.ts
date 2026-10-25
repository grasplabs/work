import {
  connectErrors,
  defaultToolClassAudiences,
} from "@grasp-os/shared/connect";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { codeResults, codeStep, chatOf, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
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
import { testBinding } from "./test-env.ts";

// The classes a company turned on, as core keeps them and checks the chat's
// agent's calls against before it signs anything for connect. These start
// from the ways it can fail: a call of a class that is off reaches connect
// (and so Microsoft) anyway; a class on for one team lets everyone in; a
// change leaves no trace, or is made by someone who isn't the company's own
// admin, Grasp staff included; a change to nothing is recorded as one.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

type Admin = Awaited<ReturnType<typeof signedInApi>>;

/**
 * A shared Microsoft 365 mailbox, as an admin connects it: granted
 * `granted`, if given, or made before connect kept grants.
 */
const connectShared = async (admin: Admin, granted?: string) => {
  const subject = `team-${crypto.randomUUID()}`;
  const { url } = await admin.api.connections.start({
    provider: "microsoft",
    scope: "shared",
  });
  const authorization = new URL(url);
  const query = new URLSearchParams({
    code: consentCode(authorization, acmeTenant, subject, granted),
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

/** A grant that holds Read company's rights. */
const readCompanyGrant =
  "openid profile email offline_access User.Read Mail.ReadWrite Files.Read.All Sites.Read.All Calendars.Read.Shared Tasks.Read";

const sentSchema = z.array(z.object({ subject: z.string() }).loose());

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The mail Graph sent with `subject`: none, unless connect sent it. */
const sentWith = async (subject: string) => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(graphSentUrl);
  return sentSchema
    .parse(await response.json())
    .filter((sent) => sent.subject === subject);
};

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

/**
 * A chat of `personId`'s whose code lists the shared mailbox and sends
 * from it, through `MAIL`, which the admin granted its agent both for,
 * then says what each call answered, or why it was refused.
 */
const chatCalling = async (
  admin: Admin,
  personId: string,
  mailbox: string,
  connectionId: string
) => {
  const subject = `Invoice ${crypto.randomUUID()}`;
  const chat = await chatOf(
    personId,
    codeStep(
      `export default async (self, env) => {
        const tried = async (action, input) => { try { const { pending } = await env.connections.call("MAIL", action, input); return pending === null ? "done" : "held"; } catch (error) { return error.message; } };
        return {
          list: await tried("mail.list", { mailbox: ${JSON.stringify(mailbox)} }),
          send: await tried("mail.send", { mailbox: ${JSON.stringify(mailbox)}, to: ["ben@acme.test"], subject: ${JSON.stringify(subject)}, body: "Attached." }),
        };
      };`
    ),
    says("Done.")
  );
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "connection", connectionId },
    actions: ["mail.list", "mail.send"],
    binding: "MAIL",
  });
  return {
    subject,
    answered: async () => {
      await chat.ask("List the mailbox and send Ben the invoice.");
      const [result] = await codeResults(chat.stub, chat.chat.id);
      return result?.text;
    },
  };
};

/**
 * Points the chat's agent at the shared `mailbox` for everyone: a shared
 * mailbox is reached only once pointed at (shared-mailboxes.test.ts).
 */
const pointedAt = async (admin: Admin, mailbox: string): Promise<void> => {
  await admin.api.connections.pointSharedMailbox(mailbox, { who: "everyone" });
};

const answer = (answers: { list: string; send: string }) =>
  `Returned:\n${JSON.stringify(answers)}`;

const off = connectErrors.create("connect.class_off").message;

/** The calls connect saw of `connectionId`: none, when core refused them. */
const connectCalls = async (connectionId: string) => {
  const events = await allEvents();
  return events.filter(
    ({ action, target }) =>
      action === "connection.call" && target?.id === connectionId
  );
};

describe("the classes a company turned on", setUpTime, () => {
  beforeEach(async () => {
    // Every test starts from the defaults.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM tool_class_settings"),
      env.DB.prepare("DELETE FROM shared_mailbox_pointers"),
      env.DB.prepare("DELETE FROM app_tool_classes"),
    ]);
  });

  it("refuse, by default, the chat's agent's send in core, so connect never sees it", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const { id, mailbox } = await connectShared(admin);
    await pointedAt(admin, mailbox);
    const chat = await chatCalling(admin, person.userId, mailbox, id);

    await expect(chat.answered()).resolves.toBe(
      // Reading the mailbox it is pointed at is on; Reach others is off
      // until an admin turns it on.
      answer({ list: "done", send: off })
    );
    const calls = await connectCalls(id);
    expect({
      sends: calls.filter(({ detail }) => detail.action === "mail.send"),
      sent: await sentWith(chat.subject),
    }).toStrictEqual({ sends: [], sent: [] });
  });

  it("let a class through once an admin turns it on for everyone", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    // Granted Read company's rights already, so turning it on asks no one
    // to connect again.
    const { id, mailbox } = await connectShared(admin, readCompanyGrant);
    await pointedAt(admin, mailbox);
    const chat = await chatCalling(admin, person.userId, mailbox, id);

    await admin.api.connections.setToolClass("reach-others", {
      who: "everyone",
    });

    await expect(chat.answered()).resolves.toBe(
      answer({ list: "done", send: "held" })
    );
  });

  it("let a class on for one team through for its people only, and the send still waits for the person", async () => {
    const admin = await signedInApi(idp, "admin");
    const inTeam = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const { id, mailbox } = await connectShared(admin);
    await pointedAt(admin, mailbox);
    const team = await teamOf(inTeam.userId);
    await admin.api.connections.setToolClass("reach-others", {
      who: "teams",
      teams: [team],
    });
    const theirs = await chatCalling(admin, inTeam.userId, mailbox, id);
    await expect(theirs.answered()).resolves.toBe(
      answer({ list: "done", send: "held" })
    );

    // One chat at a time: each answers before the next is set up.
    const others = await chatCalling(admin, outside.userId, mailbox, id);
    await expect(others.answered()).resolves.toBe(
      answer({ list: "done", send: off })
    );
    // Held for the person to confirm: nothing has gone out yet.
    await expect(sentWith(theirs.subject)).resolves.toStrictEqual([]);
  });

  it("let an app narrow a class to some teams, from the next call on, but never widen it", async () => {
    const admin = await signedInApi(idp, "admin");
    const inTeam = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const { id, mailbox } = await connectShared(admin);
    await pointedAt(admin, mailbox);
    const team = await teamOf(inTeam.userId);
    await admin.api.connections.setToolClass("read-company", {
      who: "everyone",
    });
    // Microsoft 365 reads the company's for one team only; Reach others,
    // off for the company, stays off however the app has it.
    await admin.api.connections.setAppToolClass("microsoft", "read-company", {
      who: "teams",
      teams: [team],
    });
    await admin.api.connections.setAppToolClass("microsoft", "reach-others", {
      who: "everyone",
    });

    const theirs = await chatCalling(admin, inTeam.userId, mailbox, id);
    await expect(theirs.answered()).resolves.toBe(
      answer({ list: "done", send: off })
    );
    const others = await chatCalling(admin, outside.userId, mailbox, id);
    await expect(others.answered()).resolves.toBe(
      answer({ list: off, send: off })
    );

    // As the class again: the person outside the team reads from the next
    // call on.
    await admin.api.connections.setAppToolClass("microsoft", "read-company", {
      who: "asClass",
    });
    const again = await chatCalling(admin, outside.userId, mailbox, id);
    await expect(again.answered()).resolves.toBe(
      answer({ list: "done", send: off })
    );
  });

  it("are changed by the company's admins only, never by Grasp staff, and only to teams it has", async () => {
    const member = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const admin = await signedInApi(idp, "admin");

    expect({
      member: await outcome(
        member.api.connections.setToolClass("reach-others", { who: "everyone" })
      ),
      memberReads: await outcome(member.api.connections.toolClasses()),
      staff: await outcome(
        staff.connections.setToolClass("reach-others", { who: "everyone" })
      ),
      unknownTeam: await outcome(
        admin.api.connections.setToolClass("reach-others", {
          who: "teams",
          teams: [crypto.randomUUID()],
        })
      ),
      never: await outcome(
        admin.api.connections.setToolClass(
          // @ts-expect-error -- `never` is no class a company turns on
          "never",
          { who: "everyone" }
        )
      ),
      noTeams: await outcome(
        admin.api.connections.setToolClass("reach-others", {
          who: "teams",
          teams: [],
        })
      ),
    }).toStrictEqual({
      member: "role.forbidden",
      memberReads: "role.forbidden",
      staff: "role.forbidden",
      unknownTeam: "connection.invalid",
      never: "connection.invalid",
      noTeams: "connection.invalid",
    });
    const settings = await admin.api.connections.toolClasses();
    expect(
      settings.map(({ toolClass, audience, changedBy }) => ({
        toolClass,
        audience,
        changedBy,
      }))
    ).toStrictEqual(
      Object.entries(defaultToolClassAudiences).map(
        ([toolClass, audience]) => ({ toolClass, audience, changedBy: null })
      )
    );
  });

  it("record each change in the audit log, with its teams, and nothing for a change to nothing", async () => {
    const admin = await signedInApi(idp, "admin");
    const first = await teamOf();
    const second = await teamOf();

    const events = await auditedDuring(async () => {
      await admin.api.connections.setToolClass("change-company", {
        who: "teams",
        // Twice, and out of order: kept once each, sorted.
        teams: [second, first, second],
      });
      // The same again, and a default as it is: neither changes anything.
      await admin.api.connections.setToolClass("change-company", {
        who: "teams",
        teams: [first, second],
      });
      await admin.api.connections.setToolClass("read-own", { who: "everyone" });
      await admin.api.connections.setToolClass("change-company", {
        who: "nobody",
      });
    });

    const [low, high] = [first, second].toSorted();
    expect(
      events
        .filter(({ action }) => action === "connection.class.changed")
        .map(({ actor, target, detail }) => ({ actor, target, detail }))
    ).toStrictEqual([
      {
        actor: { type: "person", userId: admin.userId },
        target: { type: "tool_class", id: "change-company" },
        detail: {
          toolClass: "change-company",
          who: "teams",
          team1: low,
          team2: high,
        },
      },
      {
        actor: { type: "person", userId: admin.userId },
        target: { type: "tool_class", id: "change-company" },
        detail: { toolClass: "change-company", who: "nobody" },
      },
    ]);
    const settings = await admin.api.connections.toolClasses();
    expect(
      settings.find(({ toolClass }) => toolClass === "change-company")
    ).toMatchObject({
      audience: { who: "nobody" },
      changedBy: admin.userId,
    });
  });

  it("ask Microsoft, when someone connects, only for the rights of the classes on, and the grants that lack a class turned on to be given again", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const { id } = await connectShared(admin);
    const asked = async () => {
      const { url } = await person.api.connections.start({
        provider: "microsoft",
        scope: "personal",
      });
      return new URL(url).searchParams.get("scope")?.split(" ") ?? [];
    };
    const statusOf = async () => {
      const listed = await admin.api.connections.list();
      return listed.find((connection) => connection.id === id)?.status;
    };

    const before = await asked();
    await admin.api.connections.setToolClass("reach-others", {
      who: "teams",
      teams: [await teamOf(person.userId)],
    });
    const sending = await asked();
    // Made before grants were kept: it holds the old wide set, sending
    // among it, but not changing the company's sites.
    const afterSending = await statusOf();
    await admin.api.connections.setToolClass("change-company", {
      who: "everyone",
    });

    expect({
      before: before.includes("Mail.Send"),
      sending: sending.includes("Mail.Send"),
      afterSending,
      afterChanging: await statusOf(),
    }).toStrictEqual({
      before: false,
      sending: true,
      afterSending: "active",
      afterChanging: "needs_reauth",
    });
  });
});
