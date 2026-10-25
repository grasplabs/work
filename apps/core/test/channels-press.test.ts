import { describe, expect, it } from "vite-plus/test";

import { cancelAction } from "../src/channels/cards.tsx";
import { say } from "../src/channels/words.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { member, post, watched } from "./teams-door.ts";
import {
  editsOf,
  heldTurn,
  linesAfterCard,
  mailOf,
  pressOn,
  waitingOf,
} from "./teams-press.ts";

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
