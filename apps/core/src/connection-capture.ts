import { delegateActorOf } from "@grasp-os/shared/audit";
import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import type { ConnectResult, ToolClass } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { redactJsonText } from "@grasp-os/shared/redact-json";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { chatAuthority } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { captureGroupOf } from "./brain-next-origins.ts";
import { addSource } from "./brain-next.ts";
import { answerText } from "./connection-answer.ts";
import {
  answerCaptureIdOf,
  captureIdOf,
  keepsWholeAnswers,
} from "./connection-capture-key.ts";
import { connectionOwnersOf } from "./connections.ts";
import { nativeItemReads } from "./native-tool-classes.gen.ts";
import { classOf } from "./tool-classes.ts";

// Capture (GRA-1730): what a chat's agent reads through its person's own
// connection is kept in the Brain, an item a source, so every connected
// system feeds it with nothing built per connector. Core relays every
// call (agent-connections.ts) and captures there, after the agent has its
// answer; connect and the Brain never call each other. The threat model
// and the decisions are on GRA-1730; in short:
//
// - Connect decides what may be kept (`ConnectResult.keep`): a read it
//   carried out just now, from a connection whose provider's terms allow
//   copies; a native connector's only when its server named the items it
//   read. Without its word nothing is kept: a change, a held call, a
//   replay, a refusal. An error answer never reaches capture: the call
//   throws it (`connect.action_failed`).
// - Only the person's own connection. What it keeps is theirs alone
//   (`owner`), as the plan's Owner is "the one whose own connection
//   brought it in". A native tool only when it reaches the person's own
//   things (its manifest's reach `own`, classed `read-own`); a toolkit's
//   as below. A shared connection's reads, and a native tool that reaches
//   the company's or others' things (a SharePoint list, a shared drive,
//   another mailbox), are kept by nothing yet: a native connection may
//   wait to be signed in again with its captures standing, so a copy
//   could outlive the person's access at the source. They come back with
//   native sync, which brings each item's readers.
// - Only a tool that answers one item's content, as its manifest declares
//   (`answersItem`: Gmail's message and attachment reads, OneNote's page
//   read), kept whole as that item's source for the tool, in the person's
//   own store (owner content), credentials redacted (`redact`); never the
//   call's input. What a tool is decides it, never how many items came
//   back: a list or a search is never kept, even with one hit (a snippet
//   beside the full copy is noise in recall, and every changed summary
//   would be a version). Nor is a file's content read as base64 (the
//   default of a tool that answers a file): bytes are no text to find.
//   No cap of its own: the Brain's own limit on a source refuses what is
//   past it, and the item fails. Outside text is content: a captured
//   source is never an instruction file, and the model reads it as
//   evidence, cited as `capture:` (turn-recall.ts).
// - A toolkit's read, or any other whose whole answer capture keeps
//   (connection-capture-key.ts `keepsWholeAnswers`; GRA-1845, the threat
//   model and the decisions are on the issue): its server names no item, and no review gives a tool's
//   item an ID, so the whole answer of one call is one source, keyed by
//   the call (connection-capture-key.ts `answerCaptureIdOf`): the same
//   call again is its next version, and two different calls never share
//   one. Kept as MCP shapes it (connection-answer.ts): its structured
//   content, or its text, never an image, audio or another binary block,
//   which is counted (`leftOut`); an answer with no text in it is skipped
//   (`no_text`). Only for a tool connect takes to read the person's own
//   things or the company's (`read-own`, `read-company`: its review's
//   class of a read, and the admin's mark of one), never others' things
//   (`read-others`): Nick's decision on GRA-1845 (17 November), a
//   person only ever gets back what they themselves opened with their own
//   login at the time, for them alone, with no check against the source
//   afterwards ("a person keeps what they read before losing access at
//   the source"). Disconnecting the connection, the person's removal and
//   their erasure erase it all (below). A shared connection's reads stay
//   uncaptured: they are the shared Brain's, with the audience an admin
//   chooses (GRA-1831), under their own connection's keys, so the two
//   never meet. Not a native connector's, which is kept item by item as
//   above, its own things only.
// - Each kept text starts with when and through what it was read ("Read
//   on <day> through <toolkit or provider>."), so the person sees it on
//   the Sources page and the model in the passage: a read again on a later
//   day is the next version, with its day.
// - Credentials are redacted inside the answer's JSON as well as over its
//   text (connection-answer.ts `redactedAnswer`); an answer whose
//   redaction cannot finish is not kept (`credential`).
// - Capturing never holds up or fails the call: it runs once the agent
//   has its answer (`waitUntil`). Every call ends in one audit event, of
//   IDs and counts alone (items, kept, failed, skipped, adding up to
//   items): kept, failed, or skipped with the reason (`shared`, `reach`,
//   `list`, `file`, `no_text`, `credential`, `erased`, `stale`). Captures of one item run
//   independently and may land out of order: each carries when its tool
//   answered (`readAt`), and the Brain, in the transaction that would make
//   it current, writes nothing for a read older than the current version's
//   (`stale`). So a late capture never replaces a newer one. `readAt` is
//   when core received the tool's answer: one clock, so no skew between
//   captures.
//
// Known, and accepted for now:
// - Capturing is one try under `waitUntil`: an isolate evicted before it
//   ends loses the capture and its audit event alike. A lost reply from
//   the Brain is counted as failed even when the add landed.
// - A capture is the item's copy, not the chat's text: deleting the chat
//   it was read in leaves it, and so does deleting the item at its source
//   (nothing tells core). A person removes them by disconnecting the
//   connection, which erases all of its captures (below), or by their own
//   erasure, which removes all of theirs.
//
// Disconnecting (GRA-1827; the threat model and the decisions are on the
// issue): every capture through a connection is added in its group
// (brain-next-origins.ts `captureGroupOf`), in its owner's own store, the
// only store that ever holds one. A disconnect is never held up by the
// Brain: connect stops the connection first, then core erases the group,
// in one call that closes it (connections.ts `eraseCapturesSoon`). The
// erasure is owed by connect's record of the stop, which stays in its
// audit outbox until core's drain has erased the group and recorded it
// (capture-erasures.ts): so the person's own disconnect, their removal
// and their erasure all erase it, whatever failed on the way. A capture
// landing after the erasure is refused by the store, one under way goes
// with the group, and a restore of an older copy replays the erasure. A
// reconnect is a new connection (connect never revives a disconnected
// one), so a new group: nothing erased comes back. A connection needing
// sign-in again (`needs_reauth`) is not ended: the same connection when
// its person reconnects it.

type CaptureEvent =
  | "brain.capture.kept"
  | "brain.capture.skipped"
  | "brain.capture.failed";

/** The audit event a capture ends in, through core's outbox. */
const audited = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  action: CaptureEvent,
  detail: Record<string, string | number>
): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: delegateActorOf(chatAuthority(scope), scope.via),
    action,
    target: { type: "connection", id: connectionId },
    detail: { ...detail, chat: scope.chatId },
  });
};

/** What an item-reading tool answers: its content, or a file's. */
const itemReadSchema = z.enum(["item", "file"]);

/**
 * Whether the native tool `action` of `provider` answers one item's
 * content (`answersItem` in its manifest), and whether that is a file's
 * (`answersFile`), by the release's generated table, checked. Undefined
 * for every other tool: a list or a search.
 */
const itemReadOf = (
  provider: string,
  action: string
): z.infer<typeof itemReadSchema> | undefined => {
  const tools = nativeItemReads[provider];
  const value =
    tools !== undefined && Object.hasOwn(tools, action)
      ? tools[action]
      : undefined;
  return value === undefined ? undefined : itemReadSchema.parse(value);
};

/** Whether a call's input asks for a file as text (`contentAs`'s `as`). */
const asksText = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  "as" in input &&
  input.as === "text";

/**
 * A tool's answer, and when it answered (taken before anything else is
 * awaited): captures of one item run independently and may land in any
 * order, and the Brain keeps the one read last (`readAt`).
 */
export interface Read {
  result: ConnectResult;
  readAt: Date;
}

/** What a call's capture ended in: its event and the event's detail. */
type Ended = [CaptureEvent, Record<string, string | number>];

/** A call skipped for `reason`: each of its `items` skipped. */
const skippedAll = (reason: string, items: number): Ended => [
  "brain.capture.skipped",
  { reason, items, kept: 0, failed: 0, skipped: items },
];

/**
 * The line a kept text starts with: the day it was read (UTC) and what it
 * was read through, a toolkit or a native provider. In the person's
 * Sources page as the source's first line, and in the passage the model
 * reads.
 */
const readLine = (readAt: Date, through: string): string =>
  `Read on ${readAt.toISOString().slice(0, 10)} through ${through}.`;

/**
 * `texts` with their credentials redacted, inside JSON as well as over
 * text (`redactJsonText`), joined; `undefined` when that cannot finish (a
 * JSON nesting too deep to walk) or a second pass would still change one:
 * a credential may be left, so nothing is kept.
 */
const redactedFor = (texts: readonly string[]): string | undefined => {
  try {
    const redacted = texts.map((text) => redactJsonText(text));
    return redacted.every((text) => redactJsonText(text) === text)
      ? redacted.join("\n\n")
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Keeps `text` (redacted, `redactedFor`), read through `through`, under
 * `id` for the chat's person alone, after the line saying when and
 * through what it was read (`readLine`): what it
 * ended in, kept, or skipped as `stale` or `erased`. Throws when the Brain
 * refused it otherwise (a text past its limit) or couldn't be reached.
 */
const keptAs = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  id: string,
  { text, through }: { text: string; through: string },
  readAt: Date
): Promise<Ended> => {
  try {
    // Owner content: core's Brain module keeps it in the person's own
    // store, never the shared one.
    const added = await addSource(env, {
      source: { producer: "capture", id },
      // Erased with it when the connection is disconnected, and refused
      // from then on.
      group: captureGroupOf(connectionId),
      // A change of its own each time: the same text again is the current
      // version (the Brain's rule), so reading an unchanged item adds
      // nothing, and an item that changed back is a version again.
      change: crypto.randomUUID(),
      text: `${readLine(readAt, through)}\n\n${text}`,
      readers: { kind: "owner", personId: scope.personId },
      readAt,
    });
    // A later read of it was kept first: this older one is not.
    if (added.newer === true) {
      return skippedAll("stale", 1);
    }
  } catch (error) {
    if (brainSourceErrors.codeOf(error) === "brain.source_erased") {
      // Its key closed by an erasure, or the person's store erased: final.
      return skippedAll("erased", 1);
    }
    throw error;
  }
  return ["brain.capture.kept", { items: 1, kept: 1, failed: 0, skipped: 0 }];
};

/**
 * What keeping the whole answer of a toolkit's read of `action` with
 * `input` ended in (GRA-1845): one item, the answer, its blocks left out
 * counted (`leftOut`) when there were any.
 */
const answerCaptured = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  action: string,
  input: unknown,
  { result, readAt }: Read,
  through: string
): Promise<Ended> => {
  const { texts, leftOut } = answerText(result.output);
  const counted: Record<string, number> = leftOut === 0 ? {} : { leftOut };
  if (texts.join("").trim() === "") {
    const [event, detail] = skippedAll("no_text", 1);
    return [event, { ...detail, ...counted }];
  }
  const text = redactedFor(texts);
  if (text === undefined) {
    const [event, detail] = skippedAll("credential", 1);
    return [event, { ...detail, ...counted }];
  }
  let ended: Ended;
  try {
    const id = await answerCaptureIdOf(
      connectionId,
      scope.personId,
      action,
      input
    );
    ended = await keptAs(
      env,
      scope,
      connectionId,
      id,
      { text, through },
      readAt
    );
  } catch (error) {
    // The Brain refused it (a text past its limit) or couldn't be
    // reached: the one item failed.
    log.warn("connection_capture.failed", {
      connectionId,
      chatId: scope.chatId,
      ...errorFields(error),
    });
    ended = [
      "brain.capture.failed",
      { items: 1, kept: 0, failed: 1, skipped: 0 },
    ];
  }
  const [event, detail] = ended;
  return [event, { ...detail, ...counted }];
};

/** The classes of a native tool whose one item capture keeps. */
const itemClasses: ReadonlySet<ToolClass | undefined> = new Set(["read-own"]);

/** The classes of a tool whose whole answer capture keeps (GRA-1845). */
const answerClasses: ReadonlySet<ToolClass | undefined> = new Set([
  "read-own",
  "read-company",
]);

/** What capturing `result` of `action` ended in. */
const captured = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  action: string,
  input: unknown,
  { result, readAt }: Read
): Promise<Ended> => {
  const [owner] = await connectionOwnersOf(env, [connectionId]);
  // A whole answer is one item, whatever its server named.
  const answers = owner !== undefined && keepsWholeAnswers(owner.source);
  const named = answers ? 1 : new Set(result.provenance).size;
  if (owner?.ownerUserId !== scope.personId) {
    return skippedAll("shared", named);
  }
  if (!(answers ? answerClasses : itemClasses).has(classOf(owner, action))) {
    return skippedAll("reach", named);
  }
  if (answers) {
    return await answerCaptured(
      env,
      scope,
      connectionId,
      action,
      input,
      { result, readAt },
      owner.provider
    );
  }
  const itemRead = itemReadOf(owner.provider, action);
  const [itemId] = result.provenance;
  if (itemRead === undefined || named !== 1 || itemId === undefined) {
    return skippedAll("list", named);
  }
  // A file read as base64 (the default): bytes are no text to find.
  if (itemRead === "file" && !asksText(input)) {
    return skippedAll("file", 1);
  }
  const id = await captureIdOf(connectionId, scope.personId, action, itemId);
  const text = redactedFor([result.output]);
  if (text === undefined) {
    return skippedAll("credential", 1);
  }
  return await keptAs(
    env,
    scope,
    connectionId,
    id,
    { text, through: owner.provider },
    readAt
  );
};

/**
 * Keeps what the chat's agent read with the tool `action` through
 * `connectionId` (`result`) as a source its person alone may read, if
 * connect said it may be kept, the connection is that person's own and
 * the tool reaches their own things: a native tool's one item, when it
 * answers one item's content (not a file's bytes); a toolkit's whole
 * answer. For `waitUntil`: never throws.
 */
export const captureRead = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  action: string,
  input: unknown,
  read: Read
): Promise<void> => {
  const { result } = read;
  if (result.keep !== true) {
    return;
  }
  let ended: Ended;
  try {
    ended = await captured(env, scope, connectionId, action, input, read);
  } catch (error) {
    // Connect unreachable, or the Brain refused a native item (a text
    // past its limit) or couldn't be reached: each item failed. A whole
    // answer's failure ends in `answerCaptured`, so only connect failing
    // to say what the connection is leaves its kind unknown here: then
    // the call counts the items it named, and at least one, its answer.
    log.warn("connection_capture.failed", {
      connectionId,
      chatId: scope.chatId,
      ...errorFields(error),
    });
    const items = Math.max(1, new Set(result.provenance).size);
    ended = [
      "brain.capture.failed",
      { items, kept: 0, failed: items, skipped: 0 },
    ];
  }
  try {
    await audited(env, scope, connectionId, ...ended);
  } catch (error) {
    log.error("connection_capture.unaudited", {
      connectionId,
      chatId: scope.chatId,
      ...errorFields(error),
    });
  }
};
