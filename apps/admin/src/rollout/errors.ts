/** Why staff's action on a channel, a client's release or the shared secrets was refused, as the page words it. */
export const rolloutErrorCodes = [
  /** The admin has no CLIENT_DOMAIN, so no client can be deployed. */
  "domain_not_set",
  /** The release isn't imported. */
  "release_not_imported",
  /**
   * Not a move a channel may make: a release goes Edge, then Beta, then
   * Stable, and a channel goes back only to a release it had.
   */
  "promotion_not_allowed",
  /** The channel's release changed as it was set: read it again. */
  "channel_changed",
  /** No such client. */
  "unknown_client",
  /** Secrets can't be rolled out while Secrets Store is missing a shared secret. */
  "secrets_store_incomplete",
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
