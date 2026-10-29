import { useAction } from "../use-action.ts";
import type { RolloutErrorCode } from "./errors.ts";

/** What staff read when the admin refuses a rollout action, by its code. */
const refusals: Readonly<Record<RolloutErrorCode, string>> = {
  domain_not_set:
    "The admin has no CLIENT_DOMAIN yet, so no client can be deployed.",
  release_not_imported: "That release isn't imported.",
  no_targets: "No active client is in that scope.",
  ring_zero_only:
    "No active client past Alpha is in that scope, so it would reach only our own deployments: pick a ring or client that has one.",
  too_large:
    "That's more clients than one rollout takes: roll out one ring or client at a time.",
  release_without_limits:
    "That release was built before platform limits were recorded, so it isn't made live: roll out a newer one.",
  release_history_incomplete:
    "A release between what a client runs and that one isn't imported, so its evidence can't be read: import the missing release first.",
  limit_evidence_missing:
    "That release raises a platform limit for a client it would reach without capacity and security evidence for its profile: publish a release with the evidence first.",
  rollout_running:
    "Another rollout is running or waiting for approval: finish or cancel it first.",
  not_waiting: "It isn't waiting for approval or a retry.",
  ring_checks_missing:
    "Before the next ring: run Stephen's eval on this release, and send the five demo messages in real Teams on this ring. Tick both once they passed.",
  not_running: "Its run isn't going, so there's nothing to pause.",
  not_paused: "It isn't paused.",
  unknown_client: "There's no such client.",
  nothing_to_roll_back:
    "The rollout didn't reach that client, so there's nothing to roll back.",
  superseded:
    "Something newer was deployed to that client since: roll out the release you want instead.",
  incompatible:
    "What that client ran before doesn't work with what it runs now, so going back could break it: roll out a release that does instead.",
  schema_incompatible:
    "What that client ran before doesn't run on its databases since this rollout's migrations: roll out a release that does instead.",
  client_busy:
    "Something else is deploying to that client right now: try again in a moment.",
  rollback_past_migration:
    "Its release added Durable Object migrations, which a client never goes back past: roll a fix out instead.",
  rollback_failed:
    "The rollback didn't finish: check the client's drift, then try again.",
  secrets_store_incomplete:
    "Secrets Store is missing a shared secret: put it in the store first.",
};

/** A staff action on a rollout (`useAction`), its refusals worded. */
export const useRolloutAction = () => useAction(refusals);
