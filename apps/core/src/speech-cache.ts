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
//
// Every way a line was said sits under one folder named by its words
// alone (`linePrefixOf`): erasing a line (an interview deleted, a purge)
// takes the whole folder, whatever voice, model, tone or language it was
// said in, so no change of speech provider or settings can leave a copy
// behind. A line kept the way it was before this layout (one flat object,
// keyed with its model and voice) can't be found by its words: the sweep
// takes every such object out at once, whatever its age.

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
  /** The line's own words, without its direction: its folder. */
  text: string;
  /** The line as sent to the voice, its direction among it. */
  spoken: string;
  voice: string;
  model: string;
  language: string;
}

/** The folder every way of saying the line `text` is kept in. */
const linePrefixOf = async (text: string): Promise<string> =>
  `${prefix}${await sha256Hex(text)}/`;

const keyOf = async ({
  text,
  spoken,
  voice,
  model,
  language,
}: SpokenKey): Promise<string> =>
  `${await linePrefixOf(text)}${await sha256Hex(JSON.stringify([model, voice, language, spoken]))}.json`;

/** Whether `key` is kept the way lines were before their folders: flat. */
const isFlat = (key: string): boolean =>
  !key.slice(prefix.length).includes("/");

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

/** Most keys one delete of the bucket takes. */
const deleteBatch = 1000;

/**
 * What erasing the lines `texts` takes out of the cache: each one's
 * folder, by a hash of its words, never the words themselves, so they can
 * wait to be taken out without keeping what was said.
 */
export const storedKeysOf = async (
  texts: readonly string[]
): Promise<string[]> => [
  ...new Set(await Promise.all(texts.map(linePrefixOf))),
];

/** Every object kept in the folder `folder`, a page at a time. */
const keptIn = async (
  env: Pick<Env, "FILES">,
  folder: string
): Promise<string[]> => {
  const keys: string[] = [];
  let cursor: string | undefined = undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page of the folder at a time
    const listed: R2Objects = await env.FILES.list({
      prefix: folder,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...listed.objects.map(({ key }) => key));
    if (!listed.truncated) {
      return keys;
    }
    ({ cursor } = listed);
  }
};

/**
 * Deletes what `stored` names (`storedKeysOf`), whether or not any is
 * kept: each folder with every way its line was said, and any single key
 * queued before lines had folders. What was said from someone's
 * interview, once it is deleted.
 */
export const forgetStored = async (
  env: Pick<Env, "FILES">,
  stored: readonly string[]
): Promise<void> => {
  const keys: string[] = [];
  for (const each of stored) {
    if (each.endsWith("/")) {
      // oxlint-disable-next-line no-await-in-loop -- one folder at a time
      keys.push(...(await keptIn(env, each)));
    } else {
      keys.push(each);
    }
  }
  for (let at = 0; at < keys.length; at += deleteBatch) {
    // oxlint-disable-next-line no-await-in-loop -- one page of keys at a time
    await env.FILES.delete(keys.slice(at, at + deleteBatch));
  }
};

/**
 * Deletes every way the lines `texts` were kept, whether or not any is:
 * what was said from someone's interview, once it is deleted.
 */
export const forgetLines = async (
  env: Pick<Env, "FILES">,
  texts: readonly string[]
): Promise<void> => {
  await forgetStored(env, await storedKeysOf(texts));
};

/**
 * Deletes lines kept longer than a month, and any kept flat, from the
 * clock: in code, not a bucket rule, so it runs wherever core does. One page of the prefix a
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
  // Kept the flat way before lines had folders, too: no erasure can find
  // such a line by its words, so none waits out its month.
  const old = listed.objects
    .filter(
      ({ key, uploaded }) =>
        isFlat(key) || now.getTime() - uploaded.getTime() > spokenKeepMs
    )
    .map(({ key }) => key);
  if (old.length > 0) {
    await env.FILES.delete(old);
  }
  await (listed.truncated
    ? env.FILES.put(sweepKey, JSON.stringify({ cursor: listed.cursor }))
    : env.FILES.delete(sweepKey));
};
