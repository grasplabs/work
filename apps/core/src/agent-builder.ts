import { agentErrors } from "@grasp-os/shared/agent";
import { agentInputSchema } from "@grasp-os/shared/agents";
import type { Agent, AgentInput } from "@grasp-os/shared/agents";
import { actorOf } from "@grasp-os/shared/audit";
import {
  companyToolClasses,
  companyToolClassSchema,
  toolClassAudienceSchema,
} from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
import { appClassAudienceSchema } from "@grasp-os/shared/stephen-reach";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { firstAgentId, readAgent } from "./agents.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { agentReach, agents, agentToolClasses } from "./db/core/schema.ts";
import {
  requireCompanyAdmin,
  requireKnownTeams,
  storedNarrowing,
  teamsDetail,
} from "./stephen-reach.ts";
import { storedOf } from "./tool-classes.ts";

// The agent builder, as core keeps it: the company's admins making an
// agent, changing what it is called and told, pausing it, and saying whom
// it reaches and for whom it has each class of tools (agent-reach.ts).
//
// An agent starts with nothing. Making one writes, in the same batch as
// the agent itself, that it reaches nobody and has every class for
// nobody: a missing row would read as the layer above it (agent-reach.ts),
// so no agent exists, even for a moment, that answers people or acts for
// them before an admin said so. What the company has off stays off
// whatever an agent's row says: the class gate asks the company first.
//
// The company's own admins change agents, never Grasp staff, and every
// change is audited; one that changes nothing records nothing. An agent's
// instructions are not kept in the audit log, only how long they are.
//
// The ways it can fail, which the tests start from: an agent that
// answers or acts before an admin gave it anyone; someone who isn't the
// company's own admin making or changing one; two agents under one name;
// the first agent's reach changed here, around Settings › Stephen; a
// change to an agent the company doesn't have; a change left unaudited.

/** What an admin said of an agent, or `agent.record_invalid`. */
const inputOf = (input: unknown): AgentInput => {
  const parsed = agentInputSchema.safeParse(input);
  if (!parsed.success) {
    throw agentErrors.create("agent.record_invalid");
  }
  return parsed.data;
};

/** The agent `agentId`, or `agent.unknown`. */
const requireAgent = async (env: Env, agentId: unknown): Promise<Agent> => {
  const agent =
    typeof agentId === "string" ? await readAgent(env, agentId) : undefined;
  if (agent === undefined) {
    throw agentErrors.create("agent.unknown");
  }
  return agent;
};

/** Refuses `name` when an agent other than `agentId` answers to it. */
const requireNameFree = async (
  env: Env,
  name: string,
  agentId: string
): Promise<void> => {
  const lowered = name.toLowerCase();
  const [taken, first] = await Promise.all([
    drizzle(env.DB)
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(eq(sql`lower(${agents.name})`, lowered), ne(agents.id, agentId))
      )
      .get(),
    // The first agent's name while it has no row of its own.
    agentId === firstAgentId ? undefined : readAgent(env, firstAgentId),
  ]);
  if (taken !== undefined || first?.name.toLowerCase() === lowered) {
    throw agentErrors.create("agent.name_taken");
  }
};

/** An agent's row as its record. */
const recordOf = (row: typeof agents.$inferSelect): Agent => ({
  id: row.id,
  name: row.name,
  face: row.face,
  job: row.job,
  instructions: row.instructions,
  modelRole: row.modelRole,
  state: row.state,
  changedBy: row.changedBy,
  changedAt: row.changedAt.toISOString(),
});

/** What an audit event says of an agent: never its instructions. */
const detailOf = ({
  name,
  face,
  job,
  instructions,
  modelRole,
}: AgentInput): Record<string, string> => ({
  name,
  face,
  job,
  instructionsLength: String(instructions.length),
  modelRole: modelRole ?? "none",
});

/** Every agent of the company, the first one first, then by name. */
export const listAgents = async (env: Env): Promise<Agent[]> => {
  const [first, rows] = await Promise.all([
    readAgent(env, firstAgentId),
    drizzle(env.DB)
      .select()
      .from(agents)
      .where(ne(agents.id, firstAgentId))
      .orderBy(asc(sql`lower(${agents.name})`), asc(agents.id)),
  ]);
  return [...(first === undefined ? [] : [first]), ...rows.map(recordOf)];
};

/**
 * Makes an agent, on, reaching nobody and with every class for nobody.
 * Throws `agent.record_invalid` for what isn't an agent's name, job or
 * instructions, and `agent.name_taken` for a name another agent has.
 */
export const makeAgent = async (
  env: Env,
  identity: Identity,
  input: unknown
): Promise<Agent> => {
  requireCompanyAdmin(identity);
  const made = inputOf(input);
  const id = `agent-${crypto.randomUUID()}`;
  await requireNameFree(env, made.name, id);
  const now = new Date();
  const by = { changedBy: identity.userId, changedAt: now };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    // It reaches nobody and has no class before it exists.
    db
      .insert(agentReach)
      .values({ agentId: id, on: true, who: "nobody", teams: "[]", ...by }),
    db.insert(agentToolClasses).values(
      companyToolClasses.map((toolClass) => ({
        agentId: id,
        toolClass,
        who: "nobody" as const,
        teams: "[]",
        ...by,
      }))
    ),
    db.insert(agents).values({
      id,
      ...made,
      state: "on",
      madeBy: identity.userId,
      madeAt: now,
      ...by,
    }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.made",
      target: { type: "agent", id },
      detail: detailOf(made),
    }),
  ]);
  return {
    id,
    ...made,
    state: "on",
    changedBy: identity.userId,
    changedAt: now.toISOString(),
  };
};

/**
 * Changes what the agent `agentId` is called and told. Throws
 * `agent.unknown` for an agent the company doesn't have,
 * `agent.record_invalid` for what isn't an agent's, and `agent.name_taken`.
 */
export const changeAgent = async (
  env: Env,
  identity: Identity,
  agentId: unknown,
  input: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const changed = inputOf(input);
  const agent = await requireAgent(env, agentId);
  await requireNameFree(env, changed.name, agent.id);
  const now = new Date();
  const by = { changedBy: identity.userId, changedAt: now };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(agents)
      // The first agent's row, the first time it is changed.
      .values({
        id: agent.id,
        ...changed,
        state: agent.state,
        madeBy: identity.userId,
        madeAt: now,
        ...by,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: { ...changed, ...by },
        setWhere: or(
          sql`${agents.name} IS NOT ${changed.name}`,
          sql`${agents.face} IS NOT ${changed.face}`,
          sql`${agents.job} IS NOT ${changed.job}`,
          sql`${agents.instructions} IS NOT ${changed.instructions}`,
          sql`${agents.modelRole} IS NOT ${changed.modelRole}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.changed",
      target: { type: "agent", id: agent.id },
      detail: detailOf(changed),
    }),
  ]);
};

/**
 * Pauses the agent `agentId`, which then takes no turn, or turns it back
 * on. Throws `agent.unknown`, and `agent.record_invalid` for what isn't a
 * yes or no.
 */
export const setAgentPaused = async (
  env: Env,
  identity: Identity,
  agentId: unknown,
  paused: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  if (typeof paused !== "boolean") {
    throw agentErrors.create("agent.record_invalid");
  }
  const agent = await requireAgent(env, agentId);
  const state = paused ? "paused" : "on";
  const now = new Date();
  const by = { changedBy: identity.userId, changedAt: now };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(agents)
      .values({
        id: agent.id,
        name: agent.name,
        face: agent.face,
        job: agent.job,
        instructions: agent.instructions,
        modelRole: agent.modelRole,
        state,
        madeBy: identity.userId,
        madeAt: now,
        ...by,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: { state, ...by },
        setWhere: sql`${agents.state} IS NOT ${state}`,
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.paused",
      target: { type: "agent", id: agent.id },
      detail: { paused: String(paused) },
    }),
  ]);
};

/** An agent whose reach and classes are set here: any but the first. */
const requireOwnSettings = async (
  env: Env,
  agentId: unknown
): Promise<string> => {
  const agent = await requireAgent(env, agentId);
  if (agent.id === firstAgentId) {
    throw agentErrors.create("agent.settings_elsewhere");
  }
  return agent.id;
};

/**
 * Turns the agent `agentId` on or off for people, and says who may reach
 * it. Throws `agent.settings_elsewhere` for the first agent, whose reach is
 * Settings › Stephen's, `agent.unknown`, and `agent.record_invalid` for an
 * audience that isn't one or a team the company doesn't have.
 */
export const setAgentReach = async (
  env: Env,
  identity: Identity,
  agentId: unknown,
  on: unknown,
  audience: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const parsed = toolClassAudienceSchema.safeParse(audience);
  if (!(typeof on === "boolean" && parsed.success)) {
    throw agentErrors.create("agent.record_invalid");
  }
  const id = await requireOwnSettings(env, agentId);
  const stored = storedOf(parsed.data);
  await requireKnownTeams(env, stored.teams);
  const by = { changedBy: identity.userId, changedAt: new Date() };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(agentReach)
      .values({ agentId: id, on, ...stored, ...by })
      .onConflictDoUpdate({
        target: agentReach.agentId,
        set: { on, ...stored, ...by },
        setWhere: or(
          sql`${agentReach.on} IS NOT ${on}`,
          sql`${agentReach.who} IS NOT ${stored.who}`,
          sql`${agentReach.teams} IS NOT ${stored.teams}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.reach.changed",
      target: { type: "agent", id },
      detail: { on: String(on), who: stored.who, ...teamsDetail(stored.teams) },
    }),
  ]);
};

/**
 * Says for whom the agent `agentId` has `toolClass`: as the company has
 * it, or fewer. Throws as `setAgentReach` does, and `agent.record_invalid` for
 * what isn't a class.
 */
export const setAgentToolClass = async (
  env: Env,
  identity: Identity,
  agentId: unknown,
  toolClass: unknown,
  audience: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const parsedClass = companyToolClassSchema.safeParse(toolClass);
  const parsedAudience = appClassAudienceSchema.safeParse(audience);
  if (!(parsedClass.success && parsedAudience.success)) {
    throw agentErrors.create("agent.record_invalid");
  }
  const id = await requireOwnSettings(env, agentId);
  const stored = storedNarrowing(parsedAudience.data);
  await requireKnownTeams(env, stored.teams);
  const { who } = parsedAudience.data;
  const by = { changedBy: identity.userId, changedAt: new Date() };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .insert(agentToolClasses)
      .values({
        agentId: id,
        toolClass: parsedClass.data,
        who,
        teams: stored.teams,
        ...by,
      })
      .onConflictDoUpdate({
        target: [agentToolClasses.agentId, agentToolClasses.toolClass],
        set: { who, teams: stored.teams, ...by },
        setWhere: or(
          sql`${agentToolClasses.who} IS NOT ${who}`,
          sql`${agentToolClasses.teams} IS NOT ${stored.teams}`
        ),
      }),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.class.changed",
      target: { type: "tool_class", id: `${id}/${parsedClass.data}` },
      detail: {
        agent: id,
        toolClass: parsedClass.data,
        who,
        ...teamsDetail(stored.teams),
      },
    }),
  ]);
};
