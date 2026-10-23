import { ensureCollection } from "@grasp-os/brain/collections";
import type { CollectionRow } from "@grasp-os/brain/collections";
import { writeVersion } from "@grasp-os/brain/documents";
import type { Writer } from "@grasp-os/brain/documents";
import type { ErasedDocument, OnErase } from "@grasp-os/brain/purge";
import { brainPayloads, documents, versions } from "@grasp-os/brain/schema";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { stringify } from "yaml";

import { versionFiles } from "../apps.ts";
import { appEntries, apps } from "../db/core/schema.ts";
import { appEntryPath, appOfEntry, appsCollectionId } from "./app-entries.ts";
import { appMemoryPath } from "./memory-files.ts";
import { brainOf } from "./ports.ts";

// The Apps collection: one entry per App, its AGENTS.md at its current
// version, with its name and description, so people and agents find the
// App that already does what they want before they create another (same
// process, same App). Who finds which entry is app-entries.ts.
//
// Nobody saves or restores in it: the collection's source is `apps`,
// which every save and restore refuses (collections.ts
// `requireWritable`). The indexer's writes go through the save pipeline,
// as `system`, so each is a version with its audit event. A purge naming
// an entry is refused while what indexing would write now (`entryNow`:
// the App's name, description and current version's AGENTS.md) holds a
// term (purge.ts `requireSavable`): the next indexing would put it back,
// from the App itself, out of a purge's reach. Once the App no longer
// holds it, the purge rewrites the entry's history like any document's.
//
// The App registry is in the core database and the collection in
// Knowledge's, so no batch holds both. Making a version current indexes
// the App straight after (`indexAppNow`), and a cron trigger every 15
// minutes indexes every App whose entry isn't of its current version
// (`indexApps`): one whose indexing failed. Indexing
// where a version is made current keeps entries current; the cron trigger
// only catches up, so every 15 minutes is enough. `app_entries`, in core's
// database, has the version each entry holds, written once the entry is:
// should that write fail, the entry is indexed again by the next run.
//
// Two indexings of one App at once (a version change and the cron, say)
// never write over each other: each reads what `app_entries` holds and the
// entry before the App, and writes only over the entry's version it read
// (the save's `ifVersion`), so the one that loses writes nothing; one that
// finds the text unchanged notes its version only over the note it read
// (`noteVersion`). The one that wins may
// have read the App before a version change that the loser saw, and so
// leave the text of a version that is no longer current: `app_entries`
// then names that version, which differs from the App's, and the next
// cron run indexes it again. So the entry heals itself within 15 minutes.

/** Who indexes: Grasp itself, with no person behind it. */
const appsActor: AuditActor = { type: "system" };

/** The author and owner of the entries' versions. */
const appsWriter: Writer = { actor: appsActor, userId: "grasp" };

/** Most Apps one cron run indexes: each is a read from R2 and a batch. */
const indexedPerRun = 20;

/**
 * Knowledge's refusals of an App's AGENTS.md as it is, which the App's
 * own limits allow: its entry is then indexed without it.
 */
const refusedAsTooLarge: ReadonlySet<string> = new Set([
  "knowledge.too_large",
  "knowledge.too_many_sections",
  "knowledge.too_many_links",
]);

const appsCollectionRow = (): CollectionRow => ({
  id: appsCollectionId,
  name: "Apps",
  description:
    "Every App's AGENTS.md, as its current version has it: what it does and how. Search here before creating an App: same process, same App. You find only the Apps you may open.",
  owner: "grasp",
  access: "everyone",
  sensitive: false,
  source: "apps",
  createdAt: new Date(),
});

interface IndexedApp {
  id: string;
  name: string;
  description: string;
}

/**
 * An App's entry: its name as the title and its description, which search
 * weighs first, and its ID; then its AGENTS.md, as the App has it (its own
 * frontmatter, if any, is text of the entry).
 */
const entryText = (app: IndexedApp, body: string): string =>
  `---\n${stringify({ title: app.name, description: app.description, app: app.id })}---\n${body}`;

/** The App `appId`, if it exists. */
const appInUse = async (env: Env, appId: string) =>
  await drizzle(env.DB)
    .select({
      id: apps.id,
      name: apps.name,
      description: apps.description,
      currentVersion: apps.currentVersion,
    })
    .from(apps)
    .where(eq(apps.id, appId))
    .get();

/** The AGENTS.md of version `version` of the App `appId`, as indexed. */
const agentsOf = async (
  env: Env,
  appId: string,
  version: number
): Promise<string> => {
  const files = await versionFiles(env, appIdSchema.parse(appId), version);
  return files[appMemoryPath] ?? "This App has no AGENTS.md.";
};

/**
 * What indexing would write for the App `appId` now: its entry's text,
 * as `entryText` makes it from the App's name and description and its
 * current version's AGENTS.md, and those parts. `undefined` when the App
 * isn't in use or has no current version. Throws what failed to read.
 */
export const entryNow = async (
  env: Env,
  appId: string
): Promise<
  | { text: string; name: string; description: string; agents: string }
  | undefined
> => {
  const app = await appInUse(env, appId);
  if (app === undefined || app.currentVersion === null) {
    return undefined;
  }
  const agents = await agentsOf(env, appId, app.currentVersion);
  return {
    text: entryText(app, agents),
    name: app.name,
    description: app.description,
    agents,
  };
};

/**
 * Sets the version the App's entry holds, once the entry does. With
 * `onlyOver`, only while `app_entries` still holds what this indexing
 * read there (`version` undefined: no row): see `indexApp`.
 */
const noteVersion = async (
  env: Env,
  appId: string,
  version: number,
  onlyOver?: { version: number | undefined }
): Promise<void> => {
  await drizzle(env.DB)
    .insert(appEntries)
    .values({ appId, version, indexedAt: new Date() })
    .onConflictDoUpdate({
      target: appEntries.appId,
      set: {
        version: sql`excluded.version`,
        indexedAt: sql`excluded.indexed_at`,
      },
      ...(onlyOver === undefined
        ? {}
        : {
            setWhere:
              onlyOver.version === undefined
                ? sql`0`
                : eq(appEntries.version, onlyOver.version),
          }),
    });
};

/**
 * Indexes the App `appId` at its current version, unless its entry holds
 * that version already, or it has none.
 * Throws what failed, `knowledge.conflict` when another indexing wrote
 * first.
 */
const indexApp = async (env: Env, appId: string): Promise<void> => {
  const knowledge = drizzle(env.KNOWLEDGE);
  const path = appEntryPath(appId);
  // What was noted and the entry first, then the App (see above).
  const noted = await drizzle(env.DB)
    .select({ version: appEntries.version })
    .from(appEntries)
    .where(eq(appEntries.appId, appId))
    .get();
  const [stored] = await knowledge
    .select({
      version: documents.currentVersion,
      sha256: brainPayloads.sha256,
    })
    .from(documents)
    .innerJoin(
      versions,
      and(
        eq(versions.documentId, documents.id),
        eq(versions.number, documents.currentVersion)
      )
    )
    .innerJoin(brainPayloads, eq(brainPayloads.key, versions.payloadKey))
    .where(
      and(
        eq(documents.collectionId, appsCollectionId),
        eq(documents.path, path)
      )
    );
  const app = await appInUse(env, appId);
  const version = app?.currentVersion ?? null;
  if (app === undefined || version === null || noted?.version === version) {
    return;
  }
  const text = entryText(app, await agentsOf(env, appId, version));
  const ifVersion = stored?.version ?? 0;
  // Compared by hash: the entry's payload isn't read.
  if (stored?.sha256 === (await sha256Hex(text))) {
    // The same text: only the version it holds, and only over what was
    // read, so an indexing that wrote another version's text meanwhile,
    // and noted it, isn't covered up: its note stays, which differs from
    // the App's, and the next run indexes the App again.
    await noteVersion(env, appId, version, { version: noted?.version });
    // A version number can come back (W, then V again), so the guard above
    // can't tell every write since; the entry's own version only grows.
    // Moved on since it was read, the entry may hold another version's
    // text under this note: the note goes, and the next run indexes the
    // App again.
    const now = await knowledge
      .select({ version: documents.currentVersion })
      .from(documents)
      .where(
        and(
          eq(documents.collectionId, appsCollectionId),
          eq(documents.path, path)
        )
      )
      .get();
    if ((now?.version ?? 0) !== ifVersion) {
      await drizzle(env.DB)
        .delete(appEntries)
        .where(eq(appEntries.appId, appId));
    }
    return;
  }
  const collection = await ensureCollection(
    brainOf(env),
    appsCollectionRow(),
    appsActor
  );
  const write = async (entry: string) =>
    await writeVersion(brainOf(env), appsWriter, {
      collection,
      path,
      text: entry,
      ifVersion,
      message: `Version ${version} of the App`,
      restoredFrom: null,
    });
  try {
    await write(text);
  } catch (error) {
    const code = knowledgeErrors.codeOf(error);
    if (code === undefined || !refusedAsTooLarge.has(code)) {
      throw error;
    }
    await write(entryText(app, "This App's AGENTS.md is too large to search."));
  }
  // Whatever was noted meanwhile: the entry now holds this version's text
  // (its save's `ifVersion` made sure of that), and `app_entries` must say
  // so. Kept from a note made since (an unchanged-text indexing of another
  // version, say), the two would agree with the App and never be indexed
  // again, with this text in the entry.
  await noteVersion(env, appId, version);
};

/**
 * `indexApp`, whose failure is logged and left to the cron trigger (see
 * `indexApps`): a conflict, another indexing that wrote first, is left to
 * it silently.
 */
export const indexAppNow = async (env: Env, appId: string): Promise<void> => {
  try {
    await indexApp(env, appId);
  } catch (error) {
    if (knowledgeErrors.codeOf(error) !== "knowledge.conflict") {
      log.error("apps.index_failed", { appId, ...errorFields(error) });
    }
  }
};

/**
 * Indexes the Apps in use whose entries aren't of their current version,
 * at most `indexedPerRun`, one at a time, from a random one on (by ID,
 * wrapping around): Apps whose indexing fails every time can't keep the
 * others waiting run after run. The cron trigger calls it every 15
 * minutes.
 */
export const indexApps = async (env: Env): Promise<void> => {
  const [noted, inUse] = await Promise.all([
    drizzle(env.DB)
      .select({ appId: appEntries.appId, version: appEntries.version })
      .from(appEntries),
    drizzle(env.DB)
      .select({ id: apps.id, currentVersion: apps.currentVersion })
      .from(apps)
      .where(isNotNull(apps.currentVersion)),
  ]);
  const held = new Map(noted.map(({ appId, version }) => [appId, version]));
  const stale = inUse
    .filter(({ id, currentVersion }) => held.get(id) !== currentVersion)
    .map(({ id }) => id)
    .toSorted();
  const [start = 0] = crypto.getRandomValues(new Uint32Array(1));
  const turn = [...stale.slice(start % stale.length), ...stale].slice(
    0,
    Math.min(stale.length, indexedPerRun)
  );
  for (const id of turn) {
    // oxlint-disable-next-line no-await-in-loop -- one App at a time
    await indexAppNow(env, id);
  }
};

/**
 * Refuses with `knowledge.read_only` a purge of an App's entry while what
 * indexing would write now (`entryNow`) holds a term (`holds`), saying
 * where: the next indexing (a version made current, the cron catching up)
 * makes the entry from the App itself, out of a purge's reach, and would
 * put it back, even when the entry is still of an older version without
 * it. Refuses too, failing closed, when the App or its current version
 * can't be read.
 */
const requireIndexedWithout = async (
  env: Env,
  document: ErasedDocument,
  holds: (text: string) => boolean
): Promise<void> => {
  const refuse = (why: string) =>
    knowledgeErrors.create("knowledge.read_only", {
      issues: [
        `documentIds: document ${document.id} is an App's entry in the Apps collection, made from the App itself: ${why}`,
      ],
    });
  const appId = appOfEntry(document.path);
  let now: Awaited<ReturnType<typeof entryNow>>;
  try {
    now = appId === undefined ? undefined : await entryNow(env, appId);
  } catch (error) {
    log.error("knowledge.purge.app_unreadable", {
      documentId: document.id,
      ...errorFields(error),
    });
    now = undefined;
  }
  if (now === undefined) {
    throw refuse(
      "the App or its current version can't be read, so it can't be checked for the terms; try again later"
    );
  }
  if (!holds(now.text)) {
    return;
  }
  const where = [
    ...(holds(now.agents)
      ? ["a term is in the App's AGENTS.md: publish a version without it"]
      : []),
    ...(holds(now.name) || holds(now.description)
      ? [
          // No API renames an App or changes its description yet.
          "a term is in the App's name or description, which a purge can't reach: the App's builders or Grasp support must change it first",
        ]
      : []),
  ];
  throw refuse(
    `${where.length > 0 ? where.join("; ") : "a term is in what indexing writes for it"}; then purge`
  );
};

/**
 * The Apps collection as a Knowledge purge reaches it (purge.ts
 * `OnErase`): its entries are made from each App, so a purge of one is
 * refused while the App holds a term.
 */
export const appsErasure = (env: Env): Pick<OnErase, "requireRewritable"> => ({
  requireRewritable: async (document, holds) => {
    if (document.source === "apps") {
      await requireIndexedWithout(env, document, holds);
    }
  },
});
