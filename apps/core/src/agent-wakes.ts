import { agentErrors } from "@grasp-os/shared/agent";
import { agentWakeInputSchema } from "@grasp-os/shared/agents";
import type { AgentWake } from "@grasp-os/shared/agents";
import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { nextScheduledRun } from "@grasp-os/shared/workflows";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { requireAgentReaches } from "./agent-reach.ts";
import { readAgent, turnAgent } from "./agents.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { memberOf } from "./auth/identity.ts";
import { agentWakes } from "./db/core/schema.ts";
import { workspace } from "./durable-objects.ts";
import { modelSettings } from "./models.ts";
import { readOrganization } from "./organization.ts";
import { personalWorkspaceId } from "./personal-workspace.ts";
import { requireCompanyAdmin } from "./stephen-reach.ts";

// An agent's wake-ups: when it takes a turn nobody asked for. An admin
// gives an agent a schedule, a person it works for, and what to ask it
// each time. At the times the schedule names, core's clock starts a turn
// of that agent in a chat of that person's, with the opening line as its
// question. That turn only reads (`AgentScope.unattended`): what it wants
// to change through a connection is held for the person, ending with the
// company's day, and every other write is refused. Its answer, and what
// it holds, are in the person's chat when they next look.
//
// The opening line is the admin's own words and the only instruction a
// wake-up carries: nothing that arrives from outside starts one here. A
// schedule is the only kind of wake-up yet.
//
// A wake-up fires once for each time its schedule names: the clock moves
// its `next_at` on in one statement before it starts the turn, and only
// the run whose statement changed the row goes on. Times missed while the
// clock was down count as one. A fire that can't start its turn is tried
// once more a few minutes later, then left until its next time, with why
// kept on the wake-up for its admin to see.
//
// The ways it can fail, which the tests start from: someone who isn't the
// company's own admin making one; one for someone who isn't a member, or
// for an agent the company doesn't have; a schedule that fires every
// minute; one time firing twice; a paused or deleted wake-up, or a paused
// agent's, firing; an agent that doesn't reach its person waking for
// them; a woken turn changing something.

/** Most wake-ups one agent has. */
const wakesPerAgent = 20;

/** Most wake-ups one run of the clock starts. */
const wakesPerRun = 25;

/** The shortest time between two fires of one wake-up. */
const shortestGapMs = 60 * 60 * 1000;

/** How long after a fire that couldn't start it is tried once more. */
const retryAfterMs = 5 * 60 * 1000;

/** A value to insert, as a column of the select that inserts it. */
const value = <T>(literal: T, column: string) => sql<T>`${literal}`.as(column);

/** Most characters of the opening line the chat is named with. */
const titleLength = 60;

type WakeRow = typeof agentWakes.$inferSelect;

const wakeOf = (row: WakeRow): AgentWake => ({
  id: row.id,
  agentId: row.agentId,
  cron: row.cron,
  timeZone: row.timeZone,
  personId: row.personId,
  opening: row.opening,
  state: row.state,
  nextAt: row.nextAt?.toISOString() ?? null,
  lastAt: row.lastAt?.toISOString() ?? null,
  lastOutcome: row.lastOutcome,
});

/** When `row`'s schedule next fires after `after`; undefined for one that names no time. */
const nextOf = (
  { cron, timeZone }: Pick<WakeRow, "cron" | "timeZone">,
  after: Date
): Date | undefined => nextScheduledRun({ cron, timeZone }, after, "skip");

/**
 * Whether the schedule names a time to come and never two closer than
 * {@link shortestGapMs}, as far as its next few times show.
 */
const firesRarely = (
  schedule: Pick<WakeRow, "cron" | "timeZone">,
  now: Date
): boolean => {
  let last = nextOf(schedule, now);
  if (last === undefined) {
    return false;
  }
  for (let step = 0; step < 4; step += 1) {
    const next = nextOf(schedule, last);
    if (next === undefined) {
      return true;
    }
    if (next.getTime() - last.getTime() < shortestGapMs) {
      return false;
    }
    last = next;
  }
  return true;
};

/** The wake-up `wakeId`, or `agent.wake_unknown`. */
const requireWake = async (env: Env, wakeId: unknown): Promise<WakeRow> => {
  const row =
    typeof wakeId === "string"
      ? await drizzle(env.DB)
          .select()
          .from(agentWakes)
          .where(eq(agentWakes.id, wakeId))
          .get()
      : undefined;
  if (row === undefined) {
    throw agentErrors.create("agent.wake_unknown");
  }
  return row;
};

/** The agent `agentId`'s wake-ups, the oldest first. Its admins' alone. */
export const listAgentWakes = async (
  env: Env,
  identity: Identity,
  agentId: unknown
): Promise<AgentWake[]> => {
  requireCompanyAdmin(identity);
  if (typeof agentId !== "string") {
    throw agentErrors.create("agent.unknown");
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(agentWakes)
    .where(eq(agentWakes.agentId, agentId))
    .orderBy(asc(agentWakes.madeAt), asc(agentWakes.id));
  return rows.map(wakeOf);
};

/**
 * Makes a wake-up of the agent `agentId`. Throws `agent.unknown` for an
 * agent the company doesn't have, and `agent.wake_invalid` for what isn't
 * a wake-up: a schedule that names no time to come or fires more often
 * than hourly, a person who isn't a member, no opening line, or one more
 * than an agent may have.
 */
export const makeAgentWake = async (
  env: Env,
  identity: Identity,
  agentId: unknown,
  input: unknown,
  now = new Date()
): Promise<AgentWake> => {
  requireCompanyAdmin(identity);
  const agent =
    typeof agentId === "string" ? await readAgent(env, agentId) : undefined;
  if (agent === undefined) {
    throw agentErrors.create("agent.unknown");
  }
  const parsed = agentWakeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw agentErrors.create("agent.wake_invalid");
  }
  const db = drizzle(env.DB);
  const [organization, person] = await Promise.all([
    readOrganization(env),
    memberOf(env.DB, parsed.data.personId),
  ]);
  const schedule = {
    cron: parsed.data.cron,
    timeZone: parsed.data.timeZone ?? organization.timeZone,
  };
  const nextAt = nextOf(schedule, now);
  if (
    person === undefined ||
    nextAt === undefined ||
    !firesRarely(schedule, now)
  ) {
    throw agentErrors.create("agent.wake_invalid");
  }
  const row: WakeRow = {
    id: `wake-${crypto.randomUUID()}`,
    agentId: agent.id,
    ...schedule,
    personId: parsed.data.personId,
    opening: parsed.data.opening,
    state: "on",
    nextAt,
    retryAt: null,
    chatId: null,
    lastAt: null,
    lastOutcome: null,
    madeBy: identity.userId,
    madeAt: now,
    changedBy: identity.userId,
    changedAt: now,
  };
  await auditedBatch(env, db, [
    // Only while the agent has room for one more, counted in the statement
    // that inserts it: two made at once can't both be the last.
    db.insert(agentWakes).select(
      db
        .select({
          id: value(row.id, "id"),
          agentId: value(row.agentId, "agent_id"),
          cron: value(row.cron, "cron"),
          timeZone: value(row.timeZone, "time_zone"),
          personId: value(row.personId, "person_id"),
          opening: value(row.opening, "opening"),
          state: value(row.state, "state"),
          nextAt: value(nextAt.getTime(), "next_at"),
          retryAt: value(null, "retry_at"),
          chatId: value(null, "chat_id"),
          lastAt: value(null, "last_at"),
          lastOutcome: value(null, "last_outcome"),
          madeBy: value(row.madeBy, "made_by"),
          madeAt: value(now.getTime(), "made_at"),
          changedBy: value(row.changedBy, "changed_by"),
          changedAt: value(now.getTime(), "changed_at"),
        })
        .from(sql`(SELECT 1)`)
        .where(
          sql`(SELECT count(*) FROM ${agentWakes} WHERE ${agentWakes.agentId} = ${row.agentId}) < ${wakesPerAgent}`
        )
    ),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.wake.made",
      target: { type: "agent", id: agent.id },
      // What it asks is the admin's own text: its length, never the text.
      detail: {
        wake: row.id,
        cron: row.cron,
        timeZone: row.timeZone,
        person: row.personId,
        openingLength: String(row.opening.length),
      },
    }),
  ]);
  const kept = await db
    .select({ id: agentWakes.id })
    .from(agentWakes)
    .where(eq(agentWakes.id, row.id))
    .get();
  if (kept === undefined) {
    // The agent had all it may have by the time this one was written.
    throw agentErrors.create("agent.wake_invalid");
  }
  return wakeOf(row);
};

/**
 * Pauses the wake-up `wakeId`, which then doesn't fire, or turns it back
 * on, from its schedule's next time. Throws `agent.wake_unknown`, and
 * `agent.wake_invalid` for what isn't a yes or no.
 */
export const setAgentWakePaused = async (
  env: Env,
  identity: Identity,
  wakeId: unknown,
  paused: unknown,
  now = new Date()
): Promise<void> => {
  requireCompanyAdmin(identity);
  if (typeof paused !== "boolean") {
    throw agentErrors.create("agent.wake_invalid");
  }
  const row = await requireWake(env, wakeId);
  const state = paused ? "paused" : "on";
  if (row.state === state) {
    // As it is already: nothing is written and nothing recorded.
    return;
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .update(agentWakes)
      .set({
        state,
        // Paused, it has no next time; on again, its schedule's next one,
        // never the ones it slept through.
        nextAt: paused ? null : (nextOf(row, now) ?? null),
        retryAt: null,
        changedBy: identity.userId,
        changedAt: now,
      })
      .where(and(eq(agentWakes.id, row.id), eq(agentWakes.state, row.state))),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.wake.paused",
      target: { type: "agent", id: row.agentId },
      detail: { wake: row.id, paused: String(paused) },
    }),
  ]);
};

/** Deletes the wake-up `wakeId`; its chat stays its person's. Throws `agent.wake_unknown`. */
export const deleteAgentWake = async (
  env: Env,
  identity: Identity,
  wakeId: unknown
): Promise<void> => {
  requireCompanyAdmin(identity);
  const row = await requireWake(env, wakeId);
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db.delete(agentWakes).where(eq(agentWakes.id, row.id)),
    outboxedIfChanged(db, {
      actor: actorOf(identity),
      action: "agent.wake.deleted",
      target: { type: "agent", id: row.agentId },
      detail: { wake: row.id },
    }),
  ]);
};

/** Drops the wake-ups that work for `personId`: they are erased. */
export const dropAgentWakesFor = async (
  env: Env,
  personId: string
): Promise<void> => {
  await drizzle(env.DB)
    .delete(agentWakes)
    .where(eq(agentWakes.personId, personId));
};

/**
 * Starts the wake-up's turn: its agent, for its person, in the wake-up's
 * chat in the person's own Workspace object, asked the opening line with
 * the company's default model. The chat is made at the first fire, and
 * anew if its person deleted it. The turn is refused as any turn is: a
 * paused agent, one that doesn't reach the person, a person who is no
 * longer a member, a chat with a turn under way.
 */
const startTurn = async (env: Env, row: WakeRow): Promise<void> => {
  const {
    models: [model],
  } = await modelSettings(env);
  if (model === undefined) {
    throw modelErrors.create("model.no_provider");
  }
  // Refused here as the turn would refuse it, before a chat is made for
  // a turn that can't be taken.
  await turnAgent(env, row.agentId);
  await requireAgentReaches(env, row.agentId, row.personId, "web");
  const chats = workspace(env, personalWorkspaceId(row.personId));
  const question = { text: row.opening, model };
  if (row.chatId !== null) {
    try {
      await chats.sendUnattended(row.chatId, question);
      return;
    } catch (error) {
      if (agentErrors.codeOf(error) !== "agent.chat_not_found") {
        throw error;
      }
    }
  }
  // No chat for someone who is no longer a member, or for a wake-up that
  // was deleted meanwhile (as erasing its person does): read last, right
  // before the chat is made.
  const [member, still] = await Promise.all([
    memberOf(env.DB, row.personId),
    drizzle(env.DB)
      .select({ id: agentWakes.id })
      .from(agentWakes)
      .where(eq(agentWakes.id, row.id))
      .get(),
  ]);
  if (member === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  if (still === undefined) {
    throw agentErrors.create("agent.wake_unknown");
  }
  const chat = await chats.createChat(
    row.opening.slice(0, titleLength),
    row.personId,
    row.agentId
  );
  await drizzle(env.DB)
    .update(agentWakes)
    .set({ chatId: chat.id })
    .where(eq(agentWakes.id, row.id));
  await chats.sendUnattended(chat.id, question);
};

/**
 * Fires `row` once: claims this time by moving the wake-up on, and only
 * the run whose statement changed the row starts the turn. A scheduled
 * fire that couldn't start is tried once more; a retry that couldn't is
 * left until the next time.
 */
const fire = async (env: Env, row: WakeRow, now: Date): Promise<void> => {
  const db = drizzle(env.DB);
  const scheduled =
    row.nextAt !== null && row.nextAt.getTime() <= now.getTime();
  const claimed = await db
    .update(agentWakes)
    .set(
      scheduled
        ? { nextAt: nextOf(row, now) ?? null, retryAt: null }
        : { retryAt: null }
    )
    .where(
      and(
        eq(agentWakes.id, row.id),
        eq(agentWakes.state, "on"),
        scheduled
          ? eq(agentWakes.nextAt, row.nextAt ?? now)
          : and(
              row.nextAt === null
                ? isNull(agentWakes.nextAt)
                : eq(agentWakes.nextAt, row.nextAt),
              eq(agentWakes.retryAt, row.retryAt ?? now)
            )
      )
    )
    .returning({ id: agentWakes.id });
  if (claimed.length === 0) {
    return;
  }
  let outcome = "started";
  try {
    await startTurn(env, row);
  } catch (error) {
    outcome = isExpectedError(error) ? error.code : "failed";
    if (!isExpectedError(error)) {
      console.error({ event: "agent.wake.failed", wake: row.id, error });
    }
  }
  await db
    .update(agentWakes)
    .set({
      lastAt: now,
      lastOutcome: outcome,
      ...(outcome !== "started" && scheduled
        ? { retryAt: new Date(now.getTime() + retryAfterMs) }
        : {}),
    })
    // Only the wake-up as it was claimed: one an admin paused, or paused
    // and turned back on, meanwhile keeps what they set, its cleared retry
    // included.
    .where(
      and(
        eq(agentWakes.id, row.id),
        eq(agentWakes.state, "on"),
        eq(agentWakes.changedAt, row.changedAt)
      )
    );
};

/**
 * Starts the wake-ups that are due at `now`: those that are on, whose
 * next time, or whose one retry, has come. The clock's task, each minute.
 */
export const startDueAgentWakes = async (
  env: Env,
  now = new Date()
): Promise<void> => {
  const due = await drizzle(env.DB)
    .select()
    .from(agentWakes)
    .where(
      and(
        eq(agentWakes.state, "on"),
        or(lte(agentWakes.nextAt, now), lte(agentWakes.retryAt, now))
      )
    )
    .orderBy(asc(agentWakes.nextAt))
    .limit(wakesPerRun);
  await Promise.all(
    due.map(async (row) => {
      await fire(env, row, now);
    })
  );
};
