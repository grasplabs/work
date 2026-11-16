import { errorFields, log } from "@grasp-os/shared/log";
import { z } from "zod";

import { forgetFor } from "../brain-memories.ts";
import { appLocale } from "./answer.ts";
import { lineCard } from "./cards.tsx";
import { pressedKey, pressedTtlMs, sayThere } from "./press.ts";
import type { CardPress } from "./press.ts";
import { callerOf } from "./remembered.ts";
import { say } from "./words.ts";

// Undo on the notice of a memory the agent saved in a person's direct
// message (remembered.ts, which says what could go wrong and what stops
// each): it retires the presser's own memory through the same
// `forgetFor` as Grasp's own notice, once per card.

const memorySchema = z.uuid();

/**
 * A press on Undo on a memory's notice, by the member the door let in
 * (`userId`), in a direct message (`direct`): retires that memory of
 * theirs, once per card, and says on the card what it did. Anything else
 * does nothing. An Undo that failed lets the card go, to be pressed again.
 */
export const pressUndo = async (
  env: Env,
  { platform, userId, event, state }: CardPress,
  direct: boolean
): Promise<void> => {
  const memory = memorySchema.safeParse(event.value);
  if (!(direct && memory.success)) {
    return;
  }
  const locale = appLocale(event.raw);
  const key = pressedKey(platform, event);
  if (!(await state.setIfNotExists(key, true, pressedTtlMs))) {
    await sayThere(event, "alreadyAnswered", locale);
    return;
  }
  let outcome: Awaited<ReturnType<typeof forgetFor>>;
  try {
    outcome = await forgetFor(env, callerOf(userId, platform), memory.data);
  } catch (error) {
    // Nothing retired: the card may be pressed again.
    await state.delete(key);
    log.warn("channel.undo_failed", { platform, ...errorFields(error) });
    await sayThere(event, "undoFailed", locale);
    return;
  }
  try {
    await event.adapter.editMessage(
      event.threadId,
      event.messageId,
      lineCard(say(outcome === "done" ? "undone" : "nothingToUndo", locale))
    );
  } catch (error) {
    log.warn("channel.card_edit_failed", errorFields(error));
  }
};
