import { stampHeader, stampPattern } from "@grasp-os/connector-kit/manifest";
import { fileErrors } from "@grasp-os/shared/app-files";
import { sha256Hex, sha256HexOfBytes, toHex } from "@grasp-os/shared/encoding";
import { readAtMost } from "@grasp-os/shared/http";
import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  runFileLimits,
  runFileNamed,
  runFileNameSchema,
  runFileTextTypes,
} from "@grasp-os/shared/run-files";
import type { RunFileType } from "@grasp-os/shared/run-files";
import { coreStartKeyPrefix } from "@grasp-os/shared/workflow-resources";
import { inputMappingSchema } from "@grasp-os/shared/workflow-triggers";
import {
  inboundEmailMaxBytes as maxMessageBytes,
  inboundEmailMaxListed as maxListed,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { InboundEmail } from "@grasp-os/shared/workflows";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Address, Attachment, Email } from "postal-mime";

import { keepAuditEvent, outboxedWhere } from "../audit-outbox.ts";
import {
  apps,
  triggerResources,
  triggerResourceVersions,
  workflowTriggers,
} from "../db/core/schema.ts";
import { inputOf as mappedInput, startOnce } from "./connector-triggers.ts";
import type { Outcome, Taker } from "./connector-triggers.ts";
import {
  isWorthKeeping,
  keepMessage,
  parsedOf,
  stagedAttachmentKey,
} from "./kept-email.ts";
import {
  learnMailDomain,
  lineageRefusals,
  mailRecipient,
  runsOwnMail,
  stampedMessageRun,
} from "./mail-stamps.ts";
import type { MailStamp, StampedRun } from "./mail-stamps.ts";
import { runFileTypeShown } from "./office-files.ts";
import { isRunFileText } from "./run-files.ts";
import { deliveryRoom, jsonBytes, maxInputBytes, startRun } from "./runs.ts";
import type { StartFiles } from "./start-files.ts";

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
// mail to their workflows.
//
// A run's own mail to the domain carries its token: core put it on the
// recipient as the run's send left (`local+<token>@domain`,
// mail-stamps.ts). Mail to a tokened address goes to the address without
// the token. It is the run's own mail, and starts its runs under the run,
// admitted against its lineage (quotas.ts, `admitChild`), only when it
// goes to the address the token was put on and its envelope sender (which
// SPF vouches for, unlike its From) is the run's; its key is then the
// token's and its Message-ID's, so the same message delivered again is
// one run, and a new one from that mailbox another run in the lineage.
// Anything else to a tokened address (a customer's reply to all, the
// token on another address) is mail like any other: a root, keyed by its
// Message-ID. A token core didn't record is part of the address, which
// no one receives at. Past the lineage's limits the run is refused and
// audited (`workflow.email.refused`, `lineage_limit`): the message
// bounces when every workflow it would start is refused so, and fails for
// now when another started or is only at its hourly limit, so a delivery
// tried again starts only what it didn't (and its sender hears of it once
// it gives up). Each message also tells core its mail domain, from
// the envelope recipient Email Routing sets, which no sender chooses: a
// run's mail to it is what core stamps, from the first message on, so a
// fresh deployment's first hop is a root.
//
// Independent workflows' email triggers (trigger-resources.ts) receive
// mail the same way, each at an address of its own (`trigger-<token>`,
// 128 random bits, never its ID): the same
// ingress, size limit, parser, loop refusal and input (`InboundEmail`,
// mapped into the run's input as a connector trigger maps its event). An
// address is looked up among live, enabled email triggers first, exactly
// as stored, and only then among Apps' addresses: a trigger's token is
// random, so it is no App's.
// Each message then takes the steps a connector event does
// (connector-triggers.ts, `startOnce`): its start, its refusals and its
// drops once each, by the message. Threat model, and how each is closed:
//
// - Forged delivery: mail reaches here only from Email Routing or the
//   router-signed raw-mail ingress (mail-ingress.ts), as App mail does.
// - Mail to a trigger that is disabled, deleted or doesn't exist bounces,
//   as mail nobody receives does, before it is read. Its ID names no
//   address: knowing it mails nothing. Nothing on this path logs its
//   address or its ID.
// - Mail loops: mail sent automatically or from the deployment's own
//   domain is dropped, audited, as above. A run's own mail joins its
//   lineage: an independent run's by the stamp its message carries
//   (`stampHeader`, `stampedMessageRun`), one level deeper (`causeOf`),
//   until the lineage's limits refuse it; an App run's (its token, or its
//   stamp) can't join an independent lineage and is refused, audited with
//   the run, never started as a new root. A recorded stamp counts for at
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
//   message, within the run's and the workflow's limits. Its
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

/**
 * A parsed message as its run's input: each attachment of `files` with
 * its reference (`attachmentRef`).
 */
const inputOf = (
  id: string,
  stored: string | null,
  envelopeFrom: string,
  parsed: Email,
  files: readonly AttachedFile[] = []
): InboundEmail => {
  const referenced = new Set(files.map(({ index }) => index));
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
      .map(({ filename, mimeType, content }, index) => ({
        filename: filename === null ? null : cut(filename),
        mimeType: cut(mimeType),
        size: sizeOf(content),
        ...(referenced.has(index)
          ? { file: { id: attachmentRef(index) } }
          : {}),
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
        eq(apps.currentVersion, workflowTriggers.version),
        // Only a published App's triggers fire (app-status.ts).
        eq(apps.status, "published")
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
 * Takes a message Email Routing delivers: starts a run of each workflow
 * that receives mail at its recipient's address, with the message as
 * input, bounces it, or fails it for now. A message that may loop
 * (`loopOf`) is dropped, and its refusal audited.
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
  const { local: address, stamp: recorded } =
    local === ""
      ? { local: "", stamp: undefined }
      : await mailRecipient(env, local);
  const taker = address === "" ? undefined : await emailTakerAt(env, address);
  if (taker !== undefined) {
    await receiveForTrigger(message, env, address, taker, recorded);
    return;
  }
  const receivers = address === "" ? [] : await receiversAt(env, address);
  if (receivers.length === 0) {
    message.setReject("No such address.");
    return;
  }
  const read = await readMessage(message, env);
  if (read === undefined) {
    return;
  }
  const { raw, parsed, id, domain } = read;
  // The run's own mail only to the address it mailed, from its sender.
  const stamp = runsOwnMail(
    recorded,
    `${address}@${domain ?? ""}`,
    message.from
  );
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
  // A run's own mail is keyed by its token too, so it is never taken for
  // mail to another.
  const messageKey = await messageKeyOf(parsed, id);
  const same =
    stamp === undefined
      ? messageKey
      : await sha256Hex(`stamp:${stamp.token}:${messageKey}`);
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
          ...(stamp === undefined
            ? {}
            : { parent: runIdSchema.parse(stamp.run) }),
        })
    )
  );
  const refused = lineageRefusals(started, withRoom);
  if (refused.length > 0) {
    // Refused for good: the lineage's limits would refuse it again.
    const db = drizzle(env.DB);
    await Promise.all(
      refused.map(async ({ receiver, limit }) => {
        await keepAuditEvent(env, db, {
          actor: { type: "system" },
          action: "workflow.email.refused",
          target: { type: "app", id: receiver.appId },
          detail: {
            address,
            workflow: receiver.workflowId,
            reason: "lineage_limit",
            limit,
            message: id,
          },
        });
      })
    );
  }
  const failures = started.flatMap((result): unknown[] =>
    result.status === "rejected" &&
    workflowErrors.codeOf(result.reason) !== "workflow.lineage_limit"
      ? [result.reason]
      : []
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
  if (refused.length > 0 && refused.length === receivers.length) {
    // Bounced, so its sender hears of it: every workflow it would start
    // is past the limits of the run that sent it.
    message.setReject(
      "This message would start a workflow run past the limits of the run that sent it."
    );
    return;
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
  if (refused.length > 0) {
    // Started some, refused others: fails for now, as for a workflow at
    // its hourly limit, so the runs started are the same runs when its
    // sender tries again, and a sender who gives up hears of it.
    log.warn("workflow.trigger_lineage_refused", {
      type: "email",
      message: id,
      refused: refused.length,
    });
    throw new Error(`Message ${id} is past a lineage's limits for a workflow`);
  }
};
