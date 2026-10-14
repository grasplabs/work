import { appTokenMs } from "@grasp-os/shared/portable";

/** A key row of the JWT plugin's, as far as its expiry goes. */
interface KeyRow {
  expiresAt?: Date | null;
}

/**
 * The keys that may still verify an App token at `now`: those that sign
 * now, and those that stopped no longer ago than a token lives (a token
 * is signed only by a key that signs then). The JWT plugin's key source
 * (auth.ts), so it signs and verifies with these alone.
 */
export const liveKeys = <Key extends KeyRow>(
  keys: readonly Key[],
  now: number
): Key[] =>
  keys.filter(
    ({ expiresAt }) =>
      expiresAt === undefined ||
      expiresAt === null ||
      expiresAt.getTime() + appTokenMs > now
  );
