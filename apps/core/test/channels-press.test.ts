import { describe, expect, it } from "vite-plus/test";

import { cancelAction, confirmAction } from "../src/channels/cards.tsx";
import { say } from "../src/channels/words.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import type { MailAnswer } from "./mail-server.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { member, messageFrom, post, reached, watched } from "./teams-door.ts";

// A press on a Teams card of held writes (src/channels/press.ts), D2: "a
// verified Teams press confirms exactly the held writes on its card,
// once". The ways it can fail come first, each named by what it defends
// against (GRA-700's ids to follow): another person's press, a second
// press, Teams sending the press again, a card whose write changed since
// it was shown, and a failure part way. Then the press that runs exactly
// the card's writes, once, in order, recorded as the person's own via
// Teams. Presses come in through the Worker, as Teams sends them, with the
// real connect and the fake Bot Connector behind it.

const idp = mockIdp();

watched();

const setUpTime = { timeout: 90_000 };

/**
 * A member whose Teams turn held two mails, to Ben then to Cleo, on a mail
 * server that answers as `plan` says; and the card that turn sent.
 */
const heldTurn = async (plan: MailAnswer[] = []) => {
  const admin = await signedInApi(idp, "admin");
  // A send whose fields its server lists, so core can check a chat app's
  // write against them (channels/stephen-rules.ts).
  const mail = await mailConnection(plan, ["MAIL_SEND"]);
  const binding = `MAIL${unique()}`.toUpperCase();
  await requestGranted(idp, admin, {
    subject: { type: "agent", agentId: chatAgentId },
    object: { type: "connection", connectionId: mail.id },
    actions: ["MAIL_SEND"],
    binding,
  });
  const send = (to: string, subject: string) =>
    `await env.connections.call(${JSON.stringify(binding)}, "MAIL_SEND", ${JSON.stringify({ to, subject })});`;
  const person = await member(
    idp,
    codeStep(
      `export default async (self, env) => { ${send("ben@acme.test", "Invoice INV-7")} ${send("cleo@acme.test", "Reminder")} return "held"; };`
    ),
    says("Both mails wait for you to confirm them.")
  );
  await post(
    messageFrom(person.teams, {
      text: "Mail ben@acme.test the invoice and remind cleo@acme.test.",
    })
  );
  const { sent } = await reached(person.teams.conversation);
  const card = sent.findLast(
    ({ id, activity }) =>
      id !== undefined && JSON.stringify(activity).includes(confirmAction)
  );
  if (card?.id === undefined) {
    throw new Error("Expected a card of held writes");
  }
  const writes = await person.api.pendingActions.list();
  // The card's order: the order they were asked for.
  const ordered = writes.toSorted(
    (a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt)
  );
  const press = ordered.map(({ id, inputHash }) => ({ id, inputHash }));
  return { person, mail, cardId: card.id, press };
};

type Turn = Awaited<ReturnType<typeof heldTurn>>;

/** A press on the card as Teams sends it: an Action.Submit on the card's message. */
const pressOf = (
  from: Turn["person"]["teams"],
  { cardId, press }: Pick<Turn, "cardId" | "press">,
  actionId: string = confirmAction,
  changes: Record<string, unknown> = {}
) => ({
  ...messageFrom(from, { text: undefined, ...changes }),
  replyToId: cardId,
  value: { actionId, value: JSON.stringify(press) },
});

/** How many calls reached the mail server, and to whom it sent. */
const mailOf = async (mail: Turn["mail"]) => {
  const did = await mail.did();
  return { calls: did.calls, to: did.sent.map(({ to }) => to) };
};

/** The held writes still waiting for `person`, by id. */
const waitingOf = async (person: Turn["person"]): Promise<string[]> => {
  const waiting = await person.api.pendingActions.list();
  return waiting.map(({ id }) => id);
};

/** The card's edits in the person's chat, each as JSON, in order. */
const editsOf = async (turn: Turn): Promise<string[]> => {
  const { sent } = await reached(turn.person.teams.conversation);
  return sent
    .filter(({ editOf }) => editOf === turn.cardId)
    .map(({ activity }) => JSON.stringify(activity));
};

/** Lines said in the person's chat after the card, as text. */
const linesAfterCard = async (turn: Turn): Promise<string[]> => {
  const { sent } = await reached(turn.person.teams.conversation);
  const at = sent.findIndex(({ id }) => id === turn.cardId);
  return sent
    .slice(at + 1)
    .filter(({ editOf }) => editOf === undefined)
    .flatMap(({ activity }) =>
      activity.text === undefined ? [] : [activity.text]
    );
};

describe("a press that mustn't run anything", setUpTime, () => {
  it("[GRA-700 P?] another person's press on the card runs nothing", async () => {
    const turn = await heldTurn();
    const other = await member(idp);
    // Someone else, in their own private chat, presses with the card's
    // ids and hashes.
    await post(pressOf(other.teams, turn));
    expect({
      mail: await mailOf(turn.mail),
      waiting: new Set(await waitingOf(turn.person)),
    }).toStrictEqual({
      mail: { calls: 0, to: [] },
      waiting: new Set(turn.press.map(({ id }) => id)),
    });
  });

  it("[GRA-700 P?] a second press, and Teams sending the press again, run nothing more", async () => {
    const turn = await heldTurn();
    const press = pressOf(turn.person.teams, turn);
    await post(press);
    // Teams sends the same activity again, then the person presses again.
    await post(press);
    await post(pressOf(turn.person.teams, turn));
    expect({
      mail: await mailOf(turn.mail),
      lines: await linesAfterCard(turn),
    }).toStrictEqual({
      mail: { calls: 2, to: ["ben@acme.test", "cleo@acme.test"] },
      lines: [say("alreadyAnswered", "en")],
    });
  });

  it("[GRA-700 P?] a card whose write changed or went since it was shown runs nothing", async () => {
    const turn = await heldTurn();
    const [first, second] = turn.press;
    if (first === undefined || second === undefined) {
      throw new Error("Expected two held writes");
    }
    // The second write was declined in Grasp's own app meanwhile, and the
    // first's hash on the card isn't the one held.
    await turn.person.api.pendingActions.decline(second.id);
    await post(
      pressOf(turn.person.teams, {
        cardId: turn.cardId,
        press: [{ id: first.id, inputHash: "0".repeat(64) }],
      })
    );
    const elsewhere = await heldTurn();
    await elsewhere.person.api.pendingActions.decline(
      elsewhere.press[1]?.id ?? ""
    );
    await post(pressOf(elsewhere.person.teams, elsewhere));
    expect({
      changed: await mailOf(turn.mail),
      gone: await mailOf(elsewhere.mail),
      stillHeld: await waitingOf(elsewhere.person),
      said: [
        ...(await linesAfterCard(turn)),
        ...(await linesAfterCard(elsewhere)),
      ],
    }).toStrictEqual({
      changed: { calls: 0, to: [] },
      gone: { calls: 0, to: [] },
      // Nothing of the card ran: its first write still waits.
      stillHeld: [elsewhere.press[0]?.id],
      said: [say("changedSince", "en"), say("changedSince", "en")],
    });
  });

  it("[GRA-700 P?] a press that adds a write the card didn't show runs nothing", async () => {
    const turn = await heldTurn();
    const another = await heldTurn();
    await post(
      pressOf(turn.person.teams, {
        cardId: turn.cardId,
        press: [...turn.press, ...another.press],
      })
    );
    expect([await mailOf(turn.mail), await mailOf(another.mail)]).toStrictEqual(
      [
        { calls: 0, to: [] },
        { calls: 0, to: [] },
      ]
    );
  });

  it("[GRA-700 P?] when the first write ends badly, nothing after it runs, and the card says how", async () => {
    const turn = await heldTurn(["invalid"]);
    await post(pressOf(turn.person.teams, turn));
    const edits = await editsOf(turn);
    expect({
      mail: await mailOf(turn.mail),
      // The second still waits for the person.
      waiting: await waitingOf(turn.person),
      // The server took it and answered nothing usable: it may have gone
      // out, so it is said to be unknown, never failed.
      said: edits.at(-1)?.includes(say("unknownOutcome", "en")),
    }).toStrictEqual({
      mail: { calls: 1, to: [] },
      waiting: [turn.press[1]?.id],
      said: true,
    });
  });
});

describe("the person's own press", setUpTime, () => {
  it("runs exactly the card's writes, once, in order, ticks the card and records it via Teams", async () => {
    const turn = await heldTurn();
    const status = await post(pressOf(turn.person.teams, turn));
    const edits = await editsOf(turn);
    const events = await allEvents();
    const confirmed = events.filter(
      ({ action, detail }) =>
        action === "connection.action.confirmed" &&
        turn.press.some(({ id }) => id === detail.pendingActionId)
    );
    expect({
      status,
      mail: await mailOf(turn.mail),
      waiting: await waitingOf(turn.person),
      // Running the first, running the second, then all done.
      edits: edits.length,
      done: edits.at(-1)?.includes(say("allDone", "en")),
      confirmed: confirmed.map(({ actor }) => actor),
    }).toStrictEqual({
      status: 200,
      mail: { calls: 2, to: ["ben@acme.test", "cleo@acme.test"] },
      waiting: [],
      edits: 3,
      done: true,
      confirmed: [
        { type: "person", userId: turn.person.userId, via: "teams" },
        { type: "person", userId: turn.person.userId, via: "teams" },
      ],
    });
  });

  it("declines the card's writes on Cancel, and runs none", async () => {
    const turn = await heldTurn();
    await post(pressOf(turn.person.teams, turn, cancelAction));
    const edits = await editsOf(turn);
    expect({
      mail: await mailOf(turn.mail),
      waiting: await waitingOf(turn.person),
      cancelled: edits.at(-1)?.includes(say("cancelled", "en")),
    }).toStrictEqual({
      mail: { calls: 0, to: [] },
      waiting: [],
      cancelled: true,
    });
  });
});
