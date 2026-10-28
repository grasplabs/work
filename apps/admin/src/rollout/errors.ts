/** Why staff's action on a rollout was refused, as the page words it. */
export const rolloutErrorCodes = [
  /** The admin has no CLIENT_DOMAIN, so no client can be deployed. */
  "domain_not_set",
  /** The release isn't imported. */
  "release_not_imported",
  /** No active client is in what the rollout was started for. */
  "no_targets",
  /**
   * The ring past 0, or the client, it was started for adds no one past
   * ring 0: it would reach only Grasp's own deployments.
   */
  "ring_zero_only",
  /** It would take its run past the step budget: roll out to fewer clients at a time. */
  "too_large",
  /**
   * The release raises a platform limit, over what a client it would reach
   * runs, without capacity and security evidence for that client's profile.
   */
  "limit_evidence_missing",
  /** The release was built before platform limits were recorded, and isn't made live. */
  "release_without_limits",
  /** A release on the way to it isn't imported, so its evidence can't be read. */
  "release_history_incomplete",
  /** Another rollout is running or waiting for approval. */
  "rollout_running",
  /** The rollout isn't waiting for approval. */
  "not_waiting",
  /** The rollout's run isn't going, so it can't be paused. */
  "not_running",
  /** The rollout's run isn't paused. */
  "not_paused",
  /** No such client. */
  "unknown_client",
  /** The rollout didn't reach the client, or recorded nothing to go back to. */
  "nothing_to_roll_back",
  /** Something newer was deployed to the client after the rollout. */
  "superseded",
  /**
   * What the client ran before doesn't work with what it runs now, or
   * declares nothing of what it works with (src/deploy/compatibility.ts).
   */
  "incompatible",
  /**
   * What the client ran before doesn't run on its databases' schemas: a
   * migration since contracted what that code uses
   * (src/deploy/compatibility.ts).
   */
  "schema_incompatible",
  /** Another runner (provisioning, another rollout, a rollback) has the client. */
  "client_busy",
  /** The rollback's run failed or was ended before it finished. */
  "rollback_failed",
  /**
   * The rollout's release added a Durable Object migration since the
   * release before, which a script never goes back past.
   */
  "rollback_past_migration",
  /** A secrets rollout can't start while Secrets Store is missing a shared secret. */
  "secrets_store_incomplete",
  /**
   * The next ring was approved without saying the eval passed and the
   * demo messages were sent in real Teams on the ring before
   * (src/rollout/control.ts, `RingChecks`).
   */
  "ring_checks_missing",
] as const;
export type RolloutErrorCode = (typeof rolloutErrorCodes)[number];

export class RolloutError extends Error {
  readonly code: RolloutErrorCode;

  constructor(code: RolloutErrorCode, message: string) {
    super(message);
    this.name = "RolloutError";
    this.code = code;
  }
}
