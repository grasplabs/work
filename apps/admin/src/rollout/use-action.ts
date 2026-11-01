import { useAction } from "../use-action.ts";
import type { RolloutErrorCode } from "./errors.ts";

/** What staff read when the admin refuses a channel or release action, by its code. */
const refusals: Readonly<Record<RolloutErrorCode, string>> = {
  domain_not_set:
    "The admin has no CLIENT_DOMAIN yet, so no client can be deployed.",
  release_not_imported: "That release isn't imported.",
  bundle_deleted:
    "That release was never promoted past Edge, and its bundle was deleted after 14 days: build it again from its commit to use it.",
  promotion_not_allowed:
    "A release goes Edge, then Beta, then Stable, and a channel goes back only to a release it had.",
  channel_changed:
    "The channel changed just now: look at it again before promoting.",
  unknown_client: "There's no such company.",
  secrets_store_incomplete:
    "Secrets Store is missing a shared secret: run Deploy platform with secrets only first.",
};

/** A staff action on a channel or a client's release (`useAction`), its refusals worded. */
export const useRolloutAction = () => useAction(refusals);
