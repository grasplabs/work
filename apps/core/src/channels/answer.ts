import { agentErrors } from "@grasp-os/shared/agent";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Thread } from "chat";
import { z } from "zod";

import { signInConfig } from "../auth/config.ts";
import { chatAgentId, personalWorkspaceId } from "../chats-rpc.ts";
import { workspace } from "../durable-objects.ts";
import { answerCard } from "./cards.tsx";
import type { ChannelHandoff, ChannelMessage } from "./door.ts";
import { channelLocales, languageOf, say } from "./words.ts";
import type { ChannelLocale } from "./words.ts";

// A member's message answered by the organization's agent, in the
// person's own chat for that platform in their own Workspace (`via`, the
// platform's name), found or made on their first message, with what it
// cited; the answer goes back to the conversation they wrote in. The door
// has already checked who wrote (door.ts), so the Workspace takes its word.
//
// While the turn runs, the platform shows Stephen typing, sent again every
// few seconds, as a typing indicator lasts only that long. A turn that
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

/** One question asked in the person's chat for `platform`, and its answer posted. */
const answerOne = async (
  env: Env,
  {
    platform,
    userId,
    thread,
  }: Pick<ChannelMessage, "platform" | "userId" | "thread">,
  text: string,
  locale: ChannelLocale
): Promise<void> => {
  const stopTyping = typingIn(thread);
  let asked: Awaited<ReturnType<ReturnType<typeof workspace>["askThrough"]>>;
  try {
    asked = await workspace(env, personalWorkspaceId(userId)).askThrough(
      userId,
      chatAgentId,
      platform,
      text
    );
  } catch (error) {
    const line = lineFor(error);
    log.warn("channel.turn_refused", {
      platform,
      line,
      ...errorFields(error),
    });
    await thread.post(say(line, locale));
    return;
  } finally {
    stopTyping();
  }
  const { chatId, answer } = asked;
  if (answer.outcome !== "answered" || answer.answer.trim() === "") {
    log.warn("channel.turn_failed", { platform, outcome: answer.outcome });
    await thread.post(say("failed", locale));
    return;
  }
  const origin = signInConfig(env)?.origin;
  if (origin === undefined) {
    await thread.post(answer.answer);
    return;
  }
  await thread.post(
    answerCard({
      locale,
      text: answer.answer,
      sources: answer.cited.map(({ title, collectionId, documentId }) => ({
        title,
        url: `${origin}/knowledge/${encodeURIComponent(collectionId)}?doc=${encodeURIComponent(documentId)}`,
      })),
      chatUrl: `${origin}/?chat=${encodeURIComponent(chatId)}`,
    })
  );
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
