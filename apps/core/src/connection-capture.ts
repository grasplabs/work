import { delegateActorOf } from "@grasp-os/shared/audit";
import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import type { ConnectResult, ConnectionOwner } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { redact } from "@grasp-os/shared/redact";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { chatAuthority } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { addSource } from "./brain-next.ts";
import { captureIdOf } from "./connection-capture-key.ts";
import { connectionOwnersOf } from "./connections.ts";
import { nativeItemReads } from "./native-tool-classes.gen.ts";
import { nativeClasses } from "./tool-classes.ts";

// Capture (GRA-1730): what a chat's agent reads through its person's own
// connection is kept in the Brain, an item a source, so every connected
// system feeds it with nothing built per connector. Core relays every
// call (agent-connections.ts) and captures there, after the agent has its
// answer; connect and the Brain never call each other. The threat model
// and the decisions are on GRA-1730; in short:
//
// - Connect decides what may be kept (`ConnectResult.keep`): a read it
//   carried out just now, whose server named the items it read, from a
//   connection whose provider's terms allow copies. Without its word
//   nothing is kept: a change, a held call, a replay, a refusal, an
//   answer that names no item.
// - Only the person's own connection, and only a tool that reaches the
//   person's own things (classed `read-own`: its manifest's reach `own`,
//   or a Composio tool its review classes so). Its items are theirs alone
//   (`owner`), as the plan's Owner is "the one whose own connection
//   brought it in". A shared connection's reads, and a tool that reaches
//   the company's or others' things (a SharePoint list, a shared drive,
//   another mailbox), are kept by nothing yet: a copy readable by its
//   person alone would outlive their access at the source. They come back
//   with native sync, which brings each item's readers.
// - Only a tool that answers one item's content, as its manifest declares
//   (`answersItem`: Gmail's message and attachment reads, OneNote's page
//   read), kept whole as that item's source for the tool, in the person's
//   own store (owner content), credentials redacted (`redact`); never the
//   call's input. What a tool is decides it, never how many items came
//   back: a list or a search is never kept, even with one hit (a snippet
//   beside the full copy is noise in recall, and every changed summary
//   would be a version). Nor is a file's content read as base64 (the
//   default of a tool that answers a file): bytes are no text to find.
//   No Composio or MCP tool carries the mark today (GRA-1845). No cap of
//   its own: the Brain's own limit on a source refuses what is past it,
//   and the item fails. Outside text is content: a captured source is
//   never an instruction file, and the model reads it as evidence, cited
//   as `capture:` (turn-recall.ts).
// - Capturing never holds up or fails the call: it runs once the agent
//   has its answer (`waitUntil`). Every call ends in one audit event, of
//   IDs and counts alone (items, kept, failed, skipped, adding up to
//   items): kept, failed, or skipped with the reason (`shared`, `reach`,
//   `list`, `file`, `erased`, `stale`). Captures of one item run
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
//   it was read in leaves it. Disconnecting the connection leaves it too,
//   until GRA-1827 erases a connection's captures; so does deleting the
//   item at its source (nothing tells core). A person can't remove one
//   short of their own erasure, which removes all of theirs.

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
 * for every other tool: a list or a search, and every Composio or MCP
 * tool, which nothing marks today (GRA-1845).
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
 * The class connect and the release give the tool `action` of `owner`'s
 * connection: a Composio tool's from its review, a native one's from its
 * manifest. Undefined for one neither knows (an HTTP connection's).
 */
const classOf = (owner: ConnectionOwner, action: string) =>
  owner.source === "composio"
    ? owner.toolClasses?.[action]
    : nativeClasses.get(owner.provider)?.get(action);

/** What capturing `result` of `action` ended in. */
const captured = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  action: string,
  input: unknown,
  { result, readAt }: Read
): Promise<Ended> => {
  const named = new Set(result.provenance).size;
  const [owner] = await connectionOwnersOf(env, [connectionId]);
  if (owner?.ownerUserId !== scope.personId) {
    return skippedAll("shared", named);
  }
  if (classOf(owner, action) !== "read-own") {
    return skippedAll("reach", named);
  }
  const itemRead =
    owner.source === "native" ? itemReadOf(owner.provider, action) : undefined;
  const [itemId] = result.provenance;
  if (itemRead === undefined || named !== 1 || itemId === undefined) {
    return skippedAll("list", named);
  }
  // A file read as base64 (the default): bytes are no text to find.
  if (itemRead === "file" && !asksText(input)) {
    return skippedAll("file", 1);
  }
  const id = await captureIdOf(connectionId, scope.personId, action, itemId);
  try {
    // Owner content: core's Brain module keeps it in the person's own
    // store, never the shared one.
    const added = await addSource(env, {
      source: { producer: "capture", id },
      // A change of its own each time: the same text again is the current
      // version (the Brain's rule), so reading an unchanged item adds
      // nothing, and an item that changed back is a version again.
      change: crypto.randomUUID(),
      text: redact(result.output),
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
 * Keeps the item the chat's agent read with the tool `action` through
 * `connectionId` (`result`) as a source its person alone may read, if
 * connect said it may be kept, the connection is that person's own, the
 * tool reaches their own things and answers one item's content (not a
 * file's bytes). For `waitUntil`: never
 * throws.
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
    // Connect unreachable, or the Brain refused the item (a text past its
    // limit) or couldn't be reached: each item failed.
    log.warn("connection_capture.failed", {
      connectionId,
      chatId: scope.chatId,
      ...errorFields(error),
    });
    const items = new Set(result.provenance).size;
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
