import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import type { ConnectResult, ToolClass } from "@grasp-os/shared/connect";
import { errorFields, log } from "@grasp-os/shared/log";
import { redact } from "@grasp-os/shared/redact";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { chatAuthority } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { keepAuditEvent } from "./audit-outbox.ts";
import { captureGroupOf } from "./brain-next-origins.ts";
import { addSource } from "./brain-next.ts";
import type { SourceReaders, SourceRef } from "./brain-next.ts";
import { answerText } from "./connection-answer.ts";
import {
  answerCaptureIdOf,
  captureIdOf,
  keepsWholeAnswers,
  sharedReadHashOf,
} from "./connection-capture-key.ts";
import { connectionOwnersOf } from "./connections.ts";
import { nativeItemReads } from "./native-tool-classes.gen.ts";
import { claimSharedRead } from "./shared-reads.ts";
import { classOf } from "./tool-classes.ts";
import type { CallingRun } from "./workflows/resource-authority.ts";
import { markCaptured } from "./workflows/run-evidence.ts";

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
//   as below. A shared connection's reads are the shared Brain's (below).
//   A native tool that reaches the company's or others' things (a SharePoint list, a shared drive,
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
//   their erasure erase it all (below). A shared connection's reads are
//   the shared Brain's, with the audience an admin chooses (below), under
//   their own connection's keys, so the two never meet. Not a native
//   connector's, which is kept item by item as
//   above, its own things only.
// - When it was read is the version's, not its text's: each capture
//   carries when its tool answered (`readAt`), which the Brain keeps per
//   read and gives as the version's latest read time, on the person's
//   Sources page and in the passage the model reads. A read again of the
//   same text adds that read time to its version, and no version.
// - Credentials are redacted once, over exactly the text kept (a
//   toolkit's blocks joined first, a native item's whole answer), so what
//   is kept never holds anything `redact` removes from that same text. Not
//   yet inside JSON string values, where an escaped newline can hide the
//   next line's credential (GRA-1880).
// - Capturing never holds up or fails the call: it runs once the agent
//   has its answer (`waitUntil`). Every call ends in one audit event, of
//   IDs and counts alone (items, kept, failed, skipped, adding up to
//   items): kept, failed, or skipped with the reason (`shared`, `reach`,
//   `list`, `file`, `no_text`, `erased`, `stale`). Captures of one item run
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

// A workflow run's reads (GRA-1828; the threat model and the decisions
// are on the issue) are kept the same way, by the same code, when the run
// acts for one person (`captureRunRead`): one a person started, or an App
// or an agent for the person it works for, its principal. A run a trigger
// started (a schedule, a webhook, a connector's event, a reply to a run's
// mail) acts as the workflow itself, nobody opening anything there and
// then: it keeps nothing for anyone's own store, only what it reads
// through a shared connection, for its audience (above). Nothing is kept
// of a call that passes a sensitive
// argument (`sensitive`): the key hashes the call's input, and the answer
// may carry what the value gave. What a run keeps is not a read of the
// Brain, so nothing of it is pinned with the run (run-evidence.ts), whose
// checks read as the company: the run read the connection, whose
// authority is decided again on each call. The run is marked as one that
// kept something before the Brain is written (`markCaptured`), so it
// hands over only how it ended, never what it returned: a copy of what it
// read that disconnecting the connection wouldn't erase.

// A shared connection's reads (GRA-1831; the threat model and the
// decisions are on the issue) are kept by the same rules, in the shared
// store, for whoever the connection's Brain audience holds at each recall
// (`connection` readers): one record for the whole audience, whoever read
// it, so its key names no person (connection-capture-key.ts
// `sharedReadHashOf`). Each is named first (shared-reads.ts
// `claimSharedRead`), only while the connection has an audience, isn't
// being erased and wasn't disconnected, in the statement that names it:
// so an erasure lists every key it must erase, and one with no audience
// keeps nothing (`no_audience`). A run a trigger started keeps these too:
// who may read them is the audience's, not the reader's. The admin chose
// who may read what agents read through the connection: one account reads
// for everyone, and its own rules per person are not mirrored.

type CaptureEvent =
  | "brain.capture.kept"
  | "brain.capture.skipped"
  | "brain.capture.failed";

/**
 * For whom a read is kept, and where it was read: the one person whose
 * own store keeps it, the chat or the run that read it, and who read it
 * as its audit event names them (asked as the event is kept, so a scope
 * core can't name an agent of fails the event alone).
 */
interface Capturer {
  /**
   * Undefined for a run a trigger started: it acts for nobody, so it
   * keeps reads through a shared connection alone, and records nothing
   * else.
   */
  readonly personId: string | undefined;
  readonly where: { readonly chat: string } | { readonly run: string };
  readonly actor: () => AuditActor;
  /**
   * Asked just before anything is written to the Brain; throws to keep
   * it nowhere. A run's marks it as one whose result copies what it kept.
   */
  readonly beforeKeep?: () => Promise<void>;
}

/** A chat's agent's read, kept for the chat's person. */
const chatCapturer = (scope: AgentScope): Capturer => ({
  personId: scope.personId,
  where: { chat: scope.chatId },
  actor: () => delegateActorOf(chatAuthority(scope), scope.via),
});

/** The audit event a capture ends in, through core's outbox. */
const audited = async (
  env: Env,
  capturer: Capturer,
  connectionId: string,
  action: CaptureEvent,
  detail: Record<string, string | number>
): Promise<void> => {
  await keepAuditEvent(env, drizzle(env.DB), {
    actor: capturer.actor(),
    action,
    target: { type: "connection", id: connectionId },
    detail: { ...detail, ...capturer.where },
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

/** What was read: a native tool's one item, or a whole answer's call. */
type ReadNamed = { readonly itemId: string } | { readonly input: unknown };

/**
 * Whose a read is: the capturer's own, through their own connection, or
 * the connection's audience's, through a shared one.
 */
type Lane = { kind: "own"; personId: string } | { kind: "shared" };

/** Where a read is kept: its source, who reads it, and the group it is erased with. */
interface Place {
  source: SourceRef;
  readers: SourceReaders;
  group?: SourceRef;
}

/**
 * Where `read` of `action` through `connectionId` is kept: for the
 * capturer alone, in their own store, erased with the connection's
 * group; or, through a shared connection, in the shared store for its
 * audience, named first (`claimSharedRead`): nowhere while it has none.
 */
const placeOf = async (
  env: Env,
  lane: Lane,
  connectionId: string,
  action: string,
  read: ReadNamed,
  readAt: Date
): Promise<Place | undefined> => {
  if (lane.kind === "shared") {
    const source = await claimSharedRead(
      env,
      connectionId,
      await sharedReadHashOf(action, read),
      readAt
    );
    return source === undefined
      ? undefined
      : { source, readers: { kind: "connection", connectionId } };
  }
  const { personId } = lane;
  const id =
    "itemId" in read
      ? await captureIdOf(connectionId, personId, action, read.itemId)
      : await answerCaptureIdOf(connectionId, personId, action, read.input);
  return {
    source: { producer: "capture", id },
    readers: { kind: "owner", personId },
    // Erased with it when the connection is disconnected, and refused
    // from then on.
    group: captureGroupOf(connectionId),
  };
};

/**
 * Keeps `text` (redacted), what `read` of `action` through `connectionId`
 * gave at `readAt`, where its lane keeps it (`placeOf`): what it ended
 * in, kept, or skipped as `no_audience`, `stale` or `erased`. Throws when
 * the Brain refused it otherwise (a text past its limit) or couldn't be
 * reached.
 */
const keptAs = async (
  env: Env,
  capturer: Capturer,
  { connectionId, lane }: { connectionId: string; lane: Lane },
  action: string,
  read: ReadNamed,
  { text, readAt }: { text: string; readAt: Date }
): Promise<Ended> => {
  const place = await placeOf(env, lane, connectionId, action, read, readAt);
  if (place === undefined) {
    return skippedAll("no_audience", 1);
  }
  await capturer.beforeKeep?.();
  try {
    // Core's Brain module keeps one person's alone in their own store,
    // and an audience's in the shared one.
    const added = await addSource(env, {
      ...place,
      // A change of its own each time: the same text again is the current
      // version (the Brain's rule), so reading an unchanged item adds no
      // version, only its read time, and an item that changed back is a
      // version again.
      change: crypto.randomUUID(),
      text,
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
  capturer: Capturer,
  kept: { connectionId: string; lane: Lane },
  action: string,
  input: unknown,
  { result, readAt }: Read
): Promise<Ended> => {
  const { texts, leftOut } = answerText(result.output);
  const counted: Record<string, number> = leftOut === 0 ? {} : { leftOut };
  if (texts.join("").trim() === "") {
    const [event, detail] = skippedAll("no_text", 1);
    return [event, { ...detail, ...counted }];
  }
  // Redacted once, over exactly the text kept: a credential's name in one
  // block and its value in the next are one credential.
  const text = redact(texts.join("\n\n"));
  let ended: Ended;
  try {
    ended = await keptAs(
      env,
      capturer,
      kept,
      action,
      { input },
      {
        text,
        readAt,
      }
    );
  } catch (error) {
    // The Brain refused it (a text past its limit) or couldn't be
    // reached: the one item failed.
    log.warn("connection_capture.failed", {
      connectionId: kept.connectionId,
      ...capturer.where,
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

/**
 * What capturing `result` of `action` ended in: nothing to record for a
 * run a trigger started, through a connection that isn't shared.
 */
const captured = async (
  env: Env,
  capturer: Capturer,
  connectionId: string,
  action: string,
  input: unknown,
  { result, readAt }: Read
): Promise<Ended | undefined> => {
  const [owner] = await connectionOwnersOf(env, [connectionId]);
  // A whole answer is one item, whatever its server named.
  const answers = owner !== undefined && keepsWholeAnswers(owner.source);
  const named = answers ? 1 : new Set(result.provenance).size;
  let lane: Lane;
  if (owner?.ownerUserId === null) {
    lane = { kind: "shared" };
  } else if (capturer.personId === undefined) {
    return undefined;
  } else if (owner?.ownerUserId === capturer.personId) {
    lane = { kind: "own", personId: capturer.personId };
  } else {
    // Connect doesn't know it, or it is someone else's (a call connect
    // refuses: `connect.not_owner`).
    return skippedAll("shared", named);
  }
  if (!(answers ? answerClasses : itemClasses).has(classOf(owner, action))) {
    return skippedAll("reach", named);
  }
  const kept = { connectionId, lane };
  if (answers) {
    return await answerCaptured(env, capturer, kept, action, input, {
      result,
      readAt,
    });
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
  return await keptAs(
    env,
    capturer,
    kept,
    action,
    { itemId },
    { text: redact(result.output), readAt }
  );
};

/** Keeps the audit event `ended` names; a failure to is logged. */
const endedAudited = async (
  env: Env,
  capturer: Capturer,
  connectionId: string,
  ended: Ended
): Promise<void> => {
  try {
    await audited(env, capturer, connectionId, ...ended);
  } catch (error) {
    log.error("connection_capture.unaudited", {
      connectionId,
      ...capturer.where,
      ...errorFields(error),
    });
  }
};

/**
 * Keeps what was read with the tool `action` through `connectionId`
 * (`read`) for `capturer`, as `captureRead` says. Never throws.
 */
const capturedFor = async (
  env: Env,
  capturer: Capturer,
  connectionId: string,
  action: string,
  input: unknown,
  read: Read
): Promise<void> => {
  const { result } = read;
  if (result.keep !== true) {
    return;
  }
  let ended: Ended | undefined;
  try {
    ended = await captured(env, capturer, connectionId, action, input, read);
  } catch (error) {
    // Connect unreachable, or the Brain refused a native item (a text
    // past its limit) or couldn't be reached: each item failed. A whole
    // answer's failure ends in `answerCaptured`, so only connect failing
    // to say what the connection is leaves its kind unknown here: then
    // the call counts the items it named, and at least one, its answer.
    log.warn("connection_capture.failed", {
      connectionId,
      ...capturer.where,
      ...errorFields(error),
    });
    const items = Math.max(1, new Set(result.provenance).size);
    ended = [
      "brain.capture.failed",
      { items, kept: 0, failed: items, skipped: 0 },
    ];
  }
  if (ended !== undefined) {
    await endedAudited(env, capturer, connectionId, ended);
  }
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
  await capturedFor(
    env,
    chatCapturer(scope),
    connectionId,
    action,
    input,
    read
  );
};

/** A workflow run's call, as its capture needs to know it. */
export interface RunRead {
  /** The run, and whom it acts for (its principal). */
  readonly run: Pick<CallingRun, "runId" | "principal" | "invoker">;
  /** Whether the call passed a sensitive argument (a binding argument). */
  readonly sensitive: boolean;
  /**
   * When the step's attempt ends (resource-calls.ts `Effect.deadline`), in
   * milliseconds since the epoch: the step waits for its capture, which
   * may take no more than half of what is left of it.
   */
  readonly deadline: number;
}

/**
 * Whether `capture` ended within `ms`; never rejects (`capture` doesn't).
 * One it outlasted goes on by itself.
 */
const endedWithin = async (
  capture: Promise<void>,
  ms: number
): Promise<boolean> =>
  await Promise.race([
    capture.then(() => true as const),
    scheduler.wait(ms).then(() => false as const),
  ]);

/**
 * Keeps what workflow run `run` read with the tool `action` through
 * `connectionId` (`read`) for the one person it acts for, by
 * `captureRead`'s rules, when it acts for one (the header), and what it
 * read through a shared connection for its audience. A run a trigger
 * started acts for nobody: only its reads through a shared connection are
 * kept, and nothing else of its calls is recorded. A call that passed a
 * sensitive argument is skipped (`sensitive`). Never throws.
 */
export const captureRunRead = async (
  env: Env,
  { run, sensitive, deadline }: RunRead,
  connectionId: string,
  action: string,
  input: unknown,
  read: Read
): Promise<void> => {
  if (read.result.keep !== true) {
    return;
  }
  const capturer: Capturer = {
    personId: run.invoker.type === "trigger" ? undefined : run.principal,
    where: { run: run.runId },
    // As the run's call receipts name it (resource-calls.ts): the
    // workflow, as a run, is the system's.
    actor: () => ({ type: "system" }),
    // Marked before the Brain is written, so a run whose read may be kept
    // hands over only how it ended, never a copy of it in what it returned
    // that disconnecting wouldn't erase (brain-sources.ts). Unmarked, the
    // read is kept nowhere: the item fails.
    beforeKeep: async () => {
      await markCaptured(env, run.runId);
    },
  };
  // The step waits for its capture (a run host has no `waitUntil`), and a
  // capture is best effort: it never costs the run its answer, which the
  // host takes only while the step's attempt holds its lease. So it may
  // take half of what the attempt has left as the answer came, the other
  // half left for the step's own code; with nothing left, it is skipped.
  // One that takes longer is given up: the step goes on, and the capture
  // with it, by itself. It still lands whole or not at all, never half:
  // the run was marked before anything is written, so a mark with no
  // capture only makes the run hand over how it ended, the safe side; and
  // once the run has ended, its row takes no mark, so nothing is kept.
  const left = deadline - Date.now();
  const budget = Math.floor(left / 2);
  // Counted as the items it named, and at least one, as a failure is.
  const items = Math.max(1, new Set(read.result.provenance).size);
  if (budget <= 0) {
    log.warn("connection_capture.skipped_late", {
      connectionId,
      ...capturer.where,
      items,
      leftMs: left,
    });
    return;
  }
  const capture = sensitive
    ? endedAudited(env, capturer, connectionId, skippedAll("sensitive", items))
    : capturedFor(env, capturer, connectionId, action, input, read);
  if (!(await endedWithin(capture, budget))) {
    log.warn("connection_capture.given_up", {
      connectionId,
      ...capturer.where,
      items,
      waitedMs: budget,
    });
  }
};
