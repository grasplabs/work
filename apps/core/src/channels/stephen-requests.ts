import { errorFields, log } from "@grasp-os/shared/log";
import { brainTool, dayFrom } from "@grasp-os/shared/stephen-requests";
import type {
  MissingReason,
  MissingTool,
  RequestKind,
  RequestOutcome,
  RequestRating,
  RequestToolCall,
} from "@grasp-os/shared/stephen-requests";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { activeMember } from "../auth/auth.ts";
import type { ToolCall } from "../chat-tool-events.ts";
import {
  stephenRequestCards,
  stephenRequestQuestions,
  stephenRequests,
  stephenSummaries,
  teamMembers,
  teams,
} from "../db/core/schema.ts";
import { readOrganization } from "../organization.ts";
import type { Sorted } from "./request-sorting.ts";

// One record for each message Stephen takes on outside Grasp (GRA-1265):
// the unit his use there is counted and priced by. Written as the message
// is taken in (answer.ts), settled once he answered, and touched again by
// a press on one of his cards (press.ts) or on Start (workflow-offers.ts),
// or by a thumb on his answer: each of those is the same request. Only
// `done` is billed.
//
// Threat model: what a record could reveal about a person, and what stops
// each.
//
// - What they asked, or what he answered: never kept. A record holds a
//   day, a place, the person and their team, labels for what he did (its
//   kind, its outcome, the tools he called and whether each worked, what
//   was off or missing), a topic's and a question's id from the company's
//   lists (request-sorting.ts), and a thumb. No words, no values.
// - When they asked, to the minute: only the day is kept, in the
//   company's time zone; never the time.
// - What they asked, read off its question: a question is Grasp's general
//   wording (request-sorting.ts), and a page shows it only once five or
//   more people asked it, every split folded the same way, and people one
//   by one only as counts, and only once an owner turned that on
//   (stephen-requests.ts).
// - A record outliving its use, or its person: kept thirteen months (a
//   year's report and the month it is in), then swept; erasing a person
//   takes theirs (person-erasure.ts), and a question no record points at
//   any more goes with the sweep.
// - Counting a message twice, so billing it twice: a record is kept by
//   the platform's id for the message, taken once (`takeRequest`): a
//   resend finds it taken and writes nothing; a press or a thumb updates
//   the record it belongs to, never makes one.
// - Someone else's request touched: a press or a thumb finds a record by
//   the person the door verified, never by a value on the card alone.
// - Another request of theirs touched: a card that can be pressed later
//   is kept with the request whose answer posted it (`keepCardsOf`), and
//   a press updates that one, however much they asked in the chat since.
// - A record of someone no longer a member: written only while they are
//   one, in the statement that writes it.
// - Counting failing a turn: every write here is best effort, logged and
//   dropped, never thrown at the conversation.

/** How long a record is kept: a year's report and the month it is in, and more. */
const keptDays = 400;

/** A day in the company's time zone, `YYYY-MM-DD`; in UTC should its zone be unknown. */
export const companyDay = async (
  env: Env,
  at: Date = new Date()
): Promise<string> => {
  const { timeZone } = await readOrganization(env);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
};

/** Why a refused call means he could not do it yet, by the code it was refused with. */
const missingWhy: Readonly<Record<string, MissingReason>> = {
  "connect.class_off": "actionOff",
  "connect.class_unknown": "actionOff",
  "connect.app_not_pointed": "actionOff",
  "connect.resource_not_pointed": "actionOff",
  "connect.mailbox_not_pointed": "actionOff",
  "connect.never": "noAction",
  "connect.connection_not_found": "appOff",
  "permission.denied": "appOff",
  "workflow.start_denied": "workflowClosed",
};

/** A text value of a call's summary, if it has one. */
const textOf = (summary: ToolCall["summary"], key: string): string | null => {
  const value = summary[key];
  return typeof value === "string" && value !== "" ? value : null;
};

/** What a connection's call did, by how it ended: a change held, or a look-up. */
const connectionWork: Readonly<
  Partial<Record<ToolCall["outcome"], RequestKind>>
> = {
  ok: "lookedUp",
  pending: "changed",
};

/**
 * A call as a request's tool: its id, and the kind of work it was when it
 * ended so; undefined for the agent's own looking around.
 */
const heardCall = (
  call: ToolCall
):
  | {
      id: string;
      work: Partial<Record<ToolCall["outcome"], RequestKind>>;
    }
  | undefined => {
  if (
    call.method.startsWith("brain.") ||
    call.method.startsWith("knowledge.")
  ) {
    return { id: brainTool, work: {} };
  }
  if (call.method === "connections.call") {
    // By the app it is of (`microsoft`), as the page counts an app's
    // calls; by the connection's name only where the call didn't say.
    const connection =
      textOf(call.summary, "app") ??
      textOf(call.summary, "connection") ??
      "app";
    const action = textOf(call.summary, "action");
    return {
      id: action === null ? connection : `${connection}.${action}`,
      work: connectionWork,
    };
  }
  if (call.method === "workflows.offer") {
    return {
      id: `workflow:${textOf(call.summary, "workflow") ?? "workflow"}`,
      work: { ok: "workflow" },
    };
  }
  if (call.method === "apps.call") {
    return {
      id: `app:${call.target?.id ?? "app"}`,
      work: { ok: "lookedUp" },
    };
  }
  return undefined;
};

/** What a turn's calls say of a request: the tools, what was missing, and what he did. */
export interface Heard {
  tools: RequestToolCall[];
  missing: MissingTool[];
  kind: RequestKind;
  /** Whether a call did something for them: looked up, held a change, offered a start. */
  worked: boolean;
}

/**
 * What the calls of a turn say: the tools he called and how each ended,
 * what was off or missing, and the request's kind, the first that
 * applies (a workflow offered, a change held, a look-up, an answer). The
 * agent's own looking around (listing connections or workflows) is no
 * tool of the request's. An answer that cites the company's documents
 * read the brain, whether or not its code searched it.
 */
export const heardFrom = (
  calls: readonly ToolCall[],
  cited: boolean
): Heard => {
  const tools: RequestToolCall[] = [];
  const missing: MissingTool[] = [];
  const did = new Set<RequestKind>();
  for (const call of calls) {
    const heard = heardCall(call);
    if (heard === undefined) {
      continue;
    }
    const why = call.reason === null ? undefined : missingWhy[call.reason];
    if (call.outcome === "refused" && why !== undefined) {
      if (!missing.some(({ id }) => id === heard.id)) {
        missing.push({ id: heard.id, why });
      }
      continue;
    }
    const ok = call.outcome === "ok" || call.outcome === "pending";
    tools.push({ id: heard.id, ok });
    const kind = heard.work[call.outcome];
    if (kind !== undefined) {
      did.add(kind);
    }
  }
  if (cited && !tools.some(({ id }) => id === brainTool)) {
    tools.unshift({ id: brainTool, ok: true });
  }
  const kind =
    (["workflow", "changed", "lookedUp"] as const).find((each) =>
      did.has(each)
    ) ?? "answered";
  return { tools, missing, kind, worked: kind !== "answered" };
};

/**
 * How a request ended, from how its turn ended and what it did: a turn
 * that answered is `done`, unless all it came to was what he could not do
 * (`notPossible`), or he said he didn't know or asked something back
 * (`unanswered`, as its sorting read it). An answer and nothing else that
 * couldn't be sorted (no model may, or the call failed) is `unanswered`
 * too: billed only once it is known he answered.
 */
export const outcomeOf = (
  ended: "answered" | "stopped" | "failed",
  heard: Heard,
  sorted: Sorted | null
): RequestOutcome => {
  if (ended !== "answered") {
    return ended;
  }
  if (heard.missing.length > 0 && !heard.worked) {
    return "notPossible";
  }
  if (!heard.worked && sorted?.answered !== true) {
    return "unanswered";
  }
  return "done";
};

/** The team a person is counted in: the first of theirs by name, if any. */
const teamOf = async (env: Env, userId: string): Promise<string | null> => {
  const [team] = await drizzle(env.DB)
    .select({ id: teams.id })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(asc(teams.name), asc(teams.id))
    .limit(1);
  return team?.id ?? null;
};

/**
 * Takes in the request `messageId` of `userId` in `platform`, once: its
 * id when this took it, null when it was taken before (the platform sent
 * the message again) or they are no longer a member. It stands as
 * `stopped` until it is settled, so a turn cut off for good is never
 * billed.
 */
export const takeRequest = async (
  env: Env,
  {
    platform,
    messageId,
    userId,
  }: { platform: string; messageId: string; userId: string }
): Promise<string | null> => {
  const id = `${platform}:${messageId}`;
  try {
    const [day, teamId] = await Promise.all([
      companyDay(env),
      teamOf(env, userId),
    ]);
    const written = await drizzle(env.DB).run(
      sql`INSERT INTO ${stephenRequests}
        (id, day, place, person_id, team_id, kind, outcome, tools, missing)
        SELECT ${id}, ${day}, ${platform}, ${userId}, ${teamId}, 'answered',
          'stopped', '[]', '[]'
        WHERE ${activeMember(userId)}
        ON CONFLICT (id) DO NOTHING`
    );
    return written.meta.changes > 0 ? id : null;
  } catch (error) {
    log.warn("stephen_requests.untaken", { platform, ...errorFields(error) });
    return null;
  }
};

const toolsSchema = z.array(z.object({ id: z.string(), ok: z.boolean() }));

/** The tools a record keeps, as JSON; none if it doesn't parse. */
export const toolsIn = (stored: string): RequestToolCall[] => {
  try {
    return toolsSchema.parse(JSON.parse(stored));
  } catch {
    return [];
  }
};

/** How a taken request ended, to settle it. */
export interface Settled {
  chatId: string | null;
  ended: "answered" | "stopped" | "failed";
  calls: readonly ToolCall[];
  cited: boolean;
  sorted: Sorted | null;
}

/**
 * Keeps what request `id`'s turn did (its kind, tools and what was
 * missing) as soon as it answered, before any card of its answer can be
 * pressed: a press then has the tools it changes, and settling, once the
 * answer is sorted, keeps what the press said. It still stands as
 * `stopped`, unbilled, until it is settled.
 */
export const heardRequest = async (
  env: Env,
  id: string,
  { calls, cited }: Pick<Settled, "calls" | "cited">
): Promise<void> => {
  const heard = heardFrom(calls, cited);
  try {
    await drizzle(env.DB)
      .update(stephenRequests)
      .set({
        kind: heard.kind,
        tools: JSON.stringify(heard.tools),
        missing: JSON.stringify(heard.missing),
      })
      .where(eq(stephenRequests.id, id));
  } catch (error) {
    log.warn("stephen_requests.unheard", errorFields(error));
  }
};

/** Settles request `id` as its turn ended. */
export const settleRequest = async (
  env: Env,
  id: string,
  { chatId, ended, calls, cited, sorted }: Settled
): Promise<void> => {
  const heard = heardFrom(calls, cited);
  try {
    const db = drizzle(env.DB);
    // A press on one of its cards may have come first: what it said of a
    // tool, and that a workflow started, stand.
    const [pressed] = await db
      .select({ kind: stephenRequests.kind, tools: stephenRequests.tools })
      .from(stephenRequests)
      .where(eq(stephenRequests.id, id));
    const before = toolsIn(pressed?.tools ?? "[]");
    // Kept as `heardRequest` wrote them, in the same order: each stands as
    // a press left it, and what a press added (a workflow's start) stays.
    const tools = [
      ...heard.tools.map((tool, at) => {
        const kept = before[at];
        return kept?.id === tool.id ? kept : tool;
      }),
      ...before.filter(
        (each) => !heard.tools.some((tool) => tool.id === each.id)
      ),
    ];
    const kind = pressed?.kind === "workflow" ? "workflow" : heard.kind;
    await db
      .update(stephenRequests)
      .set({
        chatId,
        kind,
        outcome: outcomeOf(ended, { ...heard, kind }, sorted),
        tools: JSON.stringify(tools),
        missing: JSON.stringify(heard.missing),
        topicId: sorted?.topicId ?? null,
        questionId: sorted?.questionId ?? null,
      })
      .where(eq(stephenRequests.id, id));
  } catch (error) {
    log.warn("stephen_requests.unsettled", errorFields(error));
  }
};

/**
 * Keeps the cards `keys` names (`write:<id>`, `offer:<id>`) as request
 * `requestId`'s, as its answer posts them; nothing without a request.
 */
export const keepCardsOf = async (
  env: Env,
  requestId: string | null,
  keys: readonly string[]
): Promise<void> => {
  if (requestId === null || keys.length === 0) {
    return;
  }
  try {
    const db = drizzle(env.DB);
    const now = new Date();
    await db
      .insert(stephenRequestCards)
      .values(keys.map((key) => ({ key, requestId, createdAt: now })))
      .onConflictDoNothing();
  } catch (error) {
    log.warn("stephen_requests.cards_unkept", errorFields(error));
  }
};

/**
 * The request of `userId` card `key` was posted for: the one a press on
 * it belongs to, whatever they asked in the chat since.
 */
const requestOfCard = async (env: Env, userId: string, key: string) => {
  const [found] = await drizzle(env.DB)
    .select({ id: stephenRequests.id, tools: stephenRequests.tools })
    .from(stephenRequestCards)
    .innerJoin(
      stephenRequests,
      eq(stephenRequests.id, stephenRequestCards.requestId)
    )
    .where(
      and(
        eq(stephenRequestCards.key, key),
        eq(stephenRequests.personId, userId)
      )
    )
    .limit(1);
  return found;
};

/**
 * A press on a card of held changes ran them: the request the card was
 * posted for notes the one that failed (`writeId`, by its `action`) as a
 * tool that didn't work. A change shown to confirm was billed as shown,
 * pressed or not.
 */
export const pressedChanges = async (
  env: Env,
  {
    userId,
    writeId,
    action,
  }: { userId: string; writeId: string; action: string }
): Promise<void> => {
  try {
    const request = await requestOfCard(env, userId, `write:${writeId}`);
    if (request === undefined) {
      return;
    }
    let left = true;
    const tools = toolsIn(request.tools).map((tool) => {
      if (!(left && tool.ok && tool.id.endsWith(`.${action}`))) {
        return tool;
      }
      left = false;
      return { ...tool, ok: false };
    });
    await drizzle(env.DB)
      .update(stephenRequests)
      .set({ tools: JSON.stringify(tools) })
      .where(eq(stephenRequests.id, request.id));
  } catch (error) {
    log.warn("stephen_requests.press_unkept", errorFields(error));
  }
};

/**
 * A press on Start, on the card of offer `offerId` of workflow
 * `workflowId`: the request that offered it is a workflow's, and its tool
 * says whether it started.
 */
export const pressedStart = async (
  env: Env,
  {
    userId,
    offerId,
    workflowId,
    started,
  }: { userId: string; offerId: string; workflowId: string; started: boolean }
): Promise<void> => {
  try {
    const request = await requestOfCard(env, userId, `offer:${offerId}`);
    if (request === undefined) {
      return;
    }
    const id = `workflow:${workflowId}`;
    const tools = toolsIn(request.tools);
    const at = tools.findIndex((tool) => tool.id === id);
    const next =
      at === -1
        ? [...tools, { id, ok: started }]
        : tools.map((tool, index) =>
            index === at ? { id, ok: started } : tool
          );
    await drizzle(env.DB)
      .update(stephenRequests)
      .set({ kind: "workflow", tools: JSON.stringify(next) })
      .where(eq(stephenRequests.id, request.id));
  } catch (error) {
    log.warn("stephen_requests.press_unkept", errorFields(error));
  }
};

/** Keeps the thumb `userId` gave their own request `requestId`'s answer; another's is left alone. */
export const rateRequest = async (
  env: Env,
  {
    userId,
    requestId,
    rating,
  }: { userId: string; requestId: string; rating: RequestRating }
): Promise<boolean> => {
  try {
    const written = await drizzle(env.DB)
      .update(stephenRequests)
      .set({ rating })
      .where(
        and(
          eq(stephenRequests.id, requestId),
          eq(stephenRequests.personId, userId)
        )
      );
    return written.meta.changes > 0;
  } catch (error) {
    log.warn("stephen_requests.rating_unkept", errorFields(error));
    return false;
  }
};

/**
 * Deletes requests past their thirteen months, and the questions no
 * request points at any more that are older than a day (a question just
 * named waits for the request that named it).
 */
export const sweepStephenRequests = async (
  env: Env,
  now: Date
): Promise<void> => {
  const today = now.toISOString().slice(0, 10);
  const db = drizzle(env.DB);
  await db
    .delete(stephenRequests)
    .where(lt(stephenRequests.day, dayFrom(today, -keptDays)));
  await db.delete(stephenRequestQuestions).where(
    sql`${stephenRequestQuestions.createdAt} < ${now.getTime() - 86_400_000}
        AND NOT EXISTS (SELECT 1 FROM ${stephenRequests}
          WHERE ${stephenRequests.questionId} = ${stephenRequestQuestions.id})`
  );
  // Cards whose request is gone (swept or erased), a day on.
  await db.delete(stephenRequestCards).where(
    sql`${stephenRequestCards.createdAt} < ${now.getTime() - 86_400_000}
        AND NOT EXISTS (SELECT 1 FROM ${stephenRequests}
          WHERE ${stephenRequests.id} = ${stephenRequestCards.requestId})`
  );
  // Weekly summaries sent or failed a quarter ago.
  await db
    .delete(stephenSummaries)
    .where(
      sql`${stephenSummaries.state} <> 'queued' AND ${stephenSummaries.queuedAt} < ${now.getTime() - 90 * 86_400_000}`
    );
};
