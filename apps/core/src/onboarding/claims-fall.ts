/** A team claim, by the onboarding's id for it (`claim:<source>`) and its team. */
export interface FallingClaim {
  source: string;
  team: string;
}

/**
 * Team claims a change would take down (the store's `#recountClaims`),
 * while the Brain may still have them in use: thrown inside the change's
 * transaction, so nothing of it commits until they are out (the store's
 * `#claimsFirst`).
 */
export class ClaimsFallError extends Error {
  override name = "ClaimsFallError";

  readonly claims: readonly FallingClaim[];

  constructor(claims: readonly FallingClaim[]) {
    super("Team claims fall: out of the Brain first.");
    this.claims = claims;
  }
}

/**
 * Takes the team claims `claims` out of use in the Brain's shared store,
 * as core's onboarding object does (onboarding/object.ts), throwing when
 * it can't; then erases each it can, so the Brain's ledger holds it out
 * after a restore too. The sources it erased: their erasure is owed no
 * more.
 */
export type ClaimRemover = (
  claims: readonly FallingClaim[]
) => Promise<readonly string[]>;
