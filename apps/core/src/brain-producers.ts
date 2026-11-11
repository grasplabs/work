import { log } from "@grasp-os/shared/log";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { addSource } from "./brain-next.ts";
import type { ProducerKind, SourceRef } from "./brain-next.ts";
import { personErasures } from "./db/core/schema.ts";

// What core hands over to the new Brain (brain-next.ts) beside today's
// Brain, one producer each: an upload once it is ready, a chat turn once
// it settled, an independent workflow run once it ended. Each builds its
// source from core's own records its call site passes, never from what a
// caller claims, and names its readers here from them.
//
// The rule is the same for each: the one person the record is certainly
// for reads it, nobody else. No team, no audience and no admin: who else
// may read the record in core can change (a collection's sharing, a
// chat's audience, a role), and nothing would tell the Brain, so copying
// that fails open. What core marks restricted or sensitive is not handed
// over at all: the Brain can't mark a source restricted yet.
//
// A hand-over never throws and never rejects: the record it follows is
// done already (the upload ready, the turn answered, the run ended), and
// no step of it may fail because the Brain refused or was out of reach.
// A refusal is logged as one fixed line naming the producer only: no id,
// no text and no error message, which can echo what was added.
//
// Nothing is handed over for a person whose erasure has begun: whatever
// the producer, its reader is checked against core's record of the
// erasure (`personErasures`, person-erasure.ts) just before it is added.
//
// Not producers yet: interviews and meetings; what agents fetch will be
// a producer of its own, with its own reader rule.

/** The one line a refused hand-over logs. */
const refusedEvent = "brain.source_refused";

/**
 * Most UTF-8 bytes of a text handed over, so a long text is cut rather
 * than refused for its length. It stays below the Brain's own bound,
 * `sourceTextMaxBytes` (1,000,000 bytes), which only brain-next.ts may
 * import, hence the literal; the headroom is for the Brain folding the
 * text for its word index, which can grow it. Folding can still grow a
 * text within it past the bound, which the Brain then refuses. A chat
 * keeps its latest messages, labels and all; an upload and a run their
 * text's start (`startOf`).
 */
const textMaxBytes = 900_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Whether `byte` continues a UTF-8 character rather than starting one:
 * `10xxxxxx`.
 */
const continuesCharacter = (byte: number): boolean =>
  byte >= 0x80 && byte < 0xc0;

/**
 * `text`'s start that fits {@link textMaxBytes}, cut where a character
 * starts: the same text each time for the same input, so a repeat is the
 * same change. Well-formed, as all the encoder's and decoder's output is:
 * a lone surrogate is encoded as U+FFFD.
 */
const startOf = (text: string): string => {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= textMaxBytes) {
    return decoder.decode(bytes);
  }
  let end = textMaxBytes;
  while (end > 0 && continuesCharacter(bytes[end] ?? 0)) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
};

/** Logs a refused hand-over: its producer, nothing else. */
const logRefused = (producer: ProducerKind): void => {
  log.error(refusedEvent, { producer });
};

/**
 * Whether core's records say `personId`'s erasure has begun: its row in
 * `personErasures`, keyed by their user id, is written as it is asked for
 * (`erasePerson`) and kept after it completed.
 */
const erasureBegun = async (env: Env, personId: string): Promise<boolean> => {
  const [erasure] = await drizzle(env.DB)
    .select({ userId: personErasures.userId })
    .from(personErasures)
    .where(eq(personErasures.userId, personId))
    .limit(1);
  return erasure !== undefined;
};

/**
 * Adds `text` as `change` of `source`, read by `personId` alone (every
 * producer's one reader); whether it was added. Nothing for a person whose
 * erasure has begun (`erasureBegun`), skipped without a log line: like a
 * restricted record, it is one core holds back on purpose, not one the
 * Brain refused, and a line per skip would only tell the log that an
 * erased person still had something. When the erasure can't be read,
 * nothing either, logged as a refusal: handed over unchecked, it could
 * add to an erased person's.
 */
const handOver = async (
  env: Env,
  source: SourceRef,
  change: string,
  text: string,
  personId: string
): Promise<boolean> => {
  try {
    if (await erasureBegun(env, personId)) {
      return false;
    }
    await addSource(env, {
      source,
      change,
      // Cut text (a said message's first characters) can end in half a
      // surrogate pair, which the Brain refuses: made whole the same way
      // each time, so a repeat is the same text.
      text: text.toWellFormed(),
      readers: { kind: "owner", personId },
    });
    return true;
  } catch {
    logRefused(source.producer);
    return false;
  }
};

/**
 * Hands over an upload that is ready: as the next version of its
 * document's source (`documentId`, Knowledge's own id, so the same file
 * name uploaded again is the same source, and the file's name is never
 * part of an id), its change the upload, its text's start when it is
 * past the bound (`startOf`). Read by its uploader alone, who
 * certainly saw the file: never the collection's sharing, which can be
 * narrowed at any time, and never admins. Nothing from a sensitive
 * collection, which holds restricted data.
 *
 * Only while the version the upload saved is still its document's
 * current one (`stillCurrent`, asked just before it is added; uploads.ts'
 * `handOverReadyUpload` asks Knowledge): a hand-over that lands after a
 * later upload's would otherwise put the older text on top, as the
 * source's current version. Skipped then without a log line:
 * the later upload hands over its own. This narrows the race rather than
 * closing it: a later upload saved between the check and the add still
 * lands first. When the check can't be read, nothing, logged as a refusal.
 */
export const handOverUpload = async (
  env: Env,
  upload: {
    uploadId: string;
    documentId: string;
    uploadedBy: string;
    sensitive: boolean;
    text: string;
    stillCurrent: () => Promise<boolean>;
  }
): Promise<boolean> => {
  if (upload.sensitive) {
    return false;
  }
  try {
    if (!(await upload.stillCurrent())) {
      return false;
    }
  } catch {
    logRefused("upload");
    return false;
  }
  return await handOver(
    env,
    { producer: "upload", id: upload.documentId },
    upload.uploadId,
    startOf(upload.text),
    upload.uploadedBy
  );
};

/** One message of a chat, as what was said (`saidOf`). */
export interface Said {
  role: "user" | "assistant";
  text: string;
}

/** Who said a message, as the conversation's text names them. */
const speakers = { user: "Person", assistant: "Grasp" } as const;

/**
 * `said` as one text, a message a paragraph labelled by who said it: the
 * latest messages that fit {@link textMaxBytes}.
 */
const conversationOf = (said: readonly Said[]): string => {
  const kept: string[] = [];
  let bytes = 0;
  for (const { role, text } of said.toReversed()) {
    const paragraph = `${speakers[role]}: ${text}`;
    bytes += encoder.encode(`${paragraph}\n\n`).byteLength;
    if (bytes > textMaxBytes) {
      break;
    }
    kept.push(paragraph);
  }
  return kept.toReversed().join("\n\n");
};

/**
 * Hands over a chat as of an answer it kept: the conversation up to and
 * including that answer as the next version of the chat's source (a
 * source is kept whole, and recall reads only its current version), its
 * change that answer (`answer-<message id>`). The text is a function of
 * the answer alone, so whatever hands over the same answer, a turn's
 * capture or one delivered again, late or early, names the same change
 * with the same text: one version. Only questions and answers, as said,
 * never what a step fetched or returned. Read by the chat's own person
 * alone, from the chat's record: never the caller, its agent, or a
 * channel's audience, which can hold outsiders and change with each
 * mention. Nothing from a chat that read restricted data, from which
 * today's Brain takes nothing either. `said` is the chat's messages up
 * to the answer, read by the caller as it calls.
 */
export const handOverChatTurn = async (
  env: Env,
  turn: {
    chatId: string;
    answerId: number;
    personId: string;
    restricted: boolean;
    said: readonly Said[];
  }
): Promise<boolean> => {
  if (turn.restricted) {
    return false;
  }
  const text = conversationOf(turn.said);
  if (text === "") {
    return false;
  }
  return await handOver(
    env,
    { producer: "chat", id: turn.chatId },
    `answer-${turn.answerId}`,
    text,
    turn.personId
  );
};

/** What a run that ended returned, or why it failed: neither, for some. */
export interface RunEnd {
  result?: unknown;
  error?: { message: string };
}

/** A run's text: how it ended, then what it returned or why it failed. */
const runTextOf = (status: string, { result, error }: RunEnd): string => {
  const ended = `Workflow run ${status}.`;
  if (error !== undefined) {
    return `${ended}\n\nFailed: ${error.message}`;
  }
  return result === undefined ? ended : `${ended}\n\n${JSON.stringify(result)}`;
};

/**
 * Hands over an independent workflow run that ended, once (its change
 * the end: an ended run never changes). Its text is a line naming how it
 * ended, then what it returned as JSON or why it failed, read by
 * `readEnd`; a run with neither (cancelled, or past its retention) is the
 * line alone, which still says it ended. When `readEnd` fails, nothing
 * is handed over (logged as a refusal): a run handed over without its
 * result would be that version for good. Past the bound, its text's
 * start (`startOf`): how it ended, and as much of the rest as fits. Read
 * by the person it acted for alone: never the workflow's owner or
 * builders, never what started it (an App, an agent or a trigger) and
 * never admins, who read its result in core today. Nothing from a
 * restricted run.
 */
export const handOverRun = async (
  env: Env,
  run: {
    runId: string;
    principalId: string;
    restricted: boolean;
    status: string;
    readEnd: () => Promise<RunEnd>;
  }
): Promise<boolean> => {
  if (run.restricted) {
    return false;
  }
  let end: RunEnd;
  try {
    end = await run.readEnd();
  } catch {
    logRefused("run");
    return false;
  }
  return await handOver(
    env,
    { producer: "run", id: run.runId },
    "end",
    startOf(runTextOf(run.status, end)),
    run.principalId
  );
};
