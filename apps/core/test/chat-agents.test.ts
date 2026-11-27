import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { chatAgentId } from "../src/chats-rpc.ts";
import { model, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { saveInstructions } from "./instruction-saves.ts";
import { fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi, signIn } from "./sign-in.ts";
import { startedThrough } from "./started-chats.ts";

// Picking an agent for a chat in Grasp's own chat, over `/rpc`, as a
// person's page reaches it. These start from the ways it can fail: an
// agent listed for someone outside its audience; a chat made with such
// an agent, with a paused one, or with an ID that names none; the refusal
// telling an agent that exists from one that doesn't; an agent's
// instructions handed to the page; a chat answered by another agent than
// the one it was made with. And for an agent for its maker alone: anyone
// but its maker reaching it, another admin included, by its ID or through
// a chat made before; its maker named by whoever set it; the first
// agent, which nobody made, set so; a person's own agent widened by it;
// someone else answered once its maker is erased.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const everyone = { who: "everyone" } as const;
const maker = { who: "maker" } as const;

/** The IDs of the agents `person` may talk to, as their page lists them. */
const listedFor = async (
  person: Awaited<ReturnType<typeof signedInApi>>
): Promise<string[]> => {
  const listed = await person.api.chats.agents();
  return listed.map(({ id }) => id);
};

/** What an admin says of an agent, with `over` its own. */
const said = (over: Record<string, unknown> = {}) => ({
  name: "Claire",
  face: "claire",
  job: "Chases unpaid invoices.",
  modelRole: null,
  ...over,
});

/** Tells the agent `agentId` its rule, in its instruction file, as `admin` saves it on its page. */
const tell = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  agentId: string
): Promise<void> => {
  await saveInstructions(
    admin.api,
    { scope: "agent", agentId },
    "Answer only about invoices. SECRET-RULE-17."
  );
};

/** A team of the company's, with `userIds` in it. */
const teamOf = async (...userIds: string[]): Promise<string> => {
  const team = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, 'Finance', 'organization', ?)"
    ).bind(team, Date.now()),
    ...userIds.map((userId) =>
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, userId, Date.now())
    ),
  ]);
  return team;
};

describe("picking an agent for a chat", setUpTime, () => {
  beforeEach(async () => {
    // Every test starts with the company's first agent alone.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_places"),
      env.DB.prepare("DELETE FROM agent_tool_classes"),
    ]);
  });

  it("lists only the agents that are on and have the person in their audience, without their instructions", async () => {
    const admin = await signedInApi(idp, "admin");
    const inTeam = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const team = await teamOf(inTeam.userId);
    const { connections } = admin.api;
    const claire = await connections.makeAgent(said());
    await tell(admin, claire.id);
    const nobodys = await connections.makeAgent(said({ name: "Nobody's" }));
    const paused = await connections.makeAgent(said({ name: "Pat" }));
    await connections.setAgentReach(claire.id, true, {
      who: "teams",
      teams: [team],
    });
    await connections.setAgentReach(paused.id, true, everyone);
    await connections.setAgentPaused(paused.id, true);

    const first = {
      id: chatAgentId,
      name: "Stephen",
      face: "stephen",
      job: "Answers from what the company told Grasp, and helps people in their own apps.",
      model: null,
      own: false,
    };
    const theirs = await inTeam.api.chats.agents();
    expect(theirs).toStrictEqual([
      first,
      {
        id: claire.id,
        name: "Claire",
        face: "claire",
        job: "Chases unpaid invoices.",
        model: null,
        own: false,
      },
    ]);
    await expect(outside.api.chats.agents()).resolves.toStrictEqual([first]);
    // The admin who made them is outside their audience too.
    await expect(admin.api.chats.agents()).resolves.toStrictEqual([first]);
    expect(JSON.stringify(theirs)).not.toContain("SECRET-RULE-17");
    expect(nobodys.id).not.toBe(claire.id);
  });

  it("refuses a chat with an agent the person may not talk to as with one the company doesn't have, and makes none", async () => {
    const admin = await signedInApi(idp, "admin");
    const outside = await signedInApi(idp, "user");
    const { connections } = admin.api;
    const hidden = await connections.makeAgent(said());
    const paused = await connections.makeAgent(said({ name: "Pat" }));
    await connections.setAgentReach(paused.id, true, everyone);
    await connections.setAgentPaused(paused.id, true);

    const { chats } = outside.api;
    const before = await chats.list();
    await expect(
      Promise.all([
        outcome(startedThrough(chats, "Hidden", { agentId: hidden.id })),
        outcome(startedThrough(chats, "Paused", { agentId: paused.id })),
        outcome(
          startedThrough(chats, "None", { agentId: "agent-there-is-none" })
        ),
        outcome(
          startedThrough(chats, "Not an ID", { agentId: "../organization" })
        ),
        outcome(
          startedThrough(chats, "Not a string", {
            // @ts-expect-error -- what a page must not send
            agentId: { id: hidden.id },
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "agent.unknown",
      "agent.unknown",
      "agent.unknown",
      "agent.unknown",
      "agent.invalid_request",
    ]);
    await expect(chats.list()).resolves.toStrictEqual(before);
  });

  it("makes a chat with the first agent when none is named, and with the one named when the person may talk to it", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const claire = await admin.api.connections.makeAgent(said());
    await admin.api.connections.setAgentReach(claire.id, true, everyone);

    const { chats } = person.api;
    const plain = await startedThrough(chats, "Plain");
    const named = await startedThrough(chats, "Named first", {
      agentId: chatAgentId,
    });
    const hers = await startedThrough(chats, "Invoices", {
      agentId: claire.id,
    });
    expect([plain.agentId, named.agentId, hers.agentId]).toStrictEqual([
      chatAgentId,
      chatAgentId,
      claire.id,
    ]);
    // The list, one chat's summary and a search all say whose it is.
    const listed = await chats.list();
    expect(
      Object.fromEntries(listed.map(({ title, agentId }) => [title, agentId]))
    ).toMatchObject({ Plain: chatAgentId, Invoices: claire.id });
    await expect(chats.summary(hers.id)).resolves.toMatchObject({
      agentId: claire.id,
    });
    const found = await chats.search("Invoices");
    expect(found.map(({ chat }) => chat.agentId)).toStrictEqual([claire.id]);
  });

  it("answers a chat as the agent it was made with, and no longer once that agent is taken from the person", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const { connections } = admin.api;
    const claire = await connections.makeAgent(said());
    await tell(admin, claire.id);
    await connections.setAgentReach(claire.id, true, everyone);
    const gateway = await fakeProvider(says("About invoices."));
    const chat = await startedThrough(person.api.chats, "Invoices", {
      agentId: claire.id,
    });

    await expect(
      outcome(person.api.chats.send(chat.id, { text: "Hi.", model }))
    ).resolves.toBe("ok");
    // Its own instruction file, so its own agent, went to the model.
    await vi.waitFor(() => {
      expect(JSON.stringify(gateway.requests)).toContain("SECRET-RULE-17");
    });

    await connections.setAgentReach(claire.id, true, { who: "nobody" });
    // The turn is over once the chat no longer runs.
    await vi.waitFor(async () => {
      await expect(person.api.chats.summary(chat.id)).resolves.toMatchObject({
        running: false,
      });
    });
    const asked = gateway.requests.length;
    await expect(
      outcome(person.api.chats.send(chat.id, { text: "Again.", model }))
    ).resolves.toBe("agent.not_for_you");
    expect(gateway.requests).toHaveLength(asked);
    await expect(person.api.chats.agents()).resolves.toHaveLength(1);
  });

  it("lists and answers an agent for its maker alone, never another admin or a member, by its ID or in a chat made before", async () => {
    const made = await signedInApi(idp, "admin");
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const claire = await made.api.connections.makeAgent(said());
    await made.api.connections.setAgentReach(claire.id, true, everyone);
    const before = {
      made: await startedThrough(made.api.chats, "Mine", {
        agentId: claire.id,
      }),
      admin: await startedThrough(admin.api.chats, "Theirs", {
        agentId: claire.id,
      }),
      member: await startedThrough(member.api.chats, "Hers", {
        agentId: claire.id,
      }),
    };
    // Set by another admin, it is still for the one who made it.
    await admin.api.connections.setAgentReach(claire.id, true, maker);

    expect({
      made: await listedFor(made),
      admin: await listedFor(admin),
      member: await listedFor(member),
    }).toStrictEqual({
      made: [chatAgentId, claire.id],
      admin: [chatAgentId],
      member: [chatAgentId],
    });
    const gateway = await fakeProvider(says("About invoices."));
    const hi = { text: "Hi.", model };
    // As any agent they may not reach: unknown by its ID, and no longer
    // answering in a chat made with it.
    await expect(
      Promise.all([
        outcome(
          startedThrough(admin.api.chats, "Again", { agentId: claire.id })
        ),
        outcome(
          startedThrough(member.api.chats, "Again", { agentId: claire.id })
        ),
        outcome(admin.api.chats.send(before.admin.id, hi)),
        outcome(member.api.chats.send(before.member.id, hi)),
      ])
    ).resolves.toStrictEqual([
      "agent.unknown",
      "agent.unknown",
      "agent.not_for_you",
      "agent.not_for_you",
    ]);
    expect(gateway.requests).toHaveLength(0);
    await expect(
      Promise.all([
        outcome(made.api.chats.send(before.made.id, hi)),
        outcome(
          startedThrough(made.api.chats, "Another", { agentId: claire.id })
        ),
      ])
    ).resolves.toStrictEqual(["ok", "ok"]);
    await vi.waitFor(() => {
      expect(gateway.requests.length).toBeGreaterThan(0);
    });
    // What an admin's page reads of it.
    await expect(
      admin.api.connections.agentSettings(claire.id)
    ).resolves.toMatchObject({ on: true, audience: maker });
  });

  it("never makes the first agent, which nobody made, its maker's alone, nor changes whom a person's own agent reaches", async () => {
    const admin = await signedInApi(idp, "admin");
    const other = await signedInApi(idp, "admin");
    const { connections } = admin.api;
    const own = await connections.makeOwnAgent(said({ name: "Mine" }));

    await expect(
      Promise.all([
        outcome(connections.setAgentReach(chatAgentId, true, maker)),
        outcome(
          // @ts-expect-error -- not an audience Settings › Stephen has, as a page could send it
          connections.setStephenReach(true, maker)
        ),
        // A person's own agent refuses it as any audience.
        outcome(connections.setAgentReach(own.id, true, maker)),
        outcome(connections.setAgentReach(own.id, true, everyone)),
      ])
    ).resolves.toStrictEqual([
      "agent.record_invalid",
      "connection.invalid",
      "agent.unknown",
      "agent.unknown",
    ]);
    expect({
      owner: await listedFor(admin),
      other: await listedFor(other),
    }).toStrictEqual({
      owner: [chatAgentId, own.id],
      other: [chatAgentId],
    });
  });

  it("answers nobody once its maker is erased, though it still names them", async () => {
    const made = await signedInApi(idp, "admin");
    const admin = await signedInApi(idp, "admin");
    const claire = await made.api.connections.makeAgent(said());
    await made.api.connections.setAgentReach(claire.id, true, maker);
    await admin.api.members.remove(made.userId);
    await admin.api.members.erase(made.userId, String(made.person.name));

    // Whoever signs in now, under any ID but the erased one: the erased
    // person themselves gets no session at all.
    const again = await signIn(idp, "microsoft", made.person);
    const newcomer = await signedInApi(idp, "admin");
    const listed = await admin.api.connections.agents();
    const settings = await admin.api.connections.agentSettings(claire.id);
    expect({
      again: again.session,
      admin: await listedFor(admin),
      newcomer: await listedFor(newcomer),
      madeBy: listed.find(({ id }) => id === claire.id)?.madeBy,
      audience: settings.audience,
    }).toStrictEqual({
      again: undefined,
      admin: [chatAgentId],
      newcomer: [chatAgentId],
      madeBy: made.userId,
      audience: maker,
    });
  });

  it("makes no chat with the first agent while it is paused, and says it is paused", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    await admin.api.connections.setAgentPaused(chatAgentId, true);
    const { chats } = person.api;
    const before = await chats.list();
    await expect(
      Promise.all([
        outcome(startedThrough(chats, "Unnamed")),
        outcome(startedThrough(chats, "Named", { agentId: chatAgentId })),
      ])
    ).resolves.toStrictEqual(["agent.paused", "agent.paused"]);
    await expect(chats.list()).resolves.toStrictEqual(before);
    await admin.api.connections.setAgentPaused(chatAgentId, false);
    await expect(outcome(startedThrough(chats, "Back"))).resolves.toBe("ok");
  });
});
