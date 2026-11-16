import type { ChatSavedMemory } from "@grasp-os/shared/brain-memories";
import { errorFields, log } from "@grasp-os/shared/log";
import type { PostableCard } from "chat";

import { retireUnseen } from "../unseen-memories.ts";
import { rememberedCard } from "./cards.tsx";
import type { ChannelLocale } from "./words.ts";

// What the agent remembers in a person's direct message on a chat app
// (GRA-1920, threat model on the issue): as in their own chat in Grasp
// (agent-remember.ts), each memory a turn saved is shown to them, in the
// conversation the turn answered, as a notice with Undo, and Undo retires
// it through the same `forgetFor` as Grasp's own notice does.
//
// What could go wrong, and what stops each:
// - A memory kept that the person never sees. The notice goes with the
//   turn's answer, on every path that has the turn's result, the failed
//   ones too (answer.ts). One the platform refuses is retired at once,
//   and so is one whose turn threw, or whose result reached a Workspace
//   with nobody waiting to post it (unseen-memories.ts, workspace.ts).
//   What is left, in use with no notice (it is still on their Memories
//   page in Grasp): a memory whose card the Worker died before posting,
//   once `askThrough` had returned it; one the Workspace held for its
//   asker when the Workspace restarted mid-turn; one whose retiring
//   failed twice; and one of a person no longer a member, which can't
//   be retired as them (`forgetAs` refuses), whose store their erasure
//   clears.
// - An Undo by someone else, or forged. A press comes through the door
//   as a message does, signed by the platform, from a verified member
//   (door.ts), who is the only one it acts for: `forgetFor` retires only
//   the presser's own memory, and another's answers `nothing`, exactly as
//   one that doesn't exist. Only a press in a direct message is taken.
// - Undo pressed twice, or the platform sending it again. The door takes
//   each activity once, and a card is pressed once (`pressedKey`, as a
//   card of held writes is): a second press says so and does nothing.
//   The memory is retired before the card is marked pressed, so an Undo
//   that failed or was cut short leaves the card to be pressed again.
// - What the model wrote on the card: made inert (cards.tsx).

/**
 * Posts the notice of each of `remembered`, the memories a turn saved for
 * `userId`, through `post`, in order. A notice the platform refuses has
 * its memory retired, as nobody sees it to undo it. Never throws: what
 * couldn't be posted or retired is logged.
 */
export const postRemembered = async (
  env: Env,
  {
    platform,
    userId,
    locale,
    remembered,
  }: {
    platform: string;
    userId: string;
    locale: ChannelLocale;
    remembered: readonly ChatSavedMemory[];
  },
  post: (notice: PostableCard) => Promise<void>
): Promise<void> => {
  for (const saved of remembered) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- in the order saved
      await post(rememberedCard({ locale, platform, saved }));
    } catch (error) {
      log.warn("channel.notice_refused", { platform, ...errorFields(error) });
      // oxlint-disable-next-line no-await-in-loop -- once, for this one
      await retireUnseen(env, userId, "card_refused", [saved.memory]);
    }
  }
};
