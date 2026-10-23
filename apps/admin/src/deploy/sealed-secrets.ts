/**
 * A client's own secrets that can't be derived (src/deploy/secrets.ts
 * derives the rest): its Teams bot's client secret, minted in the
 * client's own Entra, which connect sends as the bot with (connect's
 * src/channels.ts, `TEAMS_BOT_SECRET`). Staff set it, and set it again to
 * replace it (src/clients/settings.ts); a deploy gives it to the client's
 * connect as a Worker secret. Nothing ever reads it back to anyone.
 *
 * Each is sealed with AES-256-GCM under a key HKDF derives from
 * `CLIENT_KEY` for this purpose alone, so a copy of the admin's database
 * (a backup, an export, someone who reads D1) holds nothing it can open:
 * `CLIENT_KEY` is in Secrets Store, never in D1. The client's id and the
 * secret's name are its associated data, so a sealed value moved to
 * another client's row, or to another name, doesn't open, and no client's
 * connect ever gets another's secret.
 *
 * `CLIENT_KEY` changing would leave every sealed secret unreadable, as it
 * would change every client's derived ones: a deploy then stops with
 * `sealed_secret_unreadable` until staff set the secret again.
 */
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { and, eq, inArray } from "drizzle-orm";

import type { AdminDatabase } from "../db/act.ts";
import { clientSealedSecrets } from "../db/schema.ts";
import { DeployError } from "./errors.ts";

/** A sealed secret's name: the Worker secret it becomes. */
export type SealedSecretName =
  (typeof clientSealedSecrets.name.enumValues)[number];

/** Which Worker gets which sealed secret: only connect sends as the bot. */
const sealedSecretsByApp: Readonly<
  Record<string, readonly SealedSecretName[]>
> = {
  connect: ["TEAMS_BOT_SECRET"],
};

/** Every sealed secret's name, on any Worker: none can be given as a shared secret. */
export const sealedSecretNames: ReadonlySet<string> = new Set(
  Object.values(sealedSecretsByApp).flat()
);

/** What the key sealed secrets are sealed with is derived for. */
const sealingPurpose = "grasp-os admin sealed client secret";

/** The format of what `sealSecret` writes, so a later one can be told apart. */
const sealedVersion = "v1";

/** AES-GCM's recommended nonce length: 12 bytes, fresh for every seal. */
const ivBytes = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The AES-256-GCM key sealed secrets are sealed with, derived from `clientKey`. */
const sealingKey = async (clientKey: string): Promise<CryptoKey> => {
  if (clientKey === "") {
    throw new TypeError("No CLIENT_KEY");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(clientKey),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode(sealingPurpose),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

/** What binds a sealed value to its client and name. */
const associatedData = (clientId: string, name: SealedSecretName) =>
  encoder.encode(`${clientId}\n${name}`);

/** `value`, client `clientId`'s secret `name`, sealed under `clientKey`. */
export const sealSecret = async (
  clientKey: string,
  clientId: string,
  name: SealedSecretName,
  value: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(ivBytes));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(clientId, name) },
    await sealingKey(clientKey),
    encoder.encode(value)
  );
  return [
    sealedVersion,
    toBase64Url(iv),
    toBase64Url(new Uint8Array(sealed)),
  ].join(".");
};

/**
 * Client `clientId`'s secret `name`, opened from `sealed` under
 * `clientKey`; null when it doesn't open: another key, another client's
 * or name's value, or changed.
 */
const openSecret = async (
  clientKey: string,
  clientId: string,
  name: SealedSecretName,
  sealed: string
): Promise<string | null> => {
  const [version, iv, ciphertext, ...rest] = sealed.split(".");
  if (
    version !== sealedVersion ||
    iv === undefined ||
    ciphertext === undefined ||
    rest.length > 0
  ) {
    return null;
  }
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(iv),
        additionalData: associatedData(clientId, name),
      },
      await sealingKey(clientKey),
      fromBase64Url(ciphertext)
    );
    return decoder.decode(opened);
  } catch {
    // Reported by the caller, by name: nothing of the value or the key.
    return null;
  }
};

/**
 * The sealed secrets of client `clientId` that the Worker `app` runs
 * with, opened, by name; none for a client that has none, so a client
 * without a bot deploys as before. Throws `sealed_secret_unreadable` for
 * one that doesn't open, naming it and nothing of its value: a Worker is
 * never deployed without a secret staff set for it.
 */
export const sealedWorkerSecrets = async (
  db: AdminDatabase,
  clientKey: string,
  clientId: string,
  app: string
): Promise<Map<string, string>> => {
  const names = sealedSecretsByApp[app] ?? [];
  if (names.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      name: clientSealedSecrets.name,
      sealed: clientSealedSecrets.sealed,
    })
    .from(clientSealedSecrets)
    .where(
      and(
        eq(clientSealedSecrets.clientId, clientId),
        inArray(clientSealedSecrets.name, [...names])
      )
    );
  const values = new Map<string, string>();
  for (const { name, sealed } of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one or two per Worker
    const value = await openSecret(clientKey, clientId, name, sealed);
    if (value === null) {
      throw new DeployError(
        "sealed_secret_unreadable",
        `${clientId}'s ${name} doesn't open: set it again`
      );
    }
    values.set(name, value);
  }
  return values;
};
