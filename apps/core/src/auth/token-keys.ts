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
 */
const keysKeptMs = 60_000;

/**
 * How soon after reading the keys an isolate reads them again for a token
 * that names a key it doesn't hold: one another isolate just made. Bounds
 * what tokens naming made-up keys cost to one read in this long.
 */
const unknownKeyRereadMs = 5000;

/** A key row, by the ID a token's header names it with (`kid`). */
interface IdentifiedKeyRow extends KeyRow {
  id: string;
}

/**
 * The token-signing keys as one isolate holds them (the JWT plugin's key
 * source, auth.ts): to check a token, read from D1 at most once a minute,
 * not once a request, so a token costs no D1 read before anyone is known;
 * again sooner for a key made since (`unknownKeyRereadMs`). To sign one,
 * for a person signed in, always read afresh: it signs with the key D1
 * holds now, and what it read is held for the checks after. Each answer
 * is `liveKeys` of them, at the time asked.
 */
export const keyRing = <Key extends IdentifiedKeyRow>() => {
  let held: { readonly keys: Key[]; readonly readAt: number } | undefined;
  return {
    /**
     * The live keys, read with `read`: to check a token naming `wanted`,
     * only unless held fresh enough, a held copy without it read again
     * once it is `unknownKeyRereadMs` old; to sign (`wanted` undefined),
     * always.
     */
    keys: async (
      read: () => Promise<Key[]>,
      wanted: string | undefined,
      now: number
    ): Promise<Key[]> => {
      if (held !== undefined && wanted !== undefined) {
        const age = now - held.readAt;
        const known = held.keys.some(({ id }) => id === wanted);
        if (age < keysKeptMs && (known || age < unknownKeyRereadMs)) {
          return liveKeys(held.keys, now);
        }
      }
      const keys = await read();
      held = { keys, readAt: now };
      return liveKeys(keys, now);
    },
    /** Drops the held copy: a key was made, or removed. */
    forget: (): void => {
      held = undefined;
    },
  };
};

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
