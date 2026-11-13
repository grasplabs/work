import type { AuditDetailValue, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import type { ChatWork } from "@grasp-os/shared/chat";
import { draftErrors } from "@grasp-os/shared/drafts";
import type { Draft, DraftCheckpoint, Version } from "@grasp-os/shared/drafts";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Subject, SubjectKind } from "@grasp-os/shared/subject";
import { and, asc, desc, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed, outboxedWhere } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  draftBlobs,
  draftCheckpointFiles,
  draftCheckpoints,
  draftFiles,
  drafts,
} from "./db/core/schema.ts";
import { notNullFailed } from "./db/d1.ts";
import { draftWatch } from "./durable-objects.ts";

// The draft of an App or a workflow (GRA-1665): one per subject, in core's
// database, shared by everyone who builds it and by their chats' agents
// (agent-builds.ts, agent-workflow-build.ts, drafts-rpc.ts). Only core
// calls these, having checked the writer may write the subject's draft
// (its kind's `editable`) and, for an agent, that its code run is still
// open. What differs by kind (who may write, which version a draft is
// over, a version's files) is its `DraftKind` (apps.ts,
// workflow-resources.ts); publishing a draft is publish.ts's, with each
// kind's `PublishSteps`.
//
// Threat model, and how each is closed:
//
// - Two writers at once (two people's agents, or a person and an agent).
//   Every write names the revision it read and takes the next one in the
//   batch that writes it, only while the draft is still at the one it
//   read: of two writes made from the same read the second is refused
//   (`draft.conflict`) and the first stays, never merged or overwritten.
//   The writer reads the draft again and writes anew.
// - A write that loses its checkpoint. Each write keeps the draft as it
//   left it as a checkpoint in the same batch: none lands without its
//   checkpoint, and none is kept for one that didn't land. An agent
//   turn's writes amend its own checkpoint while it is the newest and
//   nothing else moved the draft since, so a turn is one checkpoint to
//   step back to; a person's own edit and a restore are each one of their
//   own. Nothing has to notice a turn's end, which a restart may skip.
// - A write by someone who may no longer make it (an archived or removed
//   App, a deleted workflow, a builder who lost their role since they
//   were let in). The revision a write takes is NULL, failing the batch,
//   once its kind's `stillEditable` no longer holds (`nextRevision`); a
//   removed App's draft takes no row at all (migration 0245's triggers).
// - Growth. A checkpoint holds each path's content by its SHA-256, each
//   content once per subject, so most writes add a file or two; what a
//   turn wrote and then wrote over is dropped once no checkpoint holds it.
// - Disclosure. A draft is the subject's code, read by its builders
//   alone, as its versions are; its checkpoints name who wrote them and
//   from which chat, which only those builders and that chat's person
//   read.
// - A publish whose answer was lost. Its batch, tried again
//   (`retriedBatch`), finds its own draft statements done: each holds
//   again for the very write it made (`emptyDraftStatements`), so the retry is
//   answered as the publish it is, never as `draft.conflict`.

/**
 * A subject's draft: the version it began over, the changes written over
 * it, by path (null deletes a file), and an App's own definition, as
 * stored (`definitionText`), null while it is its base's (always for a
 * workflow). `revision` is 0 while there is none.
 */
export interface DraftState {
  base: number | null;
  changes: Record<string, string | null>;
  definition: string | null;
  revision: number;
}

/** Who writes a draft, as far as whether they still may goes. */
export type Builder = Pick<Acting, "userId" | "role" | "teams">;

/**
 * One kind of subject, an App or a workflow, as drafts and versions see
 * it: who reads and writes its draft and the versions a draft is over
 * (apps.ts' `appKind`, workflow-resources.ts' `workflowKind`). How a
 * draft of it is published is its `PublishSteps` (publish.ts).
 */
export interface DraftKind {
  kind: SubjectKind;
  /** The subject `input` names, which `by` builds: its ID, or refused. */
  readable: (env: Env, by: Acting, input: unknown) => Promise<string>;
  /**
   * The subject `input` names, whose draft `by` may write now: its ID, or
   * refused (an archived App, a deleted workflow, no role to build it).
   * Grasp staff never reach it: their sessions are refused before
   * (session-check.ts, `fullAccess`).
   */
  editable: (env: Env, by: Acting, input: unknown) => Promise<string>;
  /** That `by` may still write subject `id`'s draft, as SQL. */
  stillEditable: (id: string, by: Builder) => SQL;
  /** The version live now; null for none. */
  currentVersion: (env: Env, id: string) => Promise<number | null>;
  /**
   * The version a draft with no changes is over, and the only one a draft
   * is published over: the live one, or what stands in for it.
   */
  liveBase: (env: Env, id: string) => Promise<number | null>;
  /** The files of `version` of subject `id`, exactly as published. */
  versionFiles: (
    env: Env,
    id: string,
    version: number
  ) => Promise<Map<string, string>>;
  /** An App version's own definition text; null for a kind without one. */
  versionDefinition: (
    env: Env,
    id: string,
    version: number
  ) => Promise<string | null>;
  /** Subject `input`'s versions as `by` may read them. */
  versions: {
    /** Newest first, a page at a time: the newest, or those before `before`. */
    list: (
      env: Env,
      by: Acting,
      input: unknown,
      before?: unknown
    ) => Promise<Version[]>;
    get: (
      env: Env,
      by: Acting,
      input: unknown,
      version: unknown
    ) => Promise<Version>;
  };
}

/** The chat whose agent writes a draft: in which turn and code step. */
export interface ChatWriter {
  chatId: string;
  turnId: string | null;
  callId: string | null;
}

/**
 * Who writes a draft, `by`, one of the subject's builders: a chat's agent
 * acting for the chat's person, in turn `turnId` and its code step
 * `callId` (from its run's own record); or a person themselves, the write
 * audited with `detail`.
 */
export type DraftWriter = { by: Acting } & (
  | { chat: ChatWriter }
  | { detail: Record<string, AuditDetailValue> }
);

/** Core's database, as a draft's write batches over it. */
type CoreDb = ReturnType<typeof drizzle<Record<string, never>, D1Database>>;

/** The tables of drafts, each keyed by its subject. */
type SubjectTable =
  | typeof drafts
  | typeof draftFiles
  | typeof draftCheckpoints
  | typeof draftCheckpointFiles
  | typeof draftBlobs;

/** A subject's rows of `table`, as SQL. */
const ofSubject = (table: SubjectTable, { kind, id }: Subject) =>
  and(eq(table.subjectKind, kind), eq(table.subjectId, id));

/** The audit log's target for each kind of subject. */
const targetTypes: Readonly<Record<SubjectKind, string>> = {
  app: "app",
  workflow: "workflow_resource",
};

/** The audit entry of a change to `subject`'s draft or versions by `by`. */
export const subjectEntry = (
  by: Pick<Acting, "userId" | "staff" | "actor">,
  action:
    | "draft.saved"
    | "draft.restored"
    | "draft.discarded"
    | "version.published"
    | "version.rolled_back",
  { kind, id }: Subject,
  detail: Record<string, AuditDetailValue>
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: targetTypes[kind], id },
  detail,
});

/** Whether a draft changes anything over its base: a file or its definition. */
export const changesAnything = (
  draft: Pick<DraftState, "changes" | "definition">
): boolean =>
  Object.keys(draft.changes).length > 0 || draft.definition !== null;

/** `subject`'s draft as it is now; revision 0 while it has none. */
export const readDraft = async (
  env: Env,
  subject: Subject
): Promise<DraftState> => {
  const db = drizzle(env.DB);
  // In one batch, so its files are those of the revision it reads.
  const [rows, files] = await db.batch([
    db.select().from(drafts).where(ofSubject(drafts, subject)),
    db
      .select({ path: draftFiles.path, content: draftFiles.content })
      .from(draftFiles)
      .where(ofSubject(draftFiles, subject)),
  ]);
  const [row] = rows;
  return {
    base: row?.base ?? null,
    changes: Object.fromEntries(
      files.map(({ path, content }) => [path, content])
    ),
    definition: row?.definition ?? null,
    revision: row?.revision ?? 0,
  };
};

/**
 * The version subject `id`'s `draft` is over: its own base while it
 * changes anything; with no changes (none yet, or all published,
 * discarded or rolled back), its kind's `liveBase`.
 */
const draftBase = async (
  env: Env,
  kind: DraftKind,
  id: string,
  draft: DraftState
): Promise<number | null> =>
  changesAnything(draft) ? draft.base : await kind.liveBase(env, id);

/** Subject `id`'s draft, as its writers read it, over its base (`draftBase`). */
export const draftOf = async (
  env: Env,
  kind: DraftKind,
  id: string
): Promise<DraftState> => {
  const draft = await readDraft(env, { kind: kind.kind, id });
  return { ...draft, base: await draftBase(env, kind, id, draft) };
};

/** A draft's files: its base version's, with its changes over them. */
export const filesOf = async (
  env: Env,
  kind: DraftKind,
  id: string,
  { base, changes }: Pick<DraftState, "base" | "changes">
): Promise<Map<string, string>> => {
  const files =
    base === null
      ? new Map<string, string>()
      : await kind.versionFiles(env, id, base);
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) {
      files.delete(path);
    } else {
      files.set(path, content);
    }
  }
  return files;
};

/**
 * Subject `id`'s `draft` over version `onto` instead of its own base: the
 * same files and definition, as changes over `onto`. Never a merge, so it
 * never conflicts and drops nothing: a draft left over an older base (a
 * write that landed while a publish went live, a checkpoint restored from
 * before one, a roll back) keeps its work over the version live, and only
 * what the live version has already stops counting as a change.
 */
export const rebasedOnto = async (
  env: Env,
  kind: DraftKind,
  id: string,
  draft: DraftState,
  onto: number | null
): Promise<DraftState> => {
  if (draft.base === onto) {
    return draft;
  }
  const [files, live] = await Promise.all([
    filesOf(env, kind, id, draft),
    filesOf(env, kind, id, { base: onto, changes: {} }),
  ]);
  const changes: DraftState["changes"] = {};
  for (const [path, content] of files) {
    if (live.get(path) !== content) {
      changes[path] = content;
    }
  }
  for (const path of live.keys()) {
    if (!files.has(path)) {
      changes[path] = null;
    }
  }
  const definitionOf = async (version: number | null) =>
    version === null ? null : await kind.versionDefinition(env, id, version);
  const definition = draft.definition ?? (await definitionOf(draft.base));
  return {
    base: onto,
    changes,
    definition: definition === (await definitionOf(onto)) ? null : definition,
    revision: draft.revision,
  };
};

/**
 * Subject `id`'s draft as its builders see it: which paths it changes,
 * without their content, and whether it changes an App's definition, over
 * its base (`draftBase`).
 */
export const draftSummary = async (
  env: Env,
  kind: DraftKind,
  id: string
): Promise<Draft> => {
  const subject = { kind: kind.kind, id };
  const db = drizzle(env.DB);
  const [rows, paths] = await db.batch([
    db.select().from(drafts).where(ofSubject(drafts, subject)),
    db
      .select({
        path: draftFiles.path,
        deleted: isNull(draftFiles.content).mapWith(Boolean),
      })
      .from(draftFiles)
      .where(ofSubject(draftFiles, subject))
      .orderBy(asc(draftFiles.path)),
  ]);
  const [row] = rows;
  const definitionChanged = (row?.definition ?? null) !== null;
  return {
    subject,
    base:
      paths.length > 0 || definitionChanged
        ? (row?.base ?? null)
        : await kind.liveBase(env, id),
    changed: paths.map(({ path }) => path),
    deleted: paths.filter(({ deleted }) => deleted).map(({ path }) => path),
    definitionChanged,
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
};

/**
 * The draft's next revision, over `revision`, as SQL: NULL, which fails
 * the batch, once another write took it, or `by` may no longer write it
 * since its kind's `editable` let them in (`notNullFailed`).
 */
const nextRevision = (
  kind: DraftKind,
  id: string,
  revision: number,
  by: Builder
) =>
  sql`(SELECT ${revision + 1} WHERE COALESCE((SELECT revision FROM drafts WHERE subject_kind = ${kind.kind} AND subject_id = ${id}), 0) = ${revision} AND ${kind.stillEditable(id, by)})`;

/**
 * Tells everyone who follows `subject`'s draft that it moved to
 * `revision` (draft-watch.ts), whoever moved it; read now when the
 * caller can't know it (a publish or roll back, whose batch may have
 * landed over a write since). Never thrown for: the write landed, and a
 * follower reads the draft afresh at its next call anyway.
 */
export const draftRevised = async (
  env: Env,
  subject: Subject,
  revision?: number
): Promise<void> => {
  try {
    if (revision === undefined) {
      const row = await drizzle(env.DB)
        .select({ revision: drafts.revision })
        .from(drafts)
        .where(ofSubject(drafts, subject))
        .get();
      await draftWatch(env, subject).revised(row?.revision ?? 0);
      return;
    }
    await draftWatch(env, subject).revised(revision);
  } catch (error) {
    log.warn("draft.watch_untold", { ...subject, ...errorFields(error) });
  }
};

/**
 * Runs `statements`, a write of subject `id`'s draft by `by` that sets its
 * next revision first (`nextRevision`): refused as its kind's `editable`
 * refuses `by` now when they may no longer write it, else
 * `draft.conflict` when another write took it since. Then tells its
 * followers it is at `revision` (`draftRevised`).
 */
const writeOver = async (
  env: Env,
  db: CoreDb,
  kind: DraftKind,
  id: string,
  by: Acting,
  statements: Parameters<typeof auditedBatch>[2],
  revision: number
): Promise<void> => {
  try {
    await auditedBatch(env, db, statements);
  } catch (error) {
    if (notNullFailed(error, "drafts.revision")) {
      await kind.editable(env, by, id);
      throw draftErrors.create("draft.conflict");
    }
    throw error;
  }
  await draftRevised(env, { kind: kind.kind, id }, revision);
};

/**
 * The latest checkpoint of `subject`'s draft: its number, revision, chat
 * and turn, and the contents it holds.
 */
const latestCheckpoint = async (
  db: CoreDb,
  subject: Subject
): Promise<
  | {
      number: number;
      revision: number;
      chatId: string | null;
      turnId: string | null;
      held: string[];
    }
  | undefined
> => {
  const row = await db
    .select({
      number: draftCheckpoints.number,
      revision: draftCheckpoints.revision,
      chatId: draftCheckpoints.chatId,
      turnId: draftCheckpoints.turnId,
    })
    .from(draftCheckpoints)
    .where(ofSubject(draftCheckpoints, subject))
    .orderBy(desc(draftCheckpoints.number))
    .limit(1)
    .get();
  if (row === undefined) {
    return undefined;
  }
  const held = await db
    .select({ sha256: draftCheckpointFiles.sha256 })
    .from(draftCheckpointFiles)
    .where(
      and(
        ofSubject(draftCheckpointFiles, subject),
        eq(draftCheckpointFiles.number, row.number)
      )
    )
    .all();
  return {
    ...row,
    held: held.flatMap(({ sha256: hash }) => (hash === null ? [] : [hash])),
  };
};

/** Who wrote a checkpoint, as its row records it. */
interface CheckpointAuthor {
  personId: string;
  chatId: string | null;
  turnId: string | null;
  callId: string | null;
  restoredFrom?: number;
}

/** A person's own, outside any chat. */
const ownAuthor = (by: Pick<Acting, "userId">): CheckpointAuthor => ({
  personId: by.userId,
  chatId: null,
  turnId: null,
  callId: null,
});

/**
 * Each path of `changes` by its content's SHA-256 (null: deleted), and
 * each content by its hash.
 */
const hashesOf = async (
  changes: DraftState["changes"]
): Promise<{
  hashes: Record<string, string | null>;
  contents: Map<string, string>;
}> => {
  const hashes: Record<string, string | null> = {};
  const contents = new Map<string, string>();
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) {
      hashes[path] = null;
    } else {
      // oxlint-disable-next-line no-await-in-loop -- each a hash of one file, in order
      const hash = await sha256Hex(content);
      hashes[path] = hash;
      contents.set(hash, content);
    }
  }
  return { hashes, contents };
};

/**
 * Those of `hashes` `subject`'s checkpoints hold already, whose content a
 * write needn't send again. Safe to skip, as nothing drops a content but
 * a write that moves the draft, which the skipping write's revision then
 * refuses.
 */
const storedHashes = async (
  db: CoreDb,
  subject: Subject,
  hashes: readonly string[]
): Promise<Set<string>> => {
  if (hashes.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ sha256: draftBlobs.sha256 })
    .from(draftBlobs)
    .where(
      and(
        ofSubject(draftBlobs, subject),
        sql`${draftBlobs.sha256} IN (SELECT value FROM json_each(${JSON.stringify(hashes)}))`
      )
    )
    .all();
  return new Set(rows.map(({ sha256: hash }) => hash));
};

/** The SHA-256 of what a checkpoint holds: its base, files and definition. */
const contentHashOf = async (
  base: number | null,
  files: Record<string, string | null>,
  definition: string | null
): Promise<string> =>
  await sha256Hex(
    canonicalJson({
      base,
      files,
      definition: definition === null ? null : await sha256Hex(definition),
    })
  );

/**
 * The statements that keep `draft`, `subject`'s draft as the write over
 * `read` leaves it, as a checkpoint by `author`: as the checkpoint of the
 * turn that wrote it, while that is the newest and nothing else moved the
 * draft since, else as the next one. Only its contents not stored yet are
 * sent; a content the amended checkpoint held and none holds any more is
 * dropped.
 */
const keepCheckpoint = async (
  db: CoreDb,
  subject: Subject,
  draft: DraftState,
  read: number,
  author: CheckpointAuthor,
  createdAt: Date
) => {
  const latest = await latestCheckpoint(db, subject);
  const amends =
    latest !== undefined &&
    author.turnId !== null &&
    latest.turnId === author.turnId &&
    latest.chatId === author.chatId &&
    latest.revision === read;
  const number = amends ? latest.number : (latest?.number ?? 0) + 1;
  const { hashes, contents } = await hashesOf(draft.changes);
  const stored = await storedHashes(db, subject, [...contents.keys()]);
  const row = {
    subjectKind: subject.kind,
    subjectId: subject.id,
    number,
    revision: draft.revision,
    base: draft.base,
    definition: draft.definition,
    contentHash: await contentHashOf(draft.base, hashes, draft.definition),
    ...author,
    restoredFrom: author.restoredFrom ?? null,
    createdAt,
  };
  const ofCheckpoint = and(
    ofSubject(draftCheckpointFiles, subject),
    eq(draftCheckpointFiles.number, number)
  );
  return {
    row,
    statements: [
      ...[...contents]
        .filter(([hash]) => !stored.has(hash))
        .map(([hash, content]) =>
          db
            .insert(draftBlobs)
            .values({
              subjectKind: subject.kind,
              subjectId: subject.id,
              sha256: hash,
              content,
            })
            .onConflictDoNothing()
        ),
      amends
        ? db
            .update(draftCheckpoints)
            .set(row)
            .where(
              and(
                ofSubject(draftCheckpoints, subject),
                eq(draftCheckpoints.number, number)
              )
            )
        : db.insert(draftCheckpoints).values(row),
      db.delete(draftCheckpointFiles).where(ofCheckpoint),
      // Every path in one statement, however many the draft changes.
      db
        .insert(draftCheckpointFiles)
        .select(
          sql`SELECT ${subject.kind}, ${subject.id}, ${number}, value ->> '$[0]', value ->> '$[1]' FROM json_each(${JSON.stringify(Object.entries(hashes))})`
        ),
      ...(amends && latest.held.length > 0
        ? [
            db
              .delete(draftBlobs)
              .where(
                and(
                  ofSubject(draftBlobs, subject),
                  sql`${draftBlobs.sha256} IN (SELECT value FROM json_each(${JSON.stringify(latest.held)}))`,
                  sql`NOT EXISTS (SELECT 1 FROM draft_checkpoint_files WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id} AND sha256 = ${draftBlobs.sha256})`
                )
              ),
          ]
        : []),
    ] as const,
  };
};

/**
 * The statement that sets subject `id`'s draft row at the revision after
 * `revision`, over `base`, with `definition` as its own, by `by`.
 */
const draftRow = (
  db: CoreDb,
  kind: DraftKind,
  id: string,
  { base, definition }: { base: number | null; definition: string | null },
  revision: number,
  by: Builder,
  updatedAt: Date
) =>
  db
    .insert(drafts)
    .values({
      subjectKind: kind.kind,
      subjectId: id,
      base,
      revision: nextRevision(kind, id, revision, by),
      definition,
      updatedAt,
      updatedBy: by.userId,
    })
    .onConflictDoUpdate({
      target: [drafts.subjectKind, drafts.subjectId],
      set: {
        base,
        revision: sql`excluded.revision`,
        definition,
        updatedAt,
        updatedBy: by.userId,
      },
    });

/**
 * Writes `changes` (new content by path, or null to delete a file) into
 * subject `id`'s `draft`, as read, drops its changes to the paths in
 * `unchanged` (back as the base has them), and sets an App's own
 * definition to `definition` if given (null: back to its base's), over
 * the revision it read: `draft.conflict`, and nothing written, when
 * another write landed since, or as `writeOver` refuses one whose writer
 * may no longer write it. Kept as a checkpoint in the same batch
 * (`keepCheckpoint`): a chat's agent's as its turn's, a person's own as
 * one of its own; audited as the writer's, the agent's acting for its
 * person. `admit`, if given, admits the write right before it is sent.
 * Answers the draft as written.
 */
export const saveDraft = async (
  env: Env,
  kind: DraftKind,
  id: string,
  draft: DraftState,
  {
    changes,
    unchanged = [],
    definition = draft.definition,
  }: {
    changes: Record<string, string | null>;
    unchanged?: readonly string[];
    definition?: string | null;
  },
  writer: DraftWriter,
  admit?: () => Promise<void>
): Promise<DraftState> => {
  const subject = { kind: kind.kind, id };
  const db = drizzle(env.DB);
  const dropped = new Set(unchanged);
  const after: DraftState = {
    base: draft.base,
    changes: Object.fromEntries(
      Object.entries({ ...draft.changes, ...changes }).filter(
        ([path]) => !dropped.has(path)
      )
    ),
    definition,
    revision: draft.revision + 1,
  };
  const { by } = writer;
  const updatedAt = new Date();
  const checkpoint = await keepCheckpoint(
    db,
    subject,
    after,
    draft.revision,
    "chat" in writer ? { personId: by.userId, ...writer.chat } : ownAuthor(by),
    updatedAt
  );
  await admit?.();
  await writeOver(
    env,
    db,
    kind,
    id,
    by,
    [
      draftRow(db, kind, id, after, draft.revision, by, updatedAt),
      ...Object.entries(changes).map(([path, content]) =>
        db
          .insert(draftFiles)
          .values({ subjectKind: kind.kind, subjectId: id, path, content })
          .onConflictDoUpdate({
            target: [
              draftFiles.subjectKind,
              draftFiles.subjectId,
              draftFiles.path,
            ],
            set: { content },
          })
      ),
      ...unchanged.map((path) =>
        db
          .delete(draftFiles)
          .where(and(ofSubject(draftFiles, subject), eq(draftFiles.path, path)))
      ),
      ...checkpoint.statements,
      outboxed(
        db,
        subjectEntry(by, "draft.saved", subject, {
          revision: after.revision,
          ...("detail" in writer ? writer.detail : {}),
        })
      ),
    ],
    after.revision
  );
  return after;
};

/**
 * Empties subject `id`'s draft over `revision`, now over `base`: its
 * changes go, unpublished, audited as `by`'s discard, its checkpoints
 * stay, and its revision goes on, so a write that read it before lands on
 * nothing. `draft.conflict` when it moved since. With `live`, a roll back
 * to `base`, the version live already (publish.ts), also kept as a
 * checkpoint of `by`'s: the draft as the live version.
 */
export const emptyDraft = async (
  env: Env,
  kind: DraftKind,
  id: string,
  {
    revision,
    base,
    by,
    live = false,
  }: {
    revision: number;
    base: number | null;
    by: Acting;
    live?: boolean;
  }
): Promise<void> => {
  const subject = { kind: kind.kind, id };
  const db = drizzle(env.DB);
  const updatedAt = new Date();
  const emptied = { base, definition: null };
  const checkpoint = live
    ? await keepCheckpoint(
        db,
        subject,
        { ...emptied, changes: {}, revision: revision + 1 },
        revision,
        ownAuthor(by),
        updatedAt
      )
    : undefined;
  await writeOver(
    env,
    db,
    kind,
    id,
    by,
    [
      draftRow(db, kind, id, emptied, revision, by, updatedAt),
      db.delete(draftFiles).where(ofSubject(draftFiles, subject)),
      ...(checkpoint?.statements ?? []),
      outboxed(
        db,
        subjectEntry(by, "draft.discarded", subject, { revision: revision + 1 })
      ),
    ],
    revision + 1
  );
};

/**
 * The statements that empty `subject`'s draft over `base`, the version a
 * publish or roll back makes live, kept as a checkpoint of `by`'s (the
 * draft as the live version), each only while `live` (SQL) holds: what
 * the publish adds to the batch that makes the version live (its kind's
 * `activate`), so the draft is emptied with it or not at all, and never
 * keeps changes the live version has.
 *
 * A publish empties the draft only while it is still at `revision`, the
 * one it published: a write that landed since keeps the draft as it is,
 * over the version it was based on, its work kept, which the publish
 * then moves onto the version live (`rebaseDraft`). A roll back
 * (`rollsBack`) empties it whatever landed since, so it never fails
 * after the App's store took the version's schema: what the draft held
 * as it landed, a write since included, is discarded, audited as `by`'s
 * discard, and stays restorable from its own checkpoint.
 *
 * Each statement holds again for the write it made itself, at `at` by
 * `by`, so a batch tried again after its answer was lost
 * (`retriedBatch`) does nothing twice and fails on nothing.
 */
export const emptyDraftStatements = async (
  db: CoreDb,
  subject: Subject,
  {
    revision,
    base,
    by,
    at,
    rollsBack,
  }: {
    revision: number;
    base: number;
    by: Pick<Acting, "userId" | "staff" | "actor">;
    at: Date;
    rollsBack: boolean;
  },
  live: SQL
) => {
  const { kind, id } = subject;
  const ofDraft = sql`subject_kind = ${kind} AND subject_id = ${id}`;
  // The draft row below landed, now or in an earlier try: nothing else
  // leaves the draft over `base`, by `by`, at `at`.
  const ours = sql`EXISTS (SELECT 1 FROM drafts WHERE ${ofDraft} AND base = ${base} AND updated_by = ${by.userId} AND updated_at = ${at.getTime()})`;
  const emptied = sql`${live} AND ${ours}`;
  // Its checkpoint isn't kept yet: false in a try after the one that kept it.
  const unkept = sql`NOT EXISTS (SELECT 1 FROM draft_checkpoints WHERE ${ofDraft} AND base = ${base} AND person_id = ${by.userId} AND created_at = ${at.getTime()})`;
  const holdsChanges = sql`(EXISTS (SELECT 1 FROM draft_files WHERE ${ofDraft}) OR EXISTS (SELECT 1 FROM drafts WHERE ${ofDraft} AND definition IS NOT NULL))`;
  const contentHash = await contentHashOf(base, {}, null);
  return [
    // What a roll back discards, told before the draft row moves.
    ...(rollsBack
      ? [
          outboxedWhere(
            db,
            subjectEntry(by, "draft.discarded", subject, { version: base }),
            sql`${live} AND ${holdsChanges} AND NOT ${ours}`
          ),
        ]
      : []),
    // Its row made, for a draft never written yet (revision 0), as
    // `draftRow` makes it, in the table's column order.
    db
      .insert(drafts)
      .select(
        sql`SELECT ${kind}, ${id}, ${base}, ${revision + 1}, NULL, ${at.getTime()}, ${by.userId} WHERE ${live}`
      )
      .onConflictDoUpdate({
        target: [drafts.subjectKind, drafts.subjectId],
        set: {
          base,
          revision: sql`${drafts.revision} + 1`,
          definition: null,
          updatedAt: at,
          updatedBy: by.userId,
        },
        setWhere: rollsBack ? sql`NOT ${ours}` : eq(drafts.revision, revision),
      }),
    db.delete(draftFiles).where(and(ofSubject(draftFiles, subject), emptied)),
    // Numbered in the statement, after whichever checkpoint landed last,
    // in the table's column order.
    db
      .insert(draftCheckpoints)
      .select(
        sql`SELECT ${kind}, ${id}, COALESCE((SELECT MAX(number) FROM draft_checkpoints WHERE ${ofDraft}), 0) + 1, (SELECT revision FROM drafts WHERE ${ofDraft}), ${base}, NULL, ${contentHash}, ${by.userId}, NULL, NULL, NULL, NULL, ${at.getTime()} WHERE ${emptied} AND ${unkept}`
      ),
  ];
};

/** Paths in one stable order, whatever order they were read in. */
const byPath = (one: string, other: string): number => {
  if (one === other) {
    return 0;
  }
  return one < other ? -1 : 1;
};

/** Most checkpoints one `draftCheckpointsOf` call answers. */
const checkpointsPerPage = 50;

/**
 * The paths each of `checkpoints` changed against the one before it, by
 * checkpoint: each holds the draft's changes over its base, so one over
 * the same base as the one before touched the paths whose content
 * differs; one over another base (the first, or the first after a
 * publish) touched the paths it changes. `checkpoints` run from the one
 * before the page (none for the draft's first), whose own paths aren't
 * answered.
 */
const touchedByCheckpoint = (
  checkpoints: readonly { number: number; base: number | null }[],
  files: readonly { number: number; path: string; hash: string | null }[]
): Map<number, string[]> => {
  const held = new Map<number, Map<string, string | null>>();
  for (const { number, path, hash } of files) {
    const each = held.get(number) ?? new Map<string, string | null>();
    each.set(path, hash);
    held.set(number, each);
  }
  const ascending = checkpoints.toSorted((a, b) => a.number - b.number);
  return new Map(
    ascending.map(({ number, base }, at): [number, string[]] => {
      const now = held.get(number) ?? new Map<string, string | null>();
      const previous = at === 0 ? undefined : ascending[at - 1];
      if (previous === undefined || previous.base !== base) {
        return [number, [...now.keys()].toSorted(byPath)];
      }
      const before =
        held.get(previous.number) ?? new Map<string, string | null>();
      const paths = new Set([...before.keys(), ...now.keys()]);
      return [
        number,
        [...paths]
          .filter((path) => before.get(path) !== now.get(path))
          .toSorted(byPath),
      ];
    })
  );
};

/**
 * `subject`'s checkpoints, newest first, each with the paths it touched:
 * the newest {@link checkpointsPerPage}, or those before checkpoint
 * `before`, for the next page.
 */
export const draftCheckpointsOf = async (
  env: Env,
  subject: Subject,
  before?: number
): Promise<DraftCheckpoint[]> => {
  const db = drizzle(env.DB);
  // One more than the page: the checkpoint before it, which what the
  // page's oldest touched is against.
  const rows = await db
    .select()
    .from(draftCheckpoints)
    .where(
      and(
        ofSubject(draftCheckpoints, subject),
        before === undefined ? undefined : lt(draftCheckpoints.number, before)
      )
    )
    .orderBy(desc(draftCheckpoints.number))
    .limit(checkpointsPerPage + 1);
  const oldest = rows.at(-1)?.number ?? 0;
  const files = await db
    .select({
      number: draftCheckpointFiles.number,
      path: draftCheckpointFiles.path,
      hash: draftCheckpointFiles.sha256,
    })
    .from(draftCheckpointFiles)
    .where(
      and(
        ofSubject(draftCheckpointFiles, subject),
        gte(draftCheckpointFiles.number, oldest),
        lte(draftCheckpointFiles.number, rows[0]?.number ?? 0)
      )
    );
  const touched = touchedByCheckpoint(rows, files);
  const changes = new Map<number, number>();
  for (const { number } of files) {
    changes.set(number, (changes.get(number) ?? 0) + 1);
  }
  return rows.slice(0, checkpointsPerPage).map((row) => ({
    number: row.number,
    revision: row.revision,
    base: row.base,
    contentHash: row.contentHash,
    personId: row.personId,
    chatId: row.chatId,
    callId: row.callId,
    restoredFrom: row.restoredFrom,
    createdAt: row.createdAt.toISOString(),
    touched: touched.get(row.number) ?? [],
    changes: changes.get(row.number) ?? 0,
  }));
};

/**
 * Checkpoint `number` of `subject`'s draft, as a draft at the revision it
 * made: `draft.checkpoint_not_found` when there is none.
 */
export const readCheckpoint = async (
  env: Env,
  subject: Subject,
  number: unknown
): Promise<DraftState & { number: number }> => {
  const db = drizzle(env.DB);
  const row =
    typeof number === "number" && Number.isSafeInteger(number)
      ? await db
          .select()
          .from(draftCheckpoints)
          .where(
            and(
              ofSubject(draftCheckpoints, subject),
              eq(draftCheckpoints.number, number)
            )
          )
          .get()
      : undefined;
  if (row === undefined) {
    throw draftErrors.create("draft.checkpoint_not_found");
  }
  const files = await db
    .select({
      path: draftCheckpointFiles.path,
      content: draftBlobs.content,
    })
    .from(draftCheckpointFiles)
    .leftJoin(
      draftBlobs,
      and(
        eq(draftBlobs.subjectKind, draftCheckpointFiles.subjectKind),
        eq(draftBlobs.subjectId, draftCheckpointFiles.subjectId),
        eq(draftBlobs.sha256, draftCheckpointFiles.sha256)
      )
    )
    .where(
      and(
        ofSubject(draftCheckpointFiles, subject),
        eq(draftCheckpointFiles.number, row.number)
      )
    )
    .all();
  return {
    number: row.number,
    base: row.base,
    changes: Object.fromEntries(
      files.map(({ path, content }) => [path, content])
    ),
    definition: row.definition,
    revision: row.revision,
  };
};

/**
 * Replaces subject `id`'s draft over `revision`, which `by` read, with
 * `draft` whole, as its next checkpoint (`restoredFrom` the one it came
 * from, if any), audited with `entry` for that checkpoint's number:
 * `draft.conflict` when the draft moved since. Answers the checkpoint's
 * number.
 */
const replaceDraft = async (
  env: Env,
  kind: DraftKind,
  id: string,
  by: Acting,
  { draft, revision }: { draft: DraftState; revision: number },
  restoredFrom: number | undefined,
  entry: (checkpoint: number) => AuditEntry
): Promise<number> => {
  const subject = { kind: kind.kind, id };
  const db = drizzle(env.DB);
  const createdAt = new Date();
  const kept = await keepCheckpoint(
    db,
    subject,
    { ...draft, revision: revision + 1 },
    revision,
    {
      ...ownAuthor(by),
      ...(restoredFrom === undefined ? {} : { restoredFrom }),
    },
    createdAt
  );
  await writeOver(
    env,
    db,
    kind,
    id,
    by,
    [
      draftRow(db, kind, id, draft, revision, by, createdAt),
      db.delete(draftFiles).where(ofSubject(draftFiles, subject)),
      ...Object.entries(draft.changes).map(([path, content]) =>
        db
          .insert(draftFiles)
          .values({ subjectKind: kind.kind, subjectId: id, path, content })
      ),
      ...kept.statements,
      outboxed(db, entry(kept.row.number)),
    ],
    revision + 1
  );
  return kept.row.number;
};

/**
 * Makes checkpoint `number` of subject `id`'s draft the draft again, over
 * `revision`, which `by` read, as its next checkpoint, audited as theirs:
 * no checkpoint is changed. One from before a publish or a roll back
 * comes back over the version live now (`rebasedOnto`), holding the files
 * it held. `draft.conflict` when the draft moved since. Answers the new
 * checkpoint.
 */
export const restoreCheckpoint = async (
  env: Env,
  kind: DraftKind,
  id: string,
  by: Acting,
  number: unknown,
  revision: number
): Promise<DraftCheckpoint> => {
  const subject = { kind: kind.kind, id };
  const held = await readCheckpoint(env, subject, number);
  const draft = await rebasedOnto(
    env,
    kind,
    id,
    held,
    await kind.liveBase(env, id)
  );
  const kept = await replaceDraft(
    env,
    kind,
    id,
    by,
    { draft, revision },
    held.number,
    (checkpoint) =>
      subjectEntry(by, "draft.restored", subject, {
        checkpoint,
        restoredFrom: held.number,
      })
  );
  const [restored] = await draftCheckpointsOf(env, subject, kept + 1);
  if (restored === undefined) {
    throw new Error("A restored checkpoint is gone as it was kept.");
  }
  return restored;
};

/** How often `rebaseDraft` reads the draft again after another write. */
const rebaseTries = 3;

/**
 * Moves subject `id`'s draft onto the version live once a write left it
 * over an older one, as a write that landed while a publish went live
 * does (`emptyDraftStatements`): the same files, as changes over the version
 * live (`rebasedOnto`), as a checkpoint of `by`'s, audited as theirs. So
 * the stored draft says what is still unshared. Read again after a write
 * meanwhile, a few times; one left over the older version still publishes
 * as it reads (publish.ts).
 */
export const rebaseDraft = async (
  env: Env,
  kind: DraftKind,
  id: string,
  by: Acting
): Promise<void> => {
  const subject = { kind: kind.kind, id };
  for (let tried = 0; tried < rebaseTries; tried += 1) {
    // oxlint-disable-next-line no-await-in-loop -- read again after each try
    const [stored, live] = await Promise.all([
      readDraft(env, subject),
      kind.liveBase(env, id),
    ]);
    if (!changesAnything(stored) || stored.base === live) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- one try at a time
    const draft = await rebasedOnto(env, kind, id, stored, live);
    try {
      // oxlint-disable-next-line no-await-in-loop -- one try at a time
      await replaceDraft(
        env,
        kind,
        id,
        by,
        { draft, revision: stored.revision },
        undefined,
        () =>
          subjectEntry(by, "draft.saved", subject, {
            revision: stored.revision + 1,
            base: live,
          })
      );
      return;
    } catch (error) {
      if (draftErrors.codeOf(error) !== "draft.conflict") {
        throw error;
      }
    }
  }
};

/**
 * The subjects whose drafts chat `chatId`'s agent wrote in turn `turnId`:
 * those with a checkpoint of that turn's, kept with the draft, so a
 * restart forgets none.
 */
export const turnSubjects = async (
  env: Env,
  chatId: string,
  turnId: string
): Promise<Subject[]> => {
  const rows = await drizzle(env.DB)
    .selectDistinct({
      kind: draftCheckpoints.subjectKind,
      id: draftCheckpoints.subjectId,
    })
    .from(draftCheckpoints)
    .where(
      and(
        eq(draftCheckpoints.chatId, chatId),
        eq(draftCheckpoints.turnId, turnId)
      )
    )
    .all();
  return rows;
};

/**
 * What chat `chatId` worked on, the most recently first: each subject
 * with a checkpoint naming the chat (its agent's writes, and what its
 * Build it made, `keepMadeInChat`), at its latest one.
 */
export const chatWork = async (
  env: Env,
  chatId: string
): Promise<ChatWork[]> => {
  const rows = await drizzle(env.DB)
    .select({
      kind: draftCheckpoints.subjectKind,
      id: draftCheckpoints.subjectId,
      createdAt: draftCheckpoints.createdAt,
      callId: draftCheckpoints.callId,
    })
    .from(draftCheckpoints)
    .where(
      and(
        eq(draftCheckpoints.chatId, chatId),
        sql`${draftCheckpoints.number} = (SELECT MAX(number) FROM draft_checkpoints AS own WHERE own.subject_kind = ${draftCheckpoints.subjectKind} AND own.subject_id = ${draftCheckpoints.subjectId} AND own.chat_id = ${chatId})`
      )
    )
    .orderBy(desc(draftCheckpoints.createdAt))
    .all();
  return rows.map(({ kind, id, createdAt, callId }) => ({
    kind,
    id,
    updatedAt: createdAt.toISOString(),
    callId,
  }));
};

/**
 * The chats of `personId`'s that worked on `subject`, whose agent wrote
 * its draft or whose Build it made it (`keepMadeInChat`): those a
 * checkpoint names, for the subject's page to carry on in
 * (`ChatsApi.forSubject`).
 */
export const chatsWorkedOn = async (
  env: Env,
  subject: Subject,
  personId: string
): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .selectDistinct({ chatId: draftCheckpoints.chatId })
    .from(draftCheckpoints)
    .where(
      and(
        ofSubject(draftCheckpoints, subject),
        eq(draftCheckpoints.personId, personId)
      )
    )
    .all();
  return rows.flatMap(({ chatId }) => (chatId === null ? [] : [chatId]));
};

/**
 * Keeps subject `id`, which Build it just made in a chat of `personId`'s
 * (`ChatsApi.build`), as worked on by that chat: its draft as it starts,
 * empty, kept as a checkpoint naming the chat and the plan's call
 * (`chat`), before the chat's agent writes a thing. So the chat is the
 * subject's (`chatsWorkedOn`) and lists it (`chatWork`) the moment it is
 * made, whether its turn then starts or not. The draft itself doesn't
 * move: nothing was written to it.
 */
export const keepMadeInChat = async (
  env: Env,
  kind: DraftKind,
  id: string,
  personId: string,
  chat: ChatWriter
): Promise<void> => {
  const db = drizzle(env.DB);
  const draft = await draftOf(env, kind, id);
  const { statements } = await keepCheckpoint(
    db,
    { kind: kind.kind, id },
    draft,
    draft.revision,
    { personId, ...chat },
    new Date()
  );
  // Never empty: the checkpoint's own row is among them.
  const [first, ...rest] = statements;
  if (first !== undefined) {
    await auditedBatch(env, db, [first, ...rest]);
  }
};
