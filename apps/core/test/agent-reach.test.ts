import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { agentFor } from "../src/agent-reach.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { chatOf, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { outcome, signedInApi } from "./sign-in.ts";

// Whom each of the company's agents answers, and where, as core keeps it
// per agent. These start from the ways it can fail: an agent reaching
// someone outside its audience, or in a place it is off in; one agent's
// settings read for another, or for the organization's own agent; a row
// that can't be read letting someone in; a turn taken for someone the
// agent doesn't answer.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

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

/** Sets whether `agentId` answers at all, and for whom, as an admin would. */
const reach = async (
  agentId: string,
  on: boolean,
  who: "nobody" | "everyone" | "teams",
  teams = "[]"
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO agent_reach (agent_id, "on", who, teams, changed_by, changed_at)
     VALUES (?, ?, ?, ?, 'admin', ?)`
  )
    .bind(agentId, on ? 1 : 0, who, teams, Date.now())
    .run();
};

/** Narrows `agentId` in `place`, as an admin would. */
const placeOf = async (
  agentId: string,
  place: string,
  who: "asAgent" | "nobody" | "everyone" | "teams",
  acts: boolean,
  teams = "[]"
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO agent_places (agent_id, place, who, teams, acts, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, 'admin', ?)`
  )
    .bind(agentId, place, who, teams, acts ? 1 : 0, Date.now())
    .run();
};

const reachesActs = { reaches: true, acts: true };
const reachesOnly = { reaches: true, acts: false };
const nothing = { reaches: false, acts: false };

describe("whom an agent answers, and where", setUpTime, () => {
  beforeEach(async () => {
    // Every test starts from the defaults.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_places"),
      env.DB.prepare("DELETE FROM stephen_reach"),
      env.DB.prepare("DELETE FROM stephen_places"),
    ]);
  });

  it("is everyone, everywhere, and it acts, until an admin changes the agent", async () => {
    const person = await signedInApi(idp, "user");
    await expect(
      Promise.all([
        agentFor(env, "claire", person.userId),
        agentFor(env, "claire", person.userId, "teams"),
        agentFor(env, "claire", person.userId, "slack"),
      ])
    ).resolves.toStrictEqual([reachesActs, reachesActs, reachesActs]);
  });

  it("is only the agent's audience, in Grasp's own chat as in a chat app, and nobody once it is off", async () => {
    const inTeam = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const team = await teamOf(inTeam.userId);
    await reach("claire", true, "teams", JSON.stringify([team]));
    await reach("pat", false, "everyone");
    await expect(
      Promise.all([
        agentFor(env, "claire", inTeam.userId),
        agentFor(env, "claire", inTeam.userId, "teams"),
        agentFor(env, "claire", outside.userId),
        agentFor(env, "claire", outside.userId, "teams"),
        agentFor(env, "pat", inTeam.userId),
      ])
    ).resolves.toStrictEqual([
      reachesActs,
      reachesActs,
      nothing,
      nothing,
      nothing,
    ]);
  });

  it("is narrowed by a place, never widened, and the agent only answers where it doesn't act", async () => {
    const inTeam = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const team = await teamOf(inTeam.userId);
    const teams = JSON.stringify([team]);
    // Claire answers the team alone in Teams, and only answers in Slack.
    await placeOf("claire", "teams", "teams", true, teams);
    await placeOf("claire", "slack", "asAgent", false);
    // Pat is for the team alone; Slack having her for everyone lets
    // nobody else in.
    await reach("pat", true, "teams", teams);
    await placeOf("pat", "slack", "everyone", true);
    await expect(
      Promise.all([
        agentFor(env, "claire", inTeam.userId, "teams"),
        agentFor(env, "claire", outside.userId, "teams"),
        agentFor(env, "claire", outside.userId, "slack"),
        agentFor(env, "claire", outside.userId),
        agentFor(env, "pat", outside.userId, "slack"),
        agentFor(env, "pat", inTeam.userId, "slack"),
      ])
    ).resolves.toStrictEqual([
      reachesActs,
      nothing,
      reachesOnly,
      reachesActs,
      nothing,
      reachesActs,
    ]);
  });

  it("keeps each agent's settings its own, and the organization's agent as Settings › Stephen has it", async () => {
    const person = await signedInApi(idp, "user");
    // Rows under the organization's agent's ID here are not its settings.
    await reach(chatAgentId, false, "nobody");
    await placeOf(chatAgentId, "teams", "nobody", false);
    await reach("claire", false, "nobody");
    await expect(
      Promise.all([
        agentFor(env, chatAgentId, person.userId),
        agentFor(env, chatAgentId, person.userId, "teams"),
        agentFor(env, "pat", person.userId, "teams"),
      ])
    ).resolves.toStrictEqual([reachesActs, reachesActs, reachesActs]);
    // Stephen off in chat apps: off there for the organization's agent
    // alone, and Grasp's own chat stays everyone's.
    await env.DB.prepare(
      `INSERT INTO stephen_reach (id, "on", who, teams, changed_by, changed_at)
       VALUES ('stephen', 0, 'everyone', '[]', 'admin', ?)`
    )
      .bind(Date.now())
      .run();
    await expect(
      Promise.all([
        agentFor(env, chatAgentId, person.userId),
        agentFor(env, chatAgentId, person.userId, "teams"),
        agentFor(env, "pat", person.userId, "teams"),
      ])
    ).resolves.toStrictEqual([reachesActs, nothing, reachesActs]);
  });

  it("is nobody for an audience that can't be read", async () => {
    const person = await signedInApi(idp, "user");
    await reach("claire", true, "teams", "not json");
    await placeOf("pat", "teams", "teams", true, "not json");
    await expect(
      Promise.all([
        agentFor(env, "claire", person.userId),
        agentFor(env, "pat", person.userId, "teams"),
      ])
    ).resolves.toStrictEqual([nothing, nothing]);
  });

  it("takes no turn for someone the chat's agent doesn't answer, and asks no model", async () => {
    const inTeam = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const team = await teamOf(inTeam.userId);
    const theirs = await chatOf(outside.userId, says("Never."));
    await reach(theirs.agent.agentId, true, "teams", JSON.stringify([team]));
    await expect(outcome(theirs.ask("Hi."))).resolves.toBe("agent.not_for_you");
    expect(theirs.provider.requests).toHaveLength(0);

    // The same agent's setting lets its own audience's turn through.
    const allowed = await chatOf(inTeam.userId, says("Hello."));
    await reach(allowed.agent.agentId, true, "teams", JSON.stringify([team]));
    await expect(outcome(allowed.ask("Hi."))).resolves.toBe("ok");
  });
});
