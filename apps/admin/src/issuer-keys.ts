/**
 * Verifying a JWT an outside issuer signs with RS256 against the keys it
 * publishes: Cloudflare Access's on every request (src/access.ts), and
 * GitHub's for a CI run (src/releases/github-oidc.ts). The keys are
 * fetched from the issuer's own address and kept for a while, per
 * isolate.
 */
import "@tanstack/react-start/server-only";
import { createLocalJWKSet, errors, jwtVerify } from "jose";
import type { JSONWebKeySet, JWTVerifyResult } from "jose";
import { z } from "zod";

/** How long an issuer's keys are kept before they are fetched again. */
const keysMaxAgeMs = 10 * 60 * 1000;

/** How long a key set's fetch may take. */
const keysTimeoutMs = 5000;

/**
 * How long after a refetch for a key id the kept keys didn't have the next
 * such refetch waits: a forged JWT naming a made-up key id is refused at
 * once rather than fetching the keys each time.
 */
const missCooldownMs = 30 * 1000;

/**
 * Each issuer's keys as last fetched, by their address, per isolate:
 * plain data only. Never a fetch in flight, a response or a remote key set
 * holding one: those belong to the request that made them, and another
 * request awaiting them fails ("Cannot perform I/O on behalf of a
 * different request") or hangs. Each request that finds no fresh keys
 * fetches them itself. `lastMissFetchAt` is when a JWT's unknown key id
 * last made a request try to fetch them again (`missCooldownMs`), recorded
 * before that fetch starts, whether it then succeeds or not; null before
 * any.
 */
const keyCache = new Map<
  string,
  { keys: JSONWebKeySet; fetchedAt: number; lastMissFetchAt: number | null }
>();

const keySetSchema = z.object({
  keys: z.array(z.object({ kty: z.string() }).loose()),
});

/**
 * The keys at `keysUrl`, fetched now, in the asking request, and kept,
 * with the last miss refetch as it was recorded (`lastMissFetchAt`).
 */
const fetchKeys = async (keysUrl: string): Promise<JSONWebKeySet> => {
  const response = await fetch(keysUrl, {
    signal: AbortSignal.timeout(keysTimeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${keysUrl} answered ${String(response.status)}`);
  }
  const keys: JSONWebKeySet = keySetSchema.parse(await response.json());
  keyCache.set(keysUrl, {
    keys,
    fetchedAt: Date.now(),
    lastMissFetchAt: keyCache.get(keysUrl)?.lastMissFetchAt ?? null,
  });
  return keys;
};

/** Whose JWT, for whom, and where the issuer publishes its keys. */
export interface IssuerJwt {
  issuer: string;
  audience: string;
  keysUrl: string;
}

/**
 * Verifies `token`, RS256 only, for `audience` from `issuer`, with the
 * keys at `keysUrl`: those kept while fresh, else fetched; kept keys that
 * have no key for it are fetched again once, as issuers rotate their
 * keys, at most once every `missCooldownMs`: within it, a JWT naming an
 * unknown key id is refused without a fetch. Throws when it doesn't
 * verify (signature, `iss`, `aud`, expiry).
 */
export const verifyIssuerJwt = async (
  token: string,
  { issuer, audience, keysUrl }: IssuerJwt
): Promise<JWTVerifyResult> => {
  const options = { issuer, audience, algorithms: ["RS256"] };
  const kept = keyCache.get(keysUrl);
  if (kept === undefined || Date.now() - kept.fetchedAt >= keysMaxAgeMs) {
    return await jwtVerify(
      token,
      createLocalJWKSet(await fetchKeys(keysUrl)),
      options
    );
  }
  try {
    return await jwtVerify(token, createLocalJWKSet(kept.keys), options);
  } catch (error) {
    if (!(error instanceof errors.JWKSNoMatchingKey)) {
      throw error;
    }
    // Read, checked and recorded with nothing awaited in between, before
    // the fetch: concurrent misses after this one refuse at once, and a
    // fetch that fails still starts the cooldown.
    const now = Date.now();
    const current = keyCache.get(keysUrl) ?? kept;
    if (
      current.lastMissFetchAt !== null &&
      now - current.lastMissFetchAt < missCooldownMs
    ) {
      throw error;
    }
    keyCache.set(keysUrl, { ...current, lastMissFetchAt: now });
    return await jwtVerify(
      token,
      createLocalJWKSet(await fetchKeys(keysUrl)),
      options
    );
  }
};
