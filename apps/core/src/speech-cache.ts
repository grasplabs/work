import { sha256Hex } from "@grasp-os/shared/encoding";
import { z } from "zod";

import { jsonOf } from "./request-body.ts";

// Lines said before, kept in the deployment's file bucket (`FILES`), so a
// line said again costs nothing: walking back and forth through the
// onboarding, or a sample everyone hears, is said once. Kept by everything
// that changes how it sounds: its words as sent (its direction among
// them), the voice, the voice model and the language. In R2, not the Cache
// API: R2 is what core already keeps files in, and the on-prem profile has
// it too (on-prem/r2.ts), where plain workerd has no cache behind
// `caches.default`.

/** How long a line is kept: a month, as the prototype kept it. */
export const spokenKeepMs = 30 * 24 * 60 * 60 * 1000;

const prefix = "spoken-lines/";

/** Where the sweep left off (`sweepSpokenLines`). */
const sweepKey = "spoken-lines-sweep.json";

/** Most lines the sweep looks at in one run. */
const sweepBatch = 500;

const sweepSchema = z.object({ cursor: z.string().min(1) });

/** What a line is kept by: everything that changes how it sounds. */
export interface SpokenKey {
  /** The line as sent to the voice, its direction among it. */
  spoken: string;
  voice: string;
  model: string;
  language: string;
}

const keyOf = async ({
  spoken,
  voice,
  model,
  language,
}: SpokenKey): Promise<string> =>
  `${prefix}${await sha256Hex(JSON.stringify([model, voice, language, spoken]))}.json`;

/** A line kept within the month, as it was answered; `undefined` when none is. */
export const keptLine = async (
  env: Pick<Env, "FILES">,
  key: SpokenKey,
  now: number = Date.now()
): Promise<string | undefined> => {
  const kept = await env.FILES.get(await keyOf(key));
  if (kept === null) {
    return undefined;
  }
  if (now - kept.uploaded.getTime() > spokenKeepMs) {
    await kept.body.cancel();
    return undefined;
  }
  return await kept.text();
};

/** Keeps a line as it was answered, for a month from now. */
export const keepLine = async (
  env: Pick<Env, "FILES">,
  key: SpokenKey,
  answer: string
): Promise<void> => {
  await env.FILES.put(await keyOf(key), answer, {
    httpMetadata: { contentType: "application/json" },
  });
};

/**
 * Deletes lines kept longer than a month, from the cron: in code, not a
 * bucket rule, so it runs wherever core does. One page of the prefix a
 * run, from where the last run stopped. A line said again after it was
 * kept a month is said anew and kept again, so nothing is ever older.
 */
export const sweepSpokenLines = async (
  env: Pick<Env, "FILES">,
  now: Date
): Promise<void> => {
  const stored = await env.FILES.get(sweepKey);
  const parsed = sweepSchema.safeParse(
    stored === null ? undefined : jsonOf(await stored.text())
  );
  const listed = await env.FILES.list({
    prefix,
    limit: sweepBatch,
    ...(parsed.success ? { cursor: parsed.data.cursor } : {}),
  });
  const old = listed.objects
    .filter(({ uploaded }) => now.getTime() - uploaded.getTime() > spokenKeepMs)
    .map(({ key }) => key);
  if (old.length > 0) {
    await env.FILES.delete(old);
  }
  await (listed.truncated
    ? env.FILES.put(sweepKey, JSON.stringify({ cursor: listed.cursor }))
    : env.FILES.delete(sweepKey));
};
