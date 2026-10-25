import { agentErrors } from "@grasp-os/shared/agent";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { StreamingPlan } from "chat";
import type { Thread } from "chat";
import { z } from "zod";

import { signInConfig } from "../auth/config.ts";
import { citedIn } from "../chat-messages.ts";
import { chatAgentId, personalWorkspaceId } from "../chats-rpc.ts";
import { workspace } from "../durable-objects.ts";
import { answerCard, heldWritesCard, sourcesCard } from "./cards.tsx";
import {
  offerConnectOwn,
  ownMicrosoftNeed,
  takeKeptAsk,
} from "./connect-own.ts";
import type { Conversation } from "./connect-own.ts";
import type { ChannelHandoff, ChannelMessage } from "./door.ts";
import { checkOf, turnHeldWrites } from "./held.ts";
import { countAnswered, countSignal } from "./signals.ts";
import type { ChannelSignal } from "./signals.ts";
import { teamsAdapter } from "./teams.ts";
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
// answer's first words, which stream in as the model writes them where
// the platform streams (Teams' private chats). A turn that
// fails or is refused ends in one of Stephen's lines, in the language the
// person wrote in, never in the gateway's words, which name models and
// budgets the person has no part in.
//
// A turn that had writes held (a meeting to put in the calendar, a row to
// change) shows them after its answer on one card, in the order they run,
// each with its exact values, and nothing changes until the person
// presses Confirm on it (cards.tsx `heldWritesCard`, held.ts).

/** How often typing is shown again while the turn runs. */
const typingEveryMs = 3000;

/** Why a turn couldn't answer, as one of Stephen's lines. */
type RefusedLine = "budget" | "busy" | "removed" | "failed";

/** The line for an error a turn was refused or failed with. */
const lineFor = (error: unknown): RefusedLine => {
  const model = modelErrors.codeOf(error);
  if (model === "model.over_budget") {
    return "budget";
  }
  if (
    model === "model.budget_busy" ||
    model === "model.queued" ||
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

/** The count a refused or failed turn's line stands for (signals.ts). */
const signalOfLine: Readonly<Record<RefusedLine, ChannelSignal | null>> = {
  budget: "over_budget",
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

/** Text as it is fed to a stream, a piece at a time, until it ends. */
const textFeed = () => {
  let controller: ReadableStreamDefaultController<string> | undefined;
  let ended = false;
  const reader = new ReadableStream<string>({
    start: (started) => {
      controller = started;
    },
  }).getReader();
  const pieces: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<string>> => {
        const read = await reader.read();
        return read.done
          ? { done: true, value: undefined }
          : { done: false, value: read.value };
      },
    }),
  };
  return {
    push: (piece: string) => {
      if (!ended) {
        controller?.enqueue(piece);
      }
    },
    end: () => {
      if (!ended) {
        ended = true;
        controller?.close();
      }
    },
    pieces,
  };
};

/**
 * An answer streamed into `thread` as the model writes it, where the
 * platform streams (Teams, in a private chat): `onText` takes the text so
 * far; `finish` adds what the last update missed of `final` and waits for
 * the stream to end. Nothing is posted until the first words, so a turn
 * that fails before any leaves no empty message. A step's words before
 * the agent ran code, and the answer after, are told apart by a blank
 * line, as the person sees them in Grasp.
 */
const streamInto = (thread: Thread, onFirst: () => void) => {
  const feed = textFeed();
  let posting: Promise<unknown> | undefined;
  let current = "";
  let finished = false;
  const tell = (text: string): void => {
    if (finished || text === "" || text === current) {
      return;
    }
    let piece = text.startsWith(current)
      ? text.slice(current.length)
      : `\n\n${text}`;
    if (posting === undefined) {
      piece = piece.trimStart();
      onFirst();
      posting = thread.post(
        new StreamingPlan(feed.pieces, { aiGenerated: true })
      );
    }
    current = text;
    feed.push(piece);
  };
  return {
    onText: tell,
    /** Whether anything was streamed, once the stream has ended. */
    finish: async (final?: string): Promise<boolean> => {
      if (posting !== undefined && final?.startsWith(current) === true) {
        tell(final);
      }
      finished = true;
      feed.end();
      if (posting === undefined) {
        return false;
      }
      await posting;
      return true;
    },
  };
};

/** The answer as a chat app shows it: no links to Grasp's own notes. */
const shownText = (text: string): string =>
  citedIn(text, () => false).text.trim();

/**
 * One question asked in the person's chat for `platform`, and its answer
 * posted: streamed as the model writes it where the platform streams, then
 * its sources; otherwise whole, with them, once it is done. A stream the
 * platform refuses ends in the whole answer instead.
 */
const answerOne = async (
  env: Env,
  {
    platform,
    userId,
    thread,
    afterward,
    shared,
  }: Pick<ChannelMessage, "platform" | "userId" | "afterward" | "shared"> & {
    thread: Thread | Conversation;
  },
  text: string,
  locale: ChannelLocale
): Promise<void> => {
  const startedAt = Date.now();
  const stopTyping = typingIn(thread);
  // Streamed only in a direct message the platform's SDK handed over.
  const streaming =
    "isDM" in thread && thread.isDM
      ? streamInto(thread, stopTyping)
      : undefined;
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
      streaming?.onText,
      shared === undefined ? undefined : { thread: thread.id, ...shared }
    );
  } catch (error) {
    stopTyping();
    await streaming?.finish();
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
    await postIn(env, platform, thread, say(line, locale));
    return;
  }
  stopTyping();
  const { chatId, answer } = asked;
  const answered = answer.outcome === "answered";
  const final = shownText(answer.answer);
  let streamed = false;
  try {
    streamed = (await streaming?.finish(answered ? final : undefined)) ?? false;
  } catch (error) {
    log.warn("channel.stream_refused", { platform, ...errorFields(error) });
  }
  if (!answered || final === "") {
    log.warn("channel.turn_failed", { platform, outcome: answer.outcome });
    await countSignal(env, platform, "failed");
    await postIn(env, platform, thread, say("failed", locale));
    return;
  }
  // The starts the turn offered, each on its card, under the answer.
  const offers = async () => {
    await postOffers(env, thread, { chatId, userId }, locale);
  };
  // Timed to the answer the person has, as they wait for it: its stream's
  // last words, or the post of it whole.
  const timed = async () => {
    await countAnswered(env, platform, Date.now() - startedAt);
  };
  if (streamed) {
    await timed();
  }
  const origin = signInConfig(env)?.origin;
  if (origin === undefined) {
    if (!streamed) {
      await postIn(env, platform, thread, final);
      await timed();
      await offers();
      return;
    }
    afterward(offers);
    return;
  }
  const sources = answer.cited.map(({ title, collectionId, documentId }) => ({
    title,
    url: `${origin}/knowledge/${encodeURIComponent(collectionId)}?doc=${encodeURIComponent(documentId)}`,
  }));
  const chatUrl = `${origin}/?chat=${encodeURIComponent(chatId)}`;
  // Without their own Microsoft 365 he answered from what the company
  // shared alone: once a day, he offers to connect it.
  const offer = async () => {
    await offerConnectOwn(env, thread, {
      userId,
      platform,
      question: text,
      locale,
    });
  };
  // The turn's held writes, on one card after the answer: nothing changes
  // until the person presses Confirm on it (held.ts).
  const held = async () => {
    const writes = await turnHeldWrites(env, userId, chatId, since);
    if (writes.length === 0) {
      return;
    }
    const check = checkOf(answer.provenance.sources);
    await thread.post(
      heldWritesCard({
        locale,
        writes,
        ...(check === undefined ? {} : { check }),
        openUrl: chatUrl,
      })
    );
  };
  if (!streamed) {
    await postIn(
      env,
      platform,
      thread,
      answerCard({ locale, text: final, sources, chatUrl })
    );
    await timed();
    await held();
    await offers();
    await offer();
    return;
  }
  // Under the answer's last words, which Teams gets once this returns.
  if (sources.length > 0) {
    afterward(
      async () => await thread.post(sourcesCard({ locale, sources, chatUrl }))
    );
  }
  afterward(held);
  afterward(offers);
  afterward(offer);
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
  const adapter = teamsAdapter(env);
  const conversation: Conversation = {
    id: kept.threadId,
    post: async (message) => await adapter.postMessage(kept.threadId, message),
    startTyping: async () => {
      await adapter.startTyping(kept.threadId);
    },
  };
  // Not a Teams thread the SDK handed over: nothing streams, so what comes
  // after the answer goes right after it.
  const later: (() => Promise<unknown>)[] = [];
  try {
    await conversation.post(say("connectedOwn", kept.locale));
    await answerOne(
      env,
      {
        platform: "teams",
        userId,
        thread: conversation,
        afterward: (send) => {
          later.push(send);
        },
      },
      kept.question,
      kept.locale
    );
    for (const send of later) {
      // oxlint-disable-next-line no-await-in-loop -- in the order they were asked for
      await send();
    }
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
      await answerOne(env, accepted, kept, languageOf(kept, fallback));
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
    await answerOne(env, accepted, text, locale);
  };
