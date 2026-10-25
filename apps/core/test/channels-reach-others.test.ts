import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { confirmAction } from "../src/channels/cards.tsx";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { codeStep, pointAtGateway, says } from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { consentCode, graphSentUrl } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi, unique } from "./sign-in.ts";
import {
  messageFrom,
  post,
  reached,
  teamsPerson,
  watched,
} from "./teams-door.ts";
import { testBinding } from "./test-env.ts";

// Reach others in a Teams chat (GRA-726): off by default, turned on per
// company. These start from the ways it can fail: Stephen sends while the
// class is off, or Microsoft is asked to let him; a send runs without a
// card that shows its exact text and every recipient; a recipient comes
// from a mail Stephen read rather than from the person; one press sends
// more than the one message the card showed. Turns come in through the
// Worker, as Teams sends them, with the real connect, its fake Graph and
// the fake Bot Connector behind it.

const idp = mockIdp();

watched();

const setUpTime = { timeout: 90_000 };

type Person = Awaited<ReturnType<typeof signedInApi>>;

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** The mail Graph sent with `subject`: none, unless connect sent it. */
const sentWith = async (subject: string) => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  const response = await providers.fetch(graphSentUrl);
  return z
    .array(z.object({ subject: z.string(), to: z.array(z.string()) }).loose())
    .parse(await response.json())
    .filter((sent) => sent.subject === subject);
};

/**
 * `person`'s own Microsoft 365 account, connected through the OAuth
 * callback, and granted to their chat's agent: its mailbox's address.
 */
const ownOutlook = async (person: Person, binding: string) => {
  const { url } = await person.api.connections.start({
    provider: "microsoft",
    scope: "personal",
  });
  const authorization = new URL(url);
  const oid = String(person.person.oid);
  await routed(
    `/api/connections/callback?${new URLSearchParams({
      code: consentCode(authorization, acmeTenant, oid),
      state: authorization.searchParams.get("state") ?? "",
    }).toString()}`,
    { headers: { cookie: person.session } }
  );
  const [connection] = await person.api.connections.list();
  if (connection?.accountName === null || connection === undefined) {
    throw new Error("Expected the person's own connection");
  }
  const admin = await signedInApi(idp, "admin");
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "connection", connectionId: connection.id },
    actions: ["mail.send"],
    binding,
  });
  return { id: connection.id, mailbox: connection.accountName };
};

/**
 * A member whose Teams turn sends one mail from their own Outlook, as the
 * model wrote it: `to` and `cc` as given, then says what the call answered.
 */
const sendingTurn = async (
  { to, cc, asked }: { to: string[]; cc: string[]; asked: string },
  turnOn = true
) => {
  const admin = await signedInApi(idp, "admin");
  if (turnOn) {
    await admin.api.connections.setToolClass("reach-others", {
      who: "everyone",
    });
  }
  const binding = `OUTLOOK${unique()}`.toUpperCase();
  const subject = `Invoice INV-${unique()}`;
  const body = "Hi Ben, the invoice is attached. Kind regards, Anna";
  const person = await signedInApi(idp, "user");
  const outlook = await ownOutlook(person, binding);
  const mail = { mailbox: outlook.mailbox, to, cc, subject, body };
  await pointAtGateway(
    workspace(env, personalWorkspaceId(person.userId)),
    fakeGateway(
      codeStep(
        `export default async (self, env) => { try { const { pending } = await env.connections.call(${JSON.stringify(binding)}, "mail.send", ${JSON.stringify(mail)}); return pending === null ? "sent" : "held"; } catch (error) { return error.message; } };`
      ),
      says("Done.")
    )
  );
  const teams = teamsPerson(String(person.person.oid));
  // The invoice's number is the person's, as a real one would be.
  await post(messageFrom(teams, { text: `${asked} It's ${subject}.` }));
  const { sent } = await reached(teams.conversation);
  const card = sent.findLast(
    ({ id, activity }) =>
      id !== undefined && JSON.stringify(activity).includes(confirmAction)
  );
  const events = await allEvents();
  const connectCalls = events.filter(
    ({ action, target }) =>
      action === "connection.call" && target?.id === outlook.id
  );
  return { person, teams, outlook, subject, body, card, connectCalls };
};

describe("reaching others from a Teams chat", setUpTime, () => {
  beforeEach(async () => {
    // Every test starts from the defaults: Reach others off.
    await env.DB.prepare("DELETE FROM tool_class_settings").run();
  });

  it("is off by default: the send is refused in core, connect never sees it, and Microsoft isn't asked to send", async () => {
    const turn = await sendingTurn(
      {
        to: ["ben@acme.test"],
        cc: [],
        asked: "Mail ben@acme.test the invoice.",
      },
      false
    );
    const { url } = await turn.person.api.connections.start({
      provider: "microsoft",
      scope: "personal",
    });
    expect({
      card: turn.card,
      held: await turn.person.api.pendingActions.list(),
      connectCalls: turn.connectCalls,
      sent: await sentWith(turn.subject),
      asksToSend: new URL(url).searchParams
        .get("scope")
        ?.split(" ")
        .includes("Mail.Send"),
    }).toStrictEqual({
      card: undefined,
      held: [],
      connectCalls: [],
      sent: [],
      asksToSend: false,
    });
  });

  it("once on, holds a send for a card that shows its exact text and every recipient", async () => {
    const turn = await sendingTurn({
      to: ["ben@acme.test"],
      cc: ["cleo@acme.test"],
      asked: "Mail ben@acme.test the invoice and copy cleo@acme.test.",
    });
    const card = JSON.stringify(turn.card?.activity ?? {});
    const held = await turn.person.api.pendingActions.list();
    expect({
      held: held.length,
      shows: [
        turn.subject,
        turn.body,
        "ben@acme.test",
        "cleo@acme.test",
        turn.outlook.mailbox,
      ].filter((value) => !card.includes(value)),
      sent: await sentWith(turn.subject),
    }).toStrictEqual({ held: 1, shows: [], sent: [] });
  });

  it("refuses a recipient the person didn't name, such as one a mail gave, before anything is held", async () => {
    const turn = await sendingTurn({
      to: ["mallory@evil.test"],
      cc: [],
      asked: "Answer the supplier's mail about the invoice.",
    });
    expect({
      card: turn.card,
      held: await turn.person.api.pendingActions.list(),
      sent: await sentWith(turn.subject),
    }).toStrictEqual({ card: undefined, held: [], sent: [] });
  });

  it("sends exactly the message the card showed, once, on one press", async () => {
    const turn = await sendingTurn({
      to: ["ben@acme.test"],
      cc: [],
      asked: "Mail ben@acme.test the invoice.",
    });
    const writes = await turn.person.api.pendingActions.list();
    const press = {
      ...messageFrom(turn.teams, { text: undefined }),
      replyToId: turn.card?.id,
      value: {
        actionId: confirmAction,
        value: JSON.stringify(
          writes.map(({ id, inputHash }) => ({ id, inputHash }))
        ),
      },
    };
    await post(press);
    await post(press);
    await post({ ...press, id: `1729${unique()}` });
    await expect(sentWith(turn.subject)).resolves.toMatchObject([
      { subject: turn.subject, to: ["ben@acme.test"] },
    ]);
  });
});
