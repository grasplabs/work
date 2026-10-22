import { errorFields, log } from "@grasp-os/shared/log";
import { z } from "zod";

import type { OutgoingMail, SendOutcome } from "./mail.ts";

// Mail a Durable Object means to send, exactly once each: queued in its
// SQLite (a `mail_outbox` table) by a key of its own, in the same
// transaction as what it is about, and sent from there by `deliverMail`,
// which the object runs right after and from its alarm. Its audit outbox
// works the same way (audit-outbox.ts). What it guards against:
//
// - A mail going twice: a key is queued once, and queuing it again sends
//   nothing; a mail is claimed for `claimMs` before it is sent, so a second
//   delivery running at once passes it by. Only a delivery cut off between
//   Email Sending's answer and the row's update can send one again, once
//   the claim runs out.
// - A quota or a passing failure losing it: tried again with a backoff,
//   `mailAttemptsMax` times over a day, then ended failed.
// - A mail that can never go (a suppressed recipient, a sender not
//   verified, no sender at all) retried for nothing: ended failed at once,
//   with the reason, for the object to log and staff to send again.
// - A link's secret kept or logged: a mail that carries one holds a slot,
//   `{{link}}`, filled in by the object as it is sent (`fill`). Logs name a
//   mail by its key, which never holds a secret, and its reason, never its
//   recipient or words.

/** How long a delivery holds a mail it is sending: others leave it alone. */
const claimMs = 10 * 60 * 1000;

/** How long before a mail is tried again: first, and at most. */
const retryMs = { first: 5 * 60 * 1000, most: 4 * 60 * 60 * 1000 };

/** Tries before a mail ends failed: over a day, a daily quota's reset. */
export const mailAttemptsMax = 12;

/** Most mails one delivery sends; the next delivery sends the rest. */
const deliveryMax = 50;

/** A mail as queued: its words, with slots for what `fill` gives. */
export const queuedMailSchema = z.strictObject({
  subject: z.string(),
  text: z.string(),
  html: z.string(),
  replyTo: z.string().optional(),
  unsubscribe: z.string().optional(),
  language: z.string().optional(),
});
export type QueuedMail = z.infer<typeof queuedMailSchema>;

/** One mail to queue. */
export interface MailToQueue {
  /** Its key: the same key is sent once. Never a secret: logs name it. */
  key: string;
  to: string;
  /** Whom it is about, by person, for the object's log. */
  about: string | null;
  /** What `fill` fills its slots from as it is sent, or null for none. */
  fill: string | null;
  mail: QueuedMail;
}

/** What became of a mail, as the object tells it. */
export interface MailState {
  key: string;
  about: string | null;
  state: "queued" | "sent" | "failed";
  attempts: number;
  /** Why its last try didn't send it. */
  reason: string | null;
  queuedAt: string;
  settledAt: string | null;
}

/** A mail as its row holds it. */
interface MailRow {
  key: string;
  about: string | null;
  to: string;
  mail: string;
  fill: string | null;
  attempts: number;
}

/** What one delivery needs from the object it runs in. */
export interface Delivery {
  send: (mail: OutgoingMail) => Promise<SendOutcome>;
  /**
   * The values of a mail's slots, by name, from its `fill`; null when it
   * can't be filled any more (whose link it was has none now): it ends
   * failed.
   */
  fill: (fill: string) => Promise<Record<string, string> | null>;
  /** Called once a mail is sent or ended failed, to log it. */
  settled: (mail: MailState) => void;
  now: number;
}

/** Queues a mail, unless its key is queued already: true when it is new. */
export const queueMail = (
  storage: SqlStorage,
  { key, to, about, fill, mail }: MailToQueue,
  now: number = Date.now()
): boolean =>
  storage
    .exec(
      "INSERT INTO mail_outbox (key, about, to_address, mail, fill, state, attempts, next_at, queued_at) VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT (key) DO NOTHING RETURNING key",
      key,
      about,
      to,
      JSON.stringify(mail),
      fill,
      now,
      new Date(now).toISOString()
    )
    .toArray().length > 0;

const stateColumns =
  "key, about, state, attempts, reason, queued_at AS queuedAt, settled_at AS settledAt";

/** A column's text, or null for none. */
const textOf = (value: SqlStorageValue): string | null =>
  typeof value === "string" ? value : null;

/** A row's state, as read with `stateColumns`. */
const stateOf = (row: Record<keyof MailState, SqlStorageValue>): MailState => {
  const state = textOf(row.state);
  return {
    key: textOf(row.key) ?? "",
    about: textOf(row.about),
    state: state === "sent" || state === "failed" ? state : "queued",
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    reason: textOf(row.reason),
    queuedAt: textOf(row.queuedAt) ?? "",
    settledAt: textOf(row.settledAt),
  };
};

/** What became of the mail `key`; null for none queued. */
export const mailState = (storage: SqlStorage, key: string): MailState | null =>
  storage
    .exec<Record<keyof MailState, SqlStorageValue>>(
      `SELECT ${stateColumns} FROM mail_outbox WHERE key = ?`,
      key
    )
    .toArray()
    .map(stateOf)[0] ?? null;

/** The mails about `about`, the newest first. */
export const mailAbout = (storage: SqlStorage, about: string): MailState[] =>
  storage
    .exec<Record<keyof MailState, SqlStorageValue>>(
      `SELECT ${stateColumns} FROM mail_outbox WHERE about = ? ORDER BY rowid DESC`,
      about
    )
    .toArray()
    .map(stateOf);

/**
 * Queues the failed mail `key` again, from its first try: true when there
 * was one. A mail queued or sent stays as it is.
 */
export const queueAgain = (
  storage: SqlStorage,
  key: string,
  now: number = Date.now()
): boolean =>
  storage
    .exec(
      "UPDATE mail_outbox SET state = 'queued', attempts = 0, next_at = ?, settled_at = NULL, reason = NULL WHERE key = ? AND state = 'failed' RETURNING key",
      now,
      key
    )
    .toArray().length > 0;

/**
 * Drops the mail about `about` still queued: for someone who left, whom
 * it would no longer be right to write to. Sent and failed mail stays.
 */
export const dropMailAbout = (storage: SqlStorage, about: string): void => {
  storage.exec(
    "DELETE FROM mail_outbox WHERE about = ? AND state = 'queued'",
    about
  );
};

/** When the next queued mail is due (ms), or null for none. */
export const nextMailAt = (storage: SqlStorage): number | null => {
  const [row] = storage
    .exec<{ at: number | null }>(
      "SELECT min(next_at) AS at FROM mail_outbox WHERE state = 'queued'"
    )
    .toArray();
  return row?.at ?? null;
};

const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** `text`, safe in HTML text and in a quoted attribute. */
export const escapeHtml = (text: string): string =>
  text.replaceAll(/[&<>"']/gu, (char) => htmlEscapes[char] ?? char);

/** `text` with each `{{name}}` slot filled in: escaped, for HTML. */
const filled = (
  text: string,
  values: Record<string, string>,
  html: boolean
): string => {
  let out = text;
  for (const [name, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${name}}}`, html ? escapeHtml(value) : value);
  }
  return out;
};

/** How long before try `attempts + 1`: doubling from `retryMs.first`. */
const backoffMs = (attempts: number): number =>
  Math.min(retryMs.first * 2 ** Math.max(attempts - 1, 0), retryMs.most);

/** Settles a mail: sent, ended failed, or due again later. */
const settle = (
  storage: SqlStorage,
  row: MailRow,
  sent: SendOutcome,
  { now, settled }: Pick<Delivery, "now" | "settled">
): void => {
  const { attempts } = row;
  const at = new Date(now).toISOString();
  if (sent.outcome === "retry" && attempts < mailAttemptsMax) {
    const nextAt = now + backoffMs(attempts);
    storage.exec(
      "UPDATE mail_outbox SET next_at = ?, reason = ? WHERE key = ?",
      nextAt,
      sent.reason,
      row.key
    );
    log.warn("mail.retry", {
      key: row.key,
      reason: sent.reason,
      attempts,
      nextAt: new Date(nextAt).toISOString(),
    });
    return;
  }
  if (sent.outcome === "sent") {
    storage.exec(
      "UPDATE mail_outbox SET state = 'sent', settled_at = ?, reason = NULL, message_id = ? WHERE key = ?",
      at,
      sent.messageId,
      row.key
    );
    log.info("mail.sent", { key: row.key, attempts });
  } else {
    storage.exec(
      "UPDATE mail_outbox SET state = 'failed', settled_at = ?, reason = ? WHERE key = ?",
      at,
      sent.reason,
      row.key
    );
    log.error("mail.failed", { key: row.key, reason: sent.reason, attempts });
  }
  const state = mailState(storage, row.key);
  if (state !== null) {
    settled(state);
  }
};

/** Sends one claimed mail, and what became of it. */
const sendOne = async (
  row: MailRow,
  { send, fill }: Pick<Delivery, "send" | "fill">
): Promise<SendOutcome> => {
  let stored: unknown;
  try {
    stored = JSON.parse(row.mail);
  } catch {
    stored = undefined;
  }
  const parsed = queuedMailSchema.safeParse(stored);
  if (!parsed.success) {
    return { outcome: "failed", reason: "mail.unreadable" };
  }
  let values: Record<string, string> | null = {};
  try {
    values = row.fill === null ? {} : await fill(row.fill);
  } catch (error) {
    log.error("mail.fill_failed", { key: row.key, ...errorFields(error) });
    return { outcome: "retry", reason: "mail.fill_failed" };
  }
  if (values === null) {
    return { outcome: "failed", reason: "mail.unfilled" };
  }
  const mail = parsed.data;
  return await send({
    ...mail,
    to: row.to,
    subject: filled(mail.subject, values, false),
    text: filled(mail.text, values, false),
    html: filled(mail.html, values, true),
  });
};

/**
 * Sends every queued mail due by `now`, at most `deliveryMax`, one after
 * another, each claimed first, and settles each. Returns when the next
 * queued mail is due, for the object's alarm; null for none.
 */
export const deliverMail = async (
  storage: SqlStorage,
  delivery: Delivery
): Promise<number | null> => {
  const { now } = delivery;
  const due = storage
    .exec<{ key: string }>(
      "SELECT key FROM mail_outbox WHERE state = 'queued' AND next_at <= ? ORDER BY next_at, rowid LIMIT ?",
      now,
      deliveryMax
    )
    .toArray()
    .map(({ key }) => key);
  for (const key of due) {
    // Claimed before it is sent: a delivery running meanwhile, or one
    // after this one is cut off, leaves it until the claim runs out.
    const [claimed] = storage
      .exec<MailRow & Record<string, SqlStorageValue>>(
        "UPDATE mail_outbox SET attempts = attempts + 1, next_at = ? WHERE key = ? AND state = 'queued' AND next_at <= ? RETURNING key, about, to_address AS 'to', mail, fill, attempts",
        now + claimMs,
        key,
        now
      )
      .toArray();
    if (claimed === undefined) {
      continue;
    }
    // One at a time: a burst would only run into the quota sooner.
    // oxlint-disable-next-line no-await-in-loop
    const sent = await sendOne(claimed, delivery);
    settle(storage, claimed, sent, delivery);
  }
  return nextMailAt(storage);
};
