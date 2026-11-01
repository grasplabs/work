import { generateKeyPair } from "jose";
import { describe, expect, it } from "vite-plus/test";

import { say } from "../src/channels/words.ts";
import { says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, otherTenant } from "./sign-in-config.ts";
import { signedInApi } from "./sign-in.ts";
import {
  kept,
  member,
  messageFrom,
  onRoster,
  post,
  reached,
  signed,
  teamsPerson,
  watched,
} from "./teams-door.ts";
import {
  heldTurn,
  linesAfterCard,
  mailOf,
  pressOn,
  waitingOf,
} from "./teams-press.ts";

// Teams as a door into core, and a press on its cards, against every way in
// (GRA-729): one case per threat, through a Worker request as Teams sends
// it, with the real connect and the fake Bot Connector behind it. Each
// names what it defends against and the control that stops it; the threat
// model's ids (GRA-700) take the place of `P?` once it has them. Each was
// seen to fail with its control taken out (the pull request lists how).
//
// Press after expiry: the end of a held write's day is GRA-766's
// (grasplabs/work#1141), tested in connect's pending.test.ts; it joins
// this suite once both are on main.

const idp = mockIdp();

watched();

const setUpTime = { timeout: 90_000 };

/** Whether the door took the message: its conversation kept, nothing said. */
const takenIn = async (conversation: string) => {
  const conversations = await kept(conversation);
  const { lines } = await reached(conversation);
  return { kept: conversations.length, lines };
};

describe("the door, against every way in", setUpTime, () => {
  it("[GRA-700 P?] an unsigned message: refused before it is read (teams.ts, no token)", async () => {
    const { teams } = await member(idp);
    const status = await post(messageFrom(teams), { authorization: null });
    expect({ status, ...(await takenIn(teams.conversation)) }).toStrictEqual({
      status: 401,
      kept: 0,
      lines: [],
    });
  });

  it("[GRA-700 P?] a forged token: refused (teams.ts, signed by a key Microsoft publishes)", async () => {
    const { teams } = await member(idp);
    const { privateKey } = await generateKeyPair("RS256");
    const status = await post(messageFrom(teams), {
      authorization: `Bearer ${await signed({ key: privateKey })}`,
    });
    expect({ status, ...(await takenIn(teams.conversation)) }).toStrictEqual({
      status: 401,
      kept: 0,
      lines: [],
    });
  });

  it("[GRA-700 P?] a token for another bot: refused (teams.ts, the audience is the client's bot)", async () => {
    const { teams } = await member(idp);
    const status = await post(messageFrom(teams), {
      authorization: `Bearer ${await signed({ claims: { aud: "another-bot" } })}`,
    });
    expect(status).toBe(401);
  });

  it("[GRA-700 P?] a wrong tenant: refused (teams.ts, the activity's tenant is the client's)", async () => {
    const { teams } = await member(idp);
    const status = await post(
      messageFrom(teams, {
        conversation: {
          id: teams.conversation,
          conversationType: "personal",
          tenantId: otherTenant,
        },
        channelData: { tenant: { id: otherTenant } },
      })
    );
    expect({ status, ...(await takenIn(teams.conversation)) }).toStrictEqual({
      status: 401,
      kept: 0,
      lines: [],
    });
  });

  it("[GRA-700 P?] a guest: one line, nothing read (door.ts, the roster's role)", async () => {
    const guest = teamsPerson();
    await onRoster(guest, { userRole: "guest", tenantId: acmeTenant });
    await post(messageFrom(guest));
    await expect(takenIn(guest.conversation)).resolves.toStrictEqual({
      kept: 0,
      lines: [say("guest", "en")],
    });
  });

  it("[GRA-700 P?] a removed member: one line, nothing read (who.ts, an active member only)", async () => {
    const admin = await signedInApi(idp, "admin");
    const { userId, teams } = await member(idp);
    await admin.api.members.remove(userId);
    await post(messageFrom(teams));
    await expect(takenIn(teams.conversation)).resolves.toStrictEqual({
      kept: 0,
      lines: [say("removed", "en")],
    });
  });

  it("[GRA-700 P?] Teams resending a message: taken once (door.ts, each activity's id)", async () => {
    const { teams, provider } = await member(
      idp,
      says("First."),
      says("Second.")
    );
    const message = messageFrom(teams);
    await post(message);
    await post(message);
    expect(provider.requests).toHaveLength(1);
  });
});

describe("the press, against every way in", setUpTime, () => {
  it("[GRA-700 P?] another person's card: runs nothing (connect, a held write waits for one person)", async () => {
    const turn = await heldTurn(idp);
    const other = await member(idp);
    await post(pressOn(other.teams, turn));
    expect({
      mail: await mailOf(turn.mail),
      waiting: new Set(await waitingOf(turn.person)),
    }).toStrictEqual({
      mail: { calls: 0, to: [] },
      waiting: new Set(turn.press.map(({ id }) => id)),
    });
  });

  it("[GRA-700 P?] a double press: runs the card once (press.ts, a card is pressed once)", async () => {
    const turn = await heldTurn(idp);
    await post(pressOn(turn.person.teams, turn));
    await post(pressOn(turn.person.teams, turn));
    expect({
      mail: await mailOf(turn.mail),
      lines: await linesAfterCard(turn),
    }).toStrictEqual({
      mail: { calls: 2, to: ["ben@acme.test", "cleo@acme.test"] },
      lines: [say("alreadyAnswered", "en")],
    });
  });

  it("[GRA-700 P?] Teams resending a press: runs the card once (door.ts, each activity's id)", async () => {
    const turn = await heldTurn(idp);
    const press = pressOn(turn.person.teams, turn);
    await post(press);
    await post(press);
    expect({
      mail: await mailOf(turn.mail),
      lines: await linesAfterCard(turn),
    }).toStrictEqual({
      mail: { calls: 2, to: ["ben@acme.test", "cleo@acme.test"] },
      // The resend never reached the press: nothing was said of it.
      lines: [],
    });
  });

  it("[GRA-700 P?] a card whose write changed since it was shown: runs nothing (press.ts and connect, the input hash)", async () => {
    const turn = await heldTurn(idp);
    await post(
      pressOn(turn.person.teams, {
        cardId: turn.cardId,
        press: turn.press.map(({ id }) => ({ id, inputHash: "0".repeat(64) })),
      })
    );
    expect({
      mail: await mailOf(turn.mail),
      lines: await linesAfterCard(turn),
    }).toStrictEqual({
      mail: { calls: 0, to: [] },
      lines: [say("changedSince", "en")],
    });
  });
});
