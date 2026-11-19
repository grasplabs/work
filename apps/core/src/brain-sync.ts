import { connectorIsolateRequests } from "@grasp-os/connector-kit/manifest";
import { auditActorSchema, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import type {
  BrainSyncConnection,
  BrainSyncPhase,
} from "@grasp-os/shared/brain-report";
import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { errorFields, errorName, log } from "@grasp-os/shared/log";
import {
  readerProofMaxAgeMs,
  sourceReaderSchema,
} from "@grasp-os/shared/source-readers";
import type { SourceReader } from "@grasp-os/shared/source-readers";
import { ownPlace, placesListing, syncErrors } from "@grasp-os/shared/sync";
import type {
  SyncItem,
  SyncPage,
  SyncPlaces,
  SyncReader,
} from "@grasp-os/shared/sync";
import { uploadTypes } from "@grasp-os/shared/uploads";
import type { UploadMediaType } from "@grasp-os/shared/uploads";
import { clockLeaseMs, clockPeriods } from "@grasp-os/workerflow/clock";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type {
  SQLiteTable,
  SQLiteUpdateSetSource,
} from "drizzle-orm/sqlite-core";

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
  eventsPerAddMax,
  principalMaxLength,
  recordEvents,
  sourceTextProblem,
} from "./brain-next.ts";
import type { ObservedStep, SourceReaders, SourceRef } from "./brain-next.ts";
import {
  brainSyncCatchUps,
  brainSyncDisconnects,
  brainSyncItems,
  brainSyncSources,
  connectionBrainAudiences,
  connectionBrainErasures,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";
import { localExtractor } from "./files/extract.ts";
import { brainCallsPerTick } from "./shared-reads.ts";
import { erasureBegan, plainPrincipalOf } from "./source-readers.ts";

// Native sync's run (GRA-1758; the design is on GRA-1719, the threat
// model on GRA-1758): pages of a connection's changes, read from connect
// (`readSyncPage`, which holds the token and the provider's code), made
// into Brain sources on core's clock. Connect and the Brain never call
// each other: core reads a page and applies it.
//
// - A source is a connection, one of its connector's syncs (`feed`) and
//   a place: a person's own account (`own`) or a place it lists (a mail
//   folder), or a place an admin picked on a shared connection (a shared
//   drive, a SharePoint library: GRA-1719), as connect lists them
//   (`syncSources`). Core keeps its cursor, so a page is committed in one
//   place.
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
// - A shared connection has no owner: everything of a place picked on it
//   goes to the shared store for that place's group, whatever its own
//   readers say (none are read), so never to whoever connected it. Core
//   puts a reader in the place's group only beside the connection's own,
//   which its Brain audience holds (GRA-1831), and only while the place
//   is picked (brain-next.ts `withConnections`). So an un-pick hides the
//   place in one statement (`hideUnpickedPlaces`), before the admin's
//   save answers; the clock then erases it (`completeDroppedPlaces`), as
//   it erases every place of a connection whose records an admin erases
//   (`dropErasedPlaces`). Nothing is read or kept while the audience is
//   nobody, an erasure of the connection's records is under way, or a
//   disconnect closed it. It records no steps: no one person made them.
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
 * and what the listing didn't name taken out: once a day, the age a
 * copied reader list may reach (`readerProofMaxAgeMs`, one constant for
 * both). A product choice, not a number derived from a limit: some
 * sharing changes come with no signal at all (Microsoft gives none for
 * unsharing one file; Google's feed isn't guaranteed either), so where a
 * vendor gives none, a reader the source took off can read an item for at
 * most a day.
 */
const relistMs = readerProofMaxAgeMs;

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

/** When a row's relist is never due: the places listing has none. */
const never = new Date(8_640_000_000_000_000);

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

/** Core's database for reading, and for batches of fenced statements (`writesOf`): it writes nothing itself. */
type Reads = Pick<Database, "select" | "batch">;

/**
 * Work a writer took, and the token it took it with: the lease
 * (`lease_id`) on the row of a source, for a page of it (`dropped`
 * false: `claimNext`, `listPlaces`) or for the erase of a place no longer
 * listed (`dropped` true: `takeDroppedPlace`), or on the row of a
 * disconnect, for its erase (`takeErasure`). A token is new each time the
 * work is taken, and the work changes it whenever it changes hands or
 * meaning: a new lease, a drop (`listPlaces`), a place listed again
 * (`sourceStatement`), a disconnect (its sources' rows gone).
 */
type Work =
  | {
      readonly db: Database;
      readonly token: string;
      readonly connectionId: string;
      readonly feed: string;
      readonly place: string;
      readonly dropped: boolean;
    }
  | {
      readonly db: Database;
      readonly token: string;
      readonly erasure: string;
    };

/** That `work` is still the writer's, as the token it took it with says, as SQL. */
const fenceOf = (work: Work): SQL =>
  "erasure" in work
    ? sql`EXISTS (SELECT 1 FROM ${brainSyncDisconnects} AS fence WHERE fence.connection_id = ${work.erasure} AND fence.lease_id = ${work.token} AND fence.erasing = 1)`
    : sql`EXISTS (SELECT 1 FROM ${brainSyncSources} AS fence WHERE fence.connection_id = ${work.connectionId} AND fence.feed = ${work.feed} AND fence.place = ${work.place} AND fence.lease_id = ${work.token} AND fence.dropped = ${work.dropped ? 1 : 0})`;

/**
 * The one way a writer of the sync writes, every statement fenced by its
 * work's token in the statement itself (`fenceOf`): once the work has
 * changed hands or meaning, each matches nothing, and the writer stops at
 * the first that a check of its own finds wrote nothing (`heldAfter`).
 * Only what takes or changes work writes otherwise: `claimNext`,
 * `takeDroppedPlace`, `takeErasure`, the take of a shared connection's
 * places listing before an un-pick or an erase drops its places
 * (`droppedExcept`), `refreshSources`'s upsert of the sources connect
 * lists, and a disconnect (`closeSyncOfDisconnect`).
 */
const writesOf = (work: Work) => {
  const { db } = work;
  const fence = fenceOf(work);
  return {
    update: <T extends SQLiteTable>(
      table: T,
      set: SQLiteUpdateSetSource<T>,
      where: SQL
    ) =>
      db
        .update(table)
        .set(set)
        .where(sql`(${where}) AND ${fence}`),
    delete: <T extends SQLiteTable>(table: T, where: SQL) =>
      db.delete(table).where(sql`(${where}) AND ${fence}`),
    /** `INSERT INTO table select WHERE (where) AND fence`: `select` has no WHERE of its own. */
    insert: <T extends SQLiteTable>(
      table: T,
      select: SQL,
      where: SQL = sql`1 = 1`
    ) => db.insert(table).select(sql`${select} WHERE (${where}) AND ${fence}`),
  };
};

type Writes = ReturnType<typeof writesOf>;

/** The writes of a page of `source` this run claimed with `leaseId` (`claimNext`). */
const pageWritesOf = (
  db: Database,
  source: Pick<Source, "connectionId" | "feed" | "place">,
  leaseId: string
): Writes =>
  writesOf({
    db,
    token: leaseId,
    connectionId: source.connectionId,
    feed: source.feed,
    place: source.place,
    dropped: false,
  });

type Source = typeof brainSyncSources.$inferSelect;
type Item = typeof brainSyncItems.$inferSelect;
type Store = NonNullable<Item["store"]>;

/**
 * Who reads a synced item, by the Brain's groups: its owner, in their own
 * store, or in the shared store, its `readers`, with them as compared
 * (`readersKey`: as core compares them, sorted, as JSON; hashed into its
 * change keys, never kept).
 */
type Plan =
  | { store: "own"; readersKey: null }
  | { store: "shared"; readers: SourceReaders; readersKey: string };

/**
 * The person whose own store `source` adds to. Only a person's own
 * connection has one: a shared connection's places never go to anyone's
 * own store (`planOf`), so asking for its owner is a bug.
 */
const ownerOf = (source: Pick<Source, "personId">): string => {
  if (source.personId === null) {
    throw new Error("A shared connection's source has no own store");
  }
  return source.personId;
};

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

/** `readers` as core compares them, sorted, as JSON: a link reaches nobody. */
const readersKeyOf = (readers: readonly SourceReader[]): string[] =>
  [
    ...new Set(readers.flatMap((reader) => readerKeyOf(reader) ?? [])),
  ].toSorted();

/**
 * Where `item` goes and who reads it. Of a place picked on a shared
 * connection, the shared store, read by those of the item's own readers
 * the place's group holds (GRA-2145): nobody's when the source named none
 * or couldn't be read whole. Else the owner's own store for mail, events
 * and attachments, and for a file whose readers name nobody but the
 * connection's own account (or couldn't be read whole); else the shared
 * store, read by its readers.
 */
const planOf = (
  source: Source,
  item: Extract<SyncItem, { gone: false }>
): Plan => {
  // A place picked on a shared connection: never an owner's, whatever the
  // item's own readers say, and never wider than they are.
  if (source.personId === null) {
    const readers = readersOf(source, item.readers ?? []);
    return {
      store: "shared",
      readers: {
        kind: "place",
        connectionId: source.connectionId,
        feed: source.feed,
        place: source.place,
        readers,
      },
      readersKey: JSON.stringify([
        "place",
        source.place,
        readersKeyOf(readers),
      ]),
    };
  }
  const own: Plan = { store: "own", readersKey: null };
  // Mail is its mailbox's own person's alone, an attachment its message's.
  if (item.kind !== "file" || item.partOf !== null || item.readers === null) {
    return own;
  }
  const readers = readersOf(source, item.readers);
  const owner =
    source.account === null
      ? undefined
      : `account:${comparable(source.account)}`;
  const keys = readersKeyOf(readers);
  if (keys.every((key) => key === owner)) {
    return own;
  }
  // Only ever hashed into a change key: no row keeps a reader.
  return {
    store: "shared",
    readers: { kind: "readers", readers },
    readersKey: JSON.stringify(keys),
  };
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
  /** Reads, and batches of statements `write` made: never a write of its own. */
  db: Reads;
  /** The audit outbox's own statements alone, each after a fenced write (`changes()`). */
  outbox: Database;
  /** Every write of the page, fenced by the source's lease (`writesOf`). */
  write: Writes;
  source: Source;
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
  /**
   * The person's steps this read applied, one per change counted
   * (`stepped`), recorded once the page is committed (`recordSteps`), and
   * the items they are of.
   */
  steps: ObservedStep[];
  stepped: Set<string>;
  /**
   * Whether an earlier read of this page saved changes and stopped before
   * its commit: its counters, stored with each change and reset only by a
   * commit, weren't all zero when this read claimed the source.
   */
  replay: boolean;
}

/**
 * Whether `applying`'s page is part of a listing: the relist's, or the
 * changes' own after a restart (or the first), each until its first page
 * with nothing more.
 */
const isListing = ({ source, stream }: Applying): boolean =>
  stream === "relist" || source.listingOpen;

/** That a disconnect closed `connectionId` for the sync, as SQL. */
const closed = (connectionId: SQL | string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${brainSyncDisconnects} WHERE ${brainSyncDisconnects.connectionId} = ${connectionId})`;

/**
 * That the shared connection `connectionId` has a Brain audience now,
 * and no erasure of its records under way or closed by a disconnect
 * (connection-audiences.ts, shared-reads.ts), as SQL.
 */
const audienced = (connectionId: SQL | string): SQL =>
  sql`EXISTS (SELECT 1 FROM ${connectionBrainAudiences} WHERE ${connectionBrainAudiences.connectionId} = ${connectionId})
    AND NOT EXISTS (SELECT 1 FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${connectionId} AND (${connectionBrainErasures.erasing} = 1 OR ${connectionBrainErasures.closed} = 1))`;

/** The row of the source of `place` of `of`'s sync, as SQL. */
const sourceRowOf = (
  of: Pick<Source, "connectionId" | "feed">,
  place: string
): SQL =>
  sql`${brainSyncSources.connectionId} = ${of.connectionId} AND ${brainSyncSources.feed} = ${of.feed} AND ${brainSyncSources.place} = ${place}`;

/** The rows of the items of the place of `source`, as SQL. */
const itemsOfPlace = (source: Source): SQL =>
  sql`${brainSyncItems.connectionId} = ${source.connectionId} AND ${brainSyncItems.feed} = ${source.feed} AND ${brainSyncItems.place} = ${source.place}`;

/**
 * One of the page's counters, one up, while the run holds the source (and
 * `when` holds, if given: a write earlier in the same batch took effect).
 */
const counted = (
  applying: Applying,
  counter: "added" | "changed" | "removed",
  when: SQL = sql`1 = 1`
) =>
  applying.write
    .update(
      brainSyncSources,
      { [counter]: sql`${brainSyncSources[counter]} + 1` },
      sql`${sourceRowOf(applying.source, applying.source.place)} AND ${when}`
    )
    .returning({ leaseId: brainSyncSources.leaseId });

/** The row of `item` as the statement `where` picks it. */
const itemWhere = (applying: Applying, itemId: string): SQL =>
  sql`${brainSyncItems.connectionId} = ${applying.source.connectionId} AND ${brainSyncItems.feed} = ${applying.source.feed} AND ${brainSyncItems.itemId} = ${itemId}`;

/**
 * `row` as the run read it, still in the place the run acts for, as SQL:
 * the same generation, in this place (the run's lease the statement's
 * fence adds, `writesOf`). Every statement that holds, leaves or erases
 * an item for a place checks it in the statement itself: a page of
 * another place may have brought the item there since it was read
 * (`bringBack`), with the same generation, and what this place says of an
 * item no longer in it changes nothing.
 */
const stillHere = (applying: Applying, row: Item): SQL =>
  sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.generation} = ${row.generation} AND ${brainSyncItems.place} = ${applying.source.place}`;

/** Throws when a batch's last statement, the counter, found the run no longer holding its source. */
const heldAfter = (counter: readonly unknown[]): void => {
  if (counter.length === 0) {
    throw new SyncStoppedError("lost");
  }
};

/**
 * What a step saved, as its row says it once saved: the key it was in,
 * the change it holds there and the Brain's version of it, or the key it
 * left (`change` "removed", no version).
 */
interface StepSaved {
  key: string;
  change: string;
  version: number | null;
}

/**
 * A step's event key, the one way it is made: from what it saved alone,
 * so a step has the same key whether the read that saved it records it or
 * a read of the same page again rebuilds it from the row
 * (`replayedSteps`), and the Brain keeps it once.
 */
const stepKeyOf = async ({
  key,
  change,
  version,
}: StepSaved): Promise<string> =>
  await sha256Hex(JSON.stringify([key, change, version]));

/**
 * One step of the connection's owner for a change this read counted: the
 * sync's kind and what happened (`file.added`, `mail.removed`), keyed by
 * the item's key in the Brain (its connection, feed, item and generation:
 * `keyOf`) and the change, hashed to stay within a key's length, so a
 * page applied twice keeps it once and two items never share a key (two
 * teammates' copies of one file), on the
 * provider's item, when the provider says it changed. Its
 * system is the connection's provider, as a call's is (brain-events.ts).
 * It writes nothing: the sync saw the change in that system, and who made
 * it there (the owner, a colleague, a sender) it doesn't know.
 */
const stepped = async (
  applying: Applying,
  counter: "added" | "changed" | "removed",
  saved: StepSaved,
  item: string,
  at: Date
): Promise<void> => {
  const { personId } = applying.source;
  // A place picked on a shared connection: no one person's steps, so none.
  if (personId === null) {
    return;
  }
  applying.stepped.add(item);
  applying.steps.push({
    key: await stepKeyOf(saved),
    personId,
    step: `${applying.source.kind}.${counter}`,
    system: applying.source.provider,
    writes: false,
    item,
    at,
  });
};

/** When the provider says `item` changed, or the read's time if it says none it can use. */
const changedOf = (item: { changedAt: string }, readAt: Date): Date => {
  const at = new Date(item.changedAt);
  return Number.isNaN(at.getTime()) ? readAt : at;
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
    ? { kind: "owner", personId: ownerOf(applying.source) }
    : { kind: "none" };

/**
 * Erases the key `row` is leaving (`leaving`, in `leavingStore`), then
 * forgets that it was: the second half of `leave`, finished on a later
 * read when a stopped run left it (`finishOwedLeaves`). Safe to repeat:
 * erasing an erased key changes nothing.
 */
const finishLeaving = async (applying: Applying, row: Item): Promise<Item> => {
  const { env, write, budget } = applying;
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
    await write
      .update(
        brainSyncItems,
        { leaving: null, leavingStore: null },
        sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.leaving} = ${row.leaving}`
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
 * the next read of the source erases it before anything else. Only while
 * the row is still here (`stillHere`): `undefined`, with nothing erased
 * or counted, for an item another place has taken since it was read.
 */
const leave = async (
  applying: Applying,
  row: Item
): Promise<Item | undefined> => {
  const { db, write, budget, source } = applying;
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
    savedAt: new Date(),
  };
  spend(budget, 1);
  // Owed first, which a leave that took nothing leaves harmlessly set;
  // counted only if the row left, by the state the leave wrote.
  const [owed, gone, counter] = await db.batch([
    write
      .update(
        brainSyncSources,
        { leavesOwed: true },
        sourceRowOf(source, source.place)
      )
      .returning({ place: brainSyncSources.place }),
    write
      .update(brainSyncItems, left, stillHere(applying, row))
      .returning({ key: brainSyncItems.key }),
    counted(
      applying,
      "removed",
      sql`EXISTS (SELECT 1 FROM ${brainSyncItems} WHERE ${itemWhere(applying, row.itemId)} AND ${brainSyncItems.generation} = ${generation} AND ${brainSyncItems.leaving} = ${row.key} AND ${brainSyncItems.place} = ${source.place})`
    ),
  ]);
  heldAfter(owed);
  if (gone.length === 0) {
    return undefined;
  }
  countedIn(applying, "removed", counter);
  await stepped(
    applying,
    "removed",
    { key: row.key, change: "removed", version: null },
    row.itemId,
    applying.readAt
  );
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
 * Whether the removal of `row` from `source` is held for a move (`hold`):
 * only in a sync that lists places, and only for what is in its owner's
 * own store. Anything others may read goes at once.
 */
const holds = (source: Source, row: Item): boolean =>
  source.place !== ownPlace && row.store === "own";

/**
 * Holds the removal of `row`'s item, gone from one place of a sync that
 * lists places: a message moved between two folders comes as gone in
 * one and new in the other, in whichever order the two are read, so it
 * is erased only once every other place of the sync has applied a page
 * since (`finishHeldRemovals`), never leaving a hole while the other
 * place is read later. Mail is its own person's alone, so nobody else
 * reads it meanwhile. Held since when it first went. Only while the row
 * is still here (`stillHere`): `undefined` for an item another place has
 * taken since it was read.
 */
const hold = async (
  applying: Applying,
  row: Item
): Promise<Item | undefined> => {
  const { db, write, budget } = applying;
  const heldSince = row.heldSince ?? new Date();
  spend(budget, 1);
  const [owed, held] = await db.batch([
    write
      .update(
        brainSyncSources,
        { leavesOwed: true },
        sourceRowOf(applying.source, applying.source.place)
      )
      .returning({ place: brainSyncSources.place }),
    write
      .update(brainSyncItems, { heldSince }, stillHere(applying, row))
      .returning({ key: brainSyncItems.key }),
  ]);
  heldAfter(owed);
  // Taken by another place since it was read: not held here.
  return held.length === 0 ? undefined : { ...row, heldSince };
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
        WHERE other.connection_id = ${source.connectionId} AND other.feed = ${source.feed} AND other.place <> ${source.place} AND other.place <> ${placesListing} AND other.dropped = 0
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
    await applying.write
      .update(
        brainSyncItems,
        moved,
        sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.generation} = ${row.generation}`
      )
      .returning({ key: brainSyncItems.key })
  );
  return { ...row, ...moved };
};

/**
 * What `page` says of the parts it doesn't name (`partOf`: a message's
 * attachments), the one rule for an item's parts: they follow the item
 * they are part of. A page that reads an item in full (with its content)
 * names every part it has with it; one that names it without content (a
 * names-only listing, whose list calls name no attachments, or an item
 * passed over) may name none. So a part the page doesn't name goes with
 * an item the page names gone (`out`, held as the item is), goes when
 * the page reads its item in full (`dropped`: no longer one of its
 * parts), and stays, named with it, when the page names its item without
 * content (`kept`). A part the page names is applied as any item is. The
 * rows are the page's (`rowsOf`), parts included.
 */
const unnamedParts = (
  applying: Applying,
  page: SyncPage,
  rows: ReadonlyMap<string, Item>
): { out: Item[]; dropped: Item[]; kept: Item[] } => {
  const named = new Map(page.items.map((item) => [item.id, item]));
  const out: Item[] = [];
  const dropped: Item[] = [];
  const kept: Item[] = [];
  for (const row of rows.values()) {
    const parent = row.partOf === null ? undefined : named.get(row.partOf);
    if (parent === undefined || row.store === null || named.has(row.itemId)) {
      continue;
    }
    if (!parent.gone) {
      (parent.content === null ? kept : dropped).push(row);
    } else if (row.place === applying.source.place) {
      // Only in the place it is in: a gone elsewhere says nothing of it.
      out.push(row);
    }
  }
  return { out, dropped, kept };
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
  plan: Extract<Plan, { store: "shared" }>
): Promise<Item> => {
  const { env, db, write, budget, readAt } = applying;
  const change = await changeOf([
    "readers",
    plan.readersKey,
    readAt.getTime(),
    row.itemId,
  ]);
  spend(budget, 1);
  const made = await changeSourceReaders(env, {
    source: sourceRefOf(row.key),
    change,
    readers: plan.readers,
    readAt,
  });
  // Not held yet, or an add of it under way (`change` null, its record
  // lost with a stopped run): the page's add records and counts it.
  if (made === null || row.change === null || made.version === row.version) {
    return row;
  }
  spend(budget, 1);
  const [, counter] = await db.batch([
    write.update(
      brainSyncItems,
      { version: made.version, savedAt: new Date() },
      sql`${itemWhere(applying, row.itemId)} AND ${brainSyncItems.generation} = ${row.generation}`
    ),
    counted(applying, "changed"),
  ]);
  countedIn(applying, "changed", counter);
  // A sharing change moves no time at the provider: as of the read.
  await stepped(
    applying,
    "changed",
    { key: row.key, change: row.change, version: made.version },
    row.itemId,
    readAt
  );
  return { ...row, version: made.version };
};

/**
 * Whether the Brain may keep what `source` reads now, as SQL, beside its
 * page's fence (which holds only while its place is listed or picked,
 * `writesOf`): for a place picked on a shared connection, an audience
 * chosen for the connection and no erasure of its records under way or
 * closed by a disconnect (`audienced`), as `claimSharedRead` checks it.
 * Nothing is kept while the audience is nobody.
 */
const mayKeep = (source: Source): SQL =>
  source.personId === null ? audienced(source.connectionId) : sql`1 = 1`;

/**
 * Names `item`'s key for `plan` before the Brain is given it, while the
 * run holds its source, no disconnect closed its connection and the Brain
 * may keep what it reads (`mayKeep`): the row as it is now, with the add
 * under way (`change` null).
 */
const claim = async (
  applying: Applying,
  row: Item | undefined,
  item: Extract<SyncItem, { gone: false }>,
  plan: Plan
): Promise<Item> => {
  const itemId = item.id;
  const { write, budget, source } = applying;
  const generation = row?.generation ?? 1;
  const key =
    row?.key ??
    (await keyOf(source.connectionId, source.feed, itemId, generation));
  spend(budget, 1);
  const [claimed] = await write
    .insert(
      brainSyncItems,
      sql`SELECT ${source.connectionId}, ${source.feed}, ${itemId}, ${source.place}, ${key}, ${generation}, ${plan.store}, NULL, NULL, NULL, ${item.partOf}, ${source.listing}, NULL, NULL, NULL, NULL`,
      sql`NOT ${closed(source.connectionId)} AND ${mayKeep(source)}`
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
 * `row` ready for `plan`'s claim: erased from the store it leaves, if it
 * crosses, and any erase a stopped run owed on it done, here before the
 * claim keeps the row (in this place, which may not be where the erase
 * was owed). An item another place took since the page was read stops
 * the page, to be read again from where that place left it.
 */
const clearedFor = async (
  applying: Applying,
  row: Item | undefined,
  plan: Plan
): Promise<Item | undefined> => {
  if (row === undefined) {
    return undefined;
  }
  if (row.store !== null && row.store !== plan.store) {
    const left = await leave(applying, row);
    if (left === undefined) {
      throw new SyncStoppedError("lost");
    }
    return left;
  }
  return await finishLeaving(applying, row);
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
  text: string
): Promise<void> => {
  const { env, db, write, budget, source, readAt } = applying;
  const change = await changeOf([
    "version",
    item.version,
    plan.readersKey,
    await sha256Hex(text),
  ]);
  if (given?.store === plan.store && given.change === change) {
    return;
  }
  const claimed = await claim(
    applying,
    await clearedFor(applying, given, plan),
    item,
    plan
  );
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
          ? { kind: "owner", personId: ownerOf(source) }
          : plan.readers,
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
    // A key this source named, erased all the same: its next key, until
    // one was never erased. An item whose row an erase forgot (a place
    // un-picked or no longer listed, an admin's "Erase what the Brain
    // kept") starts again at its first key, so it steps past each key it
    // held before; each step is charged, so the budget bounds a run. A
    // disconnect that closed the connection refuses the next key's claim,
    // and so does a person's erasure, which disconnects.
    await add(applying, await nextKey(applying, claimed), item, plan, text);
    return;
  }
  spend(budget, 1);
  const recorded = write
    .update(
      brainSyncItems,
      { change, version, marker: await markerOf(item), savedAt: new Date() },
      sql`${itemWhere(applying, item.id)} AND ${brainSyncItems.generation} = ${claimed.generation}`
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
  await stepped(
    applying,
    counter,
    { key: claimed.key, change, version },
    item.id,
    changedOf(item, readAt)
  );
};

/**
 * The rows of the page's items and of their parts (`unnamedParts`), by
 * the provider's ID.
 */
const rowsOf = async (
  applying: Applying,
  items: readonly SyncItem[]
): Promise<Map<string, Item>> => {
  const { db, budget, source } = applying;
  if (items.length === 0) {
    return new Map();
  }
  const ids = items.map(({ id }) => id);
  const rowsWhere = (column: SQLWrapper) =>
    db
      .select()
      .from(brainSyncItems)
      .where(
        and(
          eq(brainSyncItems.connectionId, source.connectionId),
          eq(brainSyncItems.feed, source.feed),
          inList(column, ids)
        )
      );
  spend(budget, 1);
  // Two halves, not one OR: each half by its own index, never a scan of
  // the connection's every row.
  const rows = await rowsWhere(brainSyncItems.itemId).unionAll(
    rowsWhere(brainSyncItems.partOf)
  );
  return new Map(rows.map((row) => [row.itemId, row]));
};

/**
 * Brings back, here, each item the page names that the Brain holds
 * (`kept`, its parts a names-only listing keeps with it included): in
 * this place, the one a later gone counts in (`applyRemovals`), and no
 * longer held to go (`hold`). Whether or not anything of it is written
 * after, so an item that comes back as it was is never erased when its
 * hold ends, nor by a gone from the place it left. One statement for
 * the page, only when one of them is elsewhere or held.
 */
const bringBack = async (
  applying: Applying,
  page: SyncPage,
  rows: Map<string, Item>,
  kept: readonly Item[]
): Promise<void> => {
  const { write, budget, source } = applying;
  const back = [
    ...page.items.flatMap((item) => {
      const row = item.gone ? undefined : rows.get(item.id);
      return row === undefined ? [] : [row];
    }),
    ...kept,
  ].filter(
    (row) =>
      row.store !== null &&
      (row.heldSince !== null || row.place !== source.place)
  );
  if (back.length === 0) {
    return;
  }
  const here = {
    place: source.place,
    heldSince: null,
    listing: source.listing,
  };
  spend(budget, 1);
  await write.update(
    brainSyncItems,
    here,
    sql`${brainSyncItems.connectionId} = ${source.connectionId} AND ${brainSyncItems.feed} = ${source.feed} AND ${inList(
      brainSyncItems.itemId,
      back.map(({ itemId }) => itemId)
    )} AND ${brainSyncItems.store} IS NOT NULL`
  );
  for (const row of back) {
    rows.set(row.itemId, { ...row, ...here });
  }
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
  const { write, budget, source } = applying;
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
  // The IDs bound as one value, however many the page names (`inList`):
  // D1 binds at most 100 to a statement, and a listing's page can name a
  // thousand. Its WHERE (the fence, `writesOf`) is SQLite's too: without
  // one, its parser takes the conflict clause for a join's.
  await write
    .insert(
      brainSyncCatchUps,
      sql`SELECT ${source.connectionId}, ${source.feed}, ${source.place}, value FROM json_each(${JSON.stringify(wanted)})`
    )
    .onConflictDoNothing();
};

/**
 * A page's first half: what went away and every change of readers of the
 * shared store (an item that leaves it for its owner's own store erased
 * there), then the parts that go with their item (`unnamedParts`).
 * Nothing of the page is added before all of it.
 */
const applyRemovals = async (
  applying: Applying,
  page: SyncPage,
  rows: Map<string, Item>,
  parts: { out: readonly Item[]; dropped: readonly Item[] }
): Promise<void> => {
  const { source } = applying;
  for (const item of page.items) {
    const row = rows.get(item.id);
    if (row?.store === null || row === undefined) {
      continue;
    }
    if (item.gone) {
      // Gone from here, but named in another place since (`bringBack`):
      // moved there, so this gone says nothing of it.
      if (row.place !== source.place) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
      const after = await (holds(source, row)
        ? hold(applying, row)
        : leave(applying, row));
      if (after !== undefined) {
        rows.set(item.id, after);
      }
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
    if (changed === undefined) {
      // Taken by another place since the page was read: read it again.
      throw new SyncStoppedError("lost");
    }
    rows.set(item.id, changed);
  }
  for (const part of parts.out) {
    // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
    await (holds(source, part) ? hold(applying, part) : leave(applying, part));
  }
  for (const part of parts.dropped) {
    // oxlint-disable-next-line no-await-in-loop -- in order, within the budget
    await leave(applying, part);
  }
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
  const { write, budget, source } = applying;
  const rows = await rowsOf(applying, page.items);
  const parts = unnamedParts(applying, page, rows);
  if ((source.listingOpen || source.relisting) && rows.size > 0) {
    // Named while a listing is under way, by it or by a change since,
    // whatever else the page does with them, their parts with them
    // (`unnamedParts`): there, so not swept. What is in another place is
    // brought here, listing and all, or left alone (`bringBack`).
    spend(budget, 1);
    await write.update(
      brainSyncItems,
      { listing: source.listing },
      sql`${brainSyncItems.connectionId} = ${source.connectionId} AND ${brainSyncItems.feed} = ${source.feed} AND ${brainSyncItems.place} = ${source.place} AND ${inList(brainSyncItems.itemId, [...rows.keys()])}`
    );
  }
  await bringBack(applying, page, rows, parts.kept);
  await applyRemovals(applying, page, rows, parts);
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
 * The IDs a catch-up asked for that `page` answers: there, or gone. Only
 * these are fetched; what it doesn't answer stays owed. A connector that
 * reads no IDs answers its ordinary first page, which may answer some of
 * them, or none.
 */
const coveredOf = (applying: Applying, page: SyncPage): string[] => {
  const answered = new Set(page.items.map(({ id }) => id));
  return applying.asked.filter((id) => answered.has(id));
};

/**
 * Whether `page` is a names-only answer: nothing in it with content. A
 * connector that reads no names answers its ordinary page, in full, which
 * is then applied as a full listing's page is: never taken for names,
 * whose items would all be fetched again by ID.
 */
const namesOnly = (page: SyncPage): boolean =>
  page.items.every((item) => item.gone || item.content === null);

/**
 * Where a relist's page moves it: on while there is more; a names-only
 * listing that ended goes on to fetch what it noted (`relistCatchUp`), at
 * once; a full listing that ended ends the relist until its next day. A
 * catch-up page that answered some of what it asked stays due at once:
 * the next read asks what is left, or ends the relist (`syncPage`). One
 * that answered none of it (a connector that reads no IDs) ends the relist
 * for the day: what it asked stays owed, noted again by the next day's.
 */
const relistMoved = async (
  applying: Applying,
  page: SyncPage,
  now: number
): Promise<Partial<typeof brainSyncSources.$inferInsert>> => {
  const { mode, source } = applying;
  if (mode === "catchUp") {
    if (coveredOf(applying, page).length > 0) {
      return { relistAt: new Date(now) };
    }
    log.warn("brain.sync.catch_up_unanswered", {
      connectionId: source.connectionId,
      feed: source.feed,
      asked: applying.asked.length,
    });
    return await endedRelist(source, now);
  }
  if (page.more) {
    return { relistCursor: page.cursor, relistAt: new Date(now) };
  }
  // A relist that asked for names (every one but files'), whichever way
  // its last page answered, fetches what its names-only pages noted.
  if (source.kind !== "file") {
    return {
      relistCursor: page.cursor,
      relistCatchUp: true,
      relistAt: new Date(now),
    };
  }
  return await endedRelist(source, now);
};

/**
 * Keeps the page's steps as the Brain's events, after its commit, for the
 * owner's teams of at least `minTeamShown` (`recordEvents` decides).
 * Never holds up the sync: a failure is logged, and so is a run whose
 * budget can't cover it, and their steps are not kept. Its calls: the
 * owner's teams, their sizes, and at least one add per `eventsPerAddMax`
 * steps (a step is an event for each of the owner's teams).
 */
const recordSteps = async (applying: Applying): Promise<void> => {
  const { env, budget, source, steps } = applying;
  if (steps.length === 0) {
    return;
  }
  try {
    spend(budget, 2 + Math.ceil(steps.length / eventsPerAddMax));
    await recordEvents(env, steps);
  } catch (error) {
    log.warn("brain.sync.steps_not_kept", {
      connectionId: source.connectionId,
      steps: steps.length,
      ...errorFields(error),
    });
  }
};

/**
 * The steps of what an earlier read of this page saved before it stopped
 * short of its commit (`replay`), which this read, finding them done,
 * didn't take again: each row of the place saved since the source last
 * committed a page (`savedAt`), not stepped by this read. Its step is what
 * the row now says: gone (no store), its key's first version (added), or
 * a later one (changed), keyed as the read that saved it keyed it
 * (`stepKeyOf`); only the read that commits records steps, so the Brain
 * keeps each once. Read while this read still holds the source, before its
 * commit gives the lease up: no row of a later page is saved by then. Only for
 * a replay: an ordinary page, a relist of what was committed long ago
 * among them, takes none.
 */
const replayedSteps = async (
  applying: Applying,
  page: SyncPage
): Promise<void> => {
  const { db, budget, source, readAt } = applying;
  if (!applying.replay) {
    return;
  }
  const since = source.lastSuccessAt?.getTime() ?? 0;
  spend(budget, 1);
  const saved = await db
    .select()
    .from(brainSyncItems)
    .where(
      sql`${itemsOfPlace(source)} AND ${brainSyncItems.savedAt} > ${since}`
    );
  const named = new Map(
    page.items.flatMap((item) => (item.gone ? [] : [[item.id, item] as const]))
  );
  for (const row of saved) {
    if (applying.stepped.has(row.itemId)) {
      continue;
    }
    const at = named.get(row.itemId);
    const when =
      at === undefined ? (row.savedAt ?? readAt) : changedOf(at, readAt);
    if (row.store === null) {
      // oxlint-disable-next-line no-await-in-loop -- a hash each, no call
      const left = await keyOf(
        row.connectionId,
        row.feed,
        row.itemId,
        row.generation - 1
      );
      // oxlint-disable-next-line no-await-in-loop -- a hash each, no call
      await stepped(
        applying,
        "removed",
        { key: left, change: "removed", version: null },
        row.itemId,
        when
      );
    } else if (row.change !== null) {
      // oxlint-disable-next-line no-await-in-loop -- a hash each, no call
      await stepped(
        applying,
        row.version === 1 ? "added" : "changed",
        { key: row.key, change: row.change, version: row.version },
        row.itemId,
        when
      );
    }
  }
};

/**
 * Moves the source's cursor past `page`, once it is applied, in one batch
 * with the page's one event (if it did anything): its counters reset,
 * the listing closed at its first page with nothing more, due again at
 * once while there is more, and its lease given up.
 */
const commit = async (applying: Applying, page: SyncPage): Promise<void> => {
  const { env, db, write, outbox, budget, source, counts } = applying;
  const now = Date.now();
  const cursorMoved =
    applying.stream === "changes"
      ? {
          cursor: page.cursor,
          listingOpen: source.listingOpen && page.more,
          dueAt: new Date(page.more ? now : now + pollMs),
        }
      : await relistMoved(applying, page, now);
  const moved = write
    .update(
      brainSyncSources,
      {
        ...cursorMoved,
        leaseId: null,
        leaseUntil: null,
        lastSuccessAt: new Date(now),
        added: 0,
        changed: 0,
        removed: 0,
        // Every erase this page owed is done (they ran before this); only a
        // removal still held for a move keeps it owed.
        leavesOwed: sql`EXISTS (SELECT 1 FROM ${brainSyncItems} WHERE ${brainSyncItems.connectionId} = ${source.connectionId} AND ${brainSyncItems.feed} = ${source.feed} AND ${brainSyncItems.place} = ${source.place} AND ${brainSyncItems.heldSince} IS NOT NULL)`,
      },
      sourceRowOf(source, source.place)
    )
    .returning({ leaseId: brainSyncSources.leaseId });
  const did = counts.added + counts.changed + counts.removed + applying.skipped;
  // Before the cursor moves, which gives up the lease that fences it.
  const fetched =
    applying.mode === "catchUp"
      ? write.delete(
          brainSyncCatchUps,
          sql`${brainSyncCatchUps.connectionId} = ${source.connectionId} AND ${brainSyncCatchUps.feed} = ${source.feed} AND ${brainSyncCatchUps.place} = ${source.place} AND ${inList(brainSyncCatchUps.itemId, coveredOf(applying, page))}`
        )
      : undefined;
  // The page's one event, only if the cursor moved (`changes()`).
  const event = outboxedEventWhere(
    outbox,
    appliedEvent(source, { ...counts, skipped: applying.skipped }),
    sql`changes() > 0`
  );
  // The steps an earlier read of this page left, while the lease that
  // keeps the next page from being read is still this read's.
  await replayedSteps(applying, page);
  spend(budget, 1);
  let committed: readonly unknown[];
  if (did === 0 && fetched === undefined) {
    [committed] = await db.batch([moved]);
  } else if (did === 0 && fetched !== undefined) {
    [, committed] = await db.batch([fetched, moved]);
  } else if (fetched === undefined) {
    [committed] = await auditedBatch(env, outbox, [moved, event]);
  } else {
    [, committed] = await auditedBatch(env, outbox, [fetched, moved, event]);
  }
  heldAfter(committed);
  await recordSteps(applying);
};

/**
 * Gives up `applying`'s source: its `stream` due again at `at`, its
 * cursors as they were or as `set` says, with when, if it names an
 * error.
 */
const release = async (
  applying: Pick<Applying, "write" | "source" | "stream">,
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
  await applying.write.update(
    brainSyncSources,
    {
      ...due,
      ...set,
      ...(set.lastError === undefined ? {} : { lastErrorAt: new Date() }),
      leaseId: null,
      leaseUntil: null,
    },
    sourceRowOf(applying.source, applying.source.place)
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
 * Whether a source's relist is past its day at `now`: the one under way
 * by when it was due to start, else the next by when it is due
 * (`overdueBy` in SQL).
 */
const relistLate = (now: number): SQL =>
  sql`CASE WHEN ${brainSyncSources.relisting} = 1 THEN coalesce(${brainSyncSources.relistSince}, ${brainSyncSources.relistAt}) ELSE ${brainSyncSources.relistAt} END < ${now - relistMs}`;

/**
 * How many sources' relists are past their day now, a dropped place's
 * left out (it is read no more): where it is not 0, a reader list can be
 * staler than a day. The staff's view of the Brain counts the same in
 * `syncForStaff`.
 */
export const overdueRelists = async (env: Pick<Env, "DB">): Promise<number> => {
  const row = await drizzle(env.DB)
    .select({ count: sql<number>`count(*)` })
    .from(brainSyncSources)
    .where(and(eq(brainSyncSources.dropped, false), relistLate(Date.now())))
    .get();
  return row?.count ?? 0;
};

/** Where a connection's sync stands, from its places' rows grouped. */
const phaseOf = ({
  listing,
  relisting,
}: {
  listing: number;
  relisting: number;
}): BrainSyncPhase => {
  if (listing === 1) {
    return "listing";
  }
  return relisting === 1 ? "relisting" : "changes";
};

/** A time a grouped read gave in milliseconds, as ISO 8601; null as null. */
const isoOf = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

/**
 * Native sync for the staff's view of the Brain (brain-report.ts,
 * GRA-1817): each synced connection, sync by sync, from its sources' rows
 * alone, never whose it is, its account, its places or anything it holds;
 * and how many sources' relists are past their day, counted over the same
 * rows. The connection is named by a hash of its ID; a dropped place
 * counts no more. Two reads, whatever the number of connections: the
 * sources, grouped, and how many items each holds in a store.
 */
export const syncForStaff = async (
  env: Pick<Env, "DB">
): Promise<{
  overdueRelists: number;
  connections: BrainSyncConnection[];
}> => {
  const db = drizzle(env.DB);
  const now = Date.now();
  const s = brainSyncSources;
  const place = sql`${s.place} <> ${placesListing}`;
  const latestError = (column: SQL) =>
    sql`(SELECT ${column} FROM ${brainSyncSources} AS e WHERE e.connection_id = ${s.connectionId} AND e.feed = ${s.feed} AND e.dropped = 0 AND e.last_error_at IS NOT NULL ORDER BY e.last_error_at DESC LIMIT 1)`;
  const [rows, held] = await Promise.all([
    db
      .select({
        connectionId: s.connectionId,
        feed: s.feed,
        provider: sql<string>`max(${s.provider})`,
        listing: sql<number>`max(${place} AND ${s.listingOpen})`,
        relisting: sql<number>`max(${s.relisting})`,
        syncedAt: sql<number | null>`max(${s.lastSuccessAt})`,
        // Missed by a run: due before the run a period ago.
        behindSince: sql<
          number | null
        >`min(CASE WHEN ${s.dueAt} < ${now - pollMs} THEN ${s.dueAt} END)`,
        relistsOverdue: sql<number>`sum(${relistLate(now)})`,
        failing: sql<number>`max(${s.lastErrorAt} IS NOT NULL AND (${s.lastSuccessAt} IS NULL OR ${s.lastErrorAt} > ${s.lastSuccessAt}))`,
        errorCode: sql<string | null>`${latestError(sql`e.last_error`)}`,
        errorAt: sql<number | null>`${latestError(sql`e.last_error_at`)}`,
      })
      .from(s)
      .where(eq(s.dropped, false))
      .groupBy(s.connectionId, s.feed)
      .all(),
    db
      .select({
        connectionId: brainSyncItems.connectionId,
        feed: brainSyncItems.feed,
        items: sql<number>`count(*)`,
      })
      .from(brainSyncItems)
      .where(isNotNull(brainSyncItems.store))
      .groupBy(brainSyncItems.connectionId, brainSyncItems.feed)
      .all(),
  ]);
  const itemsOf = new Map(
    held.map((row) => [`${row.connectionId}\n${row.feed}`, row.items])
  );
  const connections = await Promise.all(
    rows.map(async (row) => {
      const hash = await sha256Hex(row.connectionId);
      return {
        connection: hash.slice(0, 12),
        provider: row.provider,
        feed: row.feed,
        phase: phaseOf(row),
        items: itemsOf.get(`${row.connectionId}\n${row.feed}`) ?? 0,
        syncedAt: isoOf(row.syncedAt),
        behindSince: isoOf(row.behindSince),
        relistOverdue: row.relistsOverdue > 0,
        error:
          row.errorCode === null || row.errorAt === null
            ? null
            : { code: row.errorCode, at: new Date(row.errorAt).toISOString() },
        failing: row.failing === 1,
      };
    })
  );
  return {
    overdueRelists: rows.reduce((sum, row) => sum + row.relistsOverdue, 0),
    connections: connections.toSorted(
      (one, other) =>
        one.connection.localeCompare(other.connection) ||
        one.feed.localeCompare(other.feed)
    ),
  };
};

/**
 * Starts `applying`'s daily relist, unless a listing is under way already
 * (the first, or a restart's), which is one: then the relist waits for
 * its next day. A relist is a listing of its own number, from the start.
 * Whether it started.
 */
const startRelist = async (applying: Applying): Promise<boolean> => {
  const { db, write, budget, source } = applying;
  const now = Date.now();
  spend(budget, 1);
  if (source.listingOpen) {
    await release(applying, await nextRelistAt(source, now));
    return false;
  }
  // What an earlier relist left to fetch goes: one catch-up per relist.
  const [, [started]] = await db.batch([
    write.delete(
      brainSyncCatchUps,
      sql`${brainSyncCatchUps.connectionId} = ${source.connectionId} AND ${brainSyncCatchUps.feed} = ${source.feed} AND ${brainSyncCatchUps.place} = ${source.place}`
    ),
    write
      .update(
        brainSyncSources,
        {
          relisting: true,
          relistCatchUp: false,
          relistCursor: null,
          listing: source.listing + 1,
          relistSince: source.relistAt,
        },
        sourceRowOf(source, source.place)
      )
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
  const { write, budget, source } = applying;
  spend(budget, 1);
  heldAfter(
    await write
      .update(
        brainSyncSources,
        {
          ...(await endedRelist(source, Date.now())),
          leaseId: null,
          leaseUntil: null,
        },
        sourceRowOf(source, source.place)
      )
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
    outbox: db,
    write: pageWritesOf(db, source, leaseId),
    source,
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
    steps: [],
    stepped: new Set(),
    replay: source.added + source.changed + source.removed > 0,
  };
  // What earlier runs left owed needs only core and the Brain: done before
  // the read, so a source whose provider fails or whose connection waits
  // to be connected again still erases what it owes.
  await finishOwedLeaves(applying);
  if (source.leavesOwed) {
    await finishHeldRemovals(applying);
  }
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
  if (applying.mode === "names" && !namesOnly(page)) {
    applying.mode = "page";
  }
  await apply(applying, page);
  await commit(applying, page);
};

/**
 * The statement that keeps the source of `place` for the sync `of` names
 * (its connection's person, none for a shared connection, provider,
 * tenant, account and kind), unless a disconnect closed its connection
 * or its person's erasure began (a row
 * naming them, written after their erasure deleted theirs, would outlive
 * it): made from no cursor, or one dropped
 * before read again from the start; `seenIn`, the places listing that
 * named it last, for a sync that lists places.
 */
const sourceStatement = (
  insert: Writes["insert"],
  of: Pick<
    Source,
    | "connectionId"
    | "feed"
    | "personId"
    | "provider"
    | "tenant"
    | "account"
    | "kind"
  >,
  place: string,
  relistAt: number,
  now: number,
  seenIn: number | null = null
) =>
  insert(
    brainSyncSources,
    sql`SELECT ${of.connectionId}, ${of.feed}, ${place}, ${of.personId}, ${of.provider}, ${of.tenant}, ${of.account}, NULL, 1, 1, ${now}, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, 0, ${relistAt}, NULL, 0, ${of.kind}, 0, 0, ${seenIn}, NULL, NULL`,
    of.personId === null
      ? sql`NOT ${closed(of.connectionId)}`
      : sql`NOT ${closed(of.connectionId)} AND NOT ${erasureBegan(of.personId)}`
  ).onConflictDoUpdate({
    target: [
      brainSyncSources.connectionId,
      brainSyncSources.feed,
      brainSyncSources.place,
    ],
    set: {
      tenant: of.tenant,
      account: of.account,
      kind: of.kind,
      ...(seenIn === null ? {} : { seenIn }),
      dropped: false,
      // Listed again: the work changes meaning, and its token with it, so
      // nothing taken while it was dropped (its erase) writes on.
      leaseId: sql`CASE WHEN ${brainSyncSources.dropped} = 1 THEN NULL ELSE ${brainSyncSources.leaseId} END`,
      leaseUntil: sql`CASE WHEN ${brainSyncSources.dropped} = 1 THEN NULL ELSE ${brainSyncSources.leaseUntil} END`,
      cursor: sql`CASE WHEN ${brainSyncSources.dropped} = 1 THEN NULL ELSE ${brainSyncSources.cursor} END`,
      listing: sql`CASE WHEN ${brainSyncSources.dropped} = 1 THEN ${brainSyncSources.listing} + 1 ELSE ${brainSyncSources.listing} END`,
      listingOpen: sql`CASE WHEN ${brainSyncSources.dropped} = 1 THEN 1 ELSE ${brainSyncSources.listingOpen} END`,
    },
  });

/**
 * The syncs connect lists now, each kept here, a page of connections at
 * a time: a sync of the whole account as its one source (`own`); a sync
 * that lists places, or reads those picked on a shared connection, as the
 * row that lists them (`placesListing`), due at once when it is new. Its places are listed by that row in the queue
 * (`listPlaces`), never here: listing every mailbox's folders on every
 * run would leave no run for the pages.
 */
const refreshSources = async (
  env: Env,
  db: Database,
  budget: Budget
): Promise<void> => {
  // What connect lists is the registry of work, which taking a page of
  // it fences (`writesOf`): kept as it comes, not fenced by a token.
  const registered: Writes["insert"] = (table, select, where) =>
    db.insert(table).select(sql`${select} WHERE (${where ?? sql`1 = 1`})`);
  let after: string | null = null;
  do {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const page = await env.CONNECT.syncSources({ after });
    const now = Date.now();
    const statements = [];
    for (const listed of page.sources) {
      const of = { ...listed, personId: listed.ownerUserId };
      statements.push(
        listed.places === "own"
          ? sourceStatement(
              registered,
              of,
              ownPlace,
              // oxlint-disable-next-line no-await-in-loop -- a hash, no call
              await nextRelistAt({ ...listed, place: ownPlace }, now),
              now
            )
          : sourceStatement(registered, of, placesListing, never.getTime(), now)
      );
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

/**
 * Lists a sync's places, a read at a time, as work in the queue: the row
 * `listing` holds is the sync's places listing (`placesListing`), its
 * cursor where the listing goes on, its `listing` the listing's number.
 * Each read keeps a source for each place it names, marked as seen by
 * this listing; once the cursor ends, every place the listing didn't name
 * is dropped (read no more, its copies erased by the clock:
 * `completeDroppedPlaces`), and the next listing is due on the sync's
 * daily time, the relist's rhythm (`relistMs`, `nextRelistAt`): a folder
 * made or deleted is seen within a day, and at connect. A read that fails
 * changes nothing: tried again from the same cursor at the next run.
 */
const listPlaces = async (
  env: Env,
  db: Database,
  listing: Source,
  leaseId: string,
  budget: Budget
): Promise<void> => {
  const write = pageWritesOf(db, listing, leaseId);
  const applying = { write, source: listing, stream: "changes" as const };
  const number =
    listing.cursor === null ? listing.listing + 1 : listing.listing;
  spend(budget, 1);
  let read: SyncPlaces;
  try {
    read = await env.CONNECT.listSyncPlaces({
      connectionId: listing.connectionId,
      feed: listing.feed,
      cursor: listing.cursor,
    });
  } catch (error) {
    const code = syncErrors.codeOf(error);
    log.warn("brain.sync.places_failed", {
      connectionId: listing.connectionId,
      errorName: errorName(error),
    });
    spend(budget, 1);
    // The connector no longer knows the cursor (an expired folder-list
    // token): the listing starts over from no cursor at the next run,
    // under a new number, as a page read does. What the abandoned listing
    // named stays; only a listing that ends drops anything.
    await release(applying, Date.now() + pollMs, {
      lastError: code ?? "sync.failed",
      ...(code === "sync.restart" ? { cursor: null } : {}),
    });
    return;
  }
  const now = Date.now();
  const ended = read.cursor === null;
  // Each place's daily time first: a query returned from an async
  // function would run there and then, outside the batch.
  const relists = await Promise.all(
    read.places.map(
      async (place) => await nextRelistAt({ ...listing, place }, now)
    )
  );
  // Only while this run still holds the listing, in the statement that
  // keeps or drops (`writesOf`): a run that lost it changes nothing.
  const kept = read.places.map((place, index) =>
    sourceStatement(
      write.insert,
      listing,
      place,
      relists[index] ?? now + relistMs,
      now,
      number
    )
  );
  // What the listing no longer names, once it has ended: in the batch
  // that moves its cursor, before that gives up the lease the statement
  // checks.
  // The lease goes with it: a page of that place under way writes nothing
  // more (`stillHeld`).
  const drop = write.update(
    brainSyncSources,
    { dropped: true, leaseId: null, leaseUntil: null },
    sql`${brainSyncSources.connectionId} = ${listing.connectionId} AND ${brainSyncSources.feed} = ${listing.feed} AND ${brainSyncSources.place} <> ${placesListing} AND ${brainSyncSources.dropped} = 0 AND (${brainSyncSources.seenIn} IS NULL OR ${brainSyncSources.seenIn} < ${number})`
  );
  // The places first, then the cursor with what the listing drops: a run
  // stopped between the two reads the same places again, which changes
  // nothing.
  const [first, ...rest] = kept;
  if (first !== undefined) {
    spend(budget, 1);
    await db.batch([first, ...rest]);
  }
  const move = write
    .update(
      brainSyncSources,
      {
        cursor: read.cursor,
        listing: number,
        dueAt: new Date(ended ? await nextRelistAt(listing, now) : now),
        leaseId: null,
        leaseUntil: null,
        lastSuccessAt: new Date(now),
      },
      sourceRowOf(listing, placesListing)
    )
    .returning({ place: brainSyncSources.place });
  spend(budget, 1);
  if (ended) {
    const [, moved] = await db.batch([drop, move]);
    heldAfter(moved);
    return;
  }
  heldAfter(await move);
};

/**
 * The places listing of the shared connection's sync `of`, taken for the
 * work `token` names: the statement that takes it (its lease, from
 * whatever run held it, so a listing that read the picks before they
 * changed writes nothing more), and the statements fenced by it
 * (`writesOf`), for one batch, the take first: every place of the sync
 * that `keep` doesn't name dropped (read no more, out of its audience's
 * reach from the next read on: connection-audiences.ts
 * `sharedPlacesRead`; its copies erased by the clock,
 * `completeDroppedPlaces`), then the listing started again from nothing,
 * due now, its lease given up. Only a shared connection's (no person).
 * With `version`, the version of the picks `keep` is (connect's, one up
 * with each save): taken only for a version newer than the last one hid
 * for, which it records, so a save that lands late, after a newer one hid,
 * drops nothing.
 */
const droppedExcept = (
  db: Database,
  of: Pick<Source, "connectionId" | "feed">,
  keep: readonly string[],
  token: string,
  version?: number
) => {
  const now = Date.now();
  const write = writesOf({
    db,
    token,
    connectionId: of.connectionId,
    feed: of.feed,
    place: placesListing,
    dropped: false,
  });
  return [
    db
      .update(brainSyncSources)
      .set({
        leaseId: token,
        leaseUntil: new Date(now + leaseMs),
        ...(version === undefined ? {} : { picksVersion: version }),
      })
      .where(
        sql`${sourceRowOf(of, placesListing)} AND ${brainSyncSources.personId} IS NULL AND ${brainSyncSources.dropped} = 0
          AND ${version === undefined ? sql`1 = 1` : sql`coalesce(${brainSyncSources.picksVersion}, 0) < ${version}`}`
      ),
    write.update(
      brainSyncSources,
      { dropped: true, leaseId: null, leaseUntil: null },
      sql`${brainSyncSources.connectionId} = ${of.connectionId} AND ${brainSyncSources.feed} = ${of.feed} AND ${brainSyncSources.place} <> ${placesListing} AND ${brainSyncSources.dropped} = 0
        AND ${brainSyncSources.place} NOT IN (SELECT value FROM json_each(${JSON.stringify(keep)}))`
    ),
    write.update(
      brainSyncSources,
      { cursor: null, dueAt: new Date(now), leaseId: null, leaseUntil: null },
      sourceRowOf(of, placesListing)
    ),
  ] as const;
};

/**
 * Hides at once every place of the shared connection `connectionId`'s
 * sync `feed` that `picks` no longer names, once connect saved the
 * admin's picks (sync-picks.ts), before their save answers (GRA-1719), in
 * one batch (`droppedExcept`): from the next read on nobody is in an
 * un-picked place's group (brain-next.ts `withConnections`), and nothing
 * more is kept of it (a page's fence holds only while its place is not
 * dropped: `writesOf`); its copies are erased by the clock
 * (`completeDroppedPlaces`). The sync's places listing starts again, due
 * now, so a place picked now is read soon. Only for picks newer than the
 * last whose hide ran (`version`, connect's): an older save's hide that
 * lands late, after a newer one's, drops nothing the newer one picks.
 */
export const hideUnpickedPlaces = async (
  env: Pick<Env, "DB">,
  {
    connectionId,
    feed,
    picks,
    version,
  }: {
    connectionId: string;
    feed: string;
    picks: readonly string[];
    version: number;
  }
): Promise<void> => {
  const db = drizzle(env.DB);
  await db.batch(
    droppedExcept(
      db,
      { connectionId, feed },
      picks,
      crypto.randomUUID(),
      version
    )
  );
};

/**
 * Drops every place of each shared connection whose records an admin's
 * "Erase what the Brain kept" is erasing (shared-reads.ts, GRA-2066), as
 * an un-pick of all of them does (`droppedExcept`): the clock then erases
 * what they copied (`completeDroppedPlaces`), each copy counted in that
 * erasure, which ends only once none is left (shared-reads.ts `ended`).
 * The places stay picked: their listing starts again from nothing, due
 * now, and runs once an admin chooses an audience again (`claimNext`).
 * One batch per connection; again each run while the erasure is under
 * way, which changes nothing once its places are dropped.
 */
const dropErasedPlaces = async (
  db: Database,
  budget: Budget,
  token: string
): Promise<void> => {
  spend(budget, 1);
  const listings = await db
    .select({
      connectionId: brainSyncSources.connectionId,
      feed: brainSyncSources.feed,
    })
    .from(brainSyncSources)
    .where(
      sql`${brainSyncSources.place} = ${placesListing} AND ${brainSyncSources.personId} IS NULL
        AND EXISTS (SELECT 1 FROM ${connectionBrainErasures} WHERE ${connectionBrainErasures.connectionId} = ${brainSyncSources.connectionId} AND ${connectionBrainErasures.erasing} = 1)
        AND (${brainSyncSources.cursor} IS NOT NULL OR EXISTS (SELECT 1 FROM ${brainSyncSources} AS live WHERE live.connection_id = ${brainSyncSources.connectionId} AND live.feed = ${brainSyncSources.feed} AND live.place <> ${placesListing} AND live.dropped = 0))`
    );
  for (const of of listings) {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- one connection at a time
    await db.batch(droppedExcept(db, of, [], token));
  }
};

/** The readers `source`'s person's own store adds with, or the shared store's. */
const readersIn = (source: Source, store: Store): SourceReaders =>
  store === "own"
    ? { kind: "owner", personId: ownerOf(source) }
    : { kind: "none" };

/**
 * Takes the erase of `source`, a place no longer listed, for this run:
 * its row's lease, the token every statement of the erase is fenced by
 * (`writesOf`), unless another run holds it.
 */
const takeDroppedPlace = async (
  db: Database,
  budget: Budget,
  source: Source,
  leaseId: string
): Promise<Writes | undefined> => {
  const now = Date.now();
  spend(budget, 1);
  const [taken] = await db
    .update(brainSyncSources)
    .set({ leaseId, leaseUntil: new Date(now + leaseMs) })
    .where(
      sql`${sourceRowOf(source, source.place)} AND ${brainSyncSources.dropped} = 1 AND (${brainSyncSources.leaseUntil} IS NULL OR ${brainSyncSources.leaseUntil} <= ${now})`
    )
    .returning({ place: brainSyncSources.place });
  return taken === undefined
    ? undefined
    : writesOf({
        db,
        token: leaseId,
        connectionId: source.connectionId,
        feed: source.feed,
        place: source.place,
        dropped: true,
      });
};

/**
 * `completeDroppedPlaces` for one dropped source, which this run took
 * (`write`): each page of its rows begins with its lease renewed, so an
 * erase whose place was listed again, or which another run took over,
 * stops there, and every statement after is fenced by the same token.
 */
const eraseDroppedPlace = async (
  env: Env,
  db: Reads,
  write: Writes,
  budget: Budget,
  source: Source
): Promise<void> => {
  for (;;) {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const [still] = await write
      .update(
        brainSyncSources,
        { leaseUntil: new Date(Date.now() + leaseMs) },
        sourceRowOf(source, source.place)
      )
      .returning({ place: brainSyncSources.place });
    if (still === undefined) {
      return;
    }
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const rows = await db
      .select()
      .from(brainSyncItems)
      .where(itemsOfPlace(source))
      .orderBy(asc(brainSyncItems.itemId))
      .limit(erasedPerPage);
    if (rows.length === 0) {
      break;
    }
    const ids = rows.map(({ itemId }) => itemId);
    const erase = async (key: string, store: Store) => {
      spend(budget, store === "own" ? 2 : 1);
      await eraseSource(env, {
        source: sourceRefOf(key),
        readers: readersIn(source, store),
        reason: "deleted",
      });
    };
    // What a stopped run owed first: a key a row is leaving is no one's.
    for (const row of rows) {
      if (row.leaving !== null && row.leavingStore !== null) {
        // oxlint-disable-next-line no-await-in-loop -- within the budget
        await erase(row.leaving, row.leavingStore);
      }
    }
    // Then each key a row holds, taken from it (leaving, a generation on,
    // so a claim from an earlier read misses it) in a statement that
    // checks it is still in this place: one another place brought over
    // since the read keeps its key (`stillHere`).
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const taken = await write
      .update(
        brainSyncItems,
        {
          leaving: sql`${brainSyncItems.key}`,
          leavingStore: sql`${brainSyncItems.store}`,
          store: null,
          generation: sql`${brainSyncItems.generation} + 1`,
        },
        sql`${itemsOfPlace(source)} AND ${inList(brainSyncItems.itemId, ids)} AND ${brainSyncItems.store} IS NOT NULL`
      )
      .returning();
    for (const row of taken) {
      if (row.leaving !== null && row.leavingStore !== null) {
        // oxlint-disable-next-line no-await-in-loop -- within the budget
        await erase(row.leaving, row.leavingStore);
      }
    }
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    await db.batch([
      write.delete(
        brainSyncItems,
        sql`${itemsOfPlace(source)} AND ${inList(brainSyncItems.itemId, ids)} AND ${brainSyncItems.store} IS NULL`
      ),
      // Each copy erased of a shared connection whose records an admin's
      // erase is erasing (`dropErasedPlaces`) is one of the records that
      // erase reports. One of a place un-picked just before is too: it
      // was kept, and is erased while the erase is under way.
      write.update(
        connectionBrainErasures,
        { erased: sql`${connectionBrainErasures.erased} + ${taken.length}` },
        sql`${connectionBrainErasures.connectionId} = ${source.connectionId} AND ${connectionBrainErasures.erasing} = 1 AND ${source.personId === null ? sql`1 = 1` : sql`1 = 0`}`
      ),
    ]);
  }
  // What it noted to fetch, then the source itself, still under the same
  // token: listed again meanwhile, it stays.
  spend(budget, 1);
  await db.batch([
    write.delete(
      brainSyncCatchUps,
      sql`${brainSyncCatchUps.connectionId} = ${source.connectionId} AND ${brainSyncCatchUps.feed} = ${source.feed} AND ${brainSyncCatchUps.place} = ${source.place}`
    ),
    write.delete(brainSyncSources, sourceRowOf(source, source.place)),
  ]);
};

/**
 * Erases what each dropped source added (its place no longer listed: a
 * folder deleted), as a disconnect does for a connection, each taken by
 * this run first (`takeDroppedPlace`): each key it holds or was leaving
 * erased in its store, a page of rows at a time, the rows forgotten,
 * then, once none is left, what it noted to fetch and the source itself.
 * One that fails is given up, logged and tried again at the next run.
 */
const completeDroppedPlaces = async (
  env: Env,
  db: Database,
  budget: Budget,
  leaseId: string
): Promise<void> => {
  spend(budget, 1);
  const dropped = await db
    .select()
    .from(brainSyncSources)
    .where(eq(brainSyncSources.dropped, true));
  for (const source of dropped) {
    // oxlint-disable-next-line no-await-in-loop -- one source at a time
    const write = await takeDroppedPlace(db, budget, source, leaseId);
    if (write === undefined) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await eraseDroppedPlace(env, db, write, budget, source);
    } catch (error) {
      // Given up, never left held until its lease runs out.
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await write.update(
        brainSyncSources,
        { leaseId: null, leaseUntil: null },
        sourceRowOf(source, source.place)
      );
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
 * disconnect, another run holds it, or it is a shared connection's with
 * no audience (`audienced`: nothing is kept for nobody, so nothing is
 * read): this run's until `leaseMs` from
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
          AND (due.person_id IS NOT NULL OR (${audienced(sql`due.connection_id`)}))
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

/** A disconnect that stopped a native connection, for the sync's erasure. */
export interface SyncDisconnect {
  connectionId: string;
  /** Whose own connection it was; null for a shared one. */
  personId: string | null;
  /** Connect's `connection.disconnect` event's ID. */
  request: string;
  actor: AuditActor;
  at: Date;
}

/**
 * Closes the native connection a disconnect stopped for native sync, for
 * good, before connect's event leaves its outbox (capture-erasures.ts):
 * for a person's own, everything synced into their own store erased at
 * once, in one call (the connection's group, closed, so a late add in it
 * is refused); then, for a shared one too, in one batch, the connection closed here (nothing
 * named under it again), its sources gone, and the erasure of what it
 * synced into the shared store owed to the clock (`stepSyncErasure`). A
 * repeat of the same disconnect changes nothing. Throws when the Brain or
 * the database failed: the disconnect is held for the next drain.
 */
export const closeSyncOfDisconnect = async (
  env: Env,
  { connectionId, personId, request, actor, at }: SyncDisconnect
): Promise<void> => {
  // A shared connection put nothing in anyone's own store (`planOf`).
  const erased =
    personId === null
      ? 0
      : await eraseOwnGroup(env, {
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
 * Takes the erase a disconnect of `connectionId` owes for this run: its
 * row's lease, the token every statement of the erase is fenced by
 * (`writesOf`), unless another run holds it.
 */
const takeErasure = async (
  db: Database,
  budget: Budget,
  connectionId: string,
  leaseId: string
): Promise<Writes | undefined> => {
  const now = Date.now();
  spend(budget, 1);
  const [taken] = await db
    .update(brainSyncDisconnects)
    .set({ leaseId, leaseUntil: new Date(now + leaseMs) })
    .where(
      sql`${brainSyncDisconnects.connectionId} = ${connectionId} AND ${brainSyncDisconnects.erasing} = 1 AND (${brainSyncDisconnects.leaseUntil} IS NULL OR ${brainSyncDisconnects.leaseUntil} <= ${now})`
    )
    .returning({ connectionId: brainSyncDisconnects.connectionId });
  return taken === undefined
    ? undefined
    : writesOf({ db, token: leaseId, erasure: connectionId });
};

/**
 * Takes the erasure a disconnect of `connectionId` owes a step on, which
 * this run took (`write`), out of `budget`: each page begins with its
 * lease renewed, so an erase another run took over stops there; the keys
 * it gave the shared store erased and forgotten, a page at a time, and
 * once none is left, its rows forgotten and the erasure ended, with its
 * one event (`brain.sync.erased`, how many sources), in one batch, every
 * statement fenced by the same token. A step that fails leaves what it
 * erased forgotten; the next erases the rest, a key again without change.
 */
const stepSyncErasure = async (
  env: Env,
  db: Database,
  write: Writes,
  connectionId: string,
  budget: Budget
): Promise<void> => {
  const ofDisconnect = sql`${brainSyncDisconnects.connectionId} = ${connectionId}`;
  for (;;) {
    spend(budget, 1);
    // oxlint-disable-next-line no-await-in-loop -- a page at a time
    const [still] = await write
      .update(
        brainSyncDisconnects,
        { leaseUntil: new Date(Date.now() + leaseMs) },
        ofDisconnect
      )
      .returning({ connectionId: brainSyncDisconnects.connectionId });
    if (still === undefined) {
      return;
    }
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
      write.delete(
        brainSyncItems,
        sql`${brainSyncItems.connectionId} = ${connectionId} AND ${inList(
          brainSyncItems.key,
          page.map(({ key }) => key)
        )}`
      ),
      write.update(
        brainSyncDisconnects,
        { erased: sql`${brainSyncDisconnects.erased} + changes()` },
        ofDisconnect
      ),
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
    write.delete(
      brainSyncItems,
      sql`${brainSyncItems.connectionId} = ${connectionId}`
    ),
    write.update(
      brainSyncDisconnects,
      // Its event holds who disconnected: the row no longer needs to.
      { erasing: false, actor: null, leaseId: null, leaseUntil: null },
      ofDisconnect
    ),
    outboxedEventWhere(db, await erasedEvent(row), sql`changes() > 0`),
  ]);
};

/**
 * Takes every erasure a disconnect owes a step on (`stepSyncErasure`),
 * oldest first, each taken by this run first (`takeErasure`), out of
 * `budget`. One that fails is given up, logged with its connection and
 * its error's name, and tried again at the next run.
 */
const completeSyncErasures = async (
  env: Env,
  budget: Budget,
  leaseId: string
): Promise<void> => {
  const db = drizzle(env.DB);
  spend(budget, 1);
  const owed = await db
    .select({ connectionId: brainSyncDisconnects.connectionId })
    .from(brainSyncDisconnects)
    .where(eq(brainSyncDisconnects.erasing, true))
    .orderBy(asc(brainSyncDisconnects.requestedAt));
  for (const { connectionId } of owed) {
    // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
    const write = await takeErasure(db, budget, connectionId, leaseId);
    if (write === undefined) {
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await stepSyncErasure(env, db, write, connectionId, budget);
    } catch (error) {
      // Given up, never left held until its lease runs out.
      // oxlint-disable-next-line no-await-in-loop -- one erasure at a time
      await write.update(
        brainSyncDisconnects,
        { leaseId: null, leaseUntil: null },
        sql`${brainSyncDisconnects.connectionId} = ${connectionId}`
      );
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
    await completeSyncErasures(env, budget, leaseId);
    await refreshSources(env, db, budget);
    await dropErasedPlaces(db, budget, leaseId);
    await completeDroppedPlaces(env, db, budget, leaseId);
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      const claimed = await claimNext(db, budget, leaseId);
      if (claimed === undefined) {
        return;
      }
      const { source, stream } = claimed;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await (source.place === placesListing
          ? listPlaces(env, db, source, leaseId, budget)
          : syncPage(env, db, source, leaseId, budget, stream));
      } catch (error) {
        if (stoppedFor(error, "budget")) {
          log.info("brain.sync.budget_spent", {
            connectionId: source.connectionId,
          });
          // What was done is in its rows: the page is read again next run,
          // still due since when it was, so it keeps its turn.
          // oxlint-disable-next-line no-await-in-loop -- ends the run
          await release(
            { write: pageWritesOf(db, source, leaseId), source, stream },
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
        await release(
          { write: pageWritesOf(db, source, leaseId), source, stream },
          Date.now() + pollMs,
          {
            lastError: lost ? "sync.lost" : "sync.failed",
          }
        );
      }
    }
  } catch (error) {
    if (!stoppedFor(error, "budget")) {
      throw error;
    }
    // Spent before any page was claimed: what is owed waits for the next.
    log.info("brain.sync.budget_spent", {});
  }
};
