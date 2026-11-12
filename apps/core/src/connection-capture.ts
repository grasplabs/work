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
// - One source per item and tool, in the person's own store (owner
//   content): the item's part of the output (the one object that names
//   it, or the whole output when the read named one item), credentials
//   redacted (`redact`); never the call's input. When the output can't be
//   split by item, nothing of the call is kept. No cap of its own: the
//   Brain's own limit on a source refuses what is past it, and that item
//   fails. Outside text is content: a captured source is never an
//   instruction file.
// - Capturing never holds up or fails the call: it runs once the agent
//   has its answer (`waitUntil`). Every call ends in one audit event, of
//   IDs and counts alone (items, kept, failed, skipped): kept when an item
//   was, failed when none was and one failed, skipped otherwise (with the
//   reason when the whole call was). An item whose key an erasure closed
//   is skipped, not failed: that refusal is final and expected.

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

/**
 * Each item `ids` names, with its part of `output` (JSON text): the whole
 * output when it names one item; otherwise the one object in it whose
 * `id` is the item's, as connectors list what they read. Undefined when
 * an item has no such object, or more than one, or the output isn't JSON:
 * then the output can't be split by item.
 */
const itemsOf = (
  output: string,
  ids: readonly string[]
): Map<string, string> | undefined => {
  const named = new Set(ids);
  if (named.size === 1) {
    return new Map([...named].map((id) => [id, output]));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  const found = new Map<string, unknown[]>();
  // Every value, by a stack: an output can nest deeper than a call stack.
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      stack.push(...items);
    } else if (isObject(value)) {
      const { id } = value;
      if (typeof id === "string" && named.has(id)) {
        found.set(id, [...(found.get(id) ?? []), value]);
      }
      stack.push(...Object.values(value));
    }
  }
  const items = new Map<string, string>();
  for (const id of named) {
    const objects = found.get(id) ?? [];
    if (objects.length !== 1) {
      return undefined;
    }
    items.set(id, JSON.stringify(objects[0]));
  }
  return items;
};

/** What a call's capture ended in: its event and the event's detail. */
type Ended = [CaptureEvent, Record<string, string | number>];

/** A whole call skipped for `reason`: each of its `items` skipped. */
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
  const items = itemsOf(result.output, result.provenance);
  if (items === undefined) {
    return skippedAll("unsplittable", named);
  }
  let kept = 0;
  let failed = 0;
  let skipped = 0;
  for (const [itemId, part] of items) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one item at a time
      const id = await captureIdOf(
        connectionId,
        scope.personId,
        action,
        itemId
      );
      // Owner content: core's Brain module keeps it in the person's own
      // store, never the shared one.
      // oxlint-disable-next-line no-await-in-loop -- one item at a time
      await addSource(env, {
        source: { producer: "capture", id },
        // A change of its own each time: the same text again is the
        // current version (the Brain's rule), so reading an unchanged item
        // adds nothing, and an item that changed back is a version again.
        change: crypto.randomUUID(),
        text: redact(part),
        readers: { kind: "owner", personId: scope.personId },
      });
      kept += 1;
    } catch (error) {
      if (brainSourceErrors.codeOf(error) === "brain.source_erased") {
        // Its key closed by an erasure, or the person's store erased.
        skipped += 1;
      } else {
        // Refused by the Brain (a text past its limit) or unreachable:
        // this item is not kept, the others go on.
        log.warn("brain.capture.item_failed", {
          connectionId,
          chatId: scope.chatId,
          ...errorFields(error),
        });
        failed += 1;
      }
    }
  }
  const counts = { items: items.size, kept, failed, skipped };
  if (kept > 0) {
    return ["brain.capture.kept", counts];
  }
  return [
    failed > 0 ? "brain.capture.failed" : "brain.capture.skipped",
    counts,
  ];
};

/**
 * Keeps each item the chat's agent read with the tool `action` through
 * `connectionId` (`result`) as a source its person alone may read, if
 * connect said it may be kept, the connection is that person's own, and
 * the tool reaches their own things. For `waitUntil`: never
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
    // Before any item was added (connect unreachable, say): each failed.
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
