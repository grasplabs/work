import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { inJurisdiction } from "../src/durable-objects.ts";

/** How long the store gives an add to write its file, as its files.ts does. */
const fileGraceMs = 15 * 60 * 1000;

/** The record of a person's own store's erasure, as the store writes it. */
const erasureRecordSchema = z.object({ reason: z.string(), at: z.number() });

/** The SHA-256 of `text`, in hex. */
const sha256 = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Ages the record of `personId`'s own store's erasure past the time an add
 * under way has to write its file (`fileGraceMs`), as time
 * passing would: until then, erasing the store again answers that it is
 * still deleting. Nothing when there is no record.
 */
export const ageOwnErasure = async (personId: string): Promise<void> => {
  const key = `people/${await sha256(personId)}/erased`;
  const record = await env.BRAIN_OBJECTS.get(key);
  if (record === null) {
    return;
  }
  const { reason, at } = erasureRecordSchema.parse(
    JSON.parse(await record.text())
  );
  await env.BRAIN_OBJECTS.put(
    key,
    JSON.stringify({ reason, at: at - fileGraceMs - 1 })
  );
};

/**
 * Kills `personId`'s own store, as a crash or a restart would: its next
 * call starts it afresh. The kill's own error is the test's, dropped.
 */
const killOwnStore = async (personId: string): Promise<void> => {
  try {
    await runInDurableObject(
      inJurisdiction(env, env.BRAIN_STORE).getByName(`person:${personId}`),
      (_instance, state) => {
        state.abort("Killed by the test");
      }
    );
  } catch {
    // The kill ends the call it was made in.
  }
};

/**
 * Makes `personId`'s own store fail every call, as one whose erasure
 * ledger can't be read does: a ledger key no release writes, read as it
 * starts again. `heal` takes it away and starts the store again.
 */
export const breakOwnStore = async (
  personId: string
): Promise<{ heal: () => Promise<void> }> => {
  const key = `people/${await sha256(personId)}/erasures/000000000000001-source-archived-${await sha256(crypto.randomUUID())}`;
  await env.BRAIN_OBJECTS.put(key, "");
  await killOwnStore(personId);
  return {
    heal: async () => {
      await env.BRAIN_OBJECTS.delete(key);
      await killOwnStore(personId);
    },
  };
};
