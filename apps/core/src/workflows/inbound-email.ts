import { sha256Hex, toHex } from "@grasp-os/shared/encoding";
import { readAtMost } from "@grasp-os/shared/http";
import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  inboundEmailMaxBytes as maxMessageBytes,
  inboundEmailMaxListed as maxListed,
} from "@grasp-os/shared/workflows";
import type { InboundEmail } from "@grasp-os/shared/workflows";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Address, Email } from "postal-mime";

import { keepAuditEvent } from "../audit-outbox.ts";
import { apps, workflowTriggers } from "../db/core/schema.ts";
import { isWorthKeeping, keepMessage, parsedOf } from "./kept-email.ts";
import { deliveryRoom, jsonBytes, maxInputBytes, startRun } from "./runs.ts";

// Mail to workflows' email triggers (trigger-registry.ts). Email Routing
// sends every message for the deployment's mail domain to core's email
// handler, which routes it by the part of its envelope recipient before
// the `@`: to the workflows of Apps' current versions that receive mail
// there. The address is looked up first, so mail nobody receives is never
// read: mail to an address nobody receives at bounces (a permanent
// failure). Only then is the message read and parsed: one too large, or
// that doesn't parse, bounces.
//
// A run gets the message parsed (`InboundEmail`), bounded to fit a run's
// input: at most 100 each of To and Cc, names, subject and file names
// cut, attachments listed (never their content), and as much plain text
// as fits (a message with only HTML, its text). Its `id` is the SHA-256
// of its bytes.
//
// A message with an attachment that isn't inline is kept for its runs to
// read its attachments (kept-email.ts); its input names it (`stored`), or says `stored: null`. It is kept only
// for the Apps it may start a run of: one delivered again, whose runs
// started, is not kept again, whatever its bytes are this time.
//
// The same message delivered again starts no second run: its key, per
// App and workflow, is the SHA-256 of its Message-ID, or of its bytes
// when it has none, or one without an `@` (such as `<>`). A redelivery
// keeps its Message-ID but can differ in its bytes (new Received or ARC
// headers), so the Message-ID is what makes it the same. Its sender
// writes the Message-ID, though: a message that reuses another's, sent
// first, keeps that one from starting a run.
//
// Mail starts at most `triggeredRunsPerHour` runs of a workflow an hour
// (runs.ts). A
// message goes to each receiving workflow with room; if one is at its
// limit, the delivery fails for now once the others started, so its
// sender tries again later, and only the workflows that didn't start it
// start it then.
//
// Anyone can send mail, and its headers say what its sender wrote: the
// message is untrusted data for the run, its From address included. A
// start that fails fails the delivery, so the sending server can try
// again, starting only what didn't start.
//
// Mail loops. A run can send mail (through a connection), and mail can
// start a run: a workflow that mails its own App's address, or two that
// mail each other, or an auto-reply answering a run's mail, would start
// runs without end, each a new run lineage with quotas of its own. So a
// message that says it was sent automatically (`Auto-Submitted` other
// than `no`, RFC 3834), or that comes from the deployment's own mail
// domain (its From or its envelope sender), starts nothing: it is
// accepted and dropped, never bounced, as a bounce is mail that can loop
// too, and the refusal is audited (`workflow.email.refused`). The mail
// domain is the recipient's own, as Email Routing hands the message over:
// every message here was sent to the deployment's domain, so it needs no
// setting of its own, and can't be set wrong. A message from a person's
// mailbox at the client's own domain still starts runs: people forward
// mail to their workflows. Which runs a run's own mail starts, as its
// descendants, is for a later change (GRA-273's follow-up).

/** Longest subject a run's input keeps, in characters. */
const maxSubjectLength = 1000;

/** Longest name, address, file name or type a run's input keeps. */
const maxFieldLength = 256;

const cut = (text: string, max = maxFieldLength): string => text.slice(0, max);

/** At most `maxListed` mailboxes of `addresses`, a group's members included. */
const mailboxes = (addresses: readonly Address[] | undefined) =>
  (addresses ?? [])
    .flatMap((address) =>
      address.address === undefined
        ? address.group.map(({ name, address: of }) => ({ name, address: of }))
        : [{ name: address.name, address: address.address }]
    )
    .slice(0, maxListed)
    .map(({ name, address }) => ({ name: cut(name), address: cut(address) }));

/** The byte length of an attachment's content. */
const sizeOf = (content: ArrayBuffer | Uint8Array | string): number =>
  typeof content === "string"
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;

/**
 * How many bytes `input` is over a run's input, as UTF-8 JSON; 0 or less
 * fits.
 */
const overBy = (input: InboundEmail): number =>
  jsonBytes(input) - maxInputBytes;

/** Whether `code` is the first half of a character UTF-16 splits in two. */
const isHighSurrogate = (code: number): boolean =>
  code >= 0xd8_00 && code <= 0xdb_ff;

/**
 * The first `length` code units of `text`, less the first half of a
 * character split at the end, so no half is left on its own: JSON would
 * escape it, and it isn't text.
 */
const cutWhole = (text: string, length: number): string => {
  const head = text.slice(0, Math.max(0, length));
  return isHighSurrogate(head.codePointAt(head.length - 1) ?? 0)
    ? head.slice(0, -1)
    : head;
};

/**
 * The longest start of `input`'s text, cut on a character's edge, with
 * which it fits a run's input; none if not even no text does. Found by
 * halving: a longer start never takes fewer bytes, and how many bytes a
 * character takes as JSON (one to six) can't be told from its length.
 */
const fittingText = (input: InboundEmail): string => {
  let fits = 0;
  let over = input.text.length;
  while (fits < over) {
    const length = Math.ceil((fits + over) / 2);
    if (overBy({ ...input, text: cutWhole(input.text, length) }) <= 0) {
      fits = length;
    } else {
      over = length - 1;
    }
  }
  return cutWhole(input.text, fits);
};

/**
 * `input` made to fit a run's input: its text cut first, to the longest
 * start that fits (`fittingText`), then, should the rest still not fit,
 * Cc, To and attachments dropped from the end, in that order.
 */
const fitted = (input: InboundEmail): InboundEmail => {
  if (overBy(input) <= 0) {
    return input;
  }
  const text = fittingText(input);
  const cutText = {
    ...input,
    text,
    truncated: text.length < input.text.length,
  };
  const lists = ["cc", "to", "attachments"] as const;
  const fitting = { ...cutText, cc: [...cutText.cc], to: [...cutText.to] };
  const attachments = [...cutText.attachments];
  const current = (): InboundEmail => ({ ...fitting, attachments });
  for (const list of lists) {
    const items = list === "attachments" ? attachments : fitting[list];
    while (overBy(current()) > 0 && items.length > 0) {
      items.pop();
    }
  }
  if (overBy(current()) > 0) {
    throw new Error("A message's input doesn't fit with nothing left to cut");
  }
  return current();
};

/**
 * The most of a message's HTML read for its text, in characters: more
 * than a run's input could hold of what's left once the tags are gone, as
 * each character takes at least a byte.
 */
const maxHtmlLength = 4 * maxInputBytes;

/** Tags whose content isn't text. */
const skippedTags = new Set(["script", "style"]);

/** Tags whose end ends a line of text (`<br>` at its start). */
const lineEndTags = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4"]);

const tagStart = /^(?:[!?]|\/?[a-z])/u;
const tagName = /^\/?(?<name>[a-z][a-z0-9]*)/u;
const entities = /&(?<name>amp|lt|gt|quot|#39|nbsp);/gu;
const entityText: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

/**
 * The plain text of a message that has only HTML, of at most
 * `maxHtmlLength` of it: its tags dropped (a line end where a paragraph,
 * line or item ends), scripts and styles with their content, and the
 * common entities decoded. A `<` that starts no tag is text, and so is
 * the rest after a tag that never closes; only a script or style that
 * never ends ends the text. One pass, each character looked at a bounded
 * number of times, whatever the HTML.
 */
const textOfHtml = (full: string): string => {
  const html = full.slice(0, maxHtmlLength);
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) {
      parts.push(html.slice(at));
      break;
    }
    parts.push(html.slice(at, open));
    // A tag starts with a name (`<p`, `</p`), or is a comment or
    // declaration (`<!`, `<?`); any other `<`, as in `5 < 10`, is text.
    const head = lower.slice(open + 1, open + 16);
    if (!tagStart.test(head)) {
      parts.push("<");
      at = open + 1;
      continue;
    }
    const name = tagName.exec(head)?.groups?.name ?? "";
    const close = html.indexOf(">", open);
    if (close === -1) {
      // No `>` in the rest: no tag in it either. It's text, but for a
      // script or style that never starts its content.
      if (!skippedTags.has(name)) {
        parts.push(html.slice(open));
      }
      break;
    }
    const ending = lower[open + 1] === "/";
    at = close + 1;
    if (!ending && skippedTags.has(name)) {
      const end = lower.indexOf(`</${name}`, at);
      const endClose = end === -1 ? -1 : html.indexOf(">", end);
      if (endClose === -1) {
        break;
      }
      at = endClose + 1;
    } else if (ending ? lineEndTags.has(name) : name === "br") {
      parts.push("\n");
    }
  }
  return parts
    .join("")
    .replaceAll(entities, (_, name: string) => entityText[name] ?? "")
    .trim();
};

/** A parsed message as its run's input. */
const inputOf = (
  id: string,
  stored: string | null,
  envelopeFrom: string,
  parsed: Email
): InboundEmail => {
  const [from] = mailboxes(parsed.from === undefined ? [] : [parsed.from]);
  const date = parsed.date === undefined ? null : new Date(parsed.date);
  return fitted({
    id,
    stored,
    from: from ?? { name: "", address: cut(envelopeFrom) },
    to: mailboxes(parsed.to),
    cc: mailboxes(parsed.cc),
    subject: cut(parsed.subject ?? "", maxSubjectLength),
    date:
      date === null || Number.isNaN(date.getTime()) ? null : date.toISOString(),
    text: parsed.text ?? textOfHtml(parsed.html ?? ""),
    truncated: false,
    attachments: parsed.attachments
      .slice(0, maxListed)
      .map(({ filename, mimeType, content }) => ({
        filename: filename === null ? null : cut(filename),
        mimeType: cut(mimeType),
        size: sizeOf(content),
      })),
  });
};

/**
 * The workflows of Apps' current versions with an email trigger at
 * `address`, each once however many of its triggers are there: a message
 * starts a workflow's run once, and two starts of it at once would find
 * each other's run still starting.
 */
const receiversAt = async (env: Env, address: string) =>
  await drizzle(env.DB)
    .selectDistinct({
      appId: workflowTriggers.appId,
      version: workflowTriggers.version,
      workflowId: workflowTriggers.workflowId,
    })
    .from(workflowTriggers)
    .innerJoin(
      apps,
      and(
        eq(apps.id, workflowTriggers.appId),
        eq(apps.currentVersion, workflowTriggers.version)
      )
    )
    .where(
      and(
        eq(workflowTriggers.type, "email"),
        eq(workflowTriggers.address, address)
      )
    );

/** Why a message may loop, and so starts nothing (see above). */
type LoopReason = "auto_submitted" | "own_domain";

/** The domain of `address`, lower case; none without an `@`. */
const domainOf = (address: string | undefined): string | undefined => {
  const at = address?.lastIndexOf("@") ?? -1;
  return address === undefined || at < 0
    ? undefined
    : address.slice(at + 1).toLowerCase();
};

/**
 * Why `parsed`, sent to `to` by the envelope sender `from`, may be part of
 * a mail loop: it says it was sent automatically (an `Auto-Submitted`
 * header whose value isn't `no`), or it comes from the recipient's own
 * domain, the deployment's. None for mail a person sent from elsewhere.
 */
const loopOf = (
  to: string,
  from: string,
  parsed: Email
): LoopReason | undefined => {
  const submitted = parsed.headers.find(
    ({ key }) => key.toLowerCase() === "auto-submitted"
  );
  const kind = submitted?.value.split(";", 1)[0]?.trim().toLowerCase();
  if (kind !== undefined && kind !== "no") {
    return "auto_submitted";
  }
  const own = domainOf(to);
  const senders = [from, parsed.from?.address];
  return own !== undefined && senders.some((sender) => domainOf(sender) === own)
    ? "own_domain"
    : undefined;
};

/**
 * Takes a message Email Routing delivers: starts a run of each workflow
 * that receives mail at its recipient's address, with the message as
 * input, bounces it, or fails it for now. A message that may loop
 * (`loopOf`) is dropped, and its refusal audited.
 */
export const receiveEmail = async (
  message: ForwardableEmailMessage,
  env: Env
): Promise<void> => {
  // Who receives it first, one query: mail nobody receives is never read.
  const at = message.to.lastIndexOf("@");
  const address = message.to.slice(0, Math.max(at, 0)).toLowerCase();
  const receivers = address === "" ? [] : await receiversAt(env, address);
  if (receivers.length === 0) {
    message.setReject("No such address.");
    return;
  }
  const raw = await readAtMost(message.raw, maxMessageBytes);
  if (raw === undefined) {
    message.setReject("The message is too large.");
    return;
  }
  const parsed = await parsedOf(raw);
  if (parsed === undefined) {
    message.setReject("The message can't be read.");
    return;
  }
  const id = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
  const loop = loopOf(message.to, message.from, parsed);
  if (loop !== undefined) {
    // Once for each App it would have started a run of. Identifiers only:
    // the address it was sent to, why, and the hash of its bytes; never
    // who sent it or what it says.
    const db = drizzle(env.DB);
    await Promise.all(
      [...new Set(receivers.map(({ appId }) => appId))].map(async (appId) => {
        await keepAuditEvent(env, db, {
          actor: { type: "system" },
          action: "workflow.email.refused",
          target: { type: "app", id: appId },
          detail: { address, reason: loop, message: id },
        });
      })
    );
    return;
  }
  // Only a Message-ID with an `@` names one message: `<>` or `x` would
  // make every message that carries it the same one.
  const { messageId } = parsed;
  const same =
    messageId !== undefined && messageId.includes("@")
      ? await sha256Hex(messageId)
      : id;
  // By workflow, not by trigger row: the rows are written anew each time
  // a version is made current.
  const keyOf = ({
    appId,
    workflowId,
  }: {
    appId: string;
    workflowId: string;
  }) => `email:${appId}:${workflowId}:${same}`;
  // Each workflow's limit is its own: the message goes to those with room
  // now or its run already, and the others get it when the sender tries
  // again.
  const rooms = await Promise.all(
    receivers.map(
      async (receiver) =>
        await deliveryRoom(
          env,
          receiver.appId,
          receiver.workflowId,
          keyOf(receiver),
          "email"
        )
    )
  );
  const withRoom = receivers.filter((_, index) => rooms[index] !== "capped");
  // Kept before any run starts, so each finds it, and only for the Apps
  // it may start a run of now: a workflow that has its run already, past
  // `starting`, runs on the delivery that started it, which kept its own.
  // So mail sent again under one Message-ID with other bytes each time
  // keeps nothing more, and what is kept stays within the hourly limit.
  // Failing to keep it fails the delivery for now: its sender tries again.
  const stored = isWorthKeeping(parsed.attachments)
    ? await keepMessage(
        env,
        receivers
          .filter((_, index) => rooms[index] === "new")
          .map(({ appId }) => appId),
        id,
        raw
      )
    : null;
  const input = inputOf(id, stored, message.from, parsed);
  const started = await Promise.allSettled(
    withRoom.map(
      async (receiver) =>
        await startRun(env, {
          app: appIdSchema.parse(receiver.appId),
          workflow: workflowIdSchema.parse(receiver.workflowId),
          input,
          startedBy: null,
          actor: { type: "system" },
          trigger: {
            type: "email",
            key: keyOf(receiver),
            version: receiver.version,
          },
        })
    )
  );
  const failures = started.flatMap((result): unknown[] =>
    result.status === "rejected" ? [result.reason] : []
  );
  for (const failure of failures) {
    log.error("workflow.trigger_failed", {
      type: "email",
      message: id,
      ...errorFields(failure),
    });
  }
  if (failures.length > 0) {
    throw new Error(`Message ${id} didn't start every run it should`);
  }
  if (withRoom.length < receivers.length) {
    // Fails for now, so its sender tries again once the hour allows: the
    // runs started now are the same runs then (their keys), and the
    // workflows at their limit start theirs.
    log.warn("workflow.trigger_rate_limited", {
      type: "email",
      message: id,
      capped: receivers.length - withRoom.length,
    });
    throw new Error(`Message ${id} is over a workflow's hourly limit`);
  }
};
