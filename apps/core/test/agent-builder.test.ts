import { companyToolClasses } from "@grasp-os/shared/connect";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { agentFor } from "../src/agent-reach.ts";
import { readAgent } from "../src/agents.ts";
import { chatAgentId } from "../src/chats-rpc.ts";
import { model, says } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
} from "./sign-in.ts";

// The agent builder over `/rpc`, as an admin's page reaches it. These
// start from the ways it can fail: an agent that answers or acts before
// an admin gave it anyone; someone who isn't the company's own admin
// making or changing one; two agents under one name; the first agent's
// reach changed here, around Settings › Stephen; a change to an agent the
// company doesn't have; a change left unaudited, or one that keeps an
// agent's instructions in the log.

const idp = mockIdp();

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** What an admin says of an agent, with `over` its own. */
const said = (over: Record<string, unknown> = {}) => ({
  name: "Claire",
  face: "claire",
  job: "Chases unpaid invoices.",
  instructions: "Answer only about invoices.",
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

/** For whom `agentId` has each class, as core keeps it. */
const classesOf = async (agentId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT tool_class, who FROM agent_tool_classes WHERE agent_id = ? ORDER BY tool_class"
  )
    .bind(agentId)
    .all<{ tool_class: string; who: string }>();
  return Object.fromEntries(results.map((row) => [row.tool_class, row.who]));
};

const nothing = { reaches: false, acts: false };
const reachesActs = { reaches: true, acts: true };

describe("the agent builder", setUpTime, () => {
  beforeEach(async () => {
    // Every test starts with the company's first agent alone.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM agents"),
      env.DB.prepare("DELETE FROM agent_reach"),
      env.DB.prepare("DELETE FROM agent_places"),
      env.DB.prepare("DELETE FROM agent_tool_classes"),
    ]);
  });

  it("makes an agent that reaches nobody and has every class for nobody, until an admin says otherwise", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const made = await admin.api.connections.makeAgent(said());

    expect(made).toMatchObject({ ...said(), state: "on" });
    await expect(
      Promise.all([
        agentFor(env, made.id, person.userId),
        agentFor(env, made.id, person.userId, "teams"),
        agentFor(env, made.id, admin.userId),
      ])
    ).resolves.toStrictEqual([nothing, nothing, nothing]);
    await expect(classesOf(made.id)).resolves.toStrictEqual(
      Object.fromEntries(
        companyToolClasses.toSorted().map((toolClass) => [toolClass, "nobody"])
      )
    );
  });

  it("lists the first agent first, then the others by name, each under an ID of its own", async () => {
    const admin = await signedInApi(idp, "admin");
    const pat = await admin.api.connections.makeAgent(said({ name: "pat" }));
    const claire = await admin.api.connections.makeAgent(said());
    const listed = await admin.api.connections.agents();
    expect(listed.map(({ id, name }) => ({ id, name }))).toStrictEqual([
      { id: chatAgentId, name: "Stephen" },
      { id: claire.id, name: "Claire" },
      { id: pat.id, name: "pat" },
    ]);
    expect(new Set([chatAgentId, claire.id, pat.id]).size).toBe(3);
  });

  it("is the company's own admins' alone: never a member's, never Grasp staff's", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const staffRpc = await openRpc(staffSession);
    const staff = staffRpc.core.authenticate();
    const made = await admin.api.connections.makeAgent(said());
    const everyone = { who: "everyone" } as const;

    const tried = async (api: typeof member.api.connections) => ({
      reads: await outcome(api.agents()),
      makes: await outcome(api.makeAgent(said({ name: "Mallory" }))),
      changes: await outcome(api.changeAgent(made.id, said({ job: "Mine." }))),
      pauses: await outcome(api.setAgentPaused(made.id, true)),
      reach: await outcome(api.setAgentReach(made.id, true, everyone)),
      classes: await outcome(
        api.setAgentToolClass(made.id, "read-own", everyone)
      ),
    });
    const refused = "role.forbidden";
    expect({
      member: await tried(member.api.connections),
      staff: await tried(staff.connections),
    }).toStrictEqual({
      member: {
        reads: refused,
        makes: refused,
        changes: refused,
        pauses: refused,
        reach: refused,
        classes: refused,
      },
      staff: {
        reads: refused,
        makes: refused,
        changes: refused,
        pauses: refused,
        reach: refused,
        classes: refused,
      },
    });
    // Nothing of theirs was kept.
    const listed = await admin.api.connections.agents();
    expect(
      listed.map(({ name, job, state }) => ({ name, job, state }))
    ).toStrictEqual([
      { name: "Stephen", job: listed[0]?.job, state: "on" },
      { name: "Claire", job: "Chases unpaid invoices.", state: "on" },
    ]);
    await expect(agentFor(env, made.id, member.userId)).resolves.toStrictEqual(
      nothing
    );
  });

  it("gives no two agents one name, however it is written, and takes only what is an agent's", async () => {
    const admin = await signedInApi(idp, "admin");
    const { makeAgent, changeAgent } = admin.api.connections;
    const claire = await admin.api.connections.makeAgent(said());
    expect({
      same: await outcome(makeAgent(said())),
      otherCase: await outcome(makeAgent(said({ name: "CLAIRE" }))),
      firstAgents: await outcome(makeAgent(said({ name: "stephen" }))),
      renamedOnto: await outcome(
        changeAgent(chatAgentId, said({ name: "claire" }))
      ),
      // Its own name is its own.
      keptName: await outcome(changeAgent(claire.id, said({ job: "More." }))),
      noName: await outcome(makeAgent(said({ name: "  " }))),
      longName: await outcome(makeAgent(said({ name: "x".repeat(61) }))),
      longInstructions: await outcome(
        makeAgent(said({ name: "Pat", instructions: "x".repeat(8001) }))
      ),
      // A field an agent doesn't have, as a page could send it.
      extra: await outcome(makeAgent(said({ name: "Pat", state: "paused" }))),
      noSuchAgent: await outcome(changeAgent("payroll", said({ name: "Pat" }))),
    }).toStrictEqual({
      same: "agent.name_taken",
      otherCase: "agent.name_taken",
      firstAgents: "agent.name_taken",
      renamedOnto: "agent.name_taken",
      keptName: "ok",
      noName: "agent.record_invalid",
      longName: "agent.record_invalid",
      longInstructions: "agent.record_invalid",
      extra: "agent.record_invalid",
      noSuchAgent: "agent.unknown",
    });
  });

  it("counts a name once however its accents and capitals are written", async () => {
    const admin = await signedInApi(idp, "admin");
    const { makeAgent } = admin.api.connections;
    await makeAgent(said({ name: "Élodie" }));
    expect({
      lowerCase: await outcome(makeAgent(said({ name: "élodie" }))),
      // The same name with its accent as a mark of its own.
      decomposed: await outcome(makeAgent(said({ name: "E\u0301lodie" }))),
      another: await outcome(makeAgent(said({ name: "Elodie" }))),
    }).toStrictEqual({
      lowerCase: "agent.name_taken",
      decomposed: "agent.name_taken",
      another: "ok",
    });
  });

  it("stops a paused agent answering, before the model is asked, until it is turned back on", async () => {
    const admin = await signedInApi(idp, "admin");
    const member = await signedInApi(idp, "user");
    const gateway = await fakeProvider(says("Back."));
    const chat = await member.api.chats.create("Paused");
    await admin.api.connections.setAgentPaused(chatAgentId, true);
    await expect(
      outcome(member.api.chats.send(chat.id, { text: "Hi.", model }))
    ).resolves.toBe("agent.paused");
    expect(gateway.requests).toHaveLength(0);
    await admin.api.connections.setAgentPaused(chatAgentId, false);
    await expect(
      outcome(member.api.chats.send(chat.id, { text: "Hi.", model }))
    ).resolves.toBe("ok");
  });

  it("writes and records nothing for a change that leaves the first agent as Grasp ships it", async () => {
    const admin = await signedInApi(idp, "admin");
    const shipped = await readAgent(env, chatAgentId);
    if (shipped === undefined) {
      throw new Error("Expected the first agent");
    }
    const events = await auditedDuring(async () => {
      await admin.api.connections.setAgentPaused(chatAgentId, false);
      await admin.api.connections.changeAgent(chatAgentId, {
        name: shipped.name,
        face: shipped.face,
        job: shipped.job,
        instructions: shipped.instructions,
        modelRole: shipped.modelRole,
      });
    });
    expect(
      events.filter(({ action }) => action.startsWith("agent."))
    ).toStrictEqual([]);
    // Still as shipped: no row was written for it.
    await expect(readAgent(env, chatAgentId)).resolves.toMatchObject({
      changedBy: null,
      changedAt: null,
    });
  });

  it("changes and pauses the first agent under the ID it always had", async () => {
    const admin = await signedInApi(idp, "admin");
    await admin.api.connections.changeAgent(
      chatAgentId,
      said({ name: "Ada", instructions: "Be brief." })
    );
    await admin.api.connections.setAgentPaused(chatAgentId, true);
    await expect(readAgent(env, chatAgentId)).resolves.toMatchObject({
      id: chatAgentId,
      name: "Ada",
      instructions: "Be brief.",
      state: "paused",
      changedBy: admin.userId,
    });
    await admin.api.connections.setAgentPaused(chatAgentId, false);
    await expect(readAgent(env, chatAgentId)).resolves.toMatchObject({
      name: "Ada",
      state: "on",
    });
  });

  it("lets an admin say whom an agent reaches and for whom it has a class, and leaves the first agent's to Settings › Stephen", async () => {
    const admin = await signedInApi(idp, "admin");
    const inTeam = await signedInApi(idp, "user");
    const outside = await signedInApi(idp, "user");
    const team = await teamOf(inTeam.userId);
    const { setAgentReach, setAgentToolClass } = admin.api.connections;
    const made = await admin.api.connections.makeAgent(said());
    const theTeam = { who: "teams" as const, teams: [team] };
    const everyone = { who: "everyone" } as const;

    await setAgentReach(made.id, true, theTeam);
    await setAgentToolClass(made.id, "read-own", { who: "asClass" });
    await expect(
      Promise.all([
        agentFor(env, made.id, inTeam.userId),
        agentFor(env, made.id, outside.userId),
      ])
    ).resolves.toStrictEqual([reachesActs, nothing]);
    await expect(classesOf(made.id)).resolves.toMatchObject({
      "read-own": "asClass",
      "change-own": "nobody",
    });

    expect({
      firstReach: await outcome(setAgentReach(chatAgentId, false, everyone)),
      firstClass: await outcome(
        setAgentToolClass(chatAgentId, "read-own", { who: "nobody" })
      ),
      noSuchAgent: await outcome(setAgentReach("payroll", true, everyone)),
      noSuchTeam: await outcome(
        setAgentReach(made.id, true, {
          who: "teams",
          teams: [crypto.randomUUID()],
        })
      ),
      // @ts-expect-error -- not a class, as a page could send it
      noSuchClass: await outcome(setAgentToolClass(made.id, "never", everyone)),
    }).toStrictEqual({
      firstReach: "agent.settings_elsewhere",
      firstClass: "agent.settings_elsewhere",
      noSuchAgent: "agent.unknown",
      noSuchTeam: "connection.invalid",
      noSuchClass: "agent.record_invalid",
    });
    // The refused changes changed nothing.
    await expect(agentFor(env, made.id, outside.userId)).resolves.toStrictEqual(
      nothing
    );
  });

  it("records each change in the audit log, never an agent's instructions, and nothing for a change to nothing", async () => {
    const admin = await signedInApi(idp, "admin");
    const secret = `instructions-${crypto.randomUUID()}`;
    let id = "";
    const events = await auditedDuring(async () => {
      const made = await admin.api.connections.makeAgent(
        said({ instructions: secret })
      );
      ({ id } = made);
      await admin.api.connections.changeAgent(id, said({ job: "More." }));
      // The same again changes nothing.
      await admin.api.connections.changeAgent(id, said({ job: "More." }));
      await admin.api.connections.setAgentPaused(id, true);
      await admin.api.connections.setAgentPaused(id, true);
      await admin.api.connections.setAgentReach(id, true, { who: "everyone" });
      await admin.api.connections.setAgentReach(id, true, { who: "everyone" });
      await admin.api.connections.setAgentToolClass(id, "read-own", {
        who: "asClass",
      });
    });

    const ours = events.filter(({ action }) => action.startsWith("agent."));
    expect(
      ours.map(({ action, actor, target }) => ({ action, actor, target }))
    ).toStrictEqual(
      [
        ["agent.made", { type: "agent", id }],
        ["agent.changed", { type: "agent", id }],
        ["agent.paused", { type: "agent", id }],
        ["agent.reach.changed", { type: "agent", id }],
        ["agent.class.changed", { type: "tool_class", id: `${id}/read-own` }],
      ].map(([action, target]) => ({
        action,
        actor: { type: "person", userId: admin.userId },
        target,
      }))
    );
    expect(ours[0]?.detail).toMatchObject({
      name: "Claire",
      instructionsLength: String(secret.length),
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
