import { agentErrors } from "@grasp-os/shared/agent";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Thread } from "chat";
import { z } from "zod";

import { signInConfig } from "../auth/config.ts";
import { chatAgentId, personalWorkspaceId } from "../chats-rpc.ts";
import { workspace } from "../durable-objects.ts";
import { answerCard, heldWritesCard } from "./cards.tsx";
import {
  offerConnectOwn,
  ownMicrosoftNeed,
  takeKeptAsk,
} from "./connect-own.ts";
import type { Conversation } from "./connect-own.ts";
import type { ChannelHandoff, ChannelMessage } from "./door.ts";
import { checkOf, turnHeldWrites } from "./held.ts";
import { sortRequest } from "./request-sorting.ts";
import { countAnswered, countSignal } from "./signals.ts";
import type { ChannelSignal } from "./signals.ts";
import {
  heardRequest,
  keepCardsOf,
  settleRequest,
  takeRequest,
} from "./stephen-requests.ts";
import type { Settled } from "./stephen-requests.ts";
import { teamsAdapter } from "./teams.ts";
import { inSlack, inTeams, shownWithoutLinks } from "./without-links.ts";
import { channelLocales, languageOf, say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";
import { postOffers } from "./workflow-offers.ts";

// A member's message answered by the organization's agent, in the
// person's own chat for that platform in their own Workspace (`via`, the
// platform's name), found or made on their first message, with what it
// cited; the answer goes back to the conversation they wrote in. The door
// has already checked who wrote (door.ts), so the Workspace takes its word.
// Asked in a group chat or channel, it is their one chat for that thread,
// and its agent reads only what everyone in it may (knowledge/access.ts).
//
// While the turn runs, the platform shows Stephen typing, sent again every
// few seconds, as a typing indicator lasts only that long, until the
// answer is whole: it is posted once, on a card, never streamed, so the
// person sees only what Grasp keeps, without the links the model wrote
// (without-links.ts), and Slack is never asked to preview anything. A
// turn that fails or is refused ends in one of Stephen's lines, in the
// language the person wrote in, never in the gateway's words, which name
// models and budgets the person has no part in.
//
// A turn that had writes held (a meeting to put in the calendar, a row to
// change) shows them after its answer on one card, in the order they run,
// each with its exact values, and nothing changes until the person
// presses Confirm on it (cards.tsx `heldWritesCard`, held.ts).

/** How often typing is shown again while the turn runs. */
const typingEveryMs = 3000;

/** Why a turn couldn't answer, as one of Stephen's lines. */
type RefusedLine = "busy" | "removed" | "failed";

/** The line for an error a turn was refused or failed with. */
const lineFor = (error: unknown): RefusedLine => {
  const model = modelErrors.codeOf(error);
  if (
    model === "model.rate_limited" ||
    agentErrors.codeOf(error) === "agent.busy"
  ) {
    return "busy";
  }
  if (permissionErrors.codeOf(error) === "permission.person_inactive") {
    return "removed";
  }
  return "failed";
};

const rawSchema = z.object({ locale: z.string().max(64).optional() });

/** The language the person's app is set to, if the platform said. */
export const appLocale = (raw: unknown): ChannelLocale => {
  const language = rawSchema
    .safeParse(raw)
    .data?.locale?.split("-")[0]
    ?.toLowerCase();
  return channelLocales.find((each) => each === language) ?? "en";
};

/** How a request whose turn was refused or failed ended (stephen-requests.ts). */
const endOfLine: Readonly<Record<RefusedLine, "stopped" | "failed">> = {
  busy: "stopped",
  removed: "stopped",
  failed: "failed",
};

/**
 * Takes in the message `messageId` as one of Stephen's requests
 * (stephen-requests.ts), once however often the platform sends it: what
 * settles it as its turn ends, sorting it first when it was answered, and
 * the request a thumb on the answer is for, where the door takes one
 * (Teams). Nothing for a question answered again (no `messageId`).
 */
const takenIn = async (
  env: Env,
  {
    platform,
    userId,
    messageId,
    text,
  }: { platform: string; userId: string; messageId?: string; text: string }
) => {
  const requestId =
    messageId === undefined
      ? null
      : await takeRequest(env, { platform, messageId, userId });
  const settle = async (
    ended: Omit<Settled, "sorted">,
    answer?: string
  ): Promise<void> => {
    if (requestId === null) {
      return;
    }
    const sorted =
      answer === undefined
        ? null
        : await sortRequest(env, { userId, platform, message: text, answer });
    await settleRequest(env, requestId, { ...ended, sorted });
  };
  const rate =
    requestId !== null && platform === "teams" ? requestId : undefined;
  return { settle, rate, requestId };
};

/**
 * `post`, which posts something after an answer, never throwing: what
 * couldn't be posted is logged, and what comes after it still goes, the
 * answer's own record among it.
 */
const quietly =
  (what: string, post: () => Promise<void>) => async (): Promise<void> => {
    try {
      await post();
    } catch (error) {
      log.warn("channel.after_answer_failed", { what, ...errorFields(error) });
    }
  };

/** How a request whose turn ended without an answer ended. */
const endOfTurn = (outcome: string): "stopped" | "failed" =>
  outcome === "cancelled" || outcome === "max_steps" ? "stopped" : "failed";

/** The count a refused or failed turn's line stands for (signals.ts). */
const signalOfLine: Readonly<Record<RefusedLine, ChannelSignal | null>> = {
  busy: "busy",
  failed: "failed",
  // Someone removed since the door let them in: nothing about Stephen.
  removed: null,
};

/**
 * Posts `content` in `thread`, counting a post the platform didn't take
 * (`send_failed`), and one it refused as forbidden as the app uninstalled
 * (`uninstalled`: Teams answers 403 to a bot no longer in the chat, which
 * its adapter throws as a `PermissionError`). Throws what posting threw.
 */
const postIn = async (
  env: Env,
  platform: string,
  thread: Conversation,
  content: Parameters<Conversation["post"]>[0]
): Promise<void> => {
  try {
    await thread.post(content);
  } catch (error) {
    await countSignal(env, platform, "send_failed");
    if (error instanceof Error && error.name === "PermissionError") {
      await countSignal(env, platform, "uninstalled");
    }
    throw error;
  }
};

/** Shows typing in `thread` until the returned function is called. */
const typingIn = (thread: Conversation): (() => void) => {
  const show = async () => {
    try {
      await thread.startTyping();
    } catch (error) {
      log.warn("channel.typing_failed", errorFields(error));
    }
  };
  void show();
  const timer = setInterval(() => {
    void show();
  }, typingEveryMs);
  return () => {
    clearInterval(timer);
  };
};

/** Shown words as `platform` gets them: its own link and mention syntax taken out. */
const postedOn = (platform: string, shown: string): string =>
  platform === "slack" ? inSlack(shown) : inTeams(shown);

/**
 * One question asked in the person's chat for `platform`, and its answer
 * posted whole, on one card with its sources, once it is done.
 */
const answerOne = async (
  env: Env,
  {
    platform,
    userId,
    thread,
    place,
    messageId,
  }: Pick<ChannelMessage, "platform" | "userId" | "place"> & {
    thread: Thread | Conversation;
    /**
     * The platform's id for the message, which makes it one of Stephen's
     * requests (stephen-requests.ts); none for a question answered again.
     */
    messageId?: string;
  },
  text: string,
  locale: ChannelLocale
): Promise<void> => {
  const startedAt = Date.now();
  const { settle, rate, requestId } = await takenIn(env, {
    platform,
    userId,
    messageId,
    text,
  });
  const stopTyping = typingIn(thread);
  // Held writes are this turn's from here on: connect stamps each when
  // it holds it, by the same clock.
  const since = Date.now();
  let asked: Awaited<ReturnType<ReturnType<typeof workspace>["askThrough"]>>;
  try {
    asked = await workspace(env, personalWorkspaceId(userId)).askThrough(
      userId,
      chatAgentId,
      platform,
      text,
      place.kind === "direct" ? place : { thread: thread.id, ...place }
    );
  } catch (error) {
    stopTyping();
    const line = lineFor(error);
    log.warn("channel.turn_refused", {
      platform,
      line,
      ...errorFields(error),
    });
    const signal = signalOfLine[line];
    if (signal !== null) {
      await countSignal(env, platform, signal);
    }
    await settle({
      chatId: null,
      ended: endOfLine[line],
      calls: [],
      cited: false,
    });
    await postIn(env, platform, thread, say(line, locale));
    return;
  }
  stopTyping();
  const { chatId, answer, calls } = asked;
  const answered = answer.outcome === "answered";
  // As kept (without-links.ts), a citation as its words: what the
  // request is sorted by; posted as the platform takes it.
  const final = shownWithoutLinks(answer.answer);
  const posted = postedOn(platform, final);
  const cited = answer.cited.length > 0;
  if (!answered || final === "") {
    log.warn("channel.turn_failed", { platform, outcome: answer.outcome });
    await countSignal(env, platform, "failed");
    await settle({
      chatId,
      ended: endOfTurn(answer.outcome),
      calls,
      cited,
    });
    await postIn(env, platform, thread, say("failed", locale));
    return;
  }
  // What the turn did is kept now, before any card of the answer can be
  // pressed, so a press finds the tools it changes. Sorted and settled
  // once the person has the answer, as that takes a model call of its
  // own; never kept from it by a card after the answer that couldn't be
  // posted (`quietly`).
  if (requestId !== null) {
    await heardRequest(env, requestId, { calls, cited });
  }
  const recorded = async () => {
    await settle({ chatId, ended: "answered", calls, cited }, final);
  };
  // The starts the turn offered, each on its card, under the answer, each
  // kept with this request so a press on it is this request's.
  const offers = quietly("offers", async () => {
    await postOffers(env, thread, { chatId, userId, requestId }, locale);
  });
  // Timed to the answer the person has, as they wait for it.
  const timed = async () => {
    await countAnswered(env, platform, Date.now() - startedAt);
  };
  const origin = signInConfig(env)?.origin;
  if (origin === undefined) {
    await postIn(
      env,
      platform,
      thread,
      answerCard({ locale, text: posted, sources: [], rate })
    );
    await timed();
    await offers();
    await recorded();
    return;
  }
  const sources = answer.cited.map(({ title, collectionId, documentId }) => ({
    title,
    url: `${origin}/knowledge/${encodeURIComponent(collectionId)}?doc=${encodeURIComponent(documentId)}`,
  }));
  const chatUrl = `${origin}/?chat=${encodeURIComponent(chatId)}`;
  // Without their own Microsoft 365 he answered from what the company
  // shared alone: once a day, he offers to connect it, in their direct
  // message alone. What he carries on with once they have answers there
  // as theirs (`carryOnAfterConnecting`), so it is never kept from a chat
  // others read.
  const offer = quietly("connect_own", async () => {
    if (place.kind !== "direct") {
      return;
    }
    await offerConnectOwn(env, thread, {
      userId,
      platform,
      question: text,
      locale,
    });
  });
  // The turn's held writes, on one card after the answer: nothing changes
  // until the person presses Confirm on it (held.ts). Each is kept with
  // this request, so a press on it is this request's.
  const held = quietly("held", async () => {
    const writes = await turnHeldWrites(env, userId, chatId, since);
    if (writes.length === 0) {
      return;
    }
    await keepCardsOf(
      env,
      requestId,
      writes.map(({ id }) => `write:${id}`)
    );
    const check = checkOf(answer.provenance.sources);
    await thread.post(
      heldWritesCard({
        locale,
        writes,
        ...(check === undefined ? {} : { check }),
        openUrl: chatUrl,
      })
    );
  });
  await postIn(
    env,
    platform,
    thread,
    answerCard({ locale, text: posted, sources, chatUrl, rate })
  );
  await timed();
  await held();
  await offers();
  await offer();
  await recorded();
};

/**
 * Once `userId` connected their own Microsoft 365 (core's callback): says
 * so in the conversation they asked in, and answers what they asked again,
 * now with it. Nothing, if nothing they asked is still kept.
 */
export const carryOnAfterConnecting = async (
  env: Env,
  userId: string
): Promise<void> => {
  // Only once theirs works: a flow for another app carries nothing on.
  if ((await ownMicrosoftNeed(env, userId)) !== undefined) {
    return;
  }
  const kept = await takeKeptAsk(env, userId);
  if (kept?.platform !== "teams") {
    return;
  }
  const adapter = await teamsAdapter(env);
  const conversation: Conversation = {
    id: kept.threadId,
    post: async (message) => await adapter.postMessage(kept.threadId, message),
    startTyping: async () => {
      await adapter.startTyping(kept.threadId);
    },
  };
  try {
    await conversation.post(say("connectedOwn", kept.locale));
    await answerOne(
      env,
      {
        platform: "teams",
        userId,
        thread: conversation,
        // Only ever kept from their direct message (`offerConnectOwn`).
        place: { kind: "direct" },
      },
      kept.question,
      kept.locale
    );
  } catch (error) {
    log.warn("channel.carry_on_failed", errorFields(error));
  }
};

/**
 * Hands each member's message to their own chat for its platform, and
 * posts the answer, or a line, back to where they wrote. What they asked
 * before Grasp knew them, if it was kept for them, is answered first, so
 * they needn't ask it again.
 */
export const answerInChat =
  (env: Env): ChannelHandoff =>
  async (accepted) => {
    const { message, thread, kept } = accepted;
    const fallback = appLocale(message.raw);
    if (kept !== undefined) {
      // What they asked before Grasp knew them: a message of its own.
      await answerOne(
        env,
        { ...accepted, messageId: `${message.id}:kept` },
        kept,
        languageOf(kept, fallback)
      );
    }
    const text = message.text.trim();
    const locale = languageOf(text, fallback);
    if (text === "") {
      // A sign-in's "👍" or a sticker after a kept question needs no line.
      if (kept === undefined) {
        await thread.post(say("textOnly", locale));
      }
      return;
    }
    await answerOne(env, { ...accepted, messageId: message.id }, text, locale);
  };
