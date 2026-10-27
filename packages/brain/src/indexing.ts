import { and, eq, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { outboxedIfChanged } from "./audit.ts";
import type { Brain } from "./brain.ts";
import { brainErrors } from "./contract.ts";
import { insertChunks } from "./db/d1.ts";
import { brainPayloads, documents, sections, versions } from "./db/schema.ts";
import { parseBaseFields } from "./frontmatter.ts";
import type { Json } from "./json.ts";
import { knowledgeErrors } from "./knowledge.ts";
import { log } from "./log.ts";
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
// The workflow (`runIndexing`, once per document version and run) reads the
// version's payload and publishes it, retrying with backoff; each failed
// attempt marks the document `retrying`, and once the retries are spent it
// is `failed`, with the code of why: the dead letter. The cron trigger
// starts runs that never started and fails documents whose run ended
// without indexing them (`sweepIndexing`), and starts a new run for a
// failed document after a while, doubling, a bounded number of times.
//
// A purge can't wait on that: whatever saved the document, search must hold
// its current version before the purge reports done
// (`requireCurrentIndexed`), or the purge fails with
// `knowledge.purge_index_pending` and its indexing run is started.

/** How the host retries and times a step of an indexing job. */
export interface StepConfig {
  retries?: {
    /** Retries after the first attempt. */
    limit: number;
    delay: `${number} seconds`;
    backoff: "constant" | "linear" | "exponential";
  };
  /** Each attempt's, in ms. */
  timeout?: number;
}

/**
 * A durable step, as the host's job runner gives `runIndexing` one: `do`
 * runs `fn` once, retrying it as `config` says, and returns its result
 * again when the job is replayed.
 */
export interface IndexStep {
  do: (
    name: string,
    config: StepConfig,
    fn: () => Promise<unknown>
  ) => Promise<unknown>;
}

/** Documents the cron trigger looks at, each minute. */
const sweepBatch = 20;

/** How long a document may stay queued before the cron trigger looks. */
const staleAfterMs = 2 * 60_000;

/**
 * Retries of the publishing step: three, 30 seconds apart and doubling
 * (none in tests), so a moment's outage passes and a failing document
 * fails within minutes.
 */
const indexConfig: StepConfig = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: 5 * 60_000,
};

const inputSchema = z.object({
  documentId: z.string().min(1),
  version: z.int().min(1),
});

/** A document version's indexing run: its job, as the host runs it. */
export const indexRunId = (
  documentId: string,
  version: number,
  run: number
): string => `index-${documentId}-${version}-${run}`;

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
  const inserts = insertChunks(
    rows,
    (row) => db.insert(sections).values(row).toSQL().params.length
  ).map((chunk) => db.insert(sections).values(chunk));
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
        indexFailedAt: null,
        indexPurgePending: false,
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

/** Starts run `run` of indexing `version` of `documentId`. */
const startRun = async <C>(
  brain: Brain<C>,
  documentId: string,
  version: number,
  run: number
): Promise<void> => {
  await brain.ports.jobs.start(indexRunId(documentId, version, run), {
    documentId,
    version,
  });
};

/**
 * What a failure is logged with: its name only. A message may repeat what
 * failed to be written, and a purge's would hold the terms it removes.
 */
const failureFields = (error: unknown) => ({
  errorName: error instanceof Error ? error.name : typeof error,
});

/** The current and indexed versions, and run, of `documentId`. */
const stateOf = async (db: DrizzleD1Database, documentId: string) =>
  await db
    .select({
      currentVersion: documents.currentVersion,
      indexedVersion: documents.indexedVersion,
      indexRun: documents.indexRun,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .get();

/**
 * Starts indexing `documentId`'s current version now, logging a failure:
 * its run, unless that one is still going; once that one has ended (failed),
 * the next run, whatever backoff the cron trigger would have kept.
 */
const startCurrentRun = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  documentId: string
): Promise<void> => {
  try {
    const state = await stateOf(db, documentId);
    if (state === undefined) {
      return;
    }
    const { currentVersion: version, indexRun: run } = state;
    const status = await brain.ports.jobs.status(
      indexRunId(documentId, version, run)
    );
    if (status === undefined) {
      await startRun(brain, documentId, version, run);
      return;
    }
    if (status !== "ended") {
      return;
    }
    const [taken] = await db
      .update(documents)
      .set({ indexState: "retrying", indexRun: run + 1, indexFailedAt: null })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.currentVersion, version),
          eq(documents.indexRun, run),
          ne(documents.indexState, "indexed")
        )
      )
      .returning({ id: documents.id });
    if (taken !== undefined) {
      await startRun(brain, documentId, version, run + 1);
    }
  } catch (error) {
    log.warn("knowledge.index_run_start_failed", failureFields(error));
  }
};

/**
 * A purge's refusal while search may still hold a generation with its
 * terms: the data is rewritten, the index isn't yet. Running the purge
 * again finishes it, as does the indexing run started for it.
 */
const pending = () => knowledgeErrors.create("knowledge.purge_index_pending");

/**
 * Starts `documentId`'s indexing now, marks it as one a purge is waiting
 * on (never dropped from the reruns, `rerunFailed`), with the purge's
 * audit event saying it ended pending, and throws
 * `knowledge.purge_index_pending`.
 */
const refusePurgePending = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  documentId: string,
  actor: Json
): Promise<never> => {
  try {
    const state = await stateOf(db, documentId);
    // Only while search doesn't hold its current version; its audit event
    // with it, in one batch, and drained with the cron trigger's next run.
    await db.batch([
      db
        .update(documents)
        .set({ indexPurgePending: true })
        .where(
          and(
            eq(documents.id, documentId),
            sql`coalesce(${documents.indexedVersion}, 0) <> ${documents.currentVersion}`
          )
        ),
      outboxedIfChanged(brain, {
        actor,
        action: "knowledge.purge.index_pending",
        target: { type: "document", id: documentId },
        detail: { version: state?.currentVersion ?? 0 },
      }),
    ]);
  } catch (error) {
    // Pending all the same: the purge says so, whatever this failed with.
    log.warn("knowledge.index_purge_mark_failed", failureFields(error));
  }
  await startCurrentRun(brain, db, documentId);
  throw pending();
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
export const indexVersion = async <C>(
  brain: Brain<C>,
  documentId: string,
  version: number
): Promise<void> => {
  const { db } = brain;
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
  const text = await readPayload(brain, found);
  await publish(db, documentId, version, sectionsOf(found.path, text));
};

/** How often a purge publishes a document saved over while it does. */
const requireAttempts = 3;

/**
 * Makes sure search holds `documentId`'s current version, publishing it
 * from its payload when it doesn't: a purge's, so that no generation it
 * hasn't rewritten stays live. Throws `knowledge.purge_index_pending`
 * when it can't (its indexing run started), never resolving otherwise.
 */
export const requireCurrentIndexed = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  documentId: string,
  actor: Json
): Promise<void> => {
  for (let attempt = 0; attempt < requireAttempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- again only after a save
    const state = await stateOf(db, documentId);
    if (state === undefined || state.indexedVersion === state.currentVersion) {
      return;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- again only after a save
      await indexVersion(brain, documentId, state.currentVersion);
    } catch (error) {
      log.warn("knowledge.index_purge_failed", failureFields(error));
      // oxlint-disable-next-line no-await-in-loop -- once, before refusing
      await refusePurgePending(brain, db, documentId, actor);
    }
  }
  await refusePurgePending(brain, db, documentId, actor);
};

/**
 * Publishes a save's version from the sections it split, right after its
 * batch. Resolves whether search holds it now. When it can't, the
 * document stays queued and its indexing run is started; that failing
 * too, the cron trigger starts it. A purge's (`purgeBy`), whose erasure
 * mustn't wait on the index, makes sure search holds the current version,
 * whatever saved it (`requireCurrentIndexed`), or throws.
 */
export const publishInline = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  documentId: string,
  version: number,
  found: readonly Section[],
  purgeBy: Json | undefined
): Promise<boolean> => {
  try {
    const published = await publish(db, documentId, version, found);
    if (purgeBy !== undefined && !published) {
      // Saved over meanwhile: what search holds must still be current.
      await requireCurrentIndexed(brain, db, documentId, purgeBy);
    }
    return published;
  } catch (error) {
    if (knowledgeErrors.codeOf(error) === "knowledge.purge_index_pending") {
      throw error;
    }
    log.warn("knowledge.index_inline_failed", failureFields(error));
    if (purgeBy !== undefined) {
      await refusePurgePending(brain, db, documentId, purgeBy);
    }
    await startCurrentRun(brain, db, documentId);
    return false;
  }
};

/** Whether `code` is one of the Brain's own codes. */
const isBrainCode = (code: unknown): code is string =>
  knowledgeErrors.codeOf({ code }) !== undefined ||
  brainErrors.codeOf({ code }) !== undefined;

/** The code an error ends indexing with, as the engine keeps its message. */
const codeOf = (error: unknown): string => {
  const code =
    error instanceof Error ? error.message.split(": ").at(-1) : undefined;
  return isBrainCode(code) ? code : "internal.unexpected";
};

/** Runs (or resumes) the indexing of one document version. */
export const runIndexing = async <C>(
  brain: Brain<C>,
  payload: unknown,
  step: IndexStep
): Promise<void> => {
  const { documentId, version } = inputSchema.parse(payload);
  const { db } = brain;
  try {
    await step.do("index", indexConfig, async () => {
      try {
        await indexVersion(brain, documentId, version);
      } catch (error) {
        const found =
          knowledgeErrors.codeOf(error) ?? brainErrors.codeOf(error);
        const code = found ?? "internal.unexpected";
        await db
          .update(documents)
          .set({
            indexState: "retrying",
            indexAttempts: sql`${documents.indexAttempts} + 1`,
            indexFailure: code,
          })
          .where(whileCurrent(documentId, version));
        // Only its code reaches the engine, never its message.
        throw new Error(code, { cause: error });
      }
      return null;
    });
  } catch (error) {
    const code = codeOf(error);
    await step.do("fail", {}, async () => {
      await db
        .update(documents)
        .set({
          indexState: "failed",
          indexFailure: code,
          indexFailedAt: brain.ports.clock(),
        })
        .where(whileCurrent(documentId, version));
      return null;
    });
  }
};

/**
 * Runs the cron trigger starts again for a failed document, at most,
 * unless a purge is waiting on it (`indexPurgePending`): that one's go on,
 * a day apart, for as long as it takes.
 */
export const maxIndexReruns = 8;

/** How long a document stays failed before run `run` is started. */
const rerunAfterMs = (run: number): number =>
  Math.min(15 * 60_000 * 2 ** run, 24 * 60 * 60_000);

/**
 * Gives up on `id`, failed for good at run {@link maxIndexReruns}: once,
 * logged and audited as `knowledge.index_exhausted`. Search keeps the
 * version it holds until the next save.
 */
const exhaust = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  id: string,
  version: number
): Promise<void> => {
  // The claim and its audit event in one batch: recorded once, or not at
  // all and claimed again by the next sweep.
  const [claimed] = await db.batch([
    db
      .update(documents)
      .set({ indexRun: maxIndexReruns + 1 })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.currentVersion, version),
          eq(documents.indexState, "failed"),
          eq(documents.indexRun, maxIndexReruns),
          eq(documents.indexPurgePending, false)
        )
      )
      .returning({ id: documents.id }),
    outboxedIfChanged(brain, {
      actor: { type: "system" },
      action: "knowledge.index_exhausted",
      target: { type: "document", id },
      detail: { version, runs: maxIndexReruns + 1 },
    }),
  ]);
  if (claimed.length > 0) {
    log.error("knowledge.index_exhausted", { documentId: id, version });
  }
};

/**
 * Starts the next run for documents failed for long enough (`rerunAfterMs`,
 * doubling up to a day), so a text a later save replaced (a removal, say)
 * doesn't stay matchable until the next save: up to
 * {@link maxIndexReruns} times, or for as long as a purge waits on it.
 */
const rerunFailed = async <C>(
  brain: Brain<C>,
  db: DrizzleD1Database,
  now: Date
): Promise<void> => {
  const failed = await db
    .select({
      id: documents.id,
      version: documents.currentVersion,
      run: documents.indexRun,
      failedAt: documents.indexFailedAt,
      purgePending: documents.indexPurgePending,
    })
    .from(documents)
    .where(
      and(
        eq(documents.indexState, "failed"),
        or(
          lte(documents.indexRun, maxIndexReruns),
          eq(documents.indexPurgePending, true)
        )
      )
    )
    .orderBy(sql`random()`)
    .limit(sweepBatch);
  for (const { id, version, run, failedAt, purgePending } of failed) {
    try {
      if (run >= maxIndexReruns && !purgePending) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await exhaust(brain, db, id, version);
        continue;
      }
      if (
        failedAt !== null &&
        now.getTime() - failedAt.getTime() < rerunAfterMs(run)
      ) {
        continue;
      }
      // The row first, under the run it was failed by: one sweep starts it.
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      const [taken] = await db
        .update(documents)
        .set({ indexState: "retrying", indexRun: run + 1 })
        .where(
          and(
            eq(documents.id, id),
            eq(documents.currentVersion, version),
            eq(documents.indexState, "failed"),
            eq(documents.indexRun, run)
          )
        )
        .returning({ id: documents.id });
      if (taken !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await startRun(brain, id, version, run + 1);
      }
    } catch (error) {
      log.warn("knowledge.index_sweep_failed", failureFields(error));
    }
  }
};

/**
 * Every minute (index.ts): looks at documents queued (or retrying) for a
 * while. One whose run never started gets it; one whose run ended without
 * indexing it fails. Then starts runs again for failed ones
 * (`rerunFailed`).
 */
export const sweepIndexing = async <C>(
  brain: Brain<C>,
  now: Date
): Promise<void> => {
  const { db } = brain;
  const stale = await db
    .select({
      id: documents.id,
      version: documents.currentVersion,
      run: documents.indexRun,
    })
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
  const { jobs } = brain.ports;
  for (const { id, version, run } of stale) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      const status = await jobs.status(indexRunId(id, version, run));
      if (status === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await startRun(brain, id, version, run);
      } else if (status === "ended") {
        // oxlint-disable-next-line no-await-in-loop -- a few at a time
        await db
          .update(documents)
          .set({
            indexState: "failed",
            indexFailure: "internal.unexpected",
            indexFailedAt: now,
          })
          // Only while it is still the run read: a purge run again since
          // may have started the next one, which this mustn't fail.
          .where(and(whileCurrent(id, version), eq(documents.indexRun, run)));
      }
    } catch (error) {
      // One document's trouble doesn't keep the sweep from the rest.
      log.warn("knowledge.index_sweep_failed", failureFields(error));
    }
  }
  await rerunFailed(brain, db, now);
};
