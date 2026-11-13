import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { chatAgentId } from "../src/chats-rpc.ts";
import { model, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Picking an agent for a chat in Grasp's own chat, over `/rpc`, as a
// person's page reaches it. These start from the ways it can fail: an
// agent listed for someone outside its audience; a chat made with such
// an agent, with a paused one, or with an ID that names none; the refusal
// telling an agent that exists from one that doesn't; an agent's
// instructions handed to the page; a chat answered by another agent than
// the one it was made with.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const everyone = { who: "everyone" } as const;

/** What an admin says of an agent, with `over` its own. */
const said = (over: Record<string, unknown> = {}) => ({
  name: "Claire",
  face: "claire",
  job: "Chases unpaid invoices.",
  instructions: "Answer only about invoices. SECRET-RULE-17.",
  modelRole: null,
  ...over,
});

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
        outcome(chats.create("Hidden", hidden.id)),
        outcome(chats.create("Paused", paused.id)),
        outcome(chats.create("None", "agent-there-is-none")),
        outcome(chats.create("Not an ID", "../organization")),
        // @ts-expect-error -- what a page must not send
        outcome(chats.create("Not a string", { id: hidden.id })),
      ])
    ).resolves.toStrictEqual([
      "agent.unknown",
      "agent.unknown",
      "agent.unknown",
      "agent.unknown",
      "agent.unknown",
    ]);
    await expect(chats.list()).resolves.toStrictEqual(before);
  });

  it("makes a chat with the first agent when none is named, and with the one named when the person may talk to it", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const claire = await admin.api.connections.makeAgent(said());
    await admin.api.connections.setAgentReach(claire.id, true, everyone);

    const { chats } = person.api;
    const plain = await chats.create("Plain");
    const named = await chats.create("Named first", chatAgentId);
    const hers = await chats.create("Invoices", claire.id);
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
    await connections.setAgentReach(claire.id, true, everyone);
    const gateway = await fakeProvider(says("About invoices."));
    const chat = await person.api.chats.create("Invoices", claire.id);

    await expect(
      outcome(person.api.chats.send(chat.id, { text: "Hi.", model }))
    ).resolves.toBe("ok");
    // Its own instructions, so its own agent, went to the model.
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

  it("makes no chat with the first agent while it is paused, and says it is paused", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    await admin.api.connections.setAgentPaused(chatAgentId, true);
    const { chats } = person.api;
    const before = await chats.list();
    await expect(
      Promise.all([
        outcome(chats.create("Unnamed")),
        outcome(chats.create("Named", chatAgentId)),
      ])
    ).resolves.toStrictEqual(["agent.paused", "agent.paused"]);
    await expect(chats.list()).resolves.toStrictEqual(before);
    await admin.api.connections.setAgentPaused(chatAgentId, false);
    await expect(outcome(chats.create("Back"))).resolves.toBe("ok");
  });
});
