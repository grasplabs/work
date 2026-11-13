import { agentErrors } from "@grasp-os/shared/agent";
import { agentInputSchema, ownAgentsMax } from "@grasp-os/shared/agents";
import type { Agent, AgentSaid, AgentSettings } from "@grasp-os/shared/agents";
import { actorOf } from "@grasp-os/shared/audit";
import {
  companyToolClasses,
  companyToolClassSchema,
  toolClassAudienceSchema,
} from "@grasp-os/shared/connect";
import { roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { appClassAudienceSchema } from "@grasp-os/shared/stephen-reach";
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  agentOfRow,
  changeableAgent,
  companyAgent,
  firstAgentId,
  readAgent,
} from "./agents.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import {
  agentDocuments,
  agentPlaces,
  agentReach,
  agents,
  agentToolClasses,
  agentWakes,
} from "./db/core/schema.ts";
import { modelSettings } from "./models.ts";
import {
  requireCompanyAdmin,
  requireKnownTeams,
  storedNarrowing,
  teamsDetail,
} from "./stephen-reach.ts";
import { audienceOf, off, storedOf } from "./tool-classes.ts";

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
const inputOf = (input: unknown): AgentSaid => {
  const parsed = agentInputSchema.safeParse(input);
  if (!parsed.success) {
    throw agentErrors.create("agent.record_invalid");
  }
  return parsed.data;
};

/**
 * A name as two agents may not share it: the same letters in any
 * capitalisation and any way of writing an accent are one name.
 */
const agentNameKey = (name: string): string =>
  name.normalize("NFKC").toLowerCase();

/** Refuses `name` when an agent other than `agentId` answers to it. */
const requireNameFree = async (
  env: Env,
  name: string,
  agentId: string
): Promise<void> => {
  const key = agentNameKey(name);
  const [taken, first] = await Promise.all([
    drizzle(env.DB)
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.nameKey, key), ne(agents.id, agentId)))
      .get(),
    // The first agent's name while it has no row of its own.
    agentId === firstAgentId ? undefined : readAgent(env, firstAgentId),
  ]);
  if (
    taken !== undefined ||
    (first !== undefined && agentNameKey(first.name) === key)
  ) {
    throw agentErrors.create("agent.name_taken");
  }
};

/**
 * Runs `write`, a batch that names an agent: two admins who both found a
 * name free can both write it, and the index then refuses the second,
 * which is told what the first check would have said.
 */
const namedOnce = async (write: () => Promise<unknown>): Promise<void> => {
  try {
    await write();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: agents.name_key")
    ) {
      throw agentErrors.create("agent.name_taken");
    }
    throw error;
  }
};

/**
 * Holds a write of an agent's row off one an admin deleted. Every change
 * reads the agent first and refuses a deleted one, but a delete can land
 * between that read and the write: the write then changes nothing, and
 * records nothing, so a deleted agent never comes back.
 */
const notDeleted = sql`${agents.state} IS NOT 'deleted'`;

/** The agent's row is still `ownerId`'s own, or still the company's for null. */
const ownedBy = (ownerId: string | null) =>
  sql`${agents.ownerId} IS ${ownerId}`;

/** The same for a write of another table's row of the agent `agentId`. */
const keptAgent = (agentId: SQLWrapper) =>
  sql`NOT EXISTS (SELECT 1 FROM ${agents} WHERE ${agents.id} = ${agentId} AND ${agents.state} = 'deleted')`;

/** Whether `said` is what `agent` already is. */
const unchanged = (agent: Agent, said: AgentSaid): boolean =>
  agent.name === said.name &&
  agent.face === said.face &&
  agent.job === said.job &&
  agent.instructions === said.instructions &&
  agent.modelRole === said.modelRole &&
  agent.model === said.model;

/**
 * Refuses a model the organization hasn't chosen, as an agent's own: one
 * it keeps from before is let be, so an agent whose model was taken away
 * can still be renamed. Its turns pass such a model over (workspace.ts).
 */
const requireModelChosen = async (
  env: Env,
  model: string | null,
  had: string | null
): Promise<void> => {
  if (model === null || model === had) {
    return;
  }
  const { models } = await modelSettings(env);
  if (!models.includes(model)) {
    throw agentErrors.create("agent.model_unknown");
  }
};

/**
 * What an audit event says of a person's own agent: that it is one, and
 * how much it was told. Never its name or job, which are its owner's and
 * the company's admins read the log.
 */
const ownDetailOf = ({ instructions }: AgentSaid): Record<string, string> => ({
  own: "true",
  instructionsLength: String(instructions.length),
});

/** What an audit event says of an agent: never its instructions. */
const detailOf = ({
  name,
  face,
  job,
  instructions,
  modelRole,
  model,
}: AgentSaid): Record<string, string> => ({
  name,
  face,
  job,
  instructionsLength: String(instructions.length),
  modelRole: modelRole ?? "none",
  model: model ?? "none",
});

/** Every agent of the company, the first one first, then by name: never a person's own. */
export const listAgents = async (env: Env): Promise<Agent[]> => {
  const [first, rows] = await Promise.all([
    readAgent(env, firstAgentId),
    drizzle(env.DB)
      .select()
      .from(agents)
      .where(and(ne(agents.id, firstAgentId), isNull(agents.ownerId)))
      .orderBy(asc(sql`lower(${agents.name})`), asc(agents.id)),
  ]);
  return [
    ...(first === undefined ? [] : [first]),
    // Never one an admin deleted, whose row stays.
    ...rows.flatMap((row) => agentOfRow(row) ?? []),
  ];
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
  await Promise.all([
    requireNameFree(env, made.name, id),
    requireModelChosen(env, made.model, null),
  ]);
  const now = new Date();
  const by = { changedBy: identity.userId, changedAt: now };
  const db = drizzle(env.DB);
  await namedOnce(
    async () =>
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
          nameKey: agentNameKey(made.name),
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
      ])
  );
  return {
    id,
    ...made,
    state: "on",
    ownerId: null,
    changedBy: identity.userId,
    changedAt: now.toISOString(),
  };
};

/** The agents that are `userId`'s own, by name: never one they deleted. */
export const listOwnAgents = async (
  env: Pick<Env, "DB">,
  userId: string
): Promise<Agent[]> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(agents)
    .where(eq(agents.ownerId, userId))
    .orderBy(asc(sql`lower(${agents.name})`), asc(agents.id));
  return rows.flatMap((row) => agentOfRow(row) ?? []);
};

/**
 * Refuses `name` when another of `ownerId`'s own agents has it: people
 * pick their agents by name. Not held by an index, as the company's
 * names are: two of one person's adds at once can both land, and the
 * person then renames one.
 */
const requireOwnNameFree = async (
  env: Env,
  ownerId: string,
  name: string,
  agentId: string
): Promise<void> => {
  const key = agentNameKey(name);
  const own = await listOwnAgents(env, ownerId);
  if (
    own.some((each) => each.id !== agentId && agentNameKey(each.name) === key)
  ) {
    throw agentErrors.create("agent.name_taken");
  }
};

/**
 * Makes an agent of `identity`'s own: on, theirs alone. It has no row of
 * reach, place or class: who reaches it is its owner, in Grasp's own chat
 * (agent-reach.ts), and each class is for it as the company has the class
 * for that person, so it does at most what the company's first agent may
 * do for them. Anyone of the company makes one, never Grasp's staff.
 * Throws `agent.record_invalid`, `agent.name_taken` for a name another of
 * their own has, `agent.model_unknown`, and `agent.too_many_own` past
 * {@link ownAgentsMax}, which the insert itself holds.
 */
export const makeOwnAgent = async (
  env: Env,
  identity: Identity,
  input: unknown
): Promise<Agent> => {
  if (identity.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const made = inputOf(input);
  const id = `agent-${crypto.randomUUID()}`;
  const ownerId = identity.userId;
  const [own] = await Promise.all([
    listOwnAgents(env, ownerId),
    requireOwnNameFree(env, ownerId, made.name, id),
    requireModelChosen(env, made.model, null),
  ]);
  if (own.length >= ownAgentsMax) {
    throw agentErrors.create("agent.too_many_own");
  }
  const now = new Date();
  const db = drizzle(env.DB);
  const room = sql`(SELECT count(*) FROM ${agents} WHERE ${agents.ownerId} = ${ownerId} AND ${agents.state} IS NOT 'deleted') < ${ownAgentsMax}`;
  await auditedBatch(env, db, [
    db.insert(agents).select(
      sql`SELECT ${id}, ${made.name}, NULL, ${made.face}, ${made.job},
          ${made.instructions}, ${made.modelRole}, ${made.model}, 'on',
          ${ownerId}, ${ownerId}, ${now.getTime()}, ${ownerId},
          ${now.getTime()} WHERE ${room}`
    ),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.made",
      target: { type: "agent", id },
      detail: ownDetailOf(made),
    }),
  ]);
  const kept = await readAgent(env, id);
  if (kept === undefined) {
    // The insert's condition failed: full since the check.
    throw agentErrors.create("agent.too_many_own");
  }
  return kept;
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
  const agent = await changeableAgent(env, identity, agentId);
  const changed = inputOf(input);
  if (unchanged(agent, changed)) {
    // A change to nothing: nothing is written and nothing recorded, the
    // first agent's first row included.
    return;
  }
  const { ownerId } = agent;
  await Promise.all([
    ownerId === null
      ? requireNameFree(env, changed.name, agent.id)
      : requireOwnNameFree(env, ownerId, changed.name, agent.id),
    requireModelChosen(env, changed.model, agent.model),
  ]);
  const now = new Date();
  const by = { changedBy: identity.userId, changedAt: now };
  // A person's own agent keeps no key: two people may each name theirs alike.
  const named = {
    ...changed,
    nameKey: ownerId === null ? agentNameKey(changed.name) : null,
  };
  const db = drizzle(env.DB);
  const differs = or(
    sql`${agents.name} IS NOT ${changed.name}`,
    sql`${agents.face} IS NOT ${changed.face}`,
    sql`${agents.job} IS NOT ${changed.job}`,
    sql`${agents.instructions} IS NOT ${changed.instructions}`,
    sql`${agents.modelRole} IS NOT ${changed.modelRole}`,
    sql`${agents.model} IS NOT ${changed.model}`
  );
  await namedOnce(
    async () =>
      await auditedBatch(env, db, [
        // The first agent's row is made the first time it is changed. Any
        // other agent has its row, and only that row is changed: one
        // deleted since it was read stays deleted, with its name free,
        // and one erased with its owner is never made again, least of
        // all as the company's.
        agent.id === firstAgentId
          ? db
              .insert(agents)
              .values({
                id: agent.id,
                ...named,
                state: agent.state,
                madeBy: identity.userId,
                madeAt: now,
                ...by,
              })
              .onConflictDoUpdate({
                target: agents.id,
                set: { ...named, ...by },
                setWhere: and(notDeleted, differs),
              })
          : db
              .update(agents)
              .set({ ...named, ...by })
              .where(
                and(
                  eq(agents.id, agent.id),
                  notDeleted,
                  ownedBy(ownerId),
                  differs
                )
              ),
        outboxedIfChanged(db, {
          actor: actorOf(identity),
          action: "agent.changed",
          target: { type: "agent", id: agent.id },
          detail: ownerId === null ? detailOf(changed) : ownDetailOf(changed),
        }),
      ])
  );
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
  const agent = await changeableAgent(env, identity, agentId);
  if (typeof paused !== "boolean") {
    throw agentErrors.create("agent.record_invalid");
  }
  const state = paused ? "paused" : "on";
  if (agent.state === state) {
    // As it is already: nothing is written and nothing recorded.
    return;
  }
  const now = new Date();
  const by = { changedBy: identity.userId, changedAt: now };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    // As `changeAgent` writes: the first agent's row made at its first
    // change, any other's own row changed, never one deleted or erased
    // with its owner since it was read.
    agent.id === firstAgentId
      ? db
          .insert(agents)
          .values({
            id: agent.id,
            name: agent.name,
            nameKey: agentNameKey(agent.name),
            face: agent.face,
            job: agent.job,
            instructions: agent.instructions,
            modelRole: agent.modelRole,
            model: agent.model,
            state,
            madeBy: identity.userId,
            madeAt: now,
            ...by,
          })
          .onConflictDoUpdate({
            target: agents.id,
            set: { state, ...by },
            setWhere: and(notDeleted, sql`${agents.state} IS NOT ${state}`),
          })
      : db
          .update(agents)
          .set({ state, ...by })
          .where(
            and(
              eq(agents.id, agent.id),
              notDeleted,
              ownedBy(agent.ownerId),
              sql`${agents.state} IS NOT ${state}`
            )
          ),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.paused",
      target: { type: "agent", id: agent.id },
      detail: { paused: String(paused) },
    }),
  ]);
};

/**
 * Deletes the agent `agentId`, for good. Its row stays, marked deleted,
 * so a chat that still names it is refused its turn (agents.ts); its
 * name is free again; it reaches nobody and has every class for nobody,
 * whatever else reads its rows; its places, wake-ups and documents are gone. The
 * chats people had with it, its audit events and its memory file stay.
 * Throws `agent.first_stays` for the company's first agent, which every
 * chat falls back to, and `agent.unknown`.
 */
export const deleteAgent = async (
  env: Env,
  identity: Identity,
  agentId: unknown
): Promise<void> => {
  const agent = await changeableAgent(env, identity, agentId);
  if (agent.id === firstAgentId) {
    throw agentErrors.create("agent.first_stays");
  }
  const by = { changedBy: identity.userId, changedAt: new Date() };
  const nobody = { who: "nobody" as const, teams: "[]" };
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(agentReach)
      .set({ on: false, ...nobody, ...by })
      .where(eq(agentReach.agentId, agent.id)),
    db
      .update(agentToolClasses)
      .set({ ...nobody, ...by })
      .where(eq(agentToolClasses.agentId, agent.id)),
    db.delete(agentPlaces).where(eq(agentPlaces.agentId, agent.id)),
    db.delete(agentWakes).where(eq(agentWakes.agentId, agent.id)),
    db.delete(agentDocuments).where(eq(agentDocuments.agentId, agent.id)),
    // Last before the event, which is recorded only if this changed a
    // row: an agent deleted twice at once is recorded once.
    db
      .update(agents)
      .set({ state: "deleted", nameKey: null, ...by })
      .where(and(eq(agents.id, agent.id), ne(agents.state, "deleted"))),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.deleted",
      target: { type: "agent", id: agent.id },
      detail: agent.ownerId === null ? { name: agent.name } : { own: "true" },
    }),
  ]);
};

/** An agent whose reach and classes are set here: any but the first. */
const requireOwnSettings = async (
  env: Env,
  agentId: unknown
): Promise<string> => {
  // Never a person's own agent, which has neither: it is its owner's.
  const agent = await companyAgent(env, agentId);
  if (agent.id === firstAgentId) {
    throw agentErrors.create("agent.settings_elsewhere");
  }
  return agent.id;
};

/**
 * Whom the agent `agentId` reaches and for whom it has each class, for
 * admins to read. Throws `agent.settings_elsewhere` for the first agent
 * and `agent.unknown`. A class or a reach without a row reads as the
 * layer above it, as the gates read it (agent-reach.ts); one that can't
 * be read, as nobody.
 */
export const readAgentSettings = async (
  env: Env,
  agentId: unknown
): Promise<AgentSettings> => {
  const id = await requireOwnSettings(env, agentId);
  const db = drizzle(env.DB);
  const [whole, rows] = await Promise.all([
    db.select().from(agentReach).where(eq(agentReach.agentId, id)).get(),
    db.select().from(agentToolClasses).where(eq(agentToolClasses.agentId, id)),
  ]);
  const stored = new Map(rows.map((row) => [row.toolClass, row]));
  return {
    on: whole?.on ?? true,
    audience:
      whole === undefined ? { who: "everyone" } : (audienceOf(whole) ?? off),
    classes: companyToolClasses.map((toolClass) => {
      const row = stored.get(toolClass);
      return {
        toolClass,
        audience:
          row === undefined || row.who === "asClass"
            ? { who: "asClass" }
            : (audienceOf(row) ?? off),
      };
    }),
  };
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
        setWhere: and(
          keptAgent(agentReach.agentId),
          or(
            sql`${agentReach.on} IS NOT ${on}`,
            sql`${agentReach.who} IS NOT ${stored.who}`,
            sql`${agentReach.teams} IS NOT ${stored.teams}`
          )
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
        setWhere: and(
          keptAgent(agentToolClasses.agentId),
          or(
            sql`${agentToolClasses.who} IS NOT ${who}`,
            sql`${agentToolClasses.teams} IS NOT ${stored.teams}`
          )
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

/**
 * Drops the agents that are `personId`'s own, with their documents: they
 * are erased. Their rows go whole, the ones they deleted included, which
 * name them too.
 */
export const dropOwnAgentsOf = async (
  env: Pick<Env, "DB">,
  personId: string
): Promise<void> => {
  const db = drizzle(env.DB);
  const own = db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.ownerId, personId));
  await db.batch([
    db.delete(agentDocuments).where(inArray(agentDocuments.agentId, own)),
    db.delete(agents).where(eq(agents.ownerId, personId)),
  ]);
};
