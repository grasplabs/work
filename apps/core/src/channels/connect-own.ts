import { durableObjectState } from "@grasp-os/chat/state";
import type { ConnectionPerson } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { roleSchema } from "@grasp-os/shared/roles";
import type { PostableCard } from "chat";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { activeMember, organizationId } from "../auth/auth.ts";
import { signInConfig } from "../auth/config.ts";
import { personOf, tenantOf } from "../connections.ts";
import { members, users } from "../db/core/schema.ts";
import { inJurisdiction } from "../durable-objects.ts";
import { connectOwnCard } from "./cards.tsx";
import { channelLocales } from "./words.ts";

// A member's own Microsoft 365, connected from a chat app (GRA-767). Every
// Outlook, calendar and Excel action runs through the person's own
// personal connection in connect; signing in to Grasp doesn't make one, and
// a chat app has no request card to grant one from. So when someone who
// has none (or whose needs a new sign-in) is answered in a chat app,
// Stephen adds one card: what he could do in their own Microsoft 365, and a
// button to the deployment's own page that starts connect's sign-in for
// whoever is signed in there (apps/web's `/connect-microsoft`). What they
// asked is kept for the hour; once the flow finishes, core's callback tells
// them in the chat and answers it again, now with their own Microsoft 365.
//
// How it can fail, and what stops it:
//
// - The link starts or finishes a flow for someone else: it carries no
//   token, no id and nothing of theirs. The page starts the flow for the
//   person signed in to Grasp in that browser, and connect finishes a flow
//   only for the person who started it, with an account whose object id is
//   one they sign in with (`isOwnAccount` in connect's oauth.ts).
// - The answer reaches someone else: what is kept is keyed by the person's
//   own user id, and carried on in the conversation they last wrote in, as
//   the door kept it from their verified sender id.
// - A flood of cards: one a day per person, whatever they ask meanwhile.
// - Rights wider than the company allows: the page asks through core's
//   `connections.start`, which asks Microsoft only for what the company's
//   classes need.

/** The web's page that starts connecting the person's own Microsoft 365. */
export const connectOwnPath = "/connect-microsoft";

/** How long what they asked waits for them to connect. */
const keptMs = 60 * 60 * 1000;

/** How often the card is offered to one person: once a day. */
const offerEveryMs = 24 * 60 * 60 * 1000;

const keptKey = (userId: string): string => `connect-own:kept:${userId}`;
const offeredKey = (userId: string): string => `connect-own:offered:${userId}`;

/** What waits for a person to connect: their question and where they asked it. */
const keptSchema = z.object({
  platform: z.string(),
  threadId: z.string(),
  question: z.string(),
  locale: z.enum(channelLocales),
});
export type KeptAsk = z.infer<typeof keptSchema>;

/** Chat state, where the door keeps its own. */
const chatState = (env: Env) =>
  durableObjectState(inJurisdiction(env, env.CHAT_STATE));

/** A member as connect needs them, or `undefined` when they no longer are one. */
const memberPerson = async (
  env: Env,
  userId: string
): Promise<ConnectionPerson | undefined> => {
  const row = await drizzle(env.DB)
    .select({ email: users.email, role: members.role })
    .from(users)
    .innerJoin(
      members,
      and(
        eq(members.userId, users.id),
        eq(members.organizationId, organizationId)
      )
    )
    .where(and(eq(users.id, userId), activeMember(users.id)))
    .get();
  const role = roleSchema.safeParse(row?.role);
  if (row === undefined || !role.success) {
    return undefined;
  }
  return await personOf(env, {
    userId,
    role: role.data,
    // A member, never a Grasp staff session.
    staff: false,
    email: row.email,
  });
};

/**
 * Whether `userId` needs to connect their own Microsoft 365 (`connect`), or
 * sign in to it again (`reconnect`); `undefined` when theirs works, or the
 * deployment can't connect Microsoft at all.
 */
export const ownMicrosoftNeed = async (
  env: Env,
  userId: string
): Promise<"connect" | "reconnect" | undefined> => {
  const config = signInConfig(env);
  if (config === undefined || tenantOf(config, "microsoft") === undefined) {
    return undefined;
  }
  const person = await memberPerson(env, userId);
  if (person === undefined) {
    return undefined;
  }
  const listed = await env.CONNECT.listConnections(person);
  const own = listed.filter(
    (connection) =>
      connection.source === "native" &&
      connection.provider === "microsoft" &&
      connection.scope === "personal" &&
      connection.ownerUserId === userId
  );
  if (own.some(({ status }) => status === "active")) {
    return undefined;
  }
  return own.some(({ status }) => status === "needs_reauth")
    ? "reconnect"
    : "connect";
};

/**
 * Where an answer goes: a conversation it can post and type in. A Chat
 * SDK thread is one; so is a kept conversation posted to through the
 * adapter.
 */
export interface Conversation {
  id: string;
  post: (message: string | PostableCard) => Promise<unknown>;
  startTyping: () => Promise<void>;
}

/**
 * After `userId` was answered in `conversation`: if they have no working
 * Microsoft 365 of their own, keeps what they asked for the hour and, once
 * a day, offers the card to connect it. A failure here costs only the card.
 */
export const offerConnectOwn = async (
  env: Env,
  conversation: Conversation,
  ask: Omit<KeptAsk, "threadId"> & { userId: string }
): Promise<void> => {
  const origin = signInConfig(env)?.origin;
  if (origin === undefined) {
    return;
  }
  try {
    const need = await ownMicrosoftNeed(env, ask.userId);
    if (need === undefined) {
      return;
    }
    const state = chatState(env);
    const kept: KeptAsk = {
      platform: ask.platform,
      threadId: conversation.id,
      question: ask.question,
      locale: ask.locale,
    };
    await state.set(keptKey(ask.userId), kept, keptMs);
    if (
      !(await state.setIfNotExists(offeredKey(ask.userId), true, offerEveryMs))
    ) {
      return;
    }
    await conversation.post(
      connectOwnCard({
        locale: ask.locale,
        url: `${origin}${connectOwnPath}`,
        reconnect: need === "reconnect",
      })
    );
  } catch (error) {
    log.warn("channel.connect_offer_failed", errorFields(error));
  }
};

/**
 * What `userId` asked before they connected their own Microsoft 365, if it
 * is still kept: taken once, so a second callback carries nothing on.
 */
export const takeKeptAsk = async (
  env: Env,
  userId: string
): Promise<KeptAsk | undefined> => {
  const state = chatState(env);
  const kept = keptSchema.safeParse(await state.get(keptKey(userId)));
  await state.delete(keptKey(userId));
  return kept.success ? kept.data : undefined;
};
