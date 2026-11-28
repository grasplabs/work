import { useAction } from "../use-action.ts";
import type { RolloutErrorCode } from "./errors.ts";

/** What staff read when the admin refuses a channel or release action, by its code. */
const refusals: Readonly<Record<RolloutErrorCode, string>> = {
  release_not_imported: "That release isn't imported.",
  bundle_deleted:
    "That release was never promoted past Edge, and its bundle was deleted after 14 days: build it again from its commit to use it.",
  promotion_not_allowed:
    "A release goes Edge, then Beta, then Stable, and a channel goes back only to a release it had.",
  channel_behind_chat_storage:
    "The channel's release changed how chats are stored, and that release can't read them: release a fix instead.",
  channel_changed:
    "The channel changed just now: look at it again before promoting.",
  previous_channel_halted:
    "That release's rollout halted on the channel before: resume it there, or promote a fix, first.",
  not_halted: "The channel's rollout isn't halted: there's nothing to resume.",
  unknown_client: "There's no such company.",
};

/** A staff action on a channel or a client's release (`useAction`), its refusals worded. */
export const useRolloutAction = () => useAction(refusals);
