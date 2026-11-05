import { stampHeader, stampPattern } from "@grasp-os/connector-kit/manifest";
import { fileErrors } from "@grasp-os/shared/app-files";
import { auditEventSchema } from "@grasp-os/shared/audit";
import { sha256Hex, sha256HexOfBytes, toHex } from "@grasp-os/shared/encoding";
import { readAtMost } from "@grasp-os/shared/http";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  runFileLimits,
  runFileNamed,
  runFileNameSchema,
  runFileTextTypes,
} from "@grasp-os/shared/run-files";
import type { RunFileType } from "@grasp-os/shared/run-files";
import {
  coreStartKeyPrefix,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import { inputMappingSchema } from "@grasp-os/shared/workflow-triggers";
import {
  inboundEmailMaxBytes as maxMessageBytes,
  inboundEmailMaxListed as maxListed,
} from "@grasp-os/shared/workflows";
import type { InboundEmail } from "@grasp-os/shared/workflows";
import { and, eq, isNull, not } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Address, Attachment, Email } from "postal-mime";
import { z } from "zod";

import {
  auditedBatch,
  outboxedEventWhere,
  outboxedWhere,
  storedEvent,
  uuidFromHash,
} from "../audit-outbox.ts";
import {
  triggerResources,
  triggerResourceVersions,
} from "../db/core/schema.ts";
import {
  authenticationOf,
  domainOf as domainNameOf,
} from "./authentication-results.ts";
import type { Authentication } from "./authentication-results.ts";
import { inputOf as mappedInput, startOnce } from "./connector-triggers.ts";
import type { Outcome, Taker } from "./connector-triggers.ts";
import { parsedOf, postalMime, stagedAttachmentKey } from "./kept-email.ts";
import {
  learnMailDomain,
  mailRecipient,
  runsOwnMail,
  stampedMessageRun,
} from "./mail-stamps.ts";
import type { MailStamp, StampedRun } from "./mail-stamps.ts";
import { runFileTypeShown } from "./office-files.ts";
import { heldRunOf } from "./resource-authority.ts";
import { admitRunEvent, eventIdOf, notStartedYet } from "./run-events.ts";
import { isRunFileText } from "./run-files.ts";
import {
  inboxAt,
  ingressTypeOf,
  replyLocalPattern,
  replyPrefix,
} from "./run-inboxes.ts";
import type { RunInbox } from "./run-inboxes.ts";
import { jsonBytes, maxInputBytes } from "./runs.ts";
import type { StartFiles } from "./start-files.ts";

// Mail to independent workflows' email triggers (trigger-resources.ts).
// Email Routing hands each message to the Worker's `email` handler, which
// routes it by the part of its envelope recipient before the `@`: each
// trigger receives at an address of its own, the name its builder chose,
// or `trigger-<token>` (128 random bits, never its ID). The address is
// looked up first, exactly as stored, among live, enabled email triggers,
// so mail nobody receives is never read: it bounces (a permanent
// failure). Only then is the message read and parsed: one too large, or
// that doesn't parse, bounces.
//
// A run gets the message parsed (`InboundEmail`, mapped into its input as
// a connector trigger maps its event), bounded to fit a run's input: at
// most 100 each of To and Cc, names, subject and file names cut,
// attachments listed, and as much plain text as fits (a message with
// only HTML, its text). Its `id` is the SHA-256 of its bytes.
//
// Anyone can send mail, and its headers say what its sender wrote: the
// message is untrusted data for the run, its From address included.
//
// Mail loops. A run can send mail (through a connection), and mail can
// start a run: a workflow that mails its own trigger's address, or two
// that mail each other, or an auto-reply answering a run's mail, would
// start runs without end. So a message that says it was sent
// automatically (`Auto-Submitted` other than `no`, RFC 3834), or that
// comes from the deployment's own mail domain (its From or its envelope
// sender), starts nothing: it is accepted and dropped, never bounced, as
// a bounce is mail that can loop too, and the refusal is audited
// (`workflow.email.refused`). The mail domain is the recipient's own, as
// Email Routing hands the message over, so it needs no setting of its
// own, and can't be set wrong. A message from a person's mailbox at the
// client's own domain still starts runs: people forward mail to their
// workflows. Each message also tells core its mail domain, from the
// envelope recipient Email Routing sets, which no sender chooses
// (mail-stamps.ts).
// Each message then takes the steps a connector event does
// (connector-triggers.ts, `startOnce`): its start, its refusals and its
// drops once each, by the message. Threat model, and how each is closed:
//
// - Forged delivery: mail reaches here only from Email Routing or the
//   router-signed raw-mail ingress (mail-ingress.ts).
// - Mail to a trigger that is disabled, deleted or doesn't exist bounces,
//   as mail nobody receives does, before it is read. Its ID names no
//   address: knowing it mails nothing. Nothing on this path logs its
//   address or its ID.
// - Mail loops: mail sent automatically or from the deployment's own
//   domain is dropped, audited, as above. A run's own mail joins its
//   lineage by the stamp its message carries (`stampHeader`,
//   `stampedMessageRun`), one level deeper (`causeOf`), until the
//   lineage's limits refuse it; a token or stamp of a run that isn't
//   independent can't join an independent lineage and is refused, audited
//   with the run, never started as a new root. A recorded stamp counts for at
//   most a few messages at the address (`maxClaimsPerSource`). Besides, a
//   trigger starts and refuses at most `triggeredRunsPerHour` messages an
//   hour, loop drops included, so mail can't write the audit log without
//   end; past that the delivery fails for now, for its sender to try again
//   later, and one held back a day is dropped, audited once.
// - An oversized or malicious attachment: the message bounces past
//   `maxMessageBytes`, and nothing of it is kept as a message
//   (`stored: null`). An attachment reaches the run only as a file of its
//   own (GRA-1363), copied in as the start is admitted, as an App's file
//   a screen hands its run is (start-files.ts): only where the
//   workflow's input takes a file and its trigger maps the attachment's
//   `file` there; only one a run file may be, its type shown by its bytes
//   (never the label its sender gave it), its name one a run file may
//   have, and not inline; at most `runFileLimits.startFiles` of a
//   message, within the run's and the workflow's limits. Anyone with
//   the address can fill the workflow's run-file room (5 GiB), at most
//   `triggeredRunsPerHour` messages of 10 MiB an hour; past it a message
//   with a file to copy is refused for good and audited
//   (`file.workflow_quota`), never retried unheard. Its
//   reference in the message, `attachment-<index>`, names an attachment
//   of that message alone, and becomes the run file's own ID; the run
//   reads it only through its workflow's own files binding, and it goes
//   with the run's details. Each copy is audited with the run
//   (`workflow.email.attachment.sent`), never its name. While it is
//   copied it waits in R2 (`stagedAttachmentKey`), deleted once the
//   start is decided, else with its day's kept mail.
// - A sender writing an internal address: From is untrusted data for the
//   run, as above; only the envelope sender, which SPF vouches for, makes
//   mail a run's own, with a stamp core recorded.
// - A trigger acting on authority it lost: each message is a start as any
//   trigger's (workflow-starts.ts), acting for its creator, read again as
//   it is admitted: the trigger live and enabled, its creator still with
//   a role, its own `start` grant active. A refusal for good is audited
//   (`workflow.email.refused`) and the message dropped, never bounced. A
//   trigger moved to another version as the message arrived fails it for
//   now, to be started at the new version.
// - The same message delivered twice: its start is keyed by the trigger
//   and the message (its Message-ID, or bytes), so it is one run.
//
// A reply to a run's mail, to the run's reply address
// (`reply-<token>@<host>`, run-inboxes.ts), starts nothing: it is an
// event for that run (`receiveReply`), admitted as an App screen's is
// (run-events.ts, `admitRunEvent`). Its address is looked up before any
// trigger's or App's, and before the message is read. Threat model, and
// how each is closed:
//
// - A guessed or stale token: an address no inbox has (never minted, gone
//   with its run's details, or one core's key no longer derives) is
//   rejected at SMTP time, as an address nobody receives at, so no bounce
//   goes out later. Nothing logs or audits the token, only its run.
// - A builder taking a run's replies with an email trigger named after
//   one: that shape is reserved (email-addresses.ts), and reply addresses
//   are looked up first.
// - A forged sender: the From header is data. The event's source and its
//   sender (its share of the run's inbox, `inbox:<alias>`) are minted
//   from the inbox, never from the message, so outsiders fill only that
//   binding's share, never an App screen's. What Email Routing found of
//   SPF, DKIM and DMARC goes with it (authentication-results.ts: only
//   its own ARC set, on top, is read), for the workflow to check; core
//   refuses no reply on it. Its DMARC verdict only when `from`, as the
//   run gets it, is the message's one From mailbox at the domain DMARC
//   judged (`dmarcOfFrom`), so a pass always means `from`'s domain is
//   verified.
// - A reply the run can't take: one to a run that ended, through a
//   binding whose approval went, one its contract refuses, past its
//   inbox's limits, or one that may loop (`loopOf`) is accepted and
//   dropped, never bounced (a bounce can loop), and audited
//   (`workflow.email.reply.dropped`) once per run, inbox and reason a
//   day, so a flood of replies can't fill the audit log; every drop is
//   logged with the message's hash alone. One to a run whose start isn't confirmed
//   yet fails for now, for Email Routing to try again.
// - The same reply delivered twice: its key is the message's
//   (`messageKeyOf`), so it is one event, however its bytes differ.
//   Each reply a run takes is audited with its run and binding
//   (`workflow.email.reply.received`) once a day it is delivered, by its
//   event, a delivery tried again included, bounded by the run's inbox
//   limits.
// - An oversized reply: it bounces past `maxMessageBytes`, as any mail;
//   its data is fitted to an event's (`fitted`), its attachments listed,
//   never kept.

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

/** An attachment's content, as bytes. */
const bytesOf = (content: ArrayBuffer | Uint8Array | string): Uint8Array =>
  typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);

/** The byte length of an attachment's content. */
const sizeOf = (content: ArrayBuffer | Uint8Array | string): number =>
  bytesOf(content).byteLength;

/** An attachment of a message a run file may be: what a start copies. */
interface AttachedFile {
  /** Its index among the message's attachments. */
  index: number;
  name: string;
  type: RunFileType;
  bytes: Uint8Array;
}

/** What an attachment's file is named in its message, before it is copied. */
const attachmentRef = (index: number): string => `attachment-${String(index)}`;

/** What an attachment with no name a run file may have is named. */
const unnamedAttachment = "attachment";

/** The attachment a run file may be, as one: its type by its bytes. */
const attachedFileOf = async (
  attachment: Attachment,
  index: number
): Promise<AttachedFile | undefined> => {
  if (attachment.disposition === "inline") {
    return undefined;
  }
  const bytes = bytesOf(attachment.content);
  const type = await runFileTypeShown(bytes, attachment.mimeType);
  if (
    type === undefined ||
    bytes.byteLength > runFileLimits.fileBytes ||
    (runFileTextTypes.has(type)
      ? !isRunFileText(bytes)
      : bytes.byteLength === 0)
  ) {
    return undefined;
  }
  const named = runFileNameSchema.safeParse(attachment.filename ?? "");
  return {
    index,
    type,
    bytes,
    name: runFileNamed(named.success ? named.data : unnamedAttachment, type),
  };
};

/**
 * The attachments of `parsed` its run may have as files (`attachedFileOf`):
 * the first `runFileLimits.startFiles` of those its input lists.
 */
const attachedFiles = async (parsed: Email): Promise<AttachedFile[]> => {
  const found: AttachedFile[] = [];
  for (const [index, attachment] of parsed.attachments
    .slice(0, maxListed)
    .entries()) {
    if (found.length >= runFileLimits.startFiles) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- one at a time, few
    const file = await attachedFileOf(attachment, index);
    if (file !== undefined) {
      found.push(file);
    }
  }
  return found;
};

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
 * `input` made to fit a run's input (or an event's data, which is as
 * large), whatever else it carries: its text cut first, to the longest
 * start that fits (`fittingText`), then, should the rest still not fit,
 * Cc, To and attachments dropped from the end, in that order.
 */
const fitted = <T extends InboundEmail>(input: T): T => {
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
  const current = (): T => ({ ...fitting, attachments });
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

/**
 * `authentication`, its DMARC verdict kept only when `from`, the address
 * the run gets (`messageOf`, cut to fit), is the message's one From
 * mailbox, at the domain DMARC judged: one From header (counting every
 * spelling of its name; RFC 5322 3.6 allows only one), the one postal-mime
 * reads (`From:`, not `From :`), holding one mailbox, exactly `from`, with
 * one `@` (`boss@bank.test@evil.test` names no one domain). Otherwise
 * which From Email Routing judged, or which domain `from` names, the run
 * can't tell: several From headers or mailboxes, none postal-mime reads
 * (the run then gets the envelope sender), a cut address, another domain.
 */
const dmarcOfFrom = async (
  parsed: Email,
  from: string,
  authentication: Authentication
): Promise<Authentication> => {
  const { addressParser } = await postalMime();
  const fromHeaders = parsed.headers.filter(({ key }) => key.trim() === "from");
  const fromMailboxes =
    fromHeaders.length === 1 ? addressParser(fromHeaders[0]?.value ?? "") : [];
  const address = fromMailboxes[0]?.address;
  const domain = domainNameOf(address);
  const ofFrom =
    fromHeaders[0]?.key === "from" &&
    fromMailboxes.length === 1 &&
    address === from &&
    from.indexOf("@") === from.lastIndexOf("@") &&
    domain !== null &&
    domain === authentication.dmarc?.domain;
  return ofFrom ? authentication : { ...authentication, dmarc: null };
};

/**
 * A parsed message as its run's input, before it is made to fit
 * (`fitted`): each attachment of `files` with its reference
 * (`attachmentRef`).
 */
const messageOf = (
  id: string,
  stored: string | null,
  envelopeFrom: string,
  parsed: Email,
  files: readonly AttachedFile[] = []
): InboundEmail => {
  const referenced = new Set(files.map(({ index }) => index));
  const [from] = mailboxes(parsed.from === undefined ? [] : [parsed.from]);
  const date = parsed.date === undefined ? null : new Date(parsed.date);
  return {
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
      .map(({ filename, mimeType, content }, index) => ({
        filename: filename === null ? null : cut(filename),
        mimeType: cut(mimeType),
        size: sizeOf(content),
        ...(referenced.has(index)
          ? { file: { id: attachmentRef(index) } }
          : {}),
      })),
  };
};

/** A parsed message as its run's input (`messageOf`), made to fit. */
const inputOf = (...message: Parameters<typeof messageOf>): InboundEmail =>
  fitted(messageOf(...message));

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
 * A message as core takes it: from Email Routing's `email` handler, or
 * from the raw-mail ingress (src/mail-ingress.ts), which answers what this
 * rejects it with.
 */
export type InboundMessage = Pick<
  ForwardableEmailMessage,
  "from" | "to" | "raw" | "setReject"
>;

/** A message read and parsed, once someone receives it. */
interface ReadMessage {
  raw: Uint8Array;
  parsed: Email;
  /** The SHA-256 of its bytes. */
  id: string;
  domain: string | undefined;
}

/**
 * `message` read and parsed, its domain learned (mail-stamps.ts); none,
 * rejected, when too large or unreadable.
 */
const readMessage = async (
  message: InboundMessage,
  env: Env
): Promise<ReadMessage | undefined> => {
  const domain = domainOf(message.to);
  if (domain !== undefined) {
    await learnMailDomain(env, domain);
  }
  const raw = await readAtMost(message.raw, maxMessageBytes);
  if (raw === undefined) {
    message.setReject("The message is too large.");
    return undefined;
  }
  const parsed = await parsedOf(raw);
  if (parsed === undefined) {
    message.setReject("The message can't be read.");
    return undefined;
  }
  const id = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)));
  return { raw, parsed, id, domain };
};

/**
 * What makes `parsed` (of bytes hashing to `id`) one message: the SHA-256
 * of its Message-ID, or `id` when it has none that names one message:
 * `<>` or `x` would make every message that carries it the same one.
 */
const messageKeyOf = async (parsed: Email, id: string): Promise<string> => {
  const { messageId } = parsed;
  return messageId !== undefined && messageId.includes("@")
    ? await sha256Hex(messageId)
    : id;
};

/** The stamp `parsed` carries (`stampHeader`), if it carries one. */
const stampOf = (parsed: Email): string | undefined => {
  const name = stampHeader.toLowerCase();
  return parsed.headers
    .filter(({ key }) => key.toLowerCase() === name)
    .map(({ value }) => value.trim())
    .find((value) => stampPattern.test(value));
};

/** The live, enabled email trigger at `address`, if there is one. */
const emailTakerAt = async (
  env: Env,
  address: string
): Promise<Taker | undefined> =>
  await drizzle(env.DB)
    .select({
      id: triggerResources.id,
      version: triggerResources.currentVersion,
      workflowId: triggerResourceVersions.workflowResourceId,
      workflowVersion: triggerResourceVersions.workflowResourceVersion,
      inputMapping: triggerResourceVersions.inputMapping,
    })
    .from(triggerResources)
    .innerJoin(
      triggerResourceVersions,
      and(
        eq(triggerResourceVersions.triggerId, triggerResources.id),
        eq(triggerResourceVersions.version, triggerResources.currentVersion)
      )
    )
    .where(
      and(
        eq(triggerResources.emailAddress, address),
        eq(triggerResources.kind, "email"),
        eq(triggerResources.enabled, true),
        isNull(triggerResources.deletedAt)
      )
    )
    .get();

/**
 * The attachments `files` of message `id` that `taker`'s start may hand
 * its run, each read only by its reference in this message; and what
 * deletes what waited in R2 for the copy, once the start is decided.
 */
const messageFiles = (
  env: Env,
  taker: Taker,
  id: string,
  files: readonly AttachedFile[]
): { files: StartFiles; done: () => Promise<void> } => {
  const byRef = new Map(files.map((file) => [attachmentRef(file.index), file]));
  const staged = new Map<string, string>();
  return {
    files: {
      read: async (fileId) => {
        const file = byRef.get(fileId);
        if (file === undefined) {
          throw fileErrors.create("file.not_found");
        }
        const sha256 = await sha256HexOfBytes(file.bytes);
        let key = staged.get(fileId);
        if (key === undefined) {
          key = stagedAttachmentKey(taker.id, id, file.index);
          await env.FILES.put(key, file.bytes, { sha256 });
          staged.set(fileId, key);
        }
        return {
          id: fileId,
          name: file.name,
          type: file.type,
          size: file.bytes.byteLength,
          chunks: [{ key, sha256 }],
        };
      },
      // A statement of the admitting batch, never run on its own: the
      // copy and its run, never the attachment's name.
      sent: (file, runId, workflowId, admitted) =>
        outboxedWhere(
          drizzle(env.DB),
          {
            actor: { type: "system" },
            action: "workflow.email.attachment.sent",
            target: { type: "trigger", id: taker.id },
            detail: {
              message: id,
              attachment: file.id,
              workflow: workflowId,
              run: runId,
              type: file.type,
              size: file.size,
            },
          },
          admitted
        ),
    },
    done: async () => {
      if (staged.size === 0) {
        return;
      }
      try {
        await env.FILES.delete([...staged.values()]);
      } catch (error) {
        // Its start is decided either way: what R2 kept goes with its
        // day's kept mail.
        log.warn("workflow.email_staged_left", {
          message: id,
          ...errorFields(error),
        });
      }
    },
  };
};

/**
 * Takes a message to `taker`, the email trigger at `address` (its token
 * `recorded`, if any, gone): starts its run, the message mapped into its
 * input, acting for its creator; bounces it, drops it (audited), or fails
 * it for now, as the threat model above says. Logs the message's hash
 * alone: never the address or the trigger.
 */
const receiveForTrigger = async (
  message: InboundMessage,
  env: Env,
  address: string,
  taker: Taker,
  recorded: MailStamp | undefined
): Promise<void> => {
  const read = await readMessage(message, env);
  if (read === undefined) {
    return;
  }
  const { parsed, id, domain } = read;
  const messageKey = await messageKeyOf(parsed, id);
  // Mail that may loop is refused for good, as a start refused is.
  const loop = loopOf(message.to, message.from, parsed);
  // A run's own mail: an App run's token, or a run's stamp, each only to
  // this address from one of the run's senders.
  const to = `${address}@${domain ?? ""}`;
  const token = runsOwnMail(recorded, to, message.from);
  let stamped: StampedRun | undefined =
    token === undefined ? undefined : { kind: "app", runId: token.run };
  if (stamped === undefined && loop === undefined) {
    // Mail refused as a loop claims no place of a stamp.
    stamped = await stampedMessageRun(
      env,
      stampOf(parsed),
      to,
      message.from,
      messageKey
    );
  }
  const same =
    stamped === undefined
      ? messageKey
      : await sha256Hex(`stamp:${stamped.runId}:${messageKey}`);
  const mapping = inputMappingSchema.parse(
    JSON.parse(taker.inputMapping ?? "{}")
  );
  const attached = await attachedFiles(parsed);
  const handed = messageFiles(env, taker, id, attached);
  let outcome: Outcome;
  try {
    outcome = await startOnce(env, taker, {
      same,
      key: `${coreStartKeyPrefix}email:${taker.id}:${same}`,
      admission: `email:${same}:${taker.id}`,
      input: mappedInput(
        mapping,
        inputOf(id, null, message.from, parsed, attached)
      ),
      files: handed.files,
      stamped,
      noted: { message: id },
      audited: {
        refused: "workflow.email.refused",
        dropped: "workflow.email.dropped",
        detail: { message: id },
      },
      logged: { type: "email", message: id },
      ...(loop === undefined ? {} : { refusedAs: loop }),
    });
  } finally {
    await handed.done();
  }
  if (outcome === "unavailable") {
    // Disabled or deleted as it arrived: no such address. (Moved to
    // another version, it is tried again, at that version: `retry`.)
    message.setReject("No such address.");
    return;
  }
  if (outcome === "retry") {
    throw new Error(`Message ${id} didn't start its trigger's run yet`);
  }
};

/**
 * Audits `action` about a reply to `inbox`'s run, with `detail`, once a
 * day: the event's ID is derived from all it holds and the day, and its
 * time is that day, so the same event however often that day, which the
 * outbox and the log each keep once (as `auditDownload` in
 * app-file-route.ts).
 */
const auditReplyOnce = async (
  env: Env,
  inbox: RunInbox,
  action: string,
  detail: Readonly<Record<string, string>>
): Promise<void> => {
  const day = new Date().toISOString().slice(0, 10);
  const held = {
    workflow: inbox.workflowId,
    binding: inbox.binding,
    ...detail,
    day,
  };
  const event = auditEventSchema.parse({
    id: uuidFromHash(
      await sha256Hex(`${action}:${inbox.runId}:${canonicalJson(held)}`)
    ),
    at: `${day}T00:00:00.000Z`,
    source: "core",
    actor: { type: "system" },
    action,
    target: { type: "workflow_run", id: inbox.runId },
    detail: held,
  });
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    outboxedEventWhere(db, event, not(storedEvent(event.id))),
  ]);
};

/** Why a reply to a run's inbox is dropped (`receiveReply`). */
type ReplyDrop =
  | LoopReason
  | "run_ended"
  | "event_denied"
  | "event_invalid"
  | "event_refused";

/** The drop a refusal of `admitRunEvent` is, by its code. */
const replyDrops: Readonly<Record<string, ReplyDrop>> = {
  "workflow.run_ended": "run_ended",
  // A run whose row is gone took its inbox with it: never reached here
  // but in a race with retention, as an ended run's.
  "workflow.run_unavailable": "run_ended",
  "workflow.event_denied": "event_denied",
  "workflow.event_invalid": "event_invalid",
  "workflow.event_refused": "event_refused",
};

const refusalReasonSchema = z.object({
  details: z.object({ reason: z.string() }),
});

/**
 * Records that a reply to `inbox`'s run (the message hashing to
 * `message`) was dropped, and why: audited once per run, inbox and reason
 * a day (the event's ID is derived from them, and it holds nothing else,
 * so the same event however often that day), and logged each time with
 * the message's hash alone. A reply's sender can drop as many as they
 * like; the audit log takes at most one of each a day.
 */
const replyDropped = async (
  env: Env,
  inbox: RunInbox,
  reason: ReplyDrop,
  message: string
): Promise<void> => {
  log.warn("workflow.email_reply_dropped", {
    run: inbox.runId,
    reason,
    message,
  });
  await auditReplyOnce(env, inbox, "workflow.email.reply.dropped", {
    reason,
  });
};

/**
 * Records that `inbox`'s run has the reply that is its event `eventId`:
 * once a day it is delivered, however often (the audit event's ID is
 * derived from the run's event's and the day, and it holds nothing else
 * that differs), so a delivery tried again after the run took it, its
 * audit lost, records it then. Its time is that day.
 */
const replyReceived = async (
  env: Env,
  inbox: RunInbox,
  eventId: string
): Promise<void> => {
  await auditReplyOnce(env, inbox, "workflow.email.reply.received", {
    event: eventId,
  });
};

/**
 * Takes a reply to a run's mail, sent to its inbox's address
 * (`reply-<token>`, run-inboxes.ts): admits it to the run as its
 * binding's contract's email type, its data the message as an email
 * trigger's run gets it with what SPF, DKIM and DMARC found
 * (`emailReplyData`), keyed by the message (`messageKeyOf`), so a
 * redelivery is the same event. A token no inbox has is rejected, as mail
 * to an address nobody receives at, before the message is read. A reply
 * the run can't take (it ended, its binding's approval went, its inbox is
 * full, or it may loop) is accepted and dropped, audited
 * (`replyDropped`), never bounced; one to a run whose start isn't
 * confirmed yet fails for now, for Email Routing to try again.
 */
const receiveReply = async (
  message: InboundMessage,
  env: Env,
  token: string
): Promise<void> => {
  const inbox = await inboxAt(env, token);
  if (inbox === undefined) {
    message.setReject("No such address.");
    return;
  }
  const read = await readMessage(message, env);
  if (read === undefined) {
    return;
  }
  const { parsed, id } = read;
  const loop = loopOf(message.to, message.from, parsed);
  if (loop !== undefined) {
    await replyDropped(env, inbox, loop, id);
    return;
  }
  // The run's frozen bindings, ended or not: a reply its run took before
  // it ended, delivered again, is still the event it took
  // (`admitRunEvent`), never dropped as if it were lost.
  const run = await heldRunOf(env, inbox.runId);
  if (run === undefined) {
    await replyDropped(env, inbox, "run_ended", id);
    return;
  }
  const binding = run.bindings.get(inbox.binding);
  const ingress =
    binding?.kind === "event" ? await ingressTypeOf(env, binding) : undefined;
  if (ingress?.ingress !== "email") {
    await replyDropped(env, inbox, "event_invalid", id);
    return;
  }
  const input = messageOf(id, null, message.from, parsed);
  const delivery = {
    workflowId: inbox.workflowId,
    runId: inbox.runId,
    binding: inbox.binding,
    type: ingress.type,
    data: fitted({
      ...input,
      authentication: await dmarcOfFrom(
        parsed,
        input.from.address,
        authenticationOf(parsed.headers, parsed.from?.address)
      ),
    }),
    key: await messageKeyOf(parsed, id),
    // Minted from the inbox, never from the message: its From is data.
    source: `urn:grasp:run:${inbox.runId}:inbox:${inbox.binding}:email`,
    sender: `inbox:${inbox.binding}`,
  };
  let admitted: { id: string };
  try {
    admitted = await admitRunEvent(env, delivery);
  } catch (error) {
    const code = workflowResourceErrors.codeOf(error);
    if (code === "workflow.event_conflict") {
      // The same message (its Message-ID) delivered again with other
      // bytes, or what other servers found of it: the run has it already,
      // as the event its key names.
      log.warn("workflow.email_reply_redelivered", {
        run: inbox.runId,
        message: id,
      });
      await replyReceived(env, inbox, await eventIdOf(delivery));
      return;
    }
    if (
      code === "workflow.event_refused" &&
      refusalReasonSchema.safeParse(error).data?.details.reason ===
        notStartedYet
    ) {
      throw new Error(`Message ${id} reached a run that hasn't started yet`, {
        cause: error,
      });
    }
    const drop = code === undefined ? undefined : replyDrops[code];
    if (drop === undefined) {
      throw error;
    }
    await replyDropped(env, inbox, drop, id);
    return;
  }
  await replyReceived(env, inbox, admitted.id);
};

/**
 * Takes a message Email Routing delivers: a reply to a run's mail to the
 * run (`receiveReply`); anything else to the email trigger at its
 * recipient's address (`receiveForTrigger`), or bounces it when no
 * trigger receives mail there. A message that may loop (`loopOf`) is
 * dropped, and its refusal audited.
 */
export const receiveEmail = async (
  message: InboundMessage,
  env: Env
): Promise<void> => {
  // Who receives it first: mail nobody receives is never read. A token
  // core recorded goes, and names the run that may have sent it
  // (mail-stamps.ts).
  const at = message.to.lastIndexOf("@");
  const local = message.to.slice(0, Math.max(at, 0)).toLowerCase();
  // A run's reply address first: no trigger may take its shape
  // (email-addresses.ts), and it carries no recorded token.
  if (replyLocalPattern.test(local)) {
    await receiveReply(message, env, local.slice(replyPrefix.length));
    return;
  }
  const { local: address, stamp: recorded } =
    local === ""
      ? { local: "", stamp: undefined }
      : await mailRecipient(env, local);
  const taker = address === "" ? undefined : await emailTakerAt(env, address);
  if (taker !== undefined) {
    await receiveForTrigger(message, env, address, taker, recorded);
    return;
  }
  message.setReject("No such address.");
};
