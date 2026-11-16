/**
 * Team claims a change would take down (the store's `#recountClaims`), by
 * the onboarding's ids for them (`claim:<source>`), while the Brain may
 * still have them in use: thrown inside the change's transaction, so
 * nothing of it commits until they are out (the store's `#claimsFirst`).
 */
export class ClaimsFallError extends Error {
  override name = "ClaimsFallError";

  readonly sources: readonly string[];

  constructor(sources: readonly string[]) {
    super("Team claims fall: out of the Brain first.");
    this.sources = sources;
  }
}

/**
 * Takes the team claims `sources` out of use in the Brain's shared store,
 * as core's onboarding object does (onboarding/object.ts), throwing when
 * it can't; then erases each it can, so the Brain's ledger keeps it out
 * after a restore too. The sources it erased: their erasure is owed no
 * more.
 */
export type ClaimRemover = (
  sources: readonly string[]
) => Promise<readonly string[]>;
