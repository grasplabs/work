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
import { answerCard, sourcesCard } from "./cards.tsx";
import type { ChannelHandoff, ChannelMessage } from "./door.ts";
import { channelLocales, languageOf, say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";
import { postOffers } from "./workflow-offers.ts";

// A member's message answered by the organization's agent, in the
// person's own chat for that platform in their own Workspace (`via`, the
// platform's name), found or made on their first message, with what it
// cited; the answer goes back to the conversation they wrote in. The door
// has already checked who wrote (door.ts), so the Workspace takes its word.
//
// While the turn runs, the platform shows Stephen typing, sent again every
// few seconds, as a typing indicator lasts only that long, until the
// answer's first words, which stream in as the model writes them where
// the platform streams (Teams' private chats). A turn that
// fails or is refused ends in one of Stephen's lines, in the language the
// person wrote in, never in the gateway's words, which name models and
// budgets the person has no part in.

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
const appLocale = (raw: unknown): ChannelLocale => {
  const language = rawSchema
    .safeParse(raw)
    .data?.locale?.split("-")[0]
    ?.toLowerCase();
  return channelLocales.find((each) => each === language) ?? "en";
};

/** Shows typing in `thread` until the returned function is called. */
const typingIn = (thread: Thread): (() => void) => {
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
  }: Pick<ChannelMessage, "platform" | "userId" | "thread" | "afterward">,
  text: string,
  locale: ChannelLocale
): Promise<void> => {
  const stopTyping = typingIn(thread);
  const streaming = thread.isDM ? streamInto(thread, stopTyping) : undefined;
  let asked: Awaited<ReturnType<ReturnType<typeof workspace>["askThrough"]>>;
  try {
    asked = await workspace(env, personalWorkspaceId(userId)).askThrough(
      userId,
      chatAgentId,
      platform,
      text,
      streaming?.onText
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
    await thread.post(say(line, locale));
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
    await thread.post(say("failed", locale));
    return;
  }
  // The starts the turn offered, each on its card, under the answer.
  const offers = async () => {
    await postOffers(env, thread, { chatId, userId }, locale);
  };
  const origin = signInConfig(env)?.origin;
  if (origin === undefined) {
    if (!streamed) {
      await thread.post(final);
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
  if (!streamed) {
    await thread.post(answerCard({ locale, text: final, sources, chatUrl }));
    await offers();
    return;
  }
  // Under the answer's last words, which Teams gets once this returns.
  if (sources.length > 0) {
    afterward(
      async () => await thread.post(sourcesCard({ locale, sources, chatUrl }))
    );
  }
  afterward(offers);
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
