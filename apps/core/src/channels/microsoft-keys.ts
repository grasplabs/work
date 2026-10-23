/**
 * Microsoft's signing keys, as the channel door fetches them: through the
 * fetch it is given (connect's, once GRA-757 points it there), never
 * straight from the Worker.
 *
 * Microsoft's validator under the Teams adapter
 * (`@microsoft/teams.apps`'s `JwtValidator`) gets its keys from `jwks-rsa`,
 * which opens Node's `https` on its own and takes no fetch. Core's builds
 * put jwks-rsa.ts in its place (`alias` in wrangler.jsonc, and in
 * vite.config.ts for the tests), which hands the validator this module's
 * client: the validator still checks every token itself, signature,
 * expiry, audience, issuer and `serviceUrl`; only where its keys come from
 * is ours. It implements no more of `jwks-rsa` than that validator calls,
 * and outside a door's request (`withMicrosoftKeys`) it has no fetch, so a
 * key asked for there fails, and the token with it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { z } from "zod";

/** How the door reaches outside the Worker: connect's fetch, or a test's. */
export type ChannelFetch = (request: Request) => Promise<Response>;

/** One of Microsoft's public keys, as its key set lists it. */
const keySchema = z.looseObject({
  kid: z.string(),
  kty: z.string(),
  use: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
  // The channels a Bot Framework key may sign for (`msteams`, `webchat`...).
  endorsements: z.array(z.string()).optional(),
});
export type MicrosoftKey = z.infer<typeof keySchema>;

const keySetSchema = z.object({ keys: z.array(keySchema) });

/** How long a key set is kept before it is fetched again. */
const keySetLifetimeMs = 60 * 60 * 1000;

/**
 * The least time between two fetches of one key set: a token naming a key
 * the kept set lacks fetches it again (Microsoft rolls its keys), but
 * tokens with made-up key ids can't make the door fetch on every request.
 */
const refetchFloorMs = 5 * 60 * 1000;

interface KeptKeySet {
  keys: readonly MicrosoftKey[];
  fetchedAt: number;
}

/**
 * Key sets kept per fetch, then per URL: each door's fetch reaches its own
 * Microsoft (a test's stands in for it), so one never answers for another.
 */
const keptKeySets = new WeakMap<ChannelFetch, Map<string, KeptKeySet>>();

const fetchKeySet = async (
  fetch: ChannelFetch,
  url: string
): Promise<readonly MicrosoftKey[]> => {
  const response = await fetch(
    new Request(url, { headers: { accept: "application/json" } })
  );
  if (!response.ok) {
    throw new Error(`Microsoft's keys answered ${response.status}.`);
  }
  return keySetSchema.parse(await response.json()).keys;
};

/**
 * The key `kid` of the key set at `url`, fetched through `fetch` and kept
 * for an hour; undefined when the set has no such key.
 */
export const microsoftKey = async (
  fetch: ChannelFetch,
  url: string,
  kid: string,
  now: number = Date.now()
): Promise<MicrosoftKey | undefined> => {
  const sets = keptKeySets.get(fetch) ?? new Map<string, KeptKeySet>();
  keptKeySets.set(fetch, sets);
  const kept = sets.get(url);
  const fresh = kept !== undefined && now - kept.fetchedAt < keySetLifetimeMs;
  const found = kept?.keys.find((key) => key.kid === kid);
  if (fresh && (found !== undefined || now - kept.fetchedAt < refetchFloorMs)) {
    return found;
  }
  const keys = await fetchKeySet(fetch, url);
  sets.set(url, { keys, fetchedAt: now });
  return keys.find((key) => key.kid === kid);
};

/** The fetch of the door request being handled, for the validator's keys. */
const doorFetch = new AsyncLocalStorage<ChannelFetch>();

/**
 * Runs `handle` with `fetch` as where Microsoft's validator gets its keys,
 * for everything `handle` starts.
 */
export const withMicrosoftKeys = async <T>(
  fetch: ChannelFetch,
  handle: () => Promise<T>
): Promise<T> => await doorFetch.run(fetch, handle);

/** A signing key as `jwks-rsa` hands one to `jsonwebtoken`. */
interface SigningKey {
  kid: string;
  getPublicKey: () => KeyObject;
}

/** What `jwks-rsa` gives the validator for one key set. */
interface KeySetClient {
  getSigningKey: (
    kid: string | undefined,
    callback: (error: Error | null, key?: SigningKey) => void
  ) => void;
}

const signingKey = async (
  url: string,
  kid: string | undefined
): Promise<SigningKey> => {
  const fetch = doorFetch.getStore();
  if (fetch === undefined) {
    throw new Error(
      "Microsoft's keys are fetched only within a door's request."
    );
  }
  if (kid === undefined) {
    throw new Error("The token names no signing key.");
  }
  const key = await microsoftKey(fetch, url, kid);
  // Only RSA keys meant for signatures: the validator accepts RS256 alone.
  if (key === undefined || key.kty !== "RSA" || (key.use ?? "sig") !== "sig") {
    throw new Error(`Microsoft has no signing key ${kid}.`);
  }
  const publicKey = createPublicKey({
    key: { kty: key.kty, n: key.n, e: key.e },
    format: "jwk",
  });
  return { kid, getPublicKey: () => publicKey };
};

/* oxlint-disable promise/prefer-await-to-then, promise/prefer-catch, promise/prefer-await-to-callbacks, promise/no-callback-in-promise -- `jwks-rsa`'s API, as `jsonwebtoken` calls it, takes a callback */
/** `jwks-rsa`'s client for the key set at `jwksUri`, as the validator makes one. */
const jwksClient = ({ jwksUri }: { jwksUri: string }): KeySetClient => ({
  getSigningKey: (kid, callback) => {
    signingKey(jwksUri, kid).then(
      (key) => {
        callback(null, key);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    );
  },
});
/* oxlint-enable promise/prefer-await-to-then, promise/prefer-catch, promise/prefer-await-to-callbacks, promise/no-callback-in-promise */

/**
 * Where jwks-rsa.ts finds the client, under a key nothing else uses: the
 * isolate's global, as the tests load that module apart from this one.
 */
Reflect.set(globalThis, Symbol.for("@grasp-os/core/jwks-client"), jwksClient);
