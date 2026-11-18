import { connectorIsolateRequests } from "@grasp-os/connector-kit/manifest";
import { auditActorSchema, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorName, log } from "@grasp-os/shared/log";
import { sourceReaderSchema } from "@grasp-os/shared/source-readers";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { ownPlace, syncErrors } from "@grasp-os/shared/sync";
import type {
  SyncItem,
  SyncPage,
  SyncPlaces,
  SyncReader,
  SyncSource,
} from "@grasp-os/shared/sync";
import { uploadTypes } from "@grasp-os/shared/uploads";
import type { UploadMediaType } from "@grasp-os/shared/uploads";
import { clockLeaseMs, clockPeriods } from "@grasp-os/workerflow/clock";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import {
  auditedBatch,
  outboxedEventWhere,
  uuidFromHash,
} from "./audit-outbox.ts";
import {
  addSource,
  changeSourceReaders,
  eraseOwnGroup,
  eraseSource,
  principalMaxLength,
  sourceTextProblem,
} from "./brain-next.ts";
import type { SourceReaders, SourceRef } from "./brain-next.ts";
import {
  brainSyncCatchUps,
  brainSyncDisconnects,
  brainSyncItems,
  brainSyncSources,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { localExtractor } from "./files/extract.ts";
import { brainCallsPerTick } from "./shared-reads.ts";
import { plainPrincipalOf } from "./source-readers.ts";

// Native sync's run (GRA-1758; the design is on GRA-1719, the threat
// model on GRA-1758): pages of a connection's changes, read from connect
// (`readSyncPage`, which holds the token and the provider's code), made
// into Brain sources on core's clock. Connect and the Brain never call
// each other: core reads a page and applies it.
//
// - A source is a connection, one of its connector's syncs (`feed`) and
//   a place: today a person's own account (`own`), as connect lists them
//   (`syncSources`); a shared connection syncs only places picked on it,
//   none yet. Core keeps its cursor, so a page is committed in one place.
// - Each item is a Brain source under `sync:`, keyed by its connection,
//   a generation, and a hash of its sync and the provider's ID
//   (`keyOf`): the generation goes up each time the item leaves the
//   Brain, so an erased key is never added to again. Each version's
//   change key is the item's change marker with its readers and its
//   text, so reading a page again adds nothing twice. Every add and
//   every change of readers carries when core read the page (`readAt`),
//   never the item's own `changedAt`, which a change of sharing doesn't
//   move: a run that lost its lease and lands late is refused as older.
// - Where it goes: mail and events, and a file only its owner may read
//   (or whose readers couldn't be read whole), to the owner's own store,
//   in the connection's group; any other file to the shared store, read
//   by exactly its readers (`readersOf`). A file that crosses is erased
//   where it was, then added where it goes, under its next key.
// - A page is applied in order: what went away, what lost the shared
//   store, and every change of readers (the narrowings) first, then the
//   adds, then the cursor, in one batch with the page's one audit event.
//   A page that fails, is throttled or runs out of budget part-way is
//   read again from the same cursor: what was done is in each item's row
//   and is not done again.
// - A connector may answer a cursor with "restart": the source is listed
//   again from the start, and when that listing ends (its first page with
//   nothing more), every item the listing didn't name is erased before
//   the cursor moves: a relist names no "gone" for what went away in the
//   gap.
// - A disconnect closes the connection for the sync before connect's
//   event leaves its outbox (`closeSyncOfDisconnect`): the owner's own
//   group is erased at once, and every key the shared store was given is
//   erased by the clock, a page at a time (`stepSyncErasure`). A key is
//   named here before the Brain is given it, in a statement that refuses
//   a closed connection, so nothing added after the close escapes.
// - Cost: one run spends at most a stated share of the platform's
//   subrequest limit (`syncCallsPerTick`), each call charged before it is
//   made; sources take turns by when they are due, and one that fails or
//   is throttled waits while the others go on.
// - The audit log gets counts per page and connection, never an item's
//   ID, title or readers.

/**
 * Most subrequests one run of the clock spends on native sync: the same
 * share of Workers' limit per invocation as the shared store's erasures
 * (shared-reads.ts `brainCallsPerTick`, which states the limit and the
 * share). What is left waits for the next run.
 */
export const syncCallsPerTick = brainCallsPerTick;

/**
 * How long a run holds a source: the clock's own lease on a task, past
 * which it may start the task again (@grasp-os/workerflow/clock), so a
 * run that outlives it finds its source claimed and stops.
 */
const leaseMs = clockLeaseMs;

/**
 * When a source with nothing more, or one that failed, is read again: at
 * the clock's next run, its period.
 */
const pollMs = clockPeriods.minute;

/**
 * How often every source is listed again in full, its readers read again,
 * and what the listing didn't name taken out: once a day. A product
 * choice, not a number derived from a limit: some sharing changes come
 * with no signal at all (Microsoft gives none for unsharing one file;
 * Google's feed isn't guaranteed either), so where a vendor gives none, a
 * reader the source took off can read an item for at most a day.
 */
const relistMs = 24 * 60 * 60 * 1000;

/**
 * When `source` next starts its daily relist after `now`: at its own
 * fixed time of day, from a hash of its connection, sync and place, so
 * that many connections don't all relist in the same run.
 */
const nextRelistAt = async (
  source: Pick<Source, "connectionId" | "feed" | "place">,
  now: number
): Promise<number> => {
  const hash = await sha256Hex(
    JSON.stringify([source.connectionId, source.feed, source.place])
  );
  const offset = Number.parseInt(hash.slice(0, 12), 16) % relistMs;
  const since = (((now - offset) % relistMs) + relistMs) % relistMs;
  return now - since + relistMs;
};

/**
 * Which of a source's two cursors a read follows: its changes, or the
 * daily relist beside them.
 */
type Stream = "changes" | "relist";

/** A page of keys erased at once after a disconnect, or at a listing's end. */
const erasedPerPage = 100;

/** What one run may still spend: subrequests, each charged before it is made. */
export interface Budget {
  left: number;
}

/**
 * Why a run stopped a page part-way: its budget was spent (`budget`, the
 * rest waits for the next run), or it no longer holds its source
 * (`lost`: another run claimed it, or a disconnect closed it).
 */
class SyncStoppedError extends Error {
  readonly why: "budget" | "lost";

  constructor(why: "budget" | "lost") {
    super(
      why === "budget"
        ? "This run's budget for the sync is spent"
        : "The sync run no longer holds its source"
    );
    this.name = "SyncStoppedError";
    this.why = why;
  }
}

/** Whether `error` stopped a page for `why`. */
const stoppedFor = (error: unknown, why: SyncStoppedError["why"]): boolean =>
  error instanceof SyncStoppedError && error.why === why;

/** Takes `calls` from `budget`, or throws when it hasn't that many left. */
const spend = (budget: Budget, calls: number): void => {
  if (budget.left < calls) {
    budget.left = 0;
    throw new SyncStoppedError("budget");
  }
  budget.left -= calls;
};

/** Core's database, as `drizzle` makes it. */
type Database = DrizzleD1Database & { $client: D1Database };

type Source = typeof brainSyncSources.$inferSelect;
type Item = typeof brainSyncItems.$inferSelect;
type Store = NonNullable<Item["store"]>;

/** Who reads a synced item, by the Brain's groups. */
interface Plan {
  store: Store;
  /** The readers of an item in the shared store; none in an own store. */
  readers: SourceReader[];
  /** Its readers, compared as core compares them, sorted, as JSON: hashed into its change keys, never kept. */
  readersKey: string | null;
}

/** The group every item synced through `connectionId` into its owner's own store is added in. */
const syncGroupOf = (connectionId: string): SourceRef => ({
  producer: "sync",
  id: connectionId,
});

/** The key of an item in its `generation`. */
const keyOf = async (
  connectionId: string,
  feed: string,
  itemId: string,
  generation: number
): Promise<string> =>
  `${connectionId}/${generation}/${await sha256Hex(JSON.stringify([feed, itemId]))}`;

const sourceRefOf = (key: string): SourceRef => ({ producer: "sync", id: key });

/** `reader` in the shape core's readers take, under the source's provider and tenant. */
const namedReader = (
  provider: string,
  tenant: string,
  reader: SyncReader
): unknown => {
  switch (reader.kind) {
    case "account": {
      return { kind: "account", provider, tenant, account: reader.id };
    }
    case "group": {
      return { kind: "group", provider, tenant, group: reader.id };
    }
    case "tenant": {
      return { kind: "tenant", provider, tenant: reader.id };
    }
    case "link": {
      // Whoever has a link: nobody.
      return { kind: "link" };
    }
    default: {
      return undefined;
    }
  }
};

/**
 * An item's readers as core's readers (GRA-1761), for the source `source`
 * reads, by its connection's provider and tenant: an account as the
 * provider names it (Google's verified address, Microsoft's object ID),
 * which core turns into a token and counts for the person who proved it
 * is theirs; a group, which counts for nobody until core knows its
 * members; a tenant, which counts for everyone holding an account there;
 * a link, which counts for nobody; and anything else the Brain can't
 * name left out. Never a reader the source didn't list: leaving one out
 * only narrows.
 */
export const readersOf = (
  source: Pick<Source, "provider" | "tenant">,
  readers: readonly SyncReader[]
): SourceReader[] => {
  const { provider, tenant } = source;
  if (tenant === null) {
    return [];
  }
  return readers.flatMap((reader) => {
    const parsed = sourceReaderSchema.safeParse(
      namedReader(provider, tenant, reader)
    );
    if (!parsed.success) {
      return [];
    }
    // An account is named by its token; any other by a name that must fit.
    const name = plainPrincipalOf(parsed.data);
    return name !== undefined && name.length > principalMaxLength
      ? []
      : [parsed.data];
  });
};

/** A reader's parts as core compares them: Unicode NFC, lowercase. */
const comparable = (part: string): string =>
  part.normalize("NFC").toLowerCase();

/**
 * `reader` as one entry of a readers' key, compared as core compares
 * them; none for a link, which reaches nobody.
 */
const readerKeyOf = (reader: SourceReader): string | undefined => {
  switch (reader.kind) {
    case "account": {
      return `account:${comparable(reader.account)}`;
    }
    case "group": {
      return `group:${comparable(reader.group)}`;
    }
    case "tenant": {
      return `tenant:${comparable(reader.tenant)}`;
    }
    case "link": {
      return undefined;
    }
    default: {
      return undefined;
    }
  }
};

/**
 * Where `item` goes and who reads it: the owner's own store for mail,
 * events and attachments, and for a file whose readers name nobody but
 * the connection's own account (or couldn't be read whole); else the
 * shared store, read by its readers.
 */
const planOf = (
  source: Source,
  item: Extract<SyncItem, { gone: false }>
): Plan => {
  const own: Plan = { store: "own", readers: [], readersKey: null };
  // Mail is its mailbox's own person's alone, an attachment its message's.
  if (item.kind !== "file" || item.partOf !== null || item.readers === null) {
    return own;
  }
  const readers = readersOf(source, item.readers);
  const owner =
    source.account === null
      ? undefined
      : `account:${comparable(source.account)}`;
  const keys = [
    ...new Set(readers.flatMap((reader) => readerKeyOf(reader) ?? [])),
  ].toSorted();
  if (keys.every((key) => key === owner)) {
    return own;
  }
  // Only ever hashed into a change key: no row keeps a reader.
  return { store: "shared", readers, readersKey: JSON.stringify(keys) };
};

/** The extractor's types, by the type a connector names. */
const extractable: ReadonlySet<string> = new Set(Object.values(uploadTypes));

const isExtractable = (type: string): type is UploadMediaType =>
  extractable.has(type);

const bytesOf = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (character) => character.codePointAt(0) ?? 0);

/**
 * The text the Brain keeps of `item`: its title, then its text, or what
 * the extractor reads of its file; undefined when there is none the Brain
 * takes (no content, a type the extractor doesn't read, a file it can't
 * read, or a text the Brain refuses), which is counted as skipped.
 */
const textOf = async (
  env: Env,
  budget: Budget,
  item: Extract<SyncItem, { gone: false }>
): Promise<string | undefined> => {
  const { content } = item;
  if (content === null) {
    return undefined;
  }
  let body: string;
  if (content.type === "text") {
    body = content.text;
  } else {
    const { contentType } = content;
    if (!isExtractable(contentType)) {
      return undefined;
    }
    spend(budget, 1);
    try {
      ({ markdown: body } = await localExtractor(env)({
        name: item.title,
        mediaType: contentType,
        bytes: bytesOf(content.base64),
      }));
    } catch (error) {
      // The error's name only: a parser's message may quote the file.
      log.warn("brain.sync.unreadable", { errorName: errorName(error) });
      return undefined;
    }
  }
  const text = `${item.title}\n\n${body}`.toWellFormed();
  return sourceTextProblem(text) === undefined ? text : undefined;
};

/** What a run holds while it applies a page. */
interface Applying {
  env: Env;
  db: Database;
  source: Source;
  leaseId: string;
  budget: Budget;
  /** When core read the page: every add and change of readers is as of then. */
  readAt: Date;
  /** How many of the page's items this read found nothing of to keep. */
  skipped: number;
  /** Which cursor the page was read from. */
  stream: Stream;
  /**
   * What the page is: one read from a cursor (`page`), a names-only
   * listing (`names`: IDs and versions, no content), or the items a
   * names-only listing found unknown or changed, fetched in full
   * (`catchUp`, those asked for in `asked`).
   */
  mode: "page" | "names" | "catchUp";
  asked: string[];
  /**
   * The page's counters as stored, this read's included: as the claimed
   * row had them, each one up as this read counts it, so the commit needs
   * no read of its own (the run holds the source alone).
   */
  counts: { added: number; changed: number; removed: number };
}

/**
 * Whether `applying`'s page is part of a listing: the relist's, or the
 * changes' own after a restart (or the first), each until its first page
 * with nothing more.
 */
const isListing = ({ source, stream }: Applying): boolean =>
  stream === "relist" || source.listingOpen;

/** That `applying`'s run still holds its source, as SQL. */
const stillHeld = ({ source, leaseId }: Applying): SQL =>
  sql`EXISTS (SELECT 1 FROM ${brainSyncSources} WHERE ${brainSyncSources.connectionId} = ${source.connectionId} AND ${brainSyncSources.feed} = ${source.feed} AND ${brainSyncSources.place} = ${source.place} AND ${brainSyncSources.leaseId} = ${leaseId})`;

/** That a disconnect closed `connectionId` for the sync, as SQL. */
const closed = (connectionId: SQL | string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${brainSyncDisconnects} WHERE ${brainSyncDisconnects.connectionId} = ${connectionId})`;

/** The source's row, while `applying`'s run holds it, as SQL. */
const heldSource = (applying: Applying) =>
  and(
    eq(brainSyncSources.connectionId, applying.source.connectionId),
    eq(brainSyncSources.feed, applying.source.feed),
    eq(brainSyncSources.place, applying.source.place),
    eq(brainSyncSources.leaseId, applying.leaseId)
  );

/** One of the page's counters, one up, while the run holds the source. */
const counted = (
  applying: Applying,
  counter: "added" | "changed" | "removed"
) =>
  applying.db
    .update(brainSyncSources)
    .set({ [counter]: sql`${brainSyncSources[counter]} + 1` })
    .where(
      and(
        eq(brainSyncSources.connectionId, applying.source.connectionId),
        eq(brainSyncSources.feed, applying.source.feed),
        eq(brainSyncSources.place, applying.source.place),
        eq(brainSyncSources.leaseId, applying.leaseId)
      )
    )
    .returning({ leaseId: brainSyncSources.leaseId });

/** The row of `item` as the statement `where` picks it. */
const itemWhere = (applying: Applying, itemId: string): SQL =>
  sql`${brainSyncItems.connectionId} = ${applying.source.connectionId} AND ${brainSyncItems.feed} = ${applying.source.feed} AND ${brainSyncItems.itemId} = ${itemId}`;

/** Throws when a batch's last statement, the counter, found the run no longer holding its source. */
const heldAfter = (counter: readonly unknown[]): void => {
  if (counter.length === 0) {
    throw new SyncStoppedError("lost");
  }
};

/** `counter` one up in what this read knows of the page's counters, once stored. */
const countedIn = (
  applying: Applying,
  counter: "added" | "changed" | "removed",
  stored: readonly unknown[]
): void => {
  heldAfter(stored);
  applying.counts[counter] += 1;
};

/** The Brain's readers of `row`'s source as it was added: whose store it is in. */
const addedReaders = (applying: Applying, store: Store): SourceReaders =>
  store === "own"
    ? { kind: "owner", personId: applying.source.personId }
    : { kind: "none" };

/**
 * Erases the key `row` is leaving (`leaving`, in `leavingStore`), then
 * forgets that it was: the second half of `leave`, finished on a later
 * read when a stopped run left it (`finishOwedLeaves`). Safe to repeat:
 * erasing an erased key changes nothing.
 */
const finishLeaving = async (applying: Applying, row: Item): Promise<Item> => {
  const { env, db, budget } = applying;
  if (row.leaving === null || row.leavingStore === null) {
    return row;
  }
  spend(budget, row.leavingStore === "own" ? 2 : 1);
  await eraseSource(env, {
    source: sourceRefOf(row.leaving),
    readers: addedReaders(applying, row.leavingStore),
    reason: "deleted",
  });
  spend(budget, 1);
  heldAfter(
    await db
      .update(brainSyncItems)
      .set({ leaving: null, leavingStore: null })
      .where(
        sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.leaving} = ${row.leaving} AND ${stillHeld(applying)}`
      )
      .returning({ key: brainSyncItems.key })
  );
  return { ...row, leaving: null, leavingStore: null };
};

/**
 * Takes `row`'s item out of the Brain. First, in one batch with the
 * page's removal counted, the row moves to its next key, in no store,
 * naming the key it leaves; only then is that key erased
 * (`finishLeaving`). So a run stopped between the two (its budget, a
 * failed write, a lost lease, a killed isolate) leaves a row that says
 * what is still owed, never one that claims a key the Brain erased, and
 * the next read of the source erases it before anything else.
 */
const leave = async (applying: Applying, row: Item): Promise<Item> => {
  const { db, budget } = applying;
  if (row.store === null) {
    return await finishLeaving(applying, row);
  }
  const generation = row.generation + 1;
  const key = await keyOf(row.connectionId, row.feed, row.itemId, generation);
  const left = {
    store: null,
    generation,
    key,
    change: null,
    version: null,
    marker: null,
    leaving: row.key,
    leavingStore: row.store,
    heldSince: null,
  };
  spend(budget, 1);
  const [, owed, counter] = await db.batch([
    db
      .update(brainSyncItems)
      .set(left)
      .where(
        sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.generation} = ${row.generation} AND ${stillHeld(applying)}`
      ),
    db
      .update(brainSyncSources)
      .set({ leavesOwed: true })
      .where(heldSource(applying)),
    counted(applying, "removed"),
  ]);
  heldAfter(owed.meta.changes > 0 ? counter : []);
  countedIn(applying, "removed", counter);
  return await finishLeaving(applying, { ...row, ...left });
};

/**
 * Finishes every erase a stopped run left owed on the source
 * (`finishLeaving`), before anything of the page is applied: only when
 * the source says one may be (`leavesOwed`), so a page with nothing to
 * do reads nothing for it.
 */
const finishOwedLeaves = async (applying: Applying): Promise<void> => {
  const { db, budget, source } = applying;
  if (!source.leavesOwed) {
    return;
  }
  for (;;) {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const owed = await db
      .select()
      .from(brainSyncItems)
      .where(
        and(
          eq(brainSyncItems.connectionId, source.connectionId),
          eq(brainSyncItems.feed, source.feed),
          eq(brainSyncItems.place, source.place),
          isNotNull(brainSyncItems.leaving)
        )
      )
      .limit(erasedPerPage);
    if (owed.length === 0) {
      return;
    }
    for (const row of owed) {
      // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
      await finishLeaving(applying, row);
    }
  }
};

/**
 * Holds the removal of `row`'s item, gone from one place of a sync that
 * lists places: a message moved between two folders comes as gone in
 * one and new in the other, in whichever order the two are read, so it
 * is erased only once every other place of the sync has applied a page
 * since (`finishHeldRemovals`), never leaving a hole while the other
 * place is read later. Mail is its own person's alone, so nobody else
 * reads it meanwhile. Held since when it first went.
 */
const hold = async (applying: Applying, row: Item): Promise<Item> => {
  const { db, budget } = applying;
  const heldSince = row.heldSince ?? new Date();
  spend(budget, 1);
  const [held, owed] = await db.batch([
    db
      .update(brainSyncItems)
      .set({ heldSince })
      .where(
        sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.generation} = ${row.generation} AND ${stillHeld(applying)}`
      )
      .returning({ key: brainSyncItems.key }),
    db
      .update(brainSyncSources)
      .set({ leavesOwed: true })
      .where(heldSource(applying))
      .returning({ place: brainSyncSources.place }),
  ]);
  heldAfter(held);
  heldAfter(owed);
  return { ...row, heldSince };
};

/**
 * Takes out each removal of the source's place held for a move (`hold`)
 * once every other place of its sync has applied a page since it was
 * held, so a moved message is in the other place by then; or once it has
 * been held a day, the bound on a stale copy the sync keeps to anyway
 * (`relistMs`), so a place that fails for good keeps nothing alive.
 */
const finishHeldRemovals = async (applying: Applying): Promise<void> => {
  const { db, budget, source } = applying;
  if (source.place === ownPlace) {
    return;
  }
  const dayAgo = Date.now() - relistMs;
  spend(budget, 1);
  const due = await db
    .select()
    .from(brainSyncItems)
    .where(
      sql`${brainSyncItems.connectionId} = ${source.connectionId} AND ${brainSyncItems.feed} = ${source.feed} AND ${brainSyncItems.place} = ${source.place} AND ${brainSyncItems.heldSince} IS NOT NULL AND (${brainSyncItems.heldSince} < ${dayAgo} OR NOT EXISTS (
        SELECT 1 FROM ${brainSyncSources} AS other
        WHERE other.connection_id = ${source.connectionId} AND other.feed = ${source.feed} AND other.place <> ${source.place} AND other.dropped = 0
          AND (other.last_success_at IS NULL OR other.last_success_at <= ${brainSyncItems.heldSince})))`
    );
  for (const row of due) {
    // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
    await leave(applying, row);
  }
};

/**
 * Moves `row` to its next key without erasing anything: for a key the
 * Brain refused as erased already (a restore of the Brain, or an erase
 * whose record a stopped run lost), so the item is added again under a
 * key never erased instead of waiting for good.
 */
const nextKey = async (applying: Applying, row: Item): Promise<Item> => {
  const generation = row.generation + 1;
  const key = await keyOf(row.connectionId, row.feed, row.itemId, generation);
  const moved = {
    store: null,
    generation,
    key,
    change: null,
    version: null,
    marker: null,
  };
  spend(applying.budget, 1);
  heldAfter(
    await applying.db
      .update(brainSyncItems)
      .set(moved)
      .where(
        sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.generation} = ${row.generation} AND ${stillHeld(applying)}`
      )
      .returning({ key: brainSyncItems.key })
  );
  return { ...row, ...moved };
};

/**
 * Takes out every attachment of the messages `gone` names: a mailbox
 * reports only the message as gone, never its parts.
 */
const leaveParts = async (
  applying: Applying,
  gone: readonly string[]
): Promise<void> => {
  const { db, budget, source } = applying;
  if (gone.length === 0) {
    return;
  }
  spend(budget, 1);
  const parts = await db
    .select()
    .from(brainSyncItems)
    .where(
      and(
        eq(brainSyncItems.connectionId, source.connectionId),
        eq(brainSyncItems.feed, source.feed),
        isNotNull(brainSyncItems.store),
        inList(brainSyncItems.partOf, gone)
      )
    );
  for (const part of parts) {
    // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
    await (source.place === ownPlace
      ? leave(applying, part)
      : hold(applying, part));
  }
};

/**
 * A hash of `item`'s change marker, as its row keeps it: names no reader
 * and no content, and tells a page that passes over an item held at that
 * version from one that changed it.
 */
const markerOf = async (item: { version: string }): Promise<string> =>
  await sha256Hex(item.version);

/** A change key: a hash of what makes a version this one. */
const changeOf = async (parts: readonly unknown[]): Promise<string> =>
  await sha256Hex(JSON.stringify(parts));

/**
 * Gives `row`'s item in the shared store the readers `plan` names: a new
 * version with its current text (`changeSourceReaders`), so a narrowing
 * holds for everything the Brain answers before anything of the page is
 * added. Readers its current version has already write nothing, and the
 * row doesn't change: so core keeps no reader list of its own.
 */
const changeReaders = async (
  applying: Applying,
  row: Item,
  plan: Plan
): Promise<Item> => {
  const { env, db, budget, readAt } = applying;
  spend(budget, 1);
  const made = await changeSourceReaders(env, {
    source: sourceRefOf(row.key),
    change: await changeOf([
      "readers",
      plan.readersKey,
      readAt.getTime(),
      row.itemId,
    ]),
    readers: { kind: "readers", readers: plan.readers },
    readAt,
  });
  // Not held yet, or an add of it under way (`change` null, its record
  // lost with a stopped run): the page's add records and counts it.
  if (made === null || row.change === null || made.version === row.version) {
    return row;
  }
  spend(budget, 1);
  const [, counter] = await db.batch([
    db
      .update(brainSyncItems)
      .set({ version: made.version })
      .where(
        sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.generation} = ${row.generation} AND ${stillHeld(applying)}`
      ),
    counted(applying, "changed"),
  ]);
  countedIn(applying, "changed", counter);
  return { ...row, version: made.version };
};

/**
 * Names `item`'s key for `plan` before the Brain is given it, while the
 * run holds its source and no disconnect closed its connection: the row
 * as it is now, with the add under way (`change` null).
 */
const claim = async (
  applying: Applying,
  row: Item | undefined,
  item: Extract<SyncItem, { gone: false }>,
  plan: Plan
): Promise<Item> => {
  const itemId = item.id;
  const { db, budget, source } = applying;
  const generation = row?.generation ?? 1;
  const key =
    row?.key ??
    (await keyOf(source.connectionId, source.feed, itemId, generation));
  spend(budget, 1);
  const [claimed] = await db
    .insert(brainSyncItems)
    .select(
      sql`SELECT ${source.connectionId}, ${source.feed}, ${itemId}, ${source.place}, ${key}, ${generation}, ${plan.store}, NULL, NULL, NULL, ${item.partOf}, ${source.listing}, NULL, NULL, NULL
        WHERE ${stillHeld(applying)} AND NOT ${closed(source.connectionId)}`
    )
    .onConflictDoUpdate({
      target: [
        brainSyncItems.connectionId,
        brainSyncItems.feed,
        brainSyncItems.itemId,
      ],
      set: {
        place: source.place,
        store: plan.store,
        change: null,
        partOf: item.partOf,
        listing: source.listing,
        // Here again: no longer held to go.
        heldSince: null,
      },
      setWhere: sql`${brainSyncItems.generation} = ${generation}`,
    })
    .returning();
  if (claimed === undefined) {
    throw new SyncStoppedError("lost");
  }
  return claimed;
};

/**
 * Adds `item`'s `text` to the Brain as `plan` says, after naming its key
 * (`claim`), unless its row has that change already: erased first from
 * the store it leaves, if it crosses.
 */
const add = async (
  applying: Applying,
  given: Item | undefined,
  item: Extract<SyncItem, { gone: false }>,
  plan: Plan,
  text: string,
  again = false
): Promise<void> => {
  const { env, db, budget, source, readAt } = applying;
  const change = await changeOf([
    "version",
    item.version,
    plan.readersKey,
    await sha256Hex(text),
  ]);
  if (given?.store === plan.store && given.change === change) {
    return;
  }
  let row = given;
  if (
    row?.store !== null &&
    row?.store !== undefined &&
    row.store !== plan.store
  ) {
    row = await leave(applying, row);
  }
  const claimed = await claim(applying, row, item, plan);
  // An item's own store's add asks the shared store about its key before
  // and after (brain-next.ts `keptIn`), and reads the time zone.
  spend(budget, plan.store === "own" ? 4 : 2);
  let version: number;
  try {
    ({ version } = await addSource(env, {
      source: sourceRefOf(claimed.key),
      change,
      text,
      readers:
        plan.store === "own"
          ? { kind: "owner", personId: source.personId }
          : { kind: "readers", readers: plan.readers },
      said: {
        by: { kind: "outside" },
        at: new Date(item.changedAt),
        // A listing brings what was there before, "old documents and
        // archives"; later pages what changed since, "recent documents"
        // (the Brain's own classes).
        priority: isListing(applying) ? "archive" : "recent",
      },
      ...(plan.store === "own"
        ? { group: syncGroupOf(source.connectionId) }
        : {}),
      readAt,
    }));
  } catch (error) {
    if (brainSourceErrors.codeOf(error) !== "brain.source_erased") {
      throw error;
    }
    // A key this source named, erased all the same: its next key, once.
    // A disconnect that closed the connection refuses that key's claim;
    // a person's erasure, which disconnects, too.
    if (again) {
      throw new SyncStoppedError("lost");
    }
    await add(
      applying,
      await nextKey(applying, claimed),
      item,
      plan,
      text,
      true
    );
    return;
  }
  spend(budget, 1);
  const recorded = db
    .update(brainSyncItems)
    .set({ change, version, marker: await markerOf(item) })
    .where(
      sql`${itemWhere(applying, item.id)} AND ${brainSyncItems.generation} = ${claimed.generation} AND ${stillHeld(applying)}`
    )
    .returning({ key: brainSyncItems.key });
  // Counted once, by the Brain's answer, the same on a repeat: a key's
  // first version is the item added, a version the row didn't know yet
  // changed it; the current one again (its readers given this page
  // already) nothing.
  if (version === claimed.version) {
    heldAfter(await recorded);
    return;
  }
  const counter =
    claimed.version === null && version === 1 ? "added" : "changed";
  const [, stored] = await db.batch([recorded, counted(applying, counter)]);
  countedIn(applying, counter, stored);
};

/** The rows of the page's items, by the provider's ID. */
const rowsOf = async (
  applying: Applying,
  items: readonly SyncItem[]
): Promise<Map<string, Item>> => {
  const { db, budget, source } = applying;
  if (items.length === 0) {
    return new Map();
  }
  spend(budget, 1);
  const rows = await db
    .select()
    .from(brainSyncItems)
    .where(
      and(
        eq(brainSyncItems.connectionId, source.connectionId),
        eq(brainSyncItems.feed, source.feed),
        inList(
          brainSyncItems.itemId,
          items.map(({ id }) => id)
        )
      )
    );
  return new Map(rows.map((row) => [row.itemId, row]));
};

/**
 * Erases every item of the listing that just ended (`source.listing`)
 * that it didn't name: a relist names no "gone" for what went away while
 * the cursor was lost. A page of rows at a time, until none is left.
 */
const sweep = async (applying: Applying): Promise<void> => {
  const { db, budget, source } = applying;
  for (;;) {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const left = await db
      .select()
      .from(brainSyncItems)
      .where(
        and(
          eq(brainSyncItems.connectionId, source.connectionId),
          eq(brainSyncItems.feed, source.feed),
          eq(brainSyncItems.place, source.place),
          isNotNull(brainSyncItems.store),
          isNull(brainSyncItems.heldSince),
          lt(brainSyncItems.listing, source.listing)
        )
      )
      .orderBy(asc(brainSyncItems.itemId))
      .limit(erasedPerPage);
    if (left.length === 0) {
      return;
    }
    for (const row of left) {
      // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
      await leave(applying, row);
    }
  }
};

/**
 * Notes what a names-only listing found that the Brain doesn't hold at
 * the version named (unknown, held without content, or changed), to be
 * fetched once in full when the listing ends (`catchUp`): one statement
 * for the page. What is held at that version stays as it is.
 */
const noteCatchUps = async (
  applying: Applying,
  page: SyncPage,
  rows: ReadonlyMap<string, Item>
): Promise<void> => {
  const { db, budget, source } = applying;
  const wanted: string[] = [];
  for (const item of page.items) {
    if (item.gone) {
      continue;
    }
    const row = rows.get(item.id);
    const held =
      row !== undefined &&
      row.store !== null &&
      // oxlint-disable-next-line no-await-in-loop -- a hash each, no call
      row.marker === (await markerOf(item));
    if (!held) {
      wanted.push(item.id);
    }
  }
  if (wanted.length === 0) {
    return;
  }
  spend(budget, 1);
  await db
    .insert(brainSyncCatchUps)
    .values(
      wanted.map((itemId) => ({
        connectionId: source.connectionId,
        feed: source.feed,
        place: source.place,
        itemId,
      }))
    )
    .onConflictDoNothing();
};

/**
 * A page's first half: what went away and every change of readers of the
 * shared store (an item that leaves it for its owner's own store erased
 * there), then a gone message's attachments. Nothing of the page is added
 * before all of it.
 */
const applyRemovals = async (
  applying: Applying,
  page: SyncPage,
  rows: Map<string, Item>
): Promise<void> => {
  const { source } = applying;
  for (const item of page.items) {
    const row = rows.get(item.id);
    if (row?.store === null || row === undefined) {
      continue;
    }
    if (item.gone) {
      rows.set(
        item.id,
        // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
        await (source.place === ownPlace
          ? leave(applying, row)
          : hold(applying, row))
      );
      continue;
    }
    // A names-only listing names no readers: mail and events are their
    // own person's alone.
    if (row.store !== "shared" || applying.mode === "names") {
      continue;
    }
    const plan = planOf(source, item);
    // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
    const changed = await (plan.store === "own"
      ? leave(applying, row)
      : changeReaders(applying, row, plan));
    rows.set(item.id, changed);
  }
  // A gone message's attachments, which its mailbox doesn't name.
  await leaveParts(
    applying,
    page.items.flatMap((item) => (item.gone ? [item.id] : []))
  );
};

/**
 * A page's second half: each item there added as it now is; one with
 * nothing the Brain takes counted as skipped, kept when passed over at
 * the version held, else taken out.
 */
const applyAdds = async (
  applying: Applying,
  page: SyncPage,
  rows: ReadonlyMap<string, Item>
): Promise<void> => {
  const { budget, source } = applying;
  for (const item of page.items) {
    if (item.gone) {
      continue;
    }
    const row = rows.get(item.id);
    // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
    const text = await textOf(applying.env, budget, item);
    if (text === undefined) {
      if (row?.store === null || row === undefined) {
        // Counted by the read that commits the page, which meets every
        // item of it: never twice.
        applying.skipped += 1;
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
      if (row.marker === (await markerOf(item))) {
        // Passed over at the version the Brain holds (its content late,
        // or not read this time): kept as it is.
        continue;
      }
      // Changed to something the Brain can't take: out.
      // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
      await leave(applying, row);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
    await add(applying, row, item, planOf(source, item), text);
  }
};

/**
 * Applies `page` to the Brain: any erase a stopped run left first, then
 * its removals (`applyRemovals`), then its adds (`applyAdds`), or, for a
 * names-only listing, what it found not held noted to fetch; then, at the
 * end of a listing, what it didn't name erased.
 */
const apply = async (applying: Applying, page: SyncPage): Promise<void> => {
  const { db, budget, source } = applying;
  await finishOwedLeaves(applying);
  if (source.leavesOwed) {
    await finishHeldRemovals(applying);
  }
  const rows = await rowsOf(applying, page.items);
  if ((source.listingOpen || source.relisting) && rows.size > 0) {
    // Named while a listing is under way, by it or by a change since,
    // whatever else the page does with them: there, so not swept.
    spend(budget, 1);
    await db
      .update(brainSyncItems)
      .set({ listing: source.listing })
      .where(
        sql`${brainSyncItems.connectionId} = ${source.connectionId} AND ${brainSyncItems.feed} = ${source.feed} AND ${inList(brainSyncItems.itemId, [...rows.keys()])} AND ${stillHeld(applying)}`
      );
  }
  await applyRemovals(applying, page, rows);
  await (applying.mode === "names"
    ? noteCatchUps(applying, page, rows)
    : applyAdds(applying, page, rows));
  if (isListing(applying) && applying.mode !== "catchUp" && !page.more) {
    await sweep(applying);
  }
};

/** The event that records what one page did: counts, never items. */
const appliedEvent = (
  source: Source,
  counts: Pick<Source, "added" | "changed" | "removed"> & { skipped: number }
): AuditEvent =>
  createAuditEvent(
    {
      actor: { type: "system" },
      action: "brain.sync.applied",
      target: { type: "connection", id: source.connectionId },
      detail: { feed: source.feed, ...counts },
    },
    "core"
  );

/** A relist ended: due again on its next day. */
const endedRelist = async (
  source: Source,
  now: number
): Promise<Partial<typeof brainSyncSources.$inferInsert>> => ({
  relisting: false,
  relistCatchUp: false,
  relistAt: new Date(await nextRelistAt(source, now)),
  relistSince: null,
});

/**
 * Where a relist's page moves it: on while there is more; a names-only
 * listing that ended goes on to fetch what it noted (`relistCatchUp`), at
 * once; a full listing that ended ends the relist until its next day. A
 * catch-up page stays due at once: the next read finds what is left to
 * fetch, or ends the relist (`syncPage`).
 */
const relistMoved = async (
  applying: Applying,
  page: SyncPage,
  now: number
): Promise<Partial<typeof brainSyncSources.$inferInsert>> => {
  const { mode, source } = applying;
  if (mode === "catchUp") {
    return { relistAt: new Date(now) };
  }
  if (page.more) {
    return { relistCursor: page.cursor, relistAt: new Date(now) };
  }
  if (mode === "names") {
    return {
      relistCursor: page.cursor,
      relistCatchUp: true,
      relistAt: new Date(now),
    };
  }
  return await endedRelist(source, now);
};

/**
 * Moves the source's cursor past `page`, once it is applied, in one batch
 * with the page's one event (if it did anything): its counters reset,
 * the listing closed at its first page with nothing more, due again at
 * once while there is more, and its lease given up.
 */
const commit = async (applying: Applying, page: SyncPage): Promise<void> => {
  const { env, db, budget, source, counts } = applying;
  const now = Date.now();
  const cursorMoved =
    applying.stream === "changes"
      ? {
          cursor: page.cursor,
          listingOpen: source.listingOpen && page.more,
          dueAt: new Date(page.more ? now : now + pollMs),
        }
      : await relistMoved(applying, page, now);
  const moved = db
    .update(brainSyncSources)
    .set({
      ...cursorMoved,
      leaseId: null,
      leaseUntil: null,
      lastSuccessAt: new Date(now),
      lastError: null,
      added: 0,
      changed: 0,
      removed: 0,
      // Every erase this page owed is done (they ran before this); only a
      // removal still held for a move keeps it owed.
      leavesOwed: sql`EXISTS (SELECT 1 FROM ${brainSyncItems} WHERE ${brainSyncItems.connectionId} = ${source.connectionId} AND ${brainSyncItems.feed} = ${source.feed} AND ${brainSyncItems.place} = ${source.place} AND ${brainSyncItems.heldSince} IS NOT NULL)`,
    })
    .where(heldSource(applying))
    .returning({ leaseId: brainSyncSources.leaseId });
  const did = counts.added + counts.changed + counts.removed + applying.skipped;
  const fetched =
    applying.mode === "catchUp"
      ? [
          db
            .delete(brainSyncCatchUps)
            .where(
              and(
                eq(brainSyncCatchUps.connectionId, source.connectionId),
                eq(brainSyncCatchUps.feed, source.feed),
                eq(brainSyncCatchUps.place, source.place),
                inList(brainSyncCatchUps.itemId, applying.asked)
              )
            ),
        ]
      : [];
  spend(budget, 1);
  const [committed] =
    did === 0
      ? await db.batch([moved, ...fetched])
      : await auditedBatch(env, db, [
          moved,
          outboxedEventWhere(
            db,
            appliedEvent(source, { ...counts, skipped: applying.skipped }),
            sql`changes() > 0`
          ),
          ...fetched,
        ]);
  heldAfter(committed);
};

/**
 * Gives up `applying`'s source: its `stream` due again at `at`, its
 * cursors as they were or as `set` says.
 */
const release = async (
  applying: Pick<Applying, "db" | "source" | "leaseId" | "stream">,
  at: number,
  set: Partial<
    Pick<
      Source,
      | "cursor"
      | "listing"
      | "listingOpen"
      | "lastError"
      | "relistCursor"
      | "relisting"
      | "relistAt"
    >
  > = {}
): Promise<void> => {
  const due =
    applying.stream === "changes"
      ? { dueAt: new Date(at) }
      : { relistAt: new Date(at) };
  await applying.db
    .update(brainSyncSources)
    .set({ ...due, ...set, leaseId: null, leaseUntil: null })
    .where(
      and(
        eq(brainSyncSources.connectionId, applying.source.connectionId),
        eq(brainSyncSources.feed, applying.source.feed),
        eq(brainSyncSources.place, applying.source.place),
        eq(brainSyncSources.leaseId, applying.leaseId)
      )
    );
};

/** How long a throttled read waits: as the provider said, else until the next run. */
const retryAfterOf = (error: unknown): number => {
  const details =
    typeof error === "object" && error !== null && "details" in error
      ? error.details
      : undefined;
  const after: unknown =
    typeof details === "object" && details !== null
      ? Reflect.get(details, "retryAfterMs")
      : undefined;
  return typeof after === "number" && Number.isFinite(after) && after > 0
    ? after
    : pollMs;
};

/**
 * How long `source`'s relist is past its day at `now`: the one under way
 * by when it was due to start, else the next by when it is due; 0 while
 * within it.
 */
const overdueBy = (source: Source, now: number): number => {
  const since = source.relisting
    ? (source.relistSince ?? source.relistAt)
    : source.relistAt;
  return Math.max(0, now - since.getTime() - relistMs);
};

/**
 * How many sources' relists are past their day now, for the staff's view
 * of the Brain (brain-report.ts): where it is not 0, a reader list can be
 * staler than a day.
 */
export const overdueRelists = async (env: Pick<Env, "DB">): Promise<number> => {
  const late = Date.now() - relistMs;
  const row = await drizzle(env.DB)
    .select({ count: sql<number>`count(*)` })
    .from(brainSyncSources)
    .where(
      sql`CASE WHEN ${brainSyncSources.relisting} = 1 THEN coalesce(${brainSyncSources.relistSince}, ${brainSyncSources.relistAt}) ELSE ${brainSyncSources.relistAt} END < ${late}`
    )
    .get();
  return row?.count ?? 0;
};

/**
 * Starts `applying`'s daily relist, unless a listing is under way already
 * (the first, or a restart's), which is one: then the relist waits for
 * its next day. A relist is a listing of its own number, from the start.
 * Whether it started.
 */
const startRelist = async (applying: Applying): Promise<boolean> => {
  const { db, budget, source } = applying;
  const now = Date.now();
  spend(budget, 1);
  if (source.listingOpen) {
    await release(applying, await nextRelistAt(source, now));
    return false;
  }
  // What an earlier relist left to fetch goes: one catch-up per relist.
  const [, [started]] = await db.batch([
    db
      .delete(brainSyncCatchUps)
      .where(
        and(
          eq(brainSyncCatchUps.connectionId, source.connectionId),
          eq(brainSyncCatchUps.feed, source.feed),
          eq(brainSyncCatchUps.place, source.place)
        )
      ),
    db
      .update(brainSyncSources)
      .set({
        relisting: true,
        relistCatchUp: false,
        relistCursor: null,
        listing: source.listing + 1,
        relistSince: source.relistAt,
      })
      .where(heldSource(applying))
      .returning(),
  ]);
  if (started === undefined) {
    throw new SyncStoppedError("lost");
  }
  applying.source = started;
  return true;
};

/** What `applying`'s relist noted to fetch, as many as one request may name. */
const catchUpsOf = async (applying: Applying): Promise<string[]> => {
  const { db, budget, source } = applying;
  spend(budget, 1);
  const rows = await db
    .select({ itemId: brainSyncCatchUps.itemId })
    .from(brainSyncCatchUps)
    .where(
      and(
        eq(brainSyncCatchUps.connectionId, source.connectionId),
        eq(brainSyncCatchUps.feed, source.feed),
        eq(brainSyncCatchUps.place, source.place)
      )
    )
    .orderBy(asc(brainSyncCatchUps.itemId))
    .limit(connectorIsolateRequests);
  return rows.map(({ itemId }) => itemId);
};

/** Ends `applying`'s relist, nothing left to fetch, and gives its source up. */
const finishRelist = async (applying: Applying): Promise<void> => {
  const { db, budget, source } = applying;
  spend(budget, 1);
  heldAfter(
    await db
      .update(brainSyncSources)
      .set({
        ...(await endedRelist(source, Date.now())),
        leaseId: null,
        leaseUntil: null,
      })
      .where(heldSource(applying))
      .returning({ place: brainSyncSources.place })
  );
};

/**
 * Reads the next page of `source`'s `stream`, which this run holds, and
 * applies it; a read that failed leaves the cursor where it was, due
 * again when the provider asked or at the next run; a "restart" lists it
 * again from the start.
 */
const syncPage = async (
  env: Env,
  db: Database,
  source: Source,
  leaseId: string,
  budget: Budget,
  stream: Stream
): Promise<void> => {
  const applying: Applying = {
    env,
    db,
    source,
    leaseId,
    budget,
    readAt: new Date(),
    skipped: 0,
    stream,
    mode: "page",
    asked: [],
    counts: {
      added: source.added,
      changed: source.changed,
      removed: source.removed,
    },
  };
  if (stream === "relist") {
    const overdue = overdueBy(source, Date.now());
    if (overdue > 0) {
      // A relist past its day: the bound on a stale reader list is broken
      // for this source until it ends (`overdueRelists` counts them).
      log.warn("brain.sync.relist_overdue", {
        connectionId: source.connectionId,
        feed: source.feed,
        overdueMs: overdue,
      });
    }
    if (!source.relisting && !(await startRelist(applying))) {
      return;
    }
    if (applying.source.relistCatchUp) {
      applying.mode = "catchUp";
      applying.asked = await catchUpsOf(applying);
      if (applying.asked.length === 0) {
        await finishRelist(applying);
        return;
      }
    } else if (applying.source.kind !== "file") {
      // Mail and events are their own person's alone: their relist only
      // notices what went and what isn't held, by names (no content
      // fetched again). Files are listed in full, their readers read again.
      applying.mode = "names";
    }
  }
  let page: SyncPage;
  spend(budget, 1);
  try {
    page = await env.CONNECT.readSyncPage({
      connectionId: source.connectionId,
      feed: source.feed,
      place: source.place,
      cursor: (() => {
        if (stream === "changes") {
          return applying.source.cursor;
        }
        return applying.mode === "catchUp"
          ? null
          : applying.source.relistCursor;
      })(),
      ...(applying.mode === "names" ? { names: true } : {}),
      ...(applying.mode === "catchUp" ? { ids: applying.asked } : {}),
    });
  } catch (error) {
    const code = syncErrors.codeOf(error);
    const now = Date.now();
    const { listing } = applying.source;
    spend(budget, 1);
    if (code === "sync.restart") {
      // Listed again from the next run on, not at once: a source that
      // answers "restart" to every read spends one read a run, never the
      // run's budget. The changes' own listing is a full one: a relist
      // under way gives way to it.
      await release(
        applying,
        now + pollMs,
        stream === "changes"
          ? {
              cursor: null,
              listing: listing + 1,
              listingOpen: true,
              relisting: false,
              relistCursor: null,
              relistAt: new Date(await nextRelistAt(source, now)),
              lastError: code,
            }
          : { relistCursor: null, listing: listing + 1, lastError: code }
      );
      return;
    }
    if (code === undefined) {
      log.warn("brain.sync.read_failed", {
        connectionId: source.connectionId,
        errorName: errorName(error),
      });
    }
    await release(
      applying,
      now + (code === "sync.throttled" ? retryAfterOf(error) : pollMs),
      { lastError: code ?? "sync.failed" }
    );
    return;
  }
  await apply(applying, page);
  await commit(applying, page);
};

/**
 * The places of `listed`, a sync connect lists: `own` for one that reads
 * the whole account; else what it lists now (`listSyncPlaces`), or
 * undefined when that failed, which changes none of its sources.
 */
const placesOf = async (
  env: Env,
  budget: Budget,
  listed: SyncSource
): Promise<readonly string[] | undefined> => {
  if (listed.places === "own") {
    return [ownPlace];
  }
  const places: string[] = [];
  let cursor: string | null = null;
  try {
    // A list too long for one read goes on from where the last stopped.
    do {
      spend(budget, 1);
      // oxlint-disable-next-line no-await-in-loop -- one read after another
      const read: SyncPlaces = await env.CONNECT.listSyncPlaces({
        connectionId: listed.connectionId,
        feed: listed.feed,
        cursor,
      });
      places.push(...read.places);
      ({ cursor } = read);
    } while (cursor !== null);
    return places;
  } catch (error) {
    if (stoppedFor(error, "budget")) {
      throw error;
    }
    log.warn("brain.sync.places_failed", {
      connectionId: listed.connectionId,
      errorName: errorName(error),
    });
    return undefined;
  }
};

/**
 * The statements that keep `listed`'s sources as its `places` say, unless
 * a disconnect closed its connection: one source per place, a new one
 * from no cursor, one dropped before and listed again read again from the
 * start; and every place it no longer lists dropped (read no more, its
 * keys erased by the clock: `completeDroppedPlaces`).
 */
const placeStatements = (
  db: Database,
  listed: SyncSource,
  places: readonly string[],
  relistAt: number,
  now: number
) => {
  const kept = places.map((place) =>
    db
      .insert(brainSyncSources)
      .select(
        sql`SELECT ${listed.connectionId}, ${listed.feed}, ${place}, ${listed.ownerUserId}, ${listed.provider}, ${listed.tenant}, ${listed.account}, NULL, 1, 1, ${now}, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, 0, ${relistAt}, NULL, 0, ${listed.kind}, 0, 0
          WHERE NOT ${closed(listed.connectionId)}`
      )
      .onConflictDoUpdate({
        target: [
          brainSyncSources.connectionId,
          brainSyncSources.feed,
          brainSyncSources.place,
        ],
        set: {
          tenant: listed.tenant,
          account: listed.account,
          kind: listed.kind,
          dropped: false,
          cursor: sql`CASE WHEN ${brainSyncSources.dropped} = 1 THEN NULL ELSE ${brainSyncSources.cursor} END`,
          listing: sql`CASE WHEN ${brainSyncSources.dropped} = 1 THEN ${brainSyncSources.listing} + 1 ELSE ${brainSyncSources.listing} END`,
          listingOpen: sql`CASE WHEN ${brainSyncSources.dropped} = 1 THEN 1 ELSE ${brainSyncSources.listingOpen} END`,
        },
      })
  );
  return [
    ...kept,
    db
      .update(brainSyncSources)
      .set({ dropped: true })
      .where(
        sql`${brainSyncSources.connectionId} = ${listed.connectionId} AND ${brainSyncSources.feed} = ${listed.feed} AND ${brainSyncSources.dropped} = 0 AND NOT ${inList(brainSyncSources.place, [...places])}`
      ),
  ];
};

/**
 * The syncs connect lists now, each kept here as its sources, one per
 * place (`placeStatements`), a page of connections at a time. A sync
 * whose places couldn't be listed keeps its sources as they are.
 */
const refreshSources = async (
  env: Env,
  db: Database,
  budget: Budget
): Promise<void> => {
  let after: string | null = null;
  do {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const page = await env.CONNECT.syncSources({ after });
    const now = Date.now();
    const statements = [];
    for (const listed of page.sources) {
      // oxlint-disable-next-line no-await-in-loop -- one sync at a time, within the budget
      const places = await placesOf(env, budget, listed);
      if (places !== undefined) {
        statements.push(
          ...placeStatements(
            db,
            listed,
            places,
            // oxlint-disable-next-line no-await-in-loop -- a hash, no call
            await nextRelistAt({ ...listed, place: ownPlace }, now),
            now
          )
        );
      }
    }
    const [first, ...rest] = statements;
    if (first !== undefined) {
      spend(budget, 1);
      // oxlint-disable-next-line no-await-in-loop -- a page at a time
      await db.batch([first, ...rest]);
    }
    after = page.next;
  } while (after !== null);
};

/** The readers `source`'s person's own store adds with, or the shared store's. */
const readersIn = (source: Source, store: Store): SourceReaders =>
  store === "own"
    ? { kind: "owner", personId: source.personId }
    : { kind: "none" };

/** `completeDroppedPlaces` for one dropped source. */
const eraseDroppedPlace = async (
  env: Env,
  db: Database,
  budget: Budget,
  source: Source
): Promise<void> => {
  const ofPlace = and(
    eq(brainSyncItems.connectionId, source.connectionId),
    eq(brainSyncItems.feed, source.feed),
    eq(brainSyncItems.place, source.place)
  );
  for (;;) {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const rows = await db
      .select()
      .from(brainSyncItems)
      .where(ofPlace)
      .orderBy(asc(brainSyncItems.itemId))
      .limit(erasedPerPage);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      const keys = [
        ...(row.store === null ? [] : [{ key: row.key, store: row.store }]),
        ...(row.leaving === null || row.leavingStore === null
          ? []
          : [{ key: row.leaving, store: row.leavingStore }]),
      ];
      for (const { key, store } of keys) {
        spend(budget, store === "own" ? 2 : 1);
        // oxlint-disable-next-line no-await-in-loop -- within the budget
        await eraseSource(env, {
          source: sourceRefOf(key),
          readers: readersIn(source, store),
          reason: "deleted",
        });
      }
    }
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    await db.delete(brainSyncItems).where(
      and(
        ofPlace,
        inList(
          brainSyncItems.itemId,
          rows.map(({ itemId }) => itemId)
        )
      )
    );
  }
  // Only while it is still dropped: listed again meanwhile, it stays.
  spend(budget, 1);
  await db.batch([
    db
      .delete(brainSyncCatchUps)
      .where(
        and(
          eq(brainSyncCatchUps.connectionId, source.connectionId),
          eq(brainSyncCatchUps.feed, source.feed),
          eq(brainSyncCatchUps.place, source.place)
        )
      ),
    db
      .delete(brainSyncSources)
      .where(
        and(
          eq(brainSyncSources.connectionId, source.connectionId),
          eq(brainSyncSources.feed, source.feed),
          eq(brainSyncSources.place, source.place),
          eq(brainSyncSources.dropped, true)
        )
      ),
  ]);
};

/**
 * Erases what each dropped source added (its place no longer listed: a
 * folder deleted), as a disconnect does for a connection: each key it
 * holds or was leaving erased in its store, a page of rows at a time, the
 * rows forgotten, then, once none is left, what it noted to fetch and the
 * source itself. One that fails is logged and tried again at the next
 * run.
 */
const completeDroppedPlaces = async (
  env: Env,
  db: Database,
  budget: Budget
): Promise<void> => {
  spend(budget, 1);
  const dropped = await db
    .select()
    .from(brainSyncSources)
    .where(eq(brainSyncSources.dropped, true));
  for (const source of dropped) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await eraseDroppedPlace(env, db, budget, source);
    } catch (error) {
      if (stoppedFor(error, "budget")) {
        throw error;
      }
      log.warn("brain.sync.place_erasure_owed", {
        connectionId: source.connectionId,
        errorName: errorName(error),
      });
    }
  }
};

/**
 * Claims the next source to read, unless its connection was closed by a
 * disconnect or another run holds it: this run's until `leaseMs` from
 * now, with the cursor to follow: whichever has waited longest since it
 * was due, a source's changes or a relist's page, changes on a tie. So a
 * relist is never held up for good by changes that came due after it
 * (with more sources than a run reads, changes alone would fill every
 * run and the relist's day would pass), and a change waits behind no
 * relist page that came due after it.
 */
const claimNext = async (
  db: Database,
  budget: Budget,
  leaseId: string
): Promise<{ source: Source; stream: Stream } | undefined> => {
  const now = Date.now();
  spend(budget, 1);
  const [claimed] = await db
    .update(brainSyncSources)
    .set({ leaseId, leaseUntil: new Date(now + leaseMs) })
    .where(
      sql`rowid = (SELECT rowid FROM ${brainSyncSources} AS due
        WHERE (due.due_at <= ${now} OR due.relist_at <= ${now})
          AND due.dropped = 0
          AND (due.lease_until IS NULL OR due.lease_until <= ${now})
          AND NOT ${closed(sql`due.connection_id`)}
        ORDER BY CASE
            WHEN due.due_at <= ${now} AND due.relist_at <= ${now} THEN min(due.due_at, due.relist_at)
            WHEN due.due_at <= ${now} THEN due.due_at
            ELSE due.relist_at
          END,
          due.due_at > ${now},
          due.connection_id, due.feed, due.place
        LIMIT 1)`
    )
    .returning();
  if (claimed === undefined) {
    return undefined;
  }
  // The cursor that has waited longest; its changes on a tie.
  const changesAt = claimed.dueAt.getTime();
  const relistAt = claimed.relistAt.getTime();
  const changesDue = changesAt <= now;
  return {
    source: claimed,
    stream:
      changesDue && (relistAt > now || changesAt <= relistAt)
        ? "changes"
        : "relist",
  };
};

/** A disconnect that stopped a person's own connection, for the sync's erasure. */
export interface SyncDisconnect {
  connectionId: string;
  personId: string;
  /** Connect's `connection.disconnect` event's ID. */
  request: string;
  actor: AuditActor;
  at: Date;
}

/**
 * Closes the person's own connection a disconnect stopped for native
 * sync, for good, before connect's event leaves its outbox
 * (capture-erasures.ts): everything synced into their own store erased at
 * once, in one call (the connection's group, closed, so a late add in it
 * is refused), then, in one batch, the connection closed here (nothing
 * named under it again), its sources gone, and the erasure of what it
 * synced into the shared store owed to the clock (`stepSyncErasure`). A
 * repeat of the same disconnect changes nothing. Throws when the Brain or
 * the database failed: the disconnect is held for the next drain.
 */
export const closeSyncOfDisconnect = async (
  env: Env,
  { connectionId, personId, request, actor, at }: SyncDisconnect
): Promise<void> => {
  const erased = await eraseOwnGroup(env, {
    personId,
    group: syncGroupOf(connectionId),
    reason: "deleted",
  });
  const db = drizzle(env.DB);
  await db.batch([
    db
      .insert(brainSyncDisconnects)
      .values({
        connectionId,
        request,
        actor: JSON.stringify(actor),
        requestedAt: at,
        erasing: true,
        erased,
      })
      .onConflictDoNothing(),
    db
      .delete(brainSyncSources)
      .where(eq(brainSyncSources.connectionId, connectionId)),
    db
      .delete(brainSyncCatchUps)
      .where(eq(brainSyncCatchUps.connectionId, connectionId)),
  ]);
};

/** The event that ends a disconnect's erasure: by who disconnected, when they did. */
const erasedEvent = async (
  row: typeof brainSyncDisconnects.$inferSelect
): Promise<AuditEvent> => ({
  ...createAuditEvent(
    {
      actor: auditActorSchema.parse(JSON.parse(row.actor ?? "null")),
      action: "brain.sync.erased",
      target: { type: "connection", id: row.connectionId },
      detail: { sources: row.erased },
    },
    "core"
  ),
  id: uuidFromHash(
    await sha256Hex(JSON.stringify(["brain.sync.erased", row.request]))
  ),
  at: row.requestedAt.toISOString(),
});

/**
 * Takes the erasure a disconnect of `connectionId` owes a step on, out
 * of `budget`: the keys it gave the shared store erased and forgotten, a
 * page at a time, and once none is left, its rows forgotten and the
 * erasure ended, with its one event (`brain.sync.erased`, how many
 * sources), in one batch. A step that fails leaves what it erased
 * forgotten; the next erases the rest, a key again without change.
 */
export const stepSyncErasure = async (
  env: Env,
  connectionId: string,
  budget: Budget
): Promise<void> => {
  const db = drizzle(env.DB);
  for (;;) {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const page = await db
      .select({
        key: brainSyncItems.key,
        store: brainSyncItems.store,
        leaving: brainSyncItems.leaving,
        leavingStore: brainSyncItems.leavingStore,
      })
      .from(brainSyncItems)
      .where(
        sql`${brainSyncItems.connectionId} = ${connectionId} AND (${brainSyncItems.store} = 'shared' OR ${brainSyncItems.leavingStore} = 'shared')`
      )
      .orderBy(asc(brainSyncItems.feed), asc(brainSyncItems.itemId))
      .limit(erasedPerPage);
    if (page.length === 0) {
      break;
    }
    // Its key in the shared store, and the one it was leaving there when a
    // run stopped, if any.
    const keys = page.flatMap(({ key, store, leaving, leavingStore }) => [
      ...(store === "shared" ? [key] : []),
      ...(leavingStore === "shared" && leaving !== null ? [leaving] : []),
    ]);
    for (const key of keys) {
      spend(budget, 1);
      // oxlint-disable-next-line no-await-in-loop -- within the budget
      await eraseSource(env, {
        source: sourceRefOf(key),
        readers: { kind: "none" },
        reason: "deleted",
      });
    }
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    await db.batch([
      db.delete(brainSyncItems).where(
        and(
          eq(brainSyncItems.connectionId, connectionId),
          inList(
            brainSyncItems.key,
            page.map(({ key }) => key)
          )
        )
      ),
      db
        .update(brainSyncDisconnects)
        .set({ erased: sql`${brainSyncDisconnects.erased} + changes()` })
        .where(eq(brainSyncDisconnects.connectionId, connectionId)),
    ]);
  }
  spend(budget, 1);
  const row = await db
    .select()
    .from(brainSyncDisconnects)
    .where(
      and(
        eq(brainSyncDisconnects.connectionId, connectionId),
        eq(brainSyncDisconnects.erasing, true)
      )
    )
    .get();
  if (row === undefined) {
    return;
  }
  spend(budget, 1);
  await auditedBatch(env, db, [
    db
      .delete(brainSyncItems)
      .where(eq(brainSyncItems.connectionId, connectionId)),
    db
      .update(brainSyncDisconnects)
      // Its event holds who disconnected: the row no longer needs to.
      .set({ erasing: false, actor: null })
      .where(
        and(
          eq(brainSyncDisconnects.connectionId, connectionId),
          eq(brainSyncDisconnects.erasing, true)
        )
      ),
    outboxedEventWhere(db, await erasedEvent(row), sql`changes() > 0`),
  ]);
};

/**
 * Takes every erasure a disconnect owes a step on (`stepSyncErasure`),
 * oldest first, out of `budget`. One that fails is logged with its
 * connection and its error's name, and tried again at the next run.
 */
const completeSyncErasures = async (
  env: Env,
  budget: Budget
): Promise<void> => {
  spend(budget, 1);
  const owed = await drizzle(env.DB)
    .select({ connectionId: brainSyncDisconnects.connectionId })
    .from(brainSyncDisconnects)
    .where(eq(brainSyncDisconnects.erasing, true))
    .orderBy(asc(brainSyncDisconnects.requestedAt));
  for (const { connectionId } of owed) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await stepSyncErasure(env, connectionId, budget);
    } catch (error) {
      if (stoppedFor(error, "budget")) {
        throw error;
      }
      log.warn("brain.sync.erasure_owed", {
        connectionId,
        errorName: errorName(error),
      });
    }
  }
};

/**
 * One run of native sync on core's clock: owed erasures first, then the
 * sources connect lists, then pages of the sources due, each claimed in
 * turn, the one due longest first, until none is due or the run's
 * `budget` (`syncCallsPerTick`) is spent. A source whose page failed is
 * logged and left due again later; the others go on.
 */
export const runSync = async (env: Env, given?: Budget): Promise<void> => {
  const budget = given ?? { left: syncCallsPerTick };
  const db = drizzle(env.DB);
  const leaseId = crypto.randomUUID();
  try {
    await completeSyncErasures(env, budget);
    await refreshSources(env, db, budget);
    await completeDroppedPlaces(env, db, budget);
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      const claimed = await claimNext(db, budget, leaseId);
      if (claimed === undefined) {
        return;
      }
      const { source, stream } = claimed;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await syncPage(env, db, source, leaseId, budget, stream);
      } catch (error) {
        if (stoppedFor(error, "budget")) {
          // What was done is in its rows: the page is read again next run,
          // still due since when it was, so it keeps its turn.
          // oxlint-disable-next-line no-await-in-loop -- ends the run
          await release(
            { db, source, leaseId, stream },
            (stream === "changes" ? source.dueAt : source.relistAt).getTime()
          );
          return;
        }
        // Any other stop: logged, and the source given up (only while
        // this run still holds it), due again at the next run, its cursor
        // where it was. Never left held until its lease runs out.
        const lost = stoppedFor(error, "lost");
        log.warn(lost ? "brain.sync.page_stopped" : "brain.sync.page_failed", {
          connectionId: source.connectionId,
          errorName: errorName(error),
        });
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await release({ db, source, leaseId, stream }, Date.now() + pollMs, {
          lastError: lost ? "sync.lost" : "sync.failed",
        });
      }
    }
  } catch (error) {
    if (!stoppedFor(error, "budget")) {
      throw error;
    }
  }
};
