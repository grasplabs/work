import type {
  AppDraft,
  AppDraftHistoryPoint,
  AppDraftPoint,
} from "@grasp-os/shared/app-drafts";
import { appErrors } from "@grasp-os/shared/apps";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import type { ChatWork } from "@grasp-os/shared/chat";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, asc, desc, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { archivedNow, changeEntry, changesAnything, findApp } from "./apps.ts";
import { auditedBatch, outboxed, outboxedWhere } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import {
  appDraftContents,
  appDraftFiles,
  appDraftPointFiles,
  appDraftPoints,
  appDrafts,
  appVersions,
} from "./db/core/schema.ts";
import { notNullFailed } from "./db/d1.ts";
import { appPreview } from "./durable-objects.ts";

// An App's draft (GRA-1665): one per App, in core's database, shared by
// everyone who builds the App and by their chats' agents (agent-builds.ts,
// app-drafts-rpc.ts). Only core calls these, having checked the writer's
// role in the App (a builder's) and, for an agent, that its code run is
// still open.
//
// Threat model, and how each is closed:
//
// - Two writers at once (two people's agents, or a person and an agent).
//   Every write names the revision it read and takes the next one in the
//   batch that writes it, only while the draft is still at the one it
//   read: of two writes made from the same read the second is refused
//   (`app.conflict`) and the first stays, never merged or overwritten.
//   The agent reads the draft again and writes anew.
// - A write that loses its undo point. Each write keeps the draft as it
//   left it as an undo point in the same batch: none lands without its
//   point, and none is kept for one that didn't land. An agent turn's
//   writes amend its own point while it is the newest and nothing else
//   moved the draft since, so a turn is one point to step back to; a
//   person's own edit and a restore are each a point of their own.
//   Nothing has to notice a turn's end, which a restart may skip.
// - A write to an archived or removed App. The revision a write takes is
//   NULL, failing the batch, once the App was archived since the writer
//   was let in (`nextRevision`); a removed App takes no row at all
//   (migration 0232's triggers).
// - Growth. A point holds each path's content by its SHA-256, each
//   content once per App, so most writes add a file or two; what a turn
//   wrote and then wrote over is dropped once no point holds it.
// - Disclosure. A draft is the App's code, read by its builders alone,
//   as its versions are; its points name who wrote them and from which
//   chat, which only those builders and that chat's person read.

/**
 * An App's draft: the version it began over, the changes written over it,
 * by path (null deletes a file), and its own definition, as stored
 * (`definitionText`), null while it is its base's. `revision` is 0 while
 * there is none.
 */
export interface Draft {
  base: number | null;
  changes: Record<string, string | null>;
  definition: string | null;
  revision: number;
}

/**
 * Who writes a draft: a chat's agent, for the chat's person, in turn
 * `turnId` and its code step `callId` (from its run's own record); or a
 * person themselves, the write audited with `detail`.
 */
export type DraftWriter =
  | {
      chat: {
        personId: string;
        chatId: string;
        turnId: string | null;
        callId: string | null;
      };
    }
  | { by: Acting; detail: Record<string, AuditDetailValue> };

/** Core's database, as a draft's write batches over it. */
type CoreDb = ReturnType<typeof drizzle<Record<string, never>, D1Database>>;

/** A point's row, as the API answers it. */
const toPoint = (row: typeof appDraftPoints.$inferSelect): AppDraftPoint => ({
  number: row.number,
  revision: row.revision,
  base: row.base,
  contentHash: row.contentHash,
  personId: row.personId,
  chatId: row.chatId,
  callId: row.callId,
  restoredFrom: row.restoredFrom,
  createdAt: row.createdAt.toISOString(),
});

/** App `app`'s draft as it is now; revision 0 while it has none. */
export const readDraft = async (env: Env, app: string): Promise<Draft> => {
  const db = drizzle(env.DB);
  // In one batch, so its files are those of the revision it reads.
  const [rows, files] = await db.batch([
    db.select().from(appDrafts).where(eq(appDrafts.appId, app)),
    db
      .select({ path: appDraftFiles.path, content: appDraftFiles.content })
      .from(appDraftFiles)
      .where(eq(appDraftFiles.appId, app)),
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
 * App `app`'s live version, or while none is live its latest whose
 * publish didn't fail (the first of an App made from a blueprint): what
 * a draft with no changes is over, and the only base a draft is published
 * over (app-publish.ts). Never simply the latest: after a roll back that
 * is a version nobody uses, and a draft whose publish failed leaves
 * its version behind, which a discard must not bring back.
 */
export const liveBase = async (
  env: Env,
  app: AppId
): Promise<number | null> => {
  const { currentVersion } = await findApp(env, app);
  if (currentVersion !== null) {
    return currentVersion;
  }
  const latest = await drizzle(env.DB)
    .select({ version: appVersions.version })
    .from(appVersions)
    .where(
      and(
        eq(appVersions.appId, app),
        sql`${appVersions.status} IS NOT 'failed'`
      )
    )
    .orderBy(desc(appVersions.version))
    .limit(1)
    .get();
  return latest?.version ?? null;
};

/**
 * The version App `app`'s `draft` is over: its own base while it changes
 * anything; with no changes (none yet, or all published, discarded or
 * rolled back), `liveBase`.
 */
export const draftBase = async (
  env: Env,
  app: AppId,
  draft: Draft
): Promise<number | null> =>
  changesAnything(draft) ? draft.base : await liveBase(env, app);

/** App `app`'s draft, as its writers read it, over its base (`draftBase`). */
export const draftOf = async (env: Env, app: AppId): Promise<Draft> => {
  const draft = await readDraft(env, app);
  return { ...draft, base: await draftBase(env, app, draft) };
};

/**
 * App `app`'s draft as its builders see it: which paths it changes,
 * without their content, and whether it changes the definition, over its
 * base (`draftBase`).
 */
export const draftSummary = async (env: Env, app: AppId): Promise<AppDraft> => {
  const db = drizzle(env.DB);
  const [rows, paths] = await db.batch([
    db.select().from(appDrafts).where(eq(appDrafts.appId, app)),
    db
      .select({
        path: appDraftFiles.path,
        deleted: isNull(appDraftFiles.content).mapWith(Boolean),
      })
      .from(appDraftFiles)
      .where(eq(appDraftFiles.appId, app))
      .orderBy(asc(appDraftFiles.path)),
  ]);
  const [row] = rows;
  const definitionChanged = (row?.definition ?? null) !== null;
  return {
    app,
    base:
      paths.length > 0 || definitionChanged
        ? (row?.base ?? null)
        : await liveBase(env, app),
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
 * the batch, once another write took it or the App was archived since the
 * writer's `editableApp` let it in (`notNullFailed`).
 */
const nextRevision = (app: string, revision: number) =>
  sql`(SELECT ${revision + 1} WHERE COALESCE((SELECT revision FROM app_drafts WHERE app_id = ${app}), 0) = ${revision} AND NOT ${archivedNow(app)})`;

/**
 * Tells App `app`'s preview (app-preview.ts) its draft moved, so every
 * open preview of it takes the write now, whoever made it. Never thrown
 * for: the write landed, and a preview reads the draft afresh at its
 * next call anyway.
 */
export const draftRevised = async (env: Env, app: AppId): Promise<void> => {
  try {
    await appPreview(env, app).revised();
  } catch (error) {
    log.warn("app.preview_untold", { app, ...errorFields(error) });
  }
};

/**
 * Runs `statements`, a write of App `app`'s draft over `revision` that
 * sets its next revision first (`nextRevision`): `app.archived` when the
 * App was archived since, else `app.conflict` when another write took it
 * since. Then tells the App's preview (`draftRevised`).
 */
const writeOver = async (
  env: Env,
  db: CoreDb,
  app: AppId,
  statements: Parameters<typeof auditedBatch>[2]
): Promise<void> => {
  try {
    await auditedBatch(env, db, statements);
  } catch (error) {
    if (notNullFailed(error, "app_drafts.revision")) {
      const { archived } = await findApp(env, app);
      throw appErrors.create(archived ? "app.archived" : "app.conflict");
    }
    throw error;
  }
  await draftRevised(env, app);
};

/**
 * The latest undo point of App `app`'s draft: its number, revision, chat
 * and turn, and the contents it holds.
 */
const latestPoint = async (
  db: CoreDb,
  app: string
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
      number: appDraftPoints.number,
      revision: appDraftPoints.revision,
      chatId: appDraftPoints.chatId,
      turnId: appDraftPoints.turnId,
    })
    .from(appDraftPoints)
    .where(eq(appDraftPoints.appId, app))
    .orderBy(desc(appDraftPoints.number))
    .limit(1)
    .get();
  if (row === undefined) {
    return undefined;
  }
  const held = await db
    .select({ sha256: appDraftPointFiles.sha256 })
    .from(appDraftPointFiles)
    .where(
      and(
        eq(appDraftPointFiles.appId, app),
        eq(appDraftPointFiles.number, row.number)
      )
    )
    .all();
  return {
    ...row,
    held: held.flatMap(({ sha256: hash }) => (hash === null ? [] : [hash])),
  };
};

/** Who wrote a point, as its row records it. */
interface PointAuthor {
  personId: string;
  chatId: string | null;
  turnId: string | null;
  callId: string | null;
  restoredFrom?: number;
}

/**
 * Each path of `changes` by its content's SHA-256 (null: deleted), and
 * each content by its hash.
 */
const hashesOf = async (
  changes: Draft["changes"]
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
 * Those of `hashes` App `app`'s points hold already, whose content a
 * write needn't send again. Safe to skip, as nothing drops a content but a
 * write that moves the draft, which the skipping write's revision then
 * refuses.
 */
const storedHashes = async (
  db: CoreDb,
  app: string,
  hashes: readonly string[]
): Promise<Set<string>> => {
  if (hashes.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ sha256: appDraftContents.sha256 })
    .from(appDraftContents)
    .where(
      and(
        eq(appDraftContents.appId, app),
        sql`${appDraftContents.sha256} IN (SELECT value FROM json_each(${JSON.stringify(hashes)}))`
      )
    )
    .all();
  return new Set(rows.map(({ sha256: hash }) => hash));
};

/** The SHA-256 of what a point holds: its base, its files and its definition. */
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
 * The statements that keep `draft`, App `app`'s draft as the write over
 * `read` leaves it, as an undo point by `author`: as the point of the
 * turn that wrote it, while that is the newest and nothing else moved the
 * draft since, else as the next point. Only its contents not stored yet
 * are sent; a content the amended point held and no point holds any more
 * is dropped.
 */
const keepPoint = async (
  db: CoreDb,
  app: string,
  draft: Draft,
  read: number,
  author: PointAuthor,
  createdAt: Date
) => {
  const latest = await latestPoint(db, app);
  const amends =
    latest !== undefined &&
    author.turnId !== null &&
    latest.turnId === author.turnId &&
    latest.chatId === author.chatId &&
    latest.revision === read;
  const number = amends ? latest.number : (latest?.number ?? 0) + 1;
  const { hashes, contents } = await hashesOf(draft.changes);
  const stored = await storedHashes(db, app, [...contents.keys()]);
  const row = {
    appId: app,
    number,
    revision: draft.revision,
    base: draft.base,
    definition: draft.definition,
    contentHash: await contentHashOf(draft.base, hashes, draft.definition),
    ...author,
    restoredFrom: author.restoredFrom ?? null,
    createdAt,
  };
  const ofPoint = and(
    eq(appDraftPointFiles.appId, app),
    eq(appDraftPointFiles.number, number)
  );
  return {
    row,
    statements: [
      ...[...contents]
        .filter(([hash]) => !stored.has(hash))
        .map(([hash, content]) =>
          db
            .insert(appDraftContents)
            .values({ appId: app, sha256: hash, content })
            .onConflictDoNothing()
        ),
      amends
        ? db
            .update(appDraftPoints)
            .set(row)
            .where(
              and(
                eq(appDraftPoints.appId, app),
                eq(appDraftPoints.number, number)
              )
            )
        : db.insert(appDraftPoints).values(row),
      db.delete(appDraftPointFiles).where(ofPoint),
      // Every path in one statement, however many the draft changes.
      db
        .insert(appDraftPointFiles)
        .select(
          sql`SELECT ${app}, ${number}, value ->> '$[0]', value ->> '$[1]' FROM json_each(${JSON.stringify(Object.entries(hashes))})`
        ),
      ...(amends && latest.held.length > 0
        ? [
            db
              .delete(appDraftContents)
              .where(
                and(
                  eq(appDraftContents.appId, app),
                  sql`${appDraftContents.sha256} IN (SELECT value FROM json_each(${JSON.stringify(latest.held)}))`,
                  sql`NOT EXISTS (SELECT 1 FROM app_draft_point_files WHERE app_id = ${app} AND sha256 = ${appDraftContents.sha256})`
                )
              ),
          ]
        : []),
    ] as const,
  };
};

/**
 * The statement that sets App `app`'s draft row at the revision after
 * `revision`, over `base`, with `definition` as its own.
 */
const draftRow = (
  db: CoreDb,
  app: string,
  { base, definition }: { base: number | null; definition: string | null },
  revision: number,
  updatedBy: string,
  updatedAt: Date
) =>
  db
    .insert(appDrafts)
    .values({
      appId: app,
      base,
      revision: nextRevision(app, revision),
      definition,
      updatedAt,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: appDrafts.appId,
      set: {
        base,
        revision: sql`excluded.revision`,
        definition,
        updatedAt,
        updatedBy,
      },
    });

/**
 * Writes `changes` (new content by path, or null to delete a file) into
 * App `app`'s `draft`, as read, drops its changes to the paths in
 * `unchanged` (back as the base has them), and sets its own definition to
 * `definition` if given (null: back to its base's), over the revision it
 * read: `app.conflict`, and nothing written, when another write landed
 * since. Kept as an undo point in the same batch (`keepPoint`): a chat's
 * agent's as its turn's, a person's own as one of its own, audited as
 * theirs. `admit`, if given, admits the write right before it is sent.
 * Answers the draft as written.
 */
export const saveDraft = async (
  env: Env,
  app: AppId,
  draft: Draft,
  {
    changes,
    unchanged,
    definition = draft.definition,
  }: {
    changes: Record<string, string | null>;
    unchanged: readonly string[];
    definition?: string | null;
  },
  writer: DraftWriter,
  admit?: () => Promise<void>
): Promise<Draft> => {
  const db = drizzle(env.DB);
  const dropped = new Set(unchanged);
  const after: Draft = {
    base: draft.base,
    changes: Object.fromEntries(
      Object.entries({ ...draft.changes, ...changes }).filter(
        ([path]) => !dropped.has(path)
      )
    ),
    definition,
    revision: draft.revision + 1,
  };
  const personId = "chat" in writer ? writer.chat.personId : writer.by.userId;
  const updatedAt = new Date();
  const point = await keepPoint(
    db,
    app,
    after,
    draft.revision,
    "chat" in writer
      ? writer.chat
      : { personId, chatId: null, turnId: null, callId: null },
    updatedAt
  );
  await admit?.();
  await writeOver(env, db, app, [
    draftRow(db, app, after, draft.revision, personId, updatedAt),
    ...Object.entries(changes).map(([path, content]) =>
      db
        .insert(appDraftFiles)
        .values({ appId: app, path, content })
        .onConflictDoUpdate({
          target: [appDraftFiles.appId, appDraftFiles.path],
          set: { content },
        })
    ),
    ...unchanged.map((path) =>
      db
        .delete(appDraftFiles)
        .where(and(eq(appDraftFiles.appId, app), eq(appDraftFiles.path, path)))
    ),
    ...point.statements,
    ...("by" in writer
      ? [
          outboxed(
            db,
            changeEntry(writer.by, "app.draft.defined", app, {
              revision: after.revision,
              ...writer.detail,
            })
          ),
        ]
      : []),
  ]);
  return after;
};

/**
 * Empties App `app`'s draft over `revision`, now over `base`: its changes
 * go, unpublished, audited as `by`'s discard, its undo points stay, and
 * its revision goes on, so a write that read it before lands on nothing.
 * `app.conflict` when it moved since. With `published`, a roll back to
 * `base`, the version live (app-publish.ts), also kept as an undo point
 * of `by`'s: the draft as the live version.
 */
export const emptyDraft = async (
  env: Env,
  app: AppId,
  {
    revision,
    base,
    by,
    published = false,
  }: {
    revision: number;
    base: number | null;
    by: Pick<Acting, "userId" | "staff" | "actor">;
    published?: boolean;
  }
): Promise<void> => {
  const db = drizzle(env.DB);
  const updatedAt = new Date();
  const emptied = { base, definition: null };
  const point = published
    ? await keepPoint(
        db,
        app,
        { ...emptied, changes: {}, revision: revision + 1 },
        revision,
        { personId: by.userId, chatId: null, turnId: null, callId: null },
        updatedAt
      )
    : undefined;
  await writeOver(env, db, app, [
    draftRow(db, app, emptied, revision, by.userId, updatedAt),
    db.delete(appDraftFiles).where(eq(appDraftFiles.appId, app)),
    ...(point?.statements ?? []),
    outboxed(
      db,
      changeEntry(by, "app.draft.discarded", app, { revision: revision + 1 })
    ),
  ]);
};

/**
 * The statements that empty App `app`'s draft at `revision` over `base`,
 * the version a publish makes live, kept as an undo point of `by`'s (the
 * draft as the live version), each only while `live` (SQL) holds: what
 * the publish adds to the batch that makes it live (apps.ts,
 * `makeCurrent`), so the draft is emptied with it or not at all, and
 * never keeps changes the live version has. With `discards`, a roll back
 * that drops the draft's unpublished changes, audited as `by`'s discard.
 * A write that landed on the draft since `revision` keeps it as it is,
 * over the version it was based on, which a builder discards to publish
 * again (app-publish.ts).
 */
export const emptiedWhenLive = async (
  db: CoreDb,
  app: AppId,
  {
    revision,
    base,
    by,
    at,
    discards,
  }: {
    revision: number;
    base: number;
    by: Pick<Acting, "userId" | "staff" | "actor">;
    at: Date;
    discards: boolean;
  },
  live: SQL
) => {
  // The first statement below landed: none but it leaves the draft at
  // the next revision over `base`, by `by`, at `at`.
  const emptied = sql`${live} AND EXISTS (SELECT 1 FROM app_drafts WHERE app_id = ${app} AND revision = ${revision + 1} AND base = ${base} AND updated_by = ${by.userId} AND updated_at = ${at.getTime()})`;
  const contentHash = await contentHashOf(base, {}, null);
  return [
    // Its row made, for a draft never written yet (revision 0), as
    // `draftRow` makes it, in the table's column order.
    db
      .insert(appDrafts)
      .select(
        sql`SELECT ${app}, ${base}, ${revision + 1}, NULL, ${at.getTime()}, ${by.userId} WHERE ${live}`
      )
      .onConflictDoUpdate({
        target: appDrafts.appId,
        set: {
          base,
          revision: revision + 1,
          definition: null,
          updatedAt: at,
          updatedBy: by.userId,
        },
        setWhere: eq(appDrafts.revision, revision),
      }),
    db.delete(appDraftFiles).where(and(eq(appDraftFiles.appId, app), emptied)),
    // Numbered in the statement, after whichever point landed last, in
    // the table's column order.
    db
      .insert(appDraftPoints)
      .select(
        sql`SELECT ${app}, COALESCE((SELECT MAX(number) FROM app_draft_points WHERE app_id = ${app}), 0) + 1, ${revision + 1}, ${base}, NULL, ${contentHash}, ${by.userId}, NULL, NULL, NULL, NULL, ${at.getTime()} WHERE ${emptied}`
      ),
    ...(discards
      ? [
          outboxedWhere(
            db,
            changeEntry(by, "app.draft.discarded", app, {
              revision: revision + 1,
            }),
            emptied
          ),
        ]
      : []),
  ];
};

/** Paths in one stable order, whatever order they were read in. */
const byPath = (one: string, other: string): number => {
  if (one === other) {
    return 0;
  }
  return one < other ? -1 : 1;
};

/** Most undo points one `draftPoints` call answers. */
export const pointsPerPage = 50;

/**
 * The paths each of `points` changed against the one before it, by point:
 * each holds the draft's changes over its base, so a point over the same
 * base as the one before touched the paths whose content differs; one
 * over another base (the first, or the first after a publish) touched
 * the paths it changes. `points` run from the one before the page (none
 * for the draft's first), whose own paths aren't answered.
 */
const touchedByPoint = (
  points: readonly { number: number; base: number | null }[],
  files: readonly { number: number; path: string; hash: string | null }[]
): Map<number, string[]> => {
  const held = new Map<number, Map<string, string | null>>();
  for (const { number, path, hash } of files) {
    const each = held.get(number) ?? new Map<string, string | null>();
    each.set(path, hash);
    held.set(number, each);
  }
  const ascending = points.toSorted((a, b) => a.number - b.number);
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
 * App `app`'s undo points, newest first, each with the paths it touched:
 * the newest {@link pointsPerPage}, or those before point `before`, for
 * the next page.
 */
export const draftPoints = async (
  env: Env,
  app: AppId,
  before?: number
): Promise<AppDraftHistoryPoint[]> => {
  const db = drizzle(env.DB);
  // One more than the page: the point before it, which what the page's
  // oldest touched is against.
  const rows = await db
    .select()
    .from(appDraftPoints)
    .where(
      and(
        eq(appDraftPoints.appId, app),
        before === undefined ? undefined : lt(appDraftPoints.number, before)
      )
    )
    .orderBy(desc(appDraftPoints.number))
    .limit(pointsPerPage + 1);
  const oldest = rows.at(-1)?.number ?? 0;
  const files = await db
    .select({
      number: appDraftPointFiles.number,
      path: appDraftPointFiles.path,
      hash: appDraftPointFiles.sha256,
    })
    .from(appDraftPointFiles)
    .where(
      and(
        eq(appDraftPointFiles.appId, app),
        gte(appDraftPointFiles.number, oldest),
        lte(appDraftPointFiles.number, rows[0]?.number ?? 0)
      )
    );
  const touched = touchedByPoint(rows, files);
  const changes = new Map<number, number>();
  for (const { number } of files) {
    changes.set(number, (changes.get(number) ?? 0) + 1);
  }
  return rows.slice(0, pointsPerPage).map((row) => ({
    ...toPoint(row),
    touched: touched.get(row.number) ?? [],
    changes: changes.get(row.number) ?? 0,
  }));
};

/**
 * Undo point `number` of App `app`'s draft, with what it holds, as a
 * draft at the revision it made: `app.version_not_found` when there is
 * none.
 */
export const readPoint = async (
  env: Env,
  app: AppId,
  number: unknown
): Promise<{ point: AppDraftPoint; draft: Draft }> => {
  const db = drizzle(env.DB);
  const row =
    typeof number === "number" && Number.isSafeInteger(number)
      ? await db
          .select()
          .from(appDraftPoints)
          .where(
            and(
              eq(appDraftPoints.appId, app),
              eq(appDraftPoints.number, number)
            )
          )
          .get()
      : undefined;
  if (row === undefined) {
    throw appErrors.create("app.version_not_found");
  }
  const files = await db
    .select({
      path: appDraftPointFiles.path,
      content: appDraftContents.content,
    })
    .from(appDraftPointFiles)
    .leftJoin(
      appDraftContents,
      and(
        eq(appDraftContents.appId, appDraftPointFiles.appId),
        eq(appDraftContents.sha256, appDraftPointFiles.sha256)
      )
    )
    .where(
      and(
        eq(appDraftPointFiles.appId, app),
        eq(appDraftPointFiles.number, row.number)
      )
    )
    .all();
  return {
    point: toPoint(row),
    draft: {
      base: row.base,
      changes: Object.fromEntries(
        files.map(({ path, content }) => [path, content])
      ),
      definition: row.definition,
      revision: row.revision,
    },
  };
};

/**
 * Makes undo point `number` of App `app`'s draft the draft again, over
 * `revision`, which `by` read, as its next point, audited as theirs: no
 * point is changed. `app.conflict` when the draft moved since.
 */
export const restorePoint = async (
  env: Env,
  by: Acting,
  app: AppId,
  number: unknown,
  revision: number
): Promise<AppDraftPoint> => {
  const db = drizzle(env.DB);
  const { point, draft } = await readPoint(env, app, number);
  const restored: Draft = { ...draft, revision: revision + 1 };
  const createdAt = new Date();
  const kept = await keepPoint(
    db,
    app,
    restored,
    revision,
    {
      personId: by.userId,
      chatId: null,
      turnId: null,
      callId: null,
      restoredFrom: point.number,
    },
    createdAt
  );
  await writeOver(env, db, app, [
    draftRow(db, app, draft, revision, by.userId, createdAt),
    db.delete(appDraftFiles).where(eq(appDraftFiles.appId, app)),
    ...Object.entries(draft.changes).map(([path, content]) =>
      db.insert(appDraftFiles).values({ appId: app, path, content })
    ),
    ...kept.statements,
    outboxed(
      db,
      changeEntry(by, "app.draft.restored", app, {
        point: kept.row.number,
        restoredFrom: point.number,
      })
    ),
  ]);
  return toPoint(kept.row);
};

/**
 * The Apps whose drafts chat `chatId`'s agent wrote in turn `turnId`:
 * those with an undo point of that turn's, kept with the draft, so a
 * restart forgets none.
 */
export const turnApps = async (
  env: Env,
  chatId: string,
  turnId: string
): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .selectDistinct({ appId: appDraftPoints.appId })
    .from(appDraftPoints)
    .where(
      and(eq(appDraftPoints.chatId, chatId), eq(appDraftPoints.turnId, turnId))
    )
    .all();
  return rows.map(({ appId }) => appId);
};

/**
 * What chat `chatId`'s agent worked on, the most recently written first:
 * each App with an undo point naming the chat, at its latest one.
 */
export const chatWork = async (
  env: Env,
  chatId: string
): Promise<ChatWork[]> => {
  const rows = await drizzle(env.DB)
    .select({
      appId: appDraftPoints.appId,
      createdAt: appDraftPoints.createdAt,
      callId: appDraftPoints.callId,
    })
    .from(appDraftPoints)
    .where(
      and(
        eq(appDraftPoints.chatId, chatId),
        sql`${appDraftPoints.number} = (SELECT MAX(number) FROM app_draft_points AS own WHERE own.app_id = ${appDraftPoints.appId} AND own.chat_id = ${chatId})`
      )
    )
    .orderBy(desc(appDraftPoints.createdAt))
    .all();
  return rows.map(({ appId, createdAt, callId }) => ({
    kind: "app",
    id: appId,
    updatedAt: createdAt.toISOString(),
    callId,
  }));
};

/**
 * The chats of `personId`'s whose agent wrote App `app`'s draft: those an
 * undo point names, for the App's page to carry on in (`ChatsApi.forApp`).
 */
export const chatsWorkedOn = async (
  env: Env,
  app: AppId,
  personId: string
): Promise<string[]> => {
  const rows = await drizzle(env.DB)
    .selectDistinct({ chatId: appDraftPoints.chatId })
    .from(appDraftPoints)
    .where(
      and(eq(appDraftPoints.appId, app), eq(appDraftPoints.personId, personId))
    )
    .all();
  return rows.flatMap(({ chatId }) => (chatId === null ? [] : [chatId]));
};
