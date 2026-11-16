import { errorFields, log } from "@grasp-os/shared/log";
import { z } from "zod";

import { forgetFor } from "../brain-memories.ts";
import { callerOf } from "../unseen-memories.ts";
import { appLocale } from "./answer.ts";
import { lineCard } from "./cards.tsx";
import { pressedKey, pressedTtlMs, sayThere } from "./press.ts";
import type { CardPress } from "./press.ts";
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
 * does nothing. An Undo that failed leaves the card to be pressed again.
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
  if ((await state.get(key)) !== null) {
    await sayThere(event, "alreadyAnswered", locale);
    return;
  }
  // The memory first, the card marked pressed after: a crash between them
  // leaves the card to press again, which retires nothing more, as a
  // forget is idempotent (`forget:<id>`), and never a card that can't be
  // pressed while its memory is still in use.
  let outcome: Awaited<ReturnType<typeof forgetFor>>;
  try {
    outcome = await forgetFor(env, callerOf(userId, platform), memory.data);
  } catch (error) {
    log.warn("channel.undo_failed", { platform, ...errorFields(error) });
    await sayThere(event, "undoFailed", locale);
    return;
  }
  // Two presses at once may both have retired it: one card, one answer.
  if (!(await state.setIfNotExists(key, true, pressedTtlMs))) {
    await sayThere(event, "alreadyAnswered", locale);
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
