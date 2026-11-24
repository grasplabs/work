import { agentErrors } from "@grasp-os/shared/agent";
import type { ToolClassAudience } from "@grasp-os/shared/connect";
import type { StephenFor } from "@grasp-os/shared/stephen-reach";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { organizationId } from "./auth/membership-sql.ts";
import { agentPlaces, agentReach, agents } from "./db/core/schema.ts";
import { stephenFor } from "./stephen-reach.ts";
import { audienceOf, off, takesIn } from "./tool-classes.ts";

// Who one of the company's agents answers, where, and what it may do
// for them: each agent's own audience, places and classes, so two agents
// in one company can serve different people and do different things.
//
// The organization's own agent, the one every company has had, keeps
// Settings › Stephen (stephen-reach.ts) and is read from there, unchanged.
// Every other agent's settings are kept here, by its ID, in the same
// three layers, each only narrowing the one above it:
// - the agent as a whole: on or off, and who may reach it;
// - each place (a chat platform): who reaches it there, as for the agent
//   or fewer, and whether it does things there or only answers;
// - each class of tools: for whom the agent has it, as the company has
//   the class or fewer. The class gate reads it (tool-classes.ts,
//   `requireToolClassOn`) after the company's own setting and the app's,
//   never instead of them.
//
// A person's own agent (agents.ts) has none of the three: it reaches its
// owner, in Grasp's own chat, and nobody anywhere else. Its classes are
// as the company has each class for that person, with no row to narrow
// them, so it does at most what the company lets be done for them.
//
// An agent without a row is as the layer above it, as Stephen is until an
// admin changes him. So what makes a new agent start with nothing is
// whoever makes it writing its rows as it is made; nothing makes agents
// yet. Nothing here changes a setting either: this is the read and the
// gate on a turn.
//
// The ways it can fail, which the tests start from: an agent reaching
// someone outside its audience, or in a place it is off in; one agent's
// settings read for another; an agent having a class for someone the
// company doesn't, or the app doesn't; a row that can't be read letting
// someone in.

/** An agent until an admin changes it: on, for everyone. */
const defaultReach = { on: true, audience: { who: "everyone" } } as const;

/** The audience a stored row narrows to; off when it can't be read. */
const narrowedTo = (row: { who: string; teams: string }): ToolClassAudience =>
  audienceOf(row) ?? off;

/**
 * What the agent `agentId` does for `userId` in `place`, a chat platform
 * by its adapter's name, or in Grasp's own chat (no place): whether it
 * answers them at all, and whether it does things for them there. The
 * organization's own agent is as Settings › Stephen has it in a chat app,
 * and everyone's in Grasp's own chat, as it always was.
 */
export const agentFor = async (
  env: Env,
  agentId: string,
  userId: string,
  place?: string
): Promise<StephenFor> => {
  if (agentId === organizationId) {
    return place === undefined
      ? { reaches: true, acts: true }
      : await stephenFor(env, userId, place);
  }
  const db = drizzle(env.DB);
  const owned = await db
    .select({ ownerId: agents.ownerId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  if (owned !== undefined && owned.ownerId !== null) {
    // A person's own agent: theirs alone, in Grasp's own chat alone,
    // whatever rows of reach or place bear its ID.
    const reaches = place === undefined && owned.ownerId === userId;
    return { reaches, acts: reaches };
  }
  const [whole, row] = await Promise.all([
    db.select().from(agentReach).where(eq(agentReach.agentId, agentId)).get(),
    place === undefined
      ? undefined
      : db
          .select()
          .from(agentPlaces)
          .where(
            and(eq(agentPlaces.agentId, agentId), eq(agentPlaces.place, place))
          )
          .get(),
  ]);
  const on = whole?.on ?? defaultReach.on;
  const audience: ToolClassAudience =
    whole === undefined ? defaultReach.audience : narrowedTo(whole);
  const inPlace =
    row === undefined ||
    row.who === "asAgent" ||
    (await takesIn(env, narrowedTo(row), userId));
  const reaches = on && (await takesIn(env, audience, userId)) && inPlace;
  return { reaches, acts: reaches && (row?.acts ?? true) };
};

/**
 * Refuses a turn of the agent `agentId` for `userId` in a chat that came
 * through `via` (`web`: Grasp's own chat, which is no place) with
 * `agent.not_for_you`, before anything is read for it, when the agent
 * doesn't answer them there.
 */
export const requireAgentReaches = async (
  env: Env,
  agentId: string,
  userId: string,
  via: string
): Promise<void> => {
  const place = via === "web" ? undefined : via;
  const { reaches } = await agentFor(env, agentId, userId, place);
  if (!reaches) {
    throw agentErrors.create("agent.not_for_you");
  }
};
