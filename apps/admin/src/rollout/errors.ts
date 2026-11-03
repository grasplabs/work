/** Why staff's action on a channel or a client's release was refused, as the page words it. */
export const rolloutErrorCodes = [
  /** The release isn't imported. */
  "release_not_imported",
  /** The release's bundle left the bucket (src/releases/retention.ts): it can't be deployed. */
  "bundle_deleted",
  /**
   * Not a move a channel may make: a release goes Edge, then Beta, then
   * Stable, and a channel goes back only to a release it had.
   */
  "promotion_not_allowed",
  /** The channel's release changed as it was set: read it again. */
  "channel_changed",
  /** No such client. */
  "unknown_client",
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
