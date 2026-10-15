import { fromBase64Url } from "@grasp-os/shared/encoding";
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

/**
 * How long an isolate uses the key rows it read without reading them
 * again: a key signs for a month (auth.ts), so a minute's copy is current.
 * A key row deleted meanwhile (`sweepTokenKeys`) may verify in another
 * isolate for as long; only keys no current token was signed with are
 * deleted, and every check reads the token's session afresh anyway.
 */
const keysKeptMs = 60_000;

/**
 * How soon after reading the keys an isolate reads them again for a token
 * that names a key it doesn't hold (one another isolate just made, or
 * one nobody did), or whose key it can't read: what such tokens cost is
 * one read in this long.
 */
const unknownKeyRereadMs = 5000;

/**
 * How many checks against a stale copy an isolate remembers until each is
 * taken (`takeStale`): a bound on forged tokens checked at once. Once it
 * is full, a genuine token signed by a key made since gets a 401 within
 * the window, as before tokens were told to try again; that takes a flood
 * of forged keys right after a rotation.
 */
const staleChecksMax = 1024;

/** A key row, by the ID a token's header names it with (`kid`). */
interface IdentifiedKeyRow extends KeyRow {
  id: string;
}

/**
 * Why the keys are asked for, by the call that asks: to sign a token, for a
 * person signed in; or to check `token`, naming `kid` in its header
 * (`undefined` when it can't be read: a token checked all the same, and
 * refused).
 */
export type KeyUse =
  | { readonly sign: true }
  | { readonly kid: string | undefined; readonly token?: string };

/**
 * The token-signing keys as one isolate holds them (the JWT plugin's key
 * source, auth.ts). To check a token, read from D1 at most once a minute,
 * not once a request, so a token costs no D1 read before anyone is known;
 * again sooner for a key it doesn't hold (`unknownKeyRereadMs`). To sign
 * one, always read afresh: it signs with the key D1 holds now, and what it
 * read is held for the checks after. Requests meanwhile share one read.
 * Each answer is `liveKeys` of them, at the time asked.
 */
export const keyRing = <Key extends IdentifiedKeyRow>() => {
  let held: { readonly keys: Key[]; readonly readAt: number } | undefined;
  /** The read under way, which every request meanwhile joins. */
  let reading: Promise<Key[]> | undefined;
  /** Moves on with `forget`: a read begun before it is never held. */
  let version = 0;
  /** How many reads began: the one under way is the latest. */
  let begunReads = 0;
  /**
   * Tokens checked with the held copy, unread, though it lacked their key
   * (one another isolate may have made since), by how many such checks of
   * each are still to be taken. Each check's own decision: no later read
   * or `forget` changes it.
   */
  const staleChecks = new Map<string, number>();
  /** Whether a token naming `kid` is checked with what is held, unread. */
  const fresh = (kid: string | undefined, now: number): boolean => {
    if (held === undefined) {
      return false;
    }
    const age = now - held.readAt;
    const known = kid !== undefined && held.keys.some(({ id }) => id === kid);
    return age < keysKeptMs && (known || age < unknownKeyRereadMs);
  };
  const readOnce = async (
    read: () => Promise<Key[]>,
    now: number
  ): Promise<Key[]> => {
    if (reading === undefined) {
      const begun = version;
      begunReads += 1;
      const number = begunReads;
      reading = (async () => {
        try {
          const keys = await read();
          if (begun === version) {
            held = { keys, readAt: now };
          }
          return keys;
        } finally {
          if (number === begunReads) {
            reading = undefined;
          }
        }
      })();
    }
    return await reading;
  };
  return {
    /** The live keys for `use`, read with `read` unless held fresh enough. */
    keys: async (
      read: () => Promise<Key[]>,
      use: KeyUse,
      now: number
    ): Promise<Key[]> => {
      if (!("sign" in use) && held !== undefined && fresh(use.kid, now)) {
        const { kid, token } = use;
        if (
          kid !== undefined &&
          token !== undefined &&
          staleChecks.size < staleChecksMax &&
          !held.keys.some(({ id }) => id === kid)
        ) {
          staleChecks.set(token, (staleChecks.get(token) ?? 0) + 1);
        }
        return liveKeys(held.keys, now);
      }
      return liveKeys(await readOnce(read, now), now);
    },
    /**
     * Whether the check of `token` that just failed used the held copy,
     * unread, though it lacked the token's key: one another isolate may
     * have made since. Its holder is told to try again
     * (`auth.token_unavailable`), not to sign in. A key a fresh read
     * didn't find is refused outright. Takes that check's decision, once.
     */
    takeStale: (token: string): boolean => {
      const checks = staleChecks.get(token);
      if (checks === undefined) {
        return false;
      }
      if (checks > 1) {
        staleChecks.set(token, checks - 1);
      } else {
        staleChecks.delete(token);
      }
      return true;
    },
    /** Drops the held copy: a key was made, or removed. */
    forget: (): void => {
      held = undefined;
      reading = undefined;
      version += 1;
    },
  };
};

/** One isolate's token keys (`keyRing`). */
export type KeyRing<Key extends IdentifiedKeyRow> = ReturnType<
  typeof keyRing<Key>
>;

/** The key `token`'s header names (`kid`), read without checking it. */
export const keyIdOf = (token: unknown): string | undefined => {
  if (typeof token !== "string") {
    return undefined;
  }
  const [header] = token.split(".");
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(header ?? ""))
    );
    const kid: unknown =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "kid")
        : undefined;
    return typeof kid === "string" ? kid : undefined;
  } catch {
    return undefined;
  }
};
