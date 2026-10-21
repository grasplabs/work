import { isExpectedCode, isExpectedError } from "@grasp-os/shared/errors";
import { errorFields, log } from "@grasp-os/shared/log";
import type { WorkflowStepConfig } from "@grasp-os/workerflow/contracts";
import { NonRetryableError } from "@grasp-os/workerflow/errors";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import {
  brainPayloads,
  documents,
  sections,
  versions,
} from "../db/knowledge/schema.ts";
import { runEngine } from "../workflows/engine.ts";
import type { RunStep } from "../workflows/host.ts";
import { parseBaseFields } from "./frontmatter.ts";
import { splitSections } from "./markdown.ts";
import type { Section } from "./markdown.ts";
import { readPayload } from "./payloads.ts";

// Indexing: what search holds of a document is one generation, the
// sections of one version (`documents.indexed_version`), replaced whole.
//
// The save that makes a version current also marks it `queued`, in its own
// batch: the document row is the durable intent, and only the current
// version is ever indexed, so a superseded one needs no work. Right after
// its batch, the save publishes the version from the sections it has
// already split (`publishInline`); when that fails, or the isolate stops
// first, the document stays queued and search keeps serving the previous
// generation, whole, until the indexing workflow publishes it.
//
// Publishing is one batch, guarded by the version still being current and
// newer than the one indexed (`guard`): the old sections are deleted, the
// new ones inserted, each taking its version from the guard (NULL, which
// `sections.version` refuses, when it fails, so the whole batch goes), and
// the document marked indexed last. So a late generation never replaces a
// newer one, and readers never see two generations mixed.
//
// The workflow (`runIndexing`, once per document version) reads the
// version's payload and publishes it, retrying with backoff; each failed
// attempt marks the document `retrying`, and once the retries are spent it
// is `failed`, with the code of why: the dead letter. The cron trigger
// starts runs that never started and fails documents whose run ended
// without indexing them (`sweepIndexing`).

/** D1 binds at most 100 parameters to one statement: a section binds 8. */
const sectionsPerInsert = 10;

/** Documents the cron trigger looks at, each minute. */
const sweepBatch = 20;

/** How long a document may stay queued before the cron trigger looks. */
const staleAfterMs = 2 * 60_000;

/** Where the engine has a run that has ended. */
const endedStatuses: ReadonlySet<string> = new Set([
  "complete",
  "errored",
  "terminated",
]);

/**
 * Retries of the publishing step: three, 30 seconds apart and doubling
 * (none in tests), so a moment's outage passes and a failing document
 * fails within minutes.
 */
const indexConfig: WorkflowStepConfig = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: 5 * 60_000,
};

const inputSchema = z.object({
  documentId: z.string().min(1),
  version: z.int().min(1),
});

/** A document version's indexing run: its instance on the engine. */
export const indexRunId = (documentId: string, version: number): string =>
  `index-${documentId}-${version}`;

/** The sections of a version's text, as search holds them. */
export const sectionsOf = (path: string, text: string): Section[] =>
  splitSections(parseBaseFields(path, text).body);

/**
 * Whether `version` of `documentId` may be published now: it is current,
 * and newer than the version indexed.
 */
const guard = (documentId: string, version: number): SQL =>
  sql`EXISTS (SELECT 1 FROM ${documents} WHERE ${documents.id} = ${documentId} AND ${documents.currentVersion} = ${version} AND coalesce(${documents.indexedVersion}, 0) < ${version})`;

/** The batch that publishes `found`, version `version`'s sections. */
const publishStatements = (
  db: DrizzleD1Database,
  documentId: string,
  version: number,
  found: readonly Section[]
): [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] => {
  const rows = found.map((section, position) => ({
    documentId,
    version: sql<number>`(SELECT ${version} WHERE ${guard(documentId, version)})`,
    position,
    headings: JSON.stringify(section.headings),
    text: section.text,
  }));
  const inserts: BatchItem<"sqlite">[] = [];
  for (let start = 0; start < rows.length; start += sectionsPerInsert) {
    inserts.push(
      db.insert(sections).values(rows.slice(start, start + sectionsPerInsert))
    );
  }
  return [
    db
      .delete(sections)
      .where(
        and(eq(sections.documentId, documentId), guard(documentId, version))
      ),
    ...inserts,
    // Last: the guard above reads the version indexed before it.
    db
      .update(documents)
      .set({
        indexedVersion: version,
        indexState: "indexed",
        indexAttempts: 0,
        indexFailure: null,
      })
      .where(and(eq(documents.id, documentId), guard(documentId, version))),
  ];
};

/** The current and indexed versions of `documentId`, if it exists. */
const versionsOf = async (db: DrizzleD1Database, documentId: string) =>
  await db
    .select({
      currentVersion: documents.currentVersion,
      indexedVersion: documents.indexedVersion,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .get();

/**
 * Publishes `found` as `version` of `documentId`, if it may be (`guard`).
 * Resolves whether search holds that version now; a newer version that
 * became current meanwhile is the save's that made it to publish. A batch
 * that fails while the version is still current throws, to retry.
 */
export const publish = async (
  db: DrizzleD1Database,
  documentId: string,
  version: number,
  found: readonly Section[]
): Promise<boolean> => {
  let failure: Error | undefined;
  try {
    await db.batch(publishStatements(db, documentId, version, found));
  } catch (error) {
    failure =
      error instanceof Error
        ? error
        : new Error("The publish batch failed", { cause: error });
  }
  // Read after the batch, however it went: a stale generation's batch
  // fails on the guard, which says nothing of why in a way to rely on.
  const now = await versionsOf(db, documentId);
  const indexed = (now?.indexedVersion ?? 0) >= version;
  if (failure !== undefined && !indexed && now?.currentVersion === version) {
    throw failure;
  }
  return indexed;
};

/** Starts the indexing run of `version` of `documentId`. */
const startRun = async (
  env: Env,
  documentId: string,
  version: number
): Promise<void> => {
  await runEngine(env).createInternal({
    id: indexRunId(documentId, version),
    workflow: "indexing",
    input: { documentId, version },
  });
};

/**
 * Publishes a save's version from the sections it split, right after its
 * batch. Resolves whether search holds it now. When it can't, the
 * document stays queued and its indexing run is started; that failing
 * too, the cron trigger starts it. `required` (a purge, whose erasure
 * mustn't wait on the index) throws instead.
 */
export const publishInline = async (
  env: Env,
  db: DrizzleD1Database,
  documentId: string,
  version: number,
  found: readonly Section[],
  required: boolean
): Promise<boolean> => {
  try {
    return await publish(db, documentId, version, found);
  } catch (error) {
    if (required) {
      throw error;
    }
    log.warn("knowledge.index_inline_failed", errorFields(error));
  }
  try {
    await startRun(env, documentId, version);
  } catch (error) {
    log.warn("knowledge.index_run_start_failed", errorFields(error));
  }
  return false;
};

/** What indexing a version that is still current sets, by `where`. */
const whileCurrent = (documentId: string, version: number): SQL | undefined =>
  and(
    eq(documents.id, documentId),
    eq(documents.currentVersion, version),
    ne(documents.indexState, "indexed")
  );

/**
 * Reads `version` of `documentId` from its payload and publishes it.
 * Resolves without doing anything once it is superseded or indexed.
 */
export const indexVersion = async (
  env: Env,
  documentId: string,
  version: number
): Promise<void> => {
  const db = drizzle(env.KNOWLEDGE);
  const found = await db
    .select({
      path: documents.path,
      currentVersion: documents.currentVersion,
      indexedVersion: documents.indexedVersion,
      key: brainPayloads.key,
      sha256: brainPayloads.sha256,
    })
    .from(documents)
    .innerJoin(
      versions,
      and(eq(versions.documentId, documents.id), eq(versions.number, version))
    )
    .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
    .where(eq(documents.id, documentId))
    .get();
  if (
    found === undefined ||
    found.currentVersion !== version ||
    (found.indexedVersion ?? 0) >= version
  ) {
    return;
  }
  const text = await readPayload(env, found);
  await publish(db, documentId, version, sectionsOf(found.path, text));
};

/** The code an error ends indexing with, as the engine keeps its message. */
const codeOf = (error: unknown): string => {
  const code =
    error instanceof Error ? error.message.split(": ").at(-1) : undefined;
  return isExpectedCode(code) ? code : "internal.unexpected";
};

/** Runs (or resumes) the indexing of one document version. */
export const runIndexing = async (
  env: Env,
  payload: unknown,
  step: RunStep
): Promise<void> => {
  const { documentId, version } = inputSchema.parse(payload);
  const db = drizzle(env.KNOWLEDGE);
  try {
    await step.do("index", indexConfig, async () => {
      try {
        await indexVersion(env, documentId, version);
      } catch (error) {
        const code = isExpectedError(error) ? error.code : undefined;
        await db
          .update(documents)
          .set({
            indexState: "retrying",
            indexAttempts: sql`${documents.indexAttempts} + 1`,
            indexFailure: code ?? "internal.unexpected",
          })
          .where(whileCurrent(documentId, version));
        // By its code, which survives the engine.
        throw code === undefined ? error : new Error(code);
      }
      return null;
    });
  } catch (error) {
    const code =
      error instanceof NonRetryableError ? error.message : codeOf(error);
    await step.do("fail", {}, async () => {
      await db
        .update(documents)
        .set({ indexState: "failed", indexFailure: code })
        .where(whileCurrent(documentId, version));
      return null;
    });
  }
};

/**
 * Every minute (index.ts): looks at documents queued (or retrying) for a
 * while. One whose run never started gets it; one whose run ended without
 * indexing it fails.
 */
export const sweepIndexing = async (env: Env, now: Date): Promise<void> => {
  const db = drizzle(env.KNOWLEDGE);
  const stale = await db
    .select({ id: documents.id, version: documents.currentVersion })
    .from(documents)
    .where(
      and(
        inArray(documents.indexState, ["queued", "retrying"]),
        lt(documents.updatedAt, new Date(now.getTime() - staleAfterMs))
      )
    )
    // In no order: documents whose runs are still retrying stay stale for a
    // while, and mustn't keep the rest from being seen.
    .orderBy(sql`random()`)
    .limit(sweepBatch);
  const engine = runEngine(env);
  for (const { id, version } of stale) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      const run = await engine.status(indexRunId(id, version));
      if (run === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await startRun(env, id, version);
      } else if (endedStatuses.has(run.status)) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await db
          .update(documents)
          .set({ indexState: "failed", indexFailure: "internal.unexpected" })
          .where(whileCurrent(id, version));
      }
    } catch (error) {
      // One document's trouble doesn't keep the sweep from the rest.
      log.warn("knowledge.index_sweep_failed", errorFields(error));
    }
  }
};
