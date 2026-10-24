import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, otherTenant } from "./sign-in-config.ts";
import { signedInApi, unique } from "./sign-in.ts";
import {
  kept,
  member,
  messageFrom,
  onRoster,
  post,
  reached,
  teamsPerson,
  toMicrosoft,
  watched,
} from "./teams-door.ts";

// Who gets in through the door (src/channels/door.ts), as Teams posts to
// it through the Worker: a known person's private message is taken, once,
// and its conversation kept; everyone else gets one line, sent through
// connect to the fake Bot Connector behind it (test/bot-connector-fake.ts),
// and nothing they wrote is read; a flood is cut before anything is
// looked up; a platform the deployment hasn't set up isn't there.

const idp = mockIdp();

watched();

describe("a known person's message", () => {
  it("is taken, and its conversation kept as theirs", async () => {
    const { userId, teams, gateway } = await member(idp, says("You're free."));

    await expect(post(messageFrom(teams))).resolves.toBe(200);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([
      { platform: "teams", userId },
    ]);
    expect(gateway.requests).toHaveLength(1);
    expect(toMicrosoft).toStrictEqual([]);
  });

  it("is taken once when Teams sends it again", async () => {
    const { teams, gateway } = await member(
      idp,
      says("First."),
      says("Second.")
    );
    const message = messageFrom(teams);

    await post(message);
    await post(message);
    await post(messageFrom(teams));

    await expect(kept(teams.conversation)).resolves.toHaveLength(1);
    expect(gateway.requests).toHaveLength(2);
  });
});

describe("a request Teams didn't send for this client", () => {
  it("is refused without a token, and nothing is read or sent", async () => {
    const { teams } = await member(idp);

    await expect(
      post(messageFrom(teams), { authorization: null })
    ).resolves.toBe(401);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
    await expect(reached(teams.conversation)).resolves.toMatchObject({
      activities: [],
      asked: [],
    });
  });

  it("is refused from another tenant, and nothing is read or sent", async () => {
    const { teams } = await member(idp);
    const elsewhere = messageFrom(teams, {
      conversation: {
        id: teams.conversation,
        conversationType: "personal",
        tenantId: otherTenant,
      },
      channelData: { tenant: { id: otherTenant } },
    });

    await expect(post(elsewhere)).resolves.toBe(401);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
    await expect(reached(teams.conversation)).resolves.toMatchObject({
      activities: [],
      asked: [],
    });
  });
});

describe("someone who isn't one of the client's people", () => {
  it("gets one line when they're a guest, and nothing they wrote is read", async () => {
    const guest = teamsPerson();
    await onRoster(guest, { userRole: "guest", tenantId: acmeTenant });

    await expect(post(messageFrom(guest))).resolves.toBe(200);

    await expect(kept(guest.conversation)).resolves.toStrictEqual([]);
    const { lines } = await reached(guest.conversation);
    expect(lines).toStrictEqual([
      "I only help the company's own people, not its guests, so I can't help you here.",
    ]);
  });

  it("gets one line when they're from another company", async () => {
    const outsider = teamsPerson();
    await onRoster(outsider, { userRole: "user", tenantId: otherTenant });

    await post(messageFrom(outsider));

    await expect(kept(outsider.conversation)).resolves.toStrictEqual([]);
    const { lines } = await reached(outsider.conversation);
    expect(lines).toStrictEqual([
      "I only work for the people of the company that set me up, so I can't help you here.",
    ]);
  });

  it("gets the outsider's line when Teams can't say who they are", async () => {
    const unlisted = teamsPerson();

    await post(messageFrom(unlisted));

    const { lines } = await reached(unlisted.conversation);
    expect(lines).toStrictEqual([
      "I only work for the people of the company that set me up, so I can't help you here.",
    ]);
  });

  it("gets one line once they're removed, without a look at the roster", async () => {
    const admin = await signedInApi(idp, "admin");
    const { userId, teams } = await member(idp);
    await admin.api.members.remove(userId);

    await expect(post(messageFrom(teams))).resolves.toBe(200);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
    await expect(reached(teams.conversation)).resolves.toMatchObject({
      lines: [
        "You no longer have access to Grasp, so I can't help you. If you think that's a mistake, ask your admin.",
      ],
      asked: [],
    });
  });

  it("is never taken for someone else by a name or an email", async () => {
    const { teams } = await member(idp);
    const impostor = teamsPerson();
    await onRoster(impostor, { userRole: "user", tenantId: acmeTenant });

    await post(
      messageFrom(impostor, {
        from: {
          id: impostor.userId,
          aadObjectId: impostor.aadObjectId,
          name: teams.userId,
          email: "person@acme.test",
        },
      })
    );

    await expect(kept(impostor.conversation)).resolves.toStrictEqual([]);
  });

  it("gets their line once when Teams sends it again", async () => {
    const guest = teamsPerson();
    await onRoster(guest, { userRole: "guest", tenantId: acmeTenant });
    const message = messageFrom(guest);

    await post(message);
    await post(message);

    const { lines } = await reached(guest.conversation);
    expect(lines).toHaveLength(1);
  });

  it("gets their line in the language their Teams is in", async () => {
    const guest = teamsPerson();
    await onRoster(guest, { userRole: "guest", tenantId: acmeTenant });

    await post(messageFrom(guest, { locale: "de-DE" }));

    const { lines } = await reached(guest.conversation);
    expect(lines).toStrictEqual([
      "Ich helfe nur den eigenen Leuten des Unternehmens, nicht seinen Gästen, deshalb kann ich Ihnen hier nicht helfen.",
    ]);
  });
});

describe("a group chat or a channel", () => {
  it("gets one line, even from a known person, and nothing is taken", async () => {
    const { teams } = await member(idp);
    const group = `19:${unique()}@thread.v2`;

    await post(
      messageFrom(teams, {
        conversation: {
          id: group,
          conversationType: "groupChat",
          tenantId: acmeTenant,
        },
      })
    );

    await expect(kept(group)).resolves.toStrictEqual([]);
    await expect(reached(group)).resolves.toMatchObject({
      lines: [
        "I only answer in a private chat. Send me a direct message, and I'll help you there.",
      ],
      asked: [],
    });
  });
});

describe("a flood from one person", () => {
  // The clock stands still, so no token comes back while a test sends.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is cut past the limit before anything is looked up, with one line to say so", async () => {
    const flooder = teamsPerson();
    await onRoster(flooder, { userRole: "guest", tenantId: acmeTenant });

    for (let sent = 0; sent < 13; sent += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as typed
      await post(messageFrom(flooder));
    }

    const { lines, asked } = await reached(flooder.conversation);
    // Ten taken, each answered; then one line to slow down, and silence.
    expect(asked).toHaveLength(10);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe(
      "You've sent me a lot of messages in a short time. Wait a moment, then ask me again."
    );
  });

  it("is counted per person: someone else still gets in", async () => {
    const flooder = teamsPerson();
    for (let sent = 0; sent < 11; sent += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as typed
      await post(messageFrom(flooder));
    }
    const { teams } = await member(idp, says("Hello."));

    await post(messageFrom(teams));

    await expect(kept(teams.conversation)).resolves.toHaveLength(1);
  });
});

describe("a platform the deployment hasn't set up", () => {
  it("isn't there", async () => {
    const { teams } = await member(idp);

    await expect(
      post(messageFrom(teams), { path: "/api/channels/discord" })
    ).resolves.toBe(404);
    await expect(
      post(messageFrom(teams), { coreEnv: { ...env, TEAMS_BOT_ID: "" } })
    ).resolves.toBe(404);

    await expect(kept(teams.conversation)).resolves.toStrictEqual([]);
  });
});
