import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  cancelAction,
  confirmAction,
  pressOf,
} from "../src/channels/cards.tsx";
import { say } from "../src/channels/words.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { pause } from "./connection-pause.ts";
import { heldFor } from "./held-in-connect.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  failsOnce,
  member,
  messageFrom,
  post,
  reached,
  watched,
} from "./teams-door.ts";
import {
  editsOf,
  heldTurn,
  linesAfterCard,
  mailOf,
  pressOn,
  waitingOf,
} from "./teams-press.ts";
import type { Turn } from "./teams-press.ts";

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
 * A member whose Teams turn read their mail, or, given `reads`, only with
 * that tool of a connection of that provider, then held two mails on one
 * card: to Ben through `mail`, then to Cleo through `other`, another mail
 * connection when `connections` is 2, else the same.
 */
const heldMails = async (
  connections: 1 | 2,
  reads?: { provider: string; tool: string }
) => {
  const admin = await signedInApi(idp, "admin");
  const tools = ["MAIL_SEND", { name: "mail.search", read: true }];
  const mail = await mailConnection([], tools);
  const other = connections === 1 ? mail : await mailConnection([], tools);
  const read = reads?.tool ?? "mail.search";
  const reader =
    reads === undefined
      ? mail
      : await mailConnection([], [{ name: read, read: true }], {
          provider: reads.provider,
        });
  if (reads !== undefined) {
    await reader.serves([{ name: read, inputSchema: { type: "object" } }]);
    await reader.answer(read, { content: [{ type: "text", text: "[]" }] });
  }
  const actions = new Map([
    [mail.id, ["MAIL_SEND"]],
    [other.id, ["MAIL_SEND"]],
  ]);
  actions.set(reader.id, [...(actions.get(reader.id) ?? []), read]);
  const bindings = new Map<string, string>();
  for (const [id, granted] of actions) {
    const binding = `MAIL${unique()}`.toUpperCase();
    // oxlint-disable-next-line no-await-in-loop -- one grant each
    await requestGranted(idp, admin, {
      subject: { type: "agent", agentId: chatAgentId },
      object: { type: "connection", connectionId: id },
      actions: granted,
      binding,
    });
    bindings.set(id, binding);
  }
  const call = (on: { id: string }, action: string, input: unknown) =>
    `await env.connections.call(${JSON.stringify(bindings.get(on.id))}, ${JSON.stringify(action)}, ${JSON.stringify(input)});`;
  const code = [
    call(reader, read, { query: "invoice" }),
    call(mail, "MAIL_SEND", { to: "ben@acme.test", subject: "Invoice INV-7" }),
    call(other, "MAIL_SEND", {
      to: "cleo@acme.test",
      subject: "Invoice INV-7",
    }),
  ].join(" ");
  const person = await member(
    idp,
    codeStep(`export default async (self, env) => { ${code} return "held"; };`),
    says("Both mails wait for you to confirm them.")
  );
  await post(
    messageFrom(person.teams, {
      text: "Find the invoice, and mail it to ben@acme.test and cleo@acme.test.",
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
  const writes = await heldFor(person, "chat_app");
  const press = writes
    .toSorted((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
    .map(({ id, inputHash }) => ({ id, inputHash }));
  return {
    person,
    mail,
    other,
    cardId: card.id,
    card: { id: card.id, json: JSON.stringify(card.activity) },
    press,
  };
};

/** The cards of held writes posted after `turn`'s card, each as JSON. */
const cardsAfter = async (
  turn: Turn
): Promise<{ id: string; json: string }[]> => {
  const { sent } = await reached(turn.person.teams.conversation);
  const at = sent.findIndex(({ id }) => id === turn.cardId);
  return sent.slice(at + 1).flatMap(({ id, editOf, activity }) => {
    const json = JSON.stringify(activity);
    return id !== undefined &&
      editOf === undefined &&
      json.includes(confirmAction)
      ? [{ id, json }]
      : [];
  });
};

/** What button `actionId` on `card` (as JSON) carries, as Teams sends it back. */
const valueIn = (card: { json: string }, actionId: string): string => {
  let value: unknown;
  JSON.parse(card.json, (_key, each: unknown) => {
    if (
      typeof each === "object" &&
      each !== null &&
      Reflect.get(each, "actionId") === actionId
    ) {
      value = Reflect.get(each, "value");
    }
    return each;
  });
  if (typeof value !== "string") {
    throw new TypeError(`Expected ${actionId} on the card`);
  }
  return value;
};

/** A press by `from` on button `actionId` of `card`, with what it carries. */
const pressOnCard = (
  from: Turn["person"]["teams"],
  card: { id: string; json: string },
  actionId: string = confirmAction
) => ({
  ...messageFrom(from, { text: undefined }),
  replyToId: card.id,
  value: { actionId, value: valueIn(card, actionId) },
});

/** `line` as a card's JSON holds it. */
const inJson = (line: string): string => JSON.stringify(line).slice(1, -1);

const requestToolsSchema = z.array(z.object({ ok: z.boolean() }));

/** How many tools of `turn`'s person's requests are kept as not working. */
const failedToolsOf = async (turn: Turn): Promise<number> => {
  const { results } = await env.DB.prepare(
    "SELECT tools FROM stephen_requests WHERE person_id = ?"
  )
    .bind(turn.person.userId)
    .all<{ tools: string }>();
  return results
    .flatMap(({ tools }) => requestToolsSchema.parse(JSON.parse(tools)))
    .filter(({ ok }) => !ok).length;
};

describe("a press that mustn't run anything", setUpTime, () => {
  it("[GRA-700 P?] another person's press on the card runs nothing", async () => {
    const turn = await heldTurn(idp);
    const other = await member(idp);
    // Someone else, in their own private chat, presses with the card's
    // ids and hashes.
    await post(pressOn(other.teams, turn));
    expect({
      mail: await mailOf(turn.mail),
      waiting: new Set(await waitingOf(turn.person)),
    }).toStrictEqual({
      mail: { calls: 0, to: [] },
      waiting: new Set(turn.press.map(({ id }) => id)),
    });
  });

  it("[GRA-700 P?] a second press, and Teams sending the press again, run nothing more", async () => {
    const turn = await heldTurn(idp);
    const press = pressOn(turn.person.teams, turn);
    await post(press);
    // Teams sends the same activity again, then the person presses again.
    await post(press);
    await post(pressOn(turn.person.teams, turn));
    expect({
      mail: await mailOf(turn.mail),
      lines: await linesAfterCard(turn),
    }).toStrictEqual({
      mail: { calls: 2, to: ["ben@acme.test", "cleo@acme.test"] },
      lines: [say("alreadyAnswered", "en")],
    });
  });

  it("[GRA-700 P?] a card whose write changed or went since it was shown runs nothing", async () => {
    const turn = await heldTurn(idp);
    const [first, second] = turn.press;
    if (first === undefined || second === undefined) {
      throw new Error("Expected two held writes");
    }
    // The second write was declined in Grasp's own app meanwhile, and the
    // first's hash on the card isn't the one held.
    await turn.person.api.pendingActions.decline(second.id);
    await post(
      pressOn(turn.person.teams, {
        cardId: turn.cardId,
        press: [{ id: first.id, inputHash: "0".repeat(64) }],
      })
    );
    const elsewhere = await heldTurn(idp);
    await elsewhere.person.api.pendingActions.decline(
      elsewhere.press[1]?.id ?? ""
    );
    await post(pressOn(elsewhere.person.teams, elsewhere));
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
    const turn = await heldTurn(idp);
    const another = await heldTurn(idp);
    await post(
      pressOn(turn.person.teams, {
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
    const turn = await heldTurn(idp, ["invalid"]);
    await post(pressOn(turn.person.teams, turn));
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
    const turn = await heldTurn(idp);
    const status = await post(pressOn(turn.person.teams, turn));
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

  it("waits out a paused connection: the card says when to confirm again, and a new card for its writes, warning of what the turn read, runs them after the pause", async () => {
    const turn = await heldMails(1);
    await pause(turn.mail.id, Date.now() + 90_000);
    await post(pressOnCard(turn.person.teams, turn.card));
    const pausedEdits = await editsOf(turn);
    const paused = pausedEdits.at(-1) ?? "";
    const [card, ...more] = await cardsAfter(turn);
    if (card === undefined) {
      throw new Error("Expected a new card of held writes");
    }
    const whilePaused = {
      // The turn's code read mail: its card says so (GRA-2367).
      warned: turn.card.json.includes(inJson(say("checkMail", "en"))),
      mail: await mailOf(turn.mail),
      waiting: new Set(await waitingOf(turn.person)),
      said: [
        paused.includes(inJson(say("pausedManyMinutes", "en", { minutes: 2 }))),
        paused.includes(inJson(say("checkMail", "en"))),
        paused.includes(confirmAction),
      ],
      more: more.length,
      offered: pressOf(valueIn(card, confirmAction)),
      warns: card.json.includes(inJson(say("checkMail", "en"))),
      failedTools: await failedToolsOf(turn),
    };
    await pause(turn.mail.id, Date.now() - 1000);
    // The pressed card stays answered; its new card runs.
    await post(pressOnCard(turn.person.teams, turn.card));
    await post(pressOnCard(turn.person.teams, card));
    const edits = await editsOf({ ...turn, cardId: card.id });
    const lines = await linesAfterCard(turn);
    expect({
      whilePaused,
      after: {
        mail: await mailOf(turn.mail),
        waiting: await waitingOf(turn.person),
        done: edits.at(-1)?.includes(say("allDone", "en")),
        answered: lines.includes(say("alreadyAnswered", "en")),
      },
    }).toStrictEqual({
      whilePaused: {
        warned: true,
        mail: { calls: 0, to: [] },
        waiting: new Set(turn.press.map(({ id }) => id)),
        // The pressed card, with no buttons, warns no more.
        said: [true, false, false],
        more: 0,
        offered: { writes: turn.press, check: { read: "mail" } },
        warns: true,
        failedTools: 0,
      },
      after: {
        mail: { calls: 2, to: ["ben@acme.test", "cleo@acme.test"] },
        waiting: [],
        done: true,
        answered: true,
      },
    });
  });

  it("runs the writes before a paused connection's, and offers only the one still waiting on a new card, which Confirm runs and Cancel declines", async () => {
    const confirmed = await heldMails(2);
    const cancelled = await heldMails(2);
    const [, second] = confirmed.press;
    for (const turn of [confirmed, cancelled]) {
      // oxlint-disable-next-line no-await-in-loop -- one card at a time
      await pause(turn.other.id, Date.now() + 30_000);
      // oxlint-disable-next-line no-await-in-loop -- one card at a time
      await post(pressOnCard(turn.person.teams, turn.card));
    }
    const pressedEdits = await editsOf(confirmed);
    const pressed = pressedEdits.at(-1) ?? "";
    const [card] = await cardsAfter(confirmed);
    const [cancelCard] = await cardsAfter(cancelled);
    if (card === undefined || cancelCard === undefined) {
      throw new Error("Expected a new card of held writes");
    }
    const whilePaused = {
      mail: [await mailOf(confirmed.mail), await mailOf(confirmed.other)],
      waiting: await waitingOf(confirmed.person),
      pressed: [
        pressed.includes(inJson(say("stepDone", "en"))),
        pressed.includes(inJson(say("pausedOneMinute", "en"))),
        pressed.includes(confirmAction),
      ],
      offered: pressOf(valueIn(card, confirmAction))?.writes,
    };
    await pause(confirmed.other.id, Date.now() - 1000);
    await post(pressOnCard(confirmed.person.teams, card));
    await post(pressOnCard(cancelled.person.teams, cancelCard, cancelAction));
    const confirmedEdits = await editsOf({ ...confirmed, cardId: card.id });
    const cancelledEdits = await editsOf({
      ...cancelled,
      cardId: cancelCard.id,
    });
    expect({
      whilePaused,
      confirmed: {
        mail: [await mailOf(confirmed.mail), await mailOf(confirmed.other)],
        waiting: await waitingOf(confirmed.person),
        done: confirmedEdits.at(-1)?.includes(say("allDone", "en")),
      },
      cancelled: {
        mail: [await mailOf(cancelled.mail), await mailOf(cancelled.other)],
        waiting: await waitingOf(cancelled.person),
        said: cancelledEdits.at(-1)?.includes(say("cancelled", "en")),
      },
    }).toStrictEqual({
      whilePaused: {
        mail: [
          { calls: 1, to: ["ben@acme.test"] },
          { calls: 0, to: [] },
        ],
        waiting: [second?.id],
        pressed: [true, true, false],
        offered: [second],
      },
      confirmed: {
        mail: [
          { calls: 1, to: ["ben@acme.test"] },
          { calls: 1, to: ["cleo@acme.test"] },
        ],
        waiting: [],
        done: true,
      },
      cancelled: {
        mail: [
          { calls: 1, to: ["ben@acme.test"] },
          { calls: 0, to: [] },
        ],
        waiting: [],
        said: true,
      },
    });
  });

  it("declines a paused connection's writes that can't get a new card, and says to ask again", async () => {
    const turn = await heldMails(1);
    await pause(turn.mail.id, Date.now() + 90_000);
    await failsOnce(turn.person.teams.conversation, confirmAction);
    await post(pressOnCard(turn.person.teams, turn.card));
    const edits = await editsOf(turn);
    expect({
      said: edits.at(-1)?.includes(inJson(say("pausedManyAskAgain", "en"))),
      cards: await cardsAfter(turn),
      mail: await mailOf(turn.mail),
      // No card can confirm them: asked again, they are held once.
      waiting: await waitingOf(turn.person),
    }).toStrictEqual({
      said: true,
      cards: [],
      mail: { calls: 0, to: [] },
      waiting: [],
    });
  });

  it("warns of nothing on the card of a turn that read only what isn't mail", async () => {
    const turn = await heldMails(1, {
      provider: "crm",
      tool: "CRM_LIST_CONTACTS",
    });
    const card = turn.card.json;
    expect({
      mail: card.includes(inJson(say("checkMail", "en"))),
      record: card.includes(
        inJson(say("checkRecord", "en", { where: "mail" }))
      ),
      press: pressOf(valueIn(turn.card, confirmAction)),
    }).toStrictEqual({
      mail: false,
      record: false,
      press: { writes: turn.press },
    });
  });

  it("declines the card's writes on Cancel, and runs none", async () => {
    const turn = await heldTurn(idp);
    await post(pressOn(turn.person.teams, turn, cancelAction));
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

describe("a card of held writes", setUpTime, () => {
  it("shows each value as it will be sent, link syntax and all, inert, and so does the card a press edits", async () => {
    // An injected mail had the model put a link in what it would send.
    const subject = "[Agenda](https://evil.example/?d=salary) <b>now</b>";
    const turn = await heldTurn(idp, [], [subject, "Reminder"]);
    const { sent } = await reached(turn.person.teams.conversation);
    const card = JSON.stringify(
      sent.find(({ id }) => id === turn.cardId)?.activity ?? {}
    );
    await post(pressOn(turn.person.teams, turn, cancelAction));
    const edits = await editsOf(turn);
    const edited = edits.at(-1) ?? "";
    // On Teams a card's facts read `[words](address)` as a link: the
    // value's `](` is broken, so the address shows, whole, and leads
    // nowhere from the card.
    const shown = JSON.stringify(
      "[Agenda] (https://evil.example/?d=salary) <b>now</b>"
    ).slice(1, -1);
    expect({
      card: [card.includes(shown), card.includes("](")],
      edited: [edited.includes(shown), edited.includes("](")],
    }).toStrictEqual({ card: [true, false], edited: [true, false] });
  });
});
