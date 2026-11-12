import { delegateActorOf } from "@grasp-os/shared/audit";
import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import type { ConnectResult, ConnectionOwner } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { redact } from "@grasp-os/shared/redact";
import { drizzle } from "drizzle-orm/d1";

import { chatAuthority } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { addSource } from "./brain-next.ts";
import { captureIdOf } from "./connection-capture-key.ts";
import { connectionOwnersOf } from "./connections.ts";
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
// - Only a read of one item (its provenance names exactly one), kept
//   whole as that item's source for the tool, in the person's own store
//   (owner content), credentials redacted (`redact`); never the call's
//   input. A list or a search (several items) is not kept: a snippet
//   beside the full copy is noise in recall, and every changed summary
//   would be a version. Nor is a file read (`contentAs`'s base64): bytes
//   are no text to find, and past the Brain's limit they would fail each
//   time. No cap of its own: the Brain's own limit on a source refuses
//   what is past it, and the item fails. Outside text is content: a
//   captured source is never an instruction file.
// - Capturing never holds up or fails the call: it runs once the agent
//   has its answer (`waitUntil`). Every call ends in one audit event, of
//   IDs and counts alone (items, kept, failed, skipped, adding up to
//   items): kept, failed, or skipped with the reason (`shared`, `reach`,
//   `list`, `file`, `erased`).

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `output` is a file's bytes as base64 (`contentAs`'s answer). */
const isFileAnswer = (output: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return false;
  }
  return isObject(parsed) && parsed.encoding === "base64";
};

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
  result: ConnectResult
): Promise<Ended> => {
  const named = new Set(result.provenance).size;
  const [owner] = await connectionOwnersOf(env, [connectionId]);
  if (owner?.ownerUserId !== scope.personId) {
    return skippedAll("shared", named);
  }
  if (classOf(owner, action) !== "read-own") {
    return skippedAll("reach", named);
  }
  const [itemId] = result.provenance;
  if (named !== 1 || itemId === undefined) {
    return skippedAll("list", named);
  }
  if (isFileAnswer(result.output)) {
    return skippedAll("file", 1);
  }
  const id = await captureIdOf(connectionId, scope.personId, action, itemId);
  try {
    // Owner content: core's Brain module keeps it in the person's own
    // store, never the shared one.
    await addSource(env, {
      source: { producer: "capture", id },
      // A change of its own each time: the same text again is the current
      // version (the Brain's rule), so reading an unchanged item adds
      // nothing, and an item that changed back is a version again.
      change: crypto.randomUUID(),
      text: redact(result.output),
      readers: { kind: "owner", personId: scope.personId },
    });
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
 * tool reaches their own things, and the read names one item, not a file. For `waitUntil`: never
 * throws.
 */
export const captureRead = async (
  env: Env,
  scope: AgentScope,
  connectionId: string,
  action: string,
  result: ConnectResult
): Promise<void> => {
  if (result.keep !== true) {
    return;
  }
  let ended: Ended;
  try {
    ended = await captured(env, scope, connectionId, action, result);
  } catch (error) {
    // Connect unreachable, or the Brain refused the item (a text past its
    // limit) or couldn't be reached: each item failed.
    log.warn("brain.capture.failed", {
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
    log.error("brain.capture.unaudited", {
      connectionId,
      chatId: scope.chatId,
      ...errorFields(error),
    });
  }
};
