import { agentErrors } from "@grasp-os/shared/agent";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { SentMessage, Thread } from "chat";
import { z } from "zod";

import { chatAgentId, personalWorkspaceId } from "../chats-rpc.ts";
import { workspace } from "../durable-objects.ts";
import { answerCards, draftCard, heldWritesCard, lineCard } from "./cards.tsx";
import {
  offerConnectOwn,
  ownMicrosoftNeed,
  takeKeptAsk,
} from "./connect-own.ts";
import type { Conversation } from "./connect-own.ts";
import type { ChannelHandoff, ChannelMessage } from "./door.ts";
import { checkOf, inertView, turnHeldWrites } from "./held.ts";
import { inTeams } from "./inert.ts";
import { sortRequest } from "./request-sorting.ts";
import { countAnswered, countSignal } from "./signals.ts";
import type { ChannelSignal } from "./signals.ts";
import {
  answerDecides,
  heardFrom,
  heardRequest,
  keepCardsOf,
  settleRequest,
  takeRequest,
} from "./stephen-requests.ts";
import type { Settled } from "./stephen-requests.ts";
import { teamsAdapter } from "./teams.ts";
import { channelLocales, languageOf, say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";
import { postOffers } from "./workflow-offers.ts";

// A member's message answered by the organization's agent, in the
// person's own chat for that platform in their own Workspace (`via`, the
// platform's name), found or made on their first message; the answer goes
// back to the conversation they wrote in. The door has already checked who
// wrote (door.ts), so the Workspace takes its word. Asked in a group chat
// or channel, it is their one chat for that thread, and its agent reads
// only what everyone in it may.
//
// While the turn runs, the platform shows Stephen typing, sent again every
// few seconds, as a typing indicator lasts only that long. The answer is
// on one card, the model's words as written, made inert (inert.ts). In a
// Teams direct message it is written into that card as the model writes
// it: posted once there are words to show, then the same card updated in
// place, never a second message and never Teams' own stream, whose
// message text renders HTML and images. Elsewhere it is posted once,
// whole: Slack never streams, as an edit takes no flags to keep Slack from
// previewing an address, and an edited message's previews are
// undocumented. A turn that fails or is refused ends in one of Stephen's
// lines, in the language the person wrote in, never in the gateway's
// words, which name models and budgets the person has no part in.
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
    // Whether he answered is asked only where the outcome rests on it.
    const sorted =
      answer === undefined
        ? null
        : await sortRequest(env, {
            userId,
            platform,
            message: text,
            answer,
            judge: answerDecides(ended.ended, heardFrom(ended.calls)),
          });
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

/**
 * How often the card of an answer being written is updated at most: the
 * Chat SDK's own interval for streaming by edits.
 */
const updateEveryMs = 500;

/** The longest a refused update holds back the next one, doubling to it. */
const longestBackOffMs = 8000;

/** How often the card's last update is tried before the answer is posted whole. */
const lastTries = 2;

/** Waits until `at`, a time in milliseconds, if it is still ahead. */
const waitUntil = async (at: number): Promise<void> => {
  const ms = at - Date.now();
  if (ms > 0) {
    await scheduler.wait(ms);
  }
};

/** Where the card of an answer being written stands (`cardInto`). */
interface Writing {
  sent: SentMessage | undefined;
  /** The words the card shows, as drafted (`draftCard`). */
  shown: string;
  /** The latest words it should show, not yet sent. */
  pending: string | undefined;
  /** The run of updates under way, if one is. */
  updating: Promise<void> | undefined;
  /** When the next update may go. */
  nextAt: number;
  backOff: number;
  /** Whether the turn ended: no update after it but the last. */
  ended: boolean;
}

/**
 * The card an answer is written into as the model writes it, in `thread`
 * (a Teams direct message): `onText` takes the model's words so far, and
 * the card, inert at every update (`inTeams`), is posted at the first
 * words and updated in place with the latest, one update at a time and at
 * most every {@link updateEveryMs}, never one that would show what the
 * card shows already (once the card is full, none until the last). An
 * update Teams refuses leaves the card as it was and holds the next one
 * back, longer each time. `end` makes the card what the turn ended in
 * (the answer, or a line), and says whether it did: if it couldn't, or
 * nothing was posted, the caller posts that whole, once.
 */
const cardInto = (thread: Thread, onFirst: () => void) => {
  const writing: Writing = {
    sent: undefined,
    shown: "",
    pending: undefined,
    updating: undefined,
    nextAt: 0,
    backOff: updateEveryMs,
    ended: false,
  };
  /** Posts or updates the card as `content`: whether Teams took it. */
  const send = async (content: Parameters<Thread["post"]>[0]) => {
    try {
      if (writing.sent === undefined) {
        writing.sent = await thread.post(content);
        onFirst();
      } else {
        await writing.sent.edit(content);
      }
      writing.backOff = updateEveryMs;
      writing.nextAt = Date.now() + updateEveryMs;
      return true;
    } catch (error) {
      log.warn("channel.card_update_refused", errorFields(error));
      writing.nextAt = Date.now() + writing.backOff;
      writing.backOff = Math.min(writing.backOff * 2, longestBackOffMs);
      return false;
    }
  };
  const update = async (): Promise<void> => {
    try {
      while (writing.pending !== undefined && !writing.ended) {
        // oxlint-disable-next-line no-await-in-loop -- one update at a time
        await waitUntil(writing.nextAt);
        const text = writing.pending;
        writing.pending = undefined;
        if (writing.ended || text === undefined) {
          continue;
        }
        const draft = draftCard(inTeams(text));
        if (draft.shown === writing.shown) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- one update at a time
        if (await send(draft.posted)) {
          writing.shown = draft.shown;
        }
      }
    } finally {
      writing.updating = undefined;
    }
  };
  return {
    onText: (text: string): void => {
      if (writing.ended || text === "") {
        return;
      }
      writing.pending = text;
      writing.updating ??= update();
    },
    end: async (content: Parameters<Thread["post"]>[0]): Promise<boolean> => {
      writing.ended = true;
      writing.pending = undefined;
      await writing.updating;
      if (writing.sent === undefined) {
        return false;
      }
      // A line the turn ended in goes on a card too: card to card.
      const last = typeof content === "string" ? lineCard(content) : content;
      for (let tried = 0; tried < lastTries; tried += 1) {
        // oxlint-disable-next-line no-await-in-loop -- tried in turn
        await waitUntil(writing.nextAt);
        // oxlint-disable-next-line no-await-in-loop -- tried in turn
        if (await send(last)) {
          return true;
        }
      }
      return false;
    },
  };
};

/**
 * The card an answer is written into where it streams: only in a Teams
 * direct message the platform's SDK handed over.
 */
const cardIn = (
  thread: Thread | Conversation,
  platform: string,
  place: ChannelMessage["place"],
  onFirst: () => void
) =>
  platform === "teams" && place.kind === "direct" && "isDM" in thread
    ? cardInto(thread, onFirst)
    : undefined;

/**
 * One question asked in the person's chat for `platform`, and its answer
 * on as many cards as it takes, the thumbs under the last: the first
 * written into as the model writes it in a Teams direct message, the rest
 * posted after it once it is done; otherwise all posted once it is done.
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
  const card = cardIn(thread, platform, place, stopTyping);
  /**
   * Gives the person what the turn ended in: as its card where one was
   * posted, or else, or where the card couldn't be updated, posted once.
   */
  const deliver = async (content: Parameters<typeof postIn>[3]) => {
    if ((await card?.end(content)) !== true) {
      await postIn(env, platform, thread, content);
    }
  };
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
      card?.onText,
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
    });
    await deliver(say(line, locale));
    return;
  }
  stopTyping();
  const { chatId, answer, calls } = asked;
  const answered = answer.outcome === "answered";
  const final = answer.answer.trim();
  if (!answered || final === "") {
    log.warn("channel.turn_failed", { platform, outcome: answer.outcome });
    await countSignal(env, platform, "failed");
    await settle({
      chatId,
      ended: endOfTurn(answer.outcome),
      calls,
    });
    await deliver(say("failed", locale));
    return;
  }
  // What the turn did is kept now, before any card of the answer can be
  // pressed, so a press finds the tools it changes. Sorted and settled
  // once the person has the answer, as that takes a model call of its
  // own; never kept from it by a card after the answer that couldn't be
  // posted (`quietly`).
  if (requestId !== null) {
    await heardRequest(env, requestId, { calls });
  }
  const recorded = async () => {
    await settle({ chatId, ended: "answered", calls }, final);
  };
  // The starts the turn offered, each on its card, under the answer, each
  // kept with this request so a press on it is this request's.
  const offers = quietly("offers", async () => {
    await postOffers(
      env,
      thread,
      { chatId, userId, requestId, platform },
      locale
    );
  });
  // Timed to the answer the person has, as they wait for it.
  const timed = async () => {
    await countAnswered(env, platform, Date.now() - startedAt);
  };
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
        writes: writes.map((write) => inertView(platform, write)),
        ...(check === undefined ? {} : { check }),
      })
    );
  });
  // Whole and inert, in as many cards as it takes (`answerCards`): the
  // first as the card it was written into, where there is one, the rest
  // posted after it in order, the thumbs under the last. A part the
  // platform refuses ends it with the line that something went wrong,
  // and the held writes still get their card, which no page of Grasp
  // shows, and the turn is still kept, before what posting threw.
  const [first, ...rest] = answerCards({ locale, text: final, platform, rate });
  try {
    if (first !== undefined) {
      await deliver(first);
    }
    for (const part of rest) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await postIn(env, platform, thread, part);
    }
  } catch (error) {
    try {
      // Not counted again: the answer's own failure is (`postIn`).
      await quietly("failed_line", async () => {
        await thread.post(say("failed", locale));
      })();
      await held();
    } finally {
      await recorded();
    }
    throw error;
  }
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
