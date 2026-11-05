import { log } from "@grasp-os/shared/log";
import type { Email } from "postal-mime";

// What of the mail an email trigger received (inbound-email.ts) waits in
// R2 (`FILES`, in the EU): an attachment a delivery's start copies into
// its run (`stagedAttachmentKey`), under the UTC day it was staged. Only
// its day's name says when it goes: the 15-minute clock deletes a day's
// objects once 30 days have passed since that day ended
// (`deleteExpiredEmail`), so a copy its start never deleted is gone 30 to
// 31 days on.

/** Where staged attachments are, in `FILES`: by day, then trigger. */
const keptPrefix = "inbound-email/";

/** How many days a staged attachment is kept, at least (see above). */
const emailRetentionDays = 30;

const dayMs = 24 * 60 * 60 * 1000;

/** The UTC day of `time`, as `2026-09-29`. */
const dayOf = (time: Date): string => time.toISOString().slice(0, 10);

/** The first day whose messages are still kept at `now`. */
const firstKeptDay = (now: Date): string =>
  dayOf(new Date(now.getTime() - emailRetentionDays * dayMs));

/**
 * Where attachment `index` of message `id`, to email trigger `triggerId`,
 * waits while one delivery's start copies it into the run
 * (inbound-email.ts): a key of that delivery's own, so another delivery
 * of the message deleting its copy never takes this one; under today's
 * day, so a copy its start never deleted goes with that day's kept
 * messages (`deleteExpiredEmail`).
 */
export const stagedAttachmentKey = (
  triggerId: string,
  id: string,
  index: number
): string =>
  `${keptPrefix}${dayOf(new Date())}/triggers/${triggerId}/${id}/${String(index)}-${crypto.randomUUID()}`;

/** The most kept messages one clock run deletes: one R2 list and delete. */
const maxDeletedPerRun = 1000;

/** postal-mime, loaded at the first message, not as core starts (GRA-1349). */
export const postalMime = async () => await import("postal-mime");

/** `raw` parsed, or undefined for a message that doesn't parse. */
export const parsedOf = async (raw: Uint8Array): Promise<Email | undefined> => {
  const { default: PostalMime } = await postalMime();
  try {
    return await PostalMime.parse(raw);
  } catch {
    return undefined;
  }
};

/**
 * Deletes kept messages once their days are over: up to
 * `maxDeletedPerRun` of the oldest day's at `now`, so a day of any size is
 * gone within a few runs, and days missed (an outage) one after another.
 * R2 lists a day only while it holds a message.
 */
export const deleteExpiredEmail = async (
  env: Env,
  now: Date
): Promise<void> => {
  const { delimitedPrefixes } = await env.FILES.list({
    prefix: keptPrefix,
    delimiter: "/",
  });
  const firstKept = `${keptPrefix}${firstKeptDay(now)}/`;
  const [oldest] = delimitedPrefixes.toSorted();
  if (oldest === undefined || oldest >= firstKept) {
    return;
  }
  const { objects } = await env.FILES.list({
    prefix: oldest,
    limit: maxDeletedPerRun,
  });
  if (objects.length === 0) {
    return;
  }
  await env.FILES.delete(objects.map(({ key }) => key));
  log.info("workflow.email_deleted", {
    day: oldest.slice(keptPrefix.length, -1),
    messages: objects.length,
  });
};
