import type { ValueDescriptor } from "@grasp-os/sdk";
import { chunksOf, fileLimits } from "@grasp-os/shared/app-file-limits";
import type {
  FileDescription,
  FileType,
} from "@grasp-os/shared/app-file-limits";
import {
  beginUploadSchema,
  fileErrors,
  fileIdSchema,
  fileResourceSchema,
  sha256HexSchema,
} from "@grasp-os/shared/app-files";
import type { UploadState } from "@grasp-os/shared/app-files";
import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";
import { storeIdSchema } from "@grasp-os/shared/ids";
import type { StoreId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { StoreFields, WriterRoles } from "@grasp-os/shared/stores";
import { submissionErrors } from "@grasp-os/shared/submissions";
import {
  and,
  asc,
  eq,
  isNotNull,
  inArray,
  isNull,
  lte,
  gt,
  min,
  not,
  or,
  sql,
} from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  auditedBatch,
  outboxedEventWhere,
  storedEvent,
} from "./audit-outbox.ts";
import {
  fileChunks,
  fileDeleteKeys,
  fileEvents,
  fileRefs,
  files,
  fileWrites,
} from "./db/data-store/schema.ts";
import { recordFiles } from "./store-references.ts";

// An App's files, as its store keeps them (spec 9.6, 10.7.5): the record
// of each upload in the store's own SQLite, next to the records that hold
// it, and its bytes in the deployment's private R2 (EU jurisdiction), in
// chunks under the store's prefix. Core's file channel (app-file-route.ts)
// moves the bytes and asks this host, in the store's Durable Object,
// everything else. Threat model, and how each is closed:
//
// - An upload reaches another person or App: a file is the store's, and
//   one store is one App's (its release names it, nothing a caller sends
//   does). While no record holds it, only its uploader reads, finishes,
//   cancels or attaches it; once one does, everyone, its uploader too,
//   reads it only through a record they may read now. Uploading grants no
//   record visibility.
// - A file is read through a guessed, replayed or forged reference: an ID
//   is a random UUID and grants nothing. Every read is decided now, from
//   the reader's current roles, through the resource the file was
//   uploaded through. Missing, deleted, someone else's and unreadable
//   answer the same `file.not_found`. No URL carries the right to read:
//   the channel takes the person's session and their screen's lease on
//   every request.
// - A record holds a file its writer may not use: a commit that adds a
//   file to a record checks it is published, the writer's own upload, and
//   uploaded through a resource that declares `attach` (`index`), in the
//   commit's transaction; a file the record held already stays held,
//   whoever writes the record now. A call's arguments are checked the
//   same way before it runs (`usable`), so a mutation that returns early
//   can't acknowledge one either.
// - Size, type and content abuse: an upload declares its size, type and
//   SHA-256 before any byte, each bounded (`beginUploadSchema`); each
//   chunk is exactly the size its place says, checked against its own
//   hash; the whole is checked at the end against the declared hash and
//   its bytes against its type (the route's `verify`), and published only
//   then. One person has a bounded number of uploads open, of finished
//   files no record holds, and of bytes, and a store a bounded number of
//   bytes (`begin`).
// - Verified bytes replaced after their check: every chunk write has an R2
//   key of its own, recorded once with its hash (`chunkStored`); what is
//   checked and served is what was recorded, and a write that lost removes
//   only its own object, never one another write recorded.
// - An orphan after a failed upload or commit: an upload not finished in
//   time expires, and a published file no record holds expires after the
//   orphan retention (`expiresAt`, the cleanup intent, set and cleared in
//   the transactions that change what holds it). The alarm deletes only
//   what is expired and, checked again in its own transaction, still
//   held by nothing; so a stale cleanup deletes nothing, and no caller
//   names what it deletes.
// - A deletion leaves readable copies: a deleted file is a tombstone at
//   once, which every read checks, chunk by chunk; its bytes are removed
//   after (`sweep`), once any chunk write admitted before the deletion has
//   landed (`purgeGraceMs`). A file a record holds can't be deleted
//   (`file.referenced`). A deleted store's purge removes its prefix.
// - A file outlives its record or retention: deleting or changing a
//   record drops what it held in its commit; what nothing holds then
//   expires as above. Bytes already delivered to a browser can't be
//   recalled; nothing more is delivered after the tombstone.
// - Nobody can tell afterwards who did what: a publication, a deletion by
//   its uploader and a deletion by the platform (expiry, orphan cleanup,
//   rejection) each write an audit event in the transaction that does it
//   (`sdk_file_events`), handed to core's audit outbox after
//   (`flushEvents`). Downloads by anyone but the uploader are audited by
//   the channel; rejections, purges and limit refusals are logged.

/** Where a store's files' bytes are in R2. */
export const filesPrefix = (storeId: StoreId): string =>
  `app-files/${storeId}/`;

/**
 * How long a deleted file's bytes are kept: a chunk write admitted just
 * before the deletion lands within it, so nothing written then outlives
 * the purge.
 */
export const purgeGraceMs = 2 * 60_000;

/**
 * How long after its key was handed out a chunk write's object might
 * still land: a request of core's ends well within it. Until then the
 * alarm removes an unrecorded object again at each sweep.
 */
const writeLifetimeMs = 60 * 60_000;

/**
 * How long one finish's check of an upload's bytes holds the upload's
 * claim (`publishable`), at most: another finish meanwhile waits for it
 * rather than reading and hashing the whole file again. A check that
 * never reports back (its request died) lets the next one claim it then.
 */
export const finishClaimMs = 2 * 60_000;

/** One finish's claim on an upload: until when, and settled when it ends. */
interface FinishClaim {
  readonly until: number;
  readonly ended: Promise<null>;
  readonly end: () => void;
}

/** How often a file's readability is checked when its holders keep changing. */
const readableAttempts = 3;

/** A file's holders as one text, whatever order they were read in. */
const holdersKey = (
  holders: readonly { tableId: string; recordId: string }[]
): string =>
  holders
    .map(({ tableId, recordId }) => `${tableId}/${recordId}`)
    .toSorted()
    .join("\n");

/** Whether two reads of a file's holders found the same records. */
const sameHolders = (
  one: readonly { tableId: string; recordId: string }[],
  other: readonly { tableId: string; recordId: string }[]
): boolean => holdersKey(one) === holdersKey(other);

/** Files the alarm deletes or purges per transaction. */
const sweepPage = 50;

/** Audit events handed to core per hand-over. */
const eventsPage = 50;

/**
 * Holders read to decide a reader may read a file through a record. It
 * fails closed: a reader who could read only a record past these is
 * refused, never let through.
 */
const holdersRead = 50;

/** The longest file name an audit event carries. */
const nameInEvent = 200;

/** Who reads, as core resolved them, and the schema their App reads under. */
export interface FileReader {
  readonly principal: string;
  readonly roles: WriterRoles;
  readonly schemaHash: string;
}

/** A record holding a file. */
export interface FileHolder {
  readonly tableId: string;
  readonly recordId: string;
}

/** What the host needs of the store it keeps files for. */
export interface FileStoreAccess {
  /** Holds the object to `storeId`, refusing a store it doesn't hold. */
  readonly bind: (storeId: StoreId) => void;
  /** Whether `reader` may read any of `holders` now. */
  readonly readable: (
    reader: FileReader,
    holders: readonly FileHolder[]
  ) => Promise<boolean>;
}

/** A staged record, as a commit writes it. */
export interface FileStaged {
  readonly table: string;
  readonly tableId: string;
  readonly recordId: string;
  readonly fields: StoreFields | null;
}

/** One recorded chunk: its R2 object and the hash it was recorded with. */
export interface RecordedChunk {
  readonly key: string;
  readonly sha256: string;
}

/** A published file, as a reader reads it. */
export interface FileContent extends FileDescription {
  /** Who uploaded it. */
  readonly ownerId: string;
  /** Its chunks, in order. */
  readonly chunks: readonly RecordedChunk[];
}

/** An upload all of whose chunks arrived: what its check reads. */
export interface Publishable {
  readonly chunks: readonly RecordedChunk[];
  readonly size: number;
  readonly sha256: string;
  readonly mimeType: FileType;
}

type FileRow = typeof files.$inferSelect;

/**
 * A file's lifecycle, and the only moves `#move` makes: an upload is
 * `uploading` (open, its chunks arriving) until its check publishes it,
 * or it is cancelled, rejected by its check, or expires; a `published`
 * file is held or not by records (`sdk_file_refs`, its `expiresAt` the
 * cleanup intent while it isn't), until its uploader deletes it or, held
 * by nothing past the orphan retention, the alarm does; `deleted` is a
 * tombstone for good, its bytes then purged (`purgedAt`).
 */
const lifecycle = {
  uploading: ["published", "cancelled", "rejected", "expired"],
  published: ["deleted", "orphaned"],
  deleted: [],
} as const satisfies Record<FileRow["state"], readonly string[]>;

/** A move along the lifecycle. */
type Move =
  | { readonly state: "published" }
  | {
      readonly state: "deleted";
      readonly how: NonNullable<FileRow["deletedHow"]>;
    };

const notFound = () => fileErrors.create("file.not_found");

/** The size chunk `index` of a file of `size` bytes has. */
const chunkSize = (size: number, index: number): number =>
  index < chunksOf(size) - 1
    ? fileLimits.chunkBytes
    : size - fileLimits.chunkBytes * (chunksOf(size) - 1);

const ids = (fileId: unknown, resource: unknown) => ({
  fileId: fileErrors.parse("file.not_found", fileIdSchema, fileId),
  resource: fileErrors.parse("file.invalid", fileResourceSchema, resource),
});

/**
 * How a chunk's write was recorded (`FileHost.chunkStored`): its own, the
 * same bytes another write recorded first, other bytes recorded first,
 * not at all since the write took too long to settle and the alarm took
 * it for one that never would (the upload still open, so the chunk is
 * sent again), or not at all since the upload ended (or the store is
 * gone).
 */
export type ChunkRecord =
  | "recorded"
  | "held"
  | "mismatch"
  | "expired"
  | "ended";

/** `row`'s type: written only from `beginUploadSchema`'s. */
const typeOf = (row: FileRow): FileType =>
  // SAFETY: written only from `beginUploadSchema`'s type.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  row.mimeType as FileType;

export class FileHost {
  readonly #storage: DurableObjectStorage;
  readonly #env: Env;
  readonly #db: DrizzleSqliteDODatabase;
  readonly #store: FileStoreAccess;
  /** The uploads a finish is checking now, by file: one check at a time. */
  readonly #finishing = new Map<string, FinishClaim>();

  constructor(
    storage: DurableObjectStorage,
    env: Env,
    db: DrizzleSqliteDODatabase,
    store: FileStoreAccess
  ) {
    this.#storage = storage;
    this.#env = env;
    this.#db = db;
    this.#store = store;
  }

  /** The row of `fileId`, if any. */
  #row(fileId: string): FileRow | undefined {
    return this.#db.select().from(files).where(eq(files.fileId, fileId)).get();
  }

  /** The chunks of `fileId` recorded, in order. */
  #chunks(fileId: string): (RecordedChunk & { index: number })[] {
    return this.#db
      .select({
        index: fileChunks.index,
        key: fileChunks.key,
        sha256: fileChunks.sha256,
      })
      .from(fileChunks)
      .where(eq(fileChunks.fileId, fileId))
      .orderBy(asc(fileChunks.index))
      .all();
  }

  /** Whether a record holds `fileId`. */
  #held(fileId: string): boolean {
    return (
      this.#db
        .select({ fileId: fileRefs.fileId })
        .from(fileRefs)
        .where(eq(fileRefs.fileId, fileId))
        .get() !== undefined
    );
  }

  /**
   * Records an audit event about `row`, `action` by `actor`, in the
   * transaction the caller runs: handed to core after (`flushEvents`).
   */
  #event(
    action: string,
    actor: AuditActor,
    row: FileRow,
    detail: Record<string, string | number | null> = {}
  ): void {
    const now = Date.now();
    const event: AuditEvent = auditEventSchema.parse({
      id: crypto.randomUUID(),
      at: new Date(now).toISOString(),
      source: "core",
      actor,
      action,
      target: { type: "file", id: row.fileId },
      detail: {
        store: this.#storeId(),
        resource: row.resource,
        uploadedBy: row.ownerId,
        name: row.name.slice(0, nameInEvent),
        type: row.mimeType,
        size: row.size,
        sha256: row.sha256,
        ...detail,
      },
    });
    this.#db
      .insert(fileEvents)
      .values({ id: event.id, event: JSON.stringify(event), createdAt: now })
      .run();
  }

  /** The ID of the store this object holds. */
  #storeId(): string {
    return this.#storage.sql
      .exec<{ id: string }>("SELECT store_id AS id FROM sdk_store")
      .one().id;
  }

  /**
   * Moves `row` along its lifecycle, the one place a file's state changes
   * (`lifecycle`): published, with its orphan expiry and audit event, or
   * deleted `how`, a tombstone with its bytes due for purging and its
   * audit event. Anything else is refused as the bug it would be. Called
   * inside the transaction that decides the move.
   */
  #move(row: FileRow, to: Move): FileRow {
    const allowed: readonly string[] = lifecycle[row.state];
    const how = to.state === "deleted" ? to.how : "published";
    if (!allowed.includes(how)) {
      throw new Error(`A ${row.state} file can't move to ${how}`);
    }
    const now = Date.now();
    const moved: FileRow =
      to.state === "published"
        ? {
            ...row,
            state: "published",
            publishedAt: now,
            expiresAt: now + fileLimits.orphanMs,
          }
        : {
            ...row,
            state: "deleted",
            deletedAt: now,
            deletedHow: to.how,
            expiresAt: null,
          };
    this.#db
      .update(files)
      .set({
        state: moved.state,
        publishedAt: moved.publishedAt,
        deletedAt: moved.deletedAt,
        deletedHow: moved.deletedHow,
        expiresAt: moved.expiresAt,
      })
      .where(and(eq(files.fileId, row.fileId), eq(files.state, row.state)))
      .run();
    if (to.state === "published") {
      this.#event(
        "file.published",
        { type: "person", userId: row.ownerId },
        moved
      );
    } else if (to.how === "deleted") {
      this.#event(
        "file.deleted",
        { type: "person", userId: row.ownerId },
        moved
      );
    } else if (to.how !== "cancelled") {
      // A cancelled upload was never a file anyone could read: nothing to
      // audit. Every other deletion is: its uploader's, or the platform's.
      this.#event("file.deleted", { type: "system" }, moved, { how: to.how });
    }
    return moved;
  }

  /**
   * The upload `fileId` of `principal` through `resource`, its time
   * checked: one past it is refused as expired.
   */
  #ownUpload(
    storeId: StoreId,
    principal: string,
    fileId: unknown,
    resource: unknown
  ): FileRow {
    const checked = ids(fileId, resource);
    this.#store.bind(storeIdSchema.parse(storeId));
    const row = this.#row(checked.fileId);
    if (
      row === undefined ||
      row.ownerId !== principal ||
      row.resource !== checked.resource
    ) {
      throw notFound();
    }
    if (row.state === "deleted") {
      if (row.deletedHow === "expired") {
        throw fileErrors.create("file.upload_expired");
      }
      if (row.deletedHow === "cancelled") {
        return row;
      }
      throw notFound();
    }
    // Past its time: refused, and deleted by the alarm (`sweep`), as a
    // deletion written here would be undone with the refusal.
    if (
      row.state === "uploading" &&
      row.expiresAt !== null &&
      row.expiresAt <= Date.now()
    ) {
      throw fileErrors.create("file.upload_expired");
    }
    return row;
  }

  #stateOf(row: FileRow): UploadState {
    return {
      file: row.fileId,
      state: row.state === "deleted" ? "cancelled" : row.state,
      chunkBytes: fileLimits.chunkBytes,
      received:
        row.state === "uploading"
          ? this.#chunks(row.fileId).map(({ index }) => index)
          : [],
    };
  }

  /**
   * Refuses an upload of `size` more bytes for `principal` past what a
   * person or the store may hold (see the header): uploads open,
   * finished files no record holds, the person's bytes and the store's.
   */
  #withinQuotas(principal: string, size: number, now: number): void {
    const [counted] = this.#db
      .select({
        open: sql<number>`coalesce(sum(${files.ownerId} = ${principal} AND ${files.state} = 'uploading' AND ${files.expiresAt} > ${now}), 0)`,
        // An open upload holds its slot among the unattached files it may
        // become, so uploads started at once can't publish past the limit.
        unattached: sql<number>`coalesce(sum(${files.ownerId} = ${principal} AND ((${files.state} = 'published' AND ${files.expiresAt} IS NOT NULL) OR (${files.state} = 'uploading' AND ${files.expiresAt} > ${now}))), 0)`,
        personBytes: sql<number>`coalesce(sum(CASE WHEN ${files.ownerId} = ${principal} THEN ${files.size} ELSE 0 END), 0)`,
        storeBytes: sql<number>`coalesce(sum(${files.size}), 0)`,
      })
      .from(files)
      // Written as the live-files index's condition is, a literal, so the
      // count reads that index and never the tombstones.
      .where(sql`${files.state} <> 'deleted'`)
      .all();
    let refusal:
      | "file.uploads_open"
      | "file.unattached_limit"
      | "file.quota_exceeded"
      | undefined;
    if ((counted?.open ?? 0) >= fileLimits.openUploads) {
      refusal = "file.uploads_open";
    } else if ((counted?.unattached ?? 0) >= fileLimits.unattachedPerPerson) {
      refusal = "file.unattached_limit";
    } else if (
      (counted?.personBytes ?? 0) + size > fileLimits.personBytes ||
      (counted?.storeBytes ?? 0) + size > fileLimits.storeBytes
    ) {
      refusal = "file.quota_exceeded";
    }
    if (refusal !== undefined) {
      // One line per refused start, which the browser request budget
      // bounds: for whoever reviews what a person tried.
      log.warn("app_file.limit_refused", {
        store: this.#storeId(),
        principal,
        code: refusal,
      });
      throw fileErrors.create(refusal);
    }
  }

  /**
   * Starts an upload for `principal` through `resource`: its name, type,
   * size and hash, each checked before any byte (`beginUploadSchema`),
   * past which nothing arrives, within the quotas (`#withinQuotas`). Its
   * `key`, the page's for this one upload, makes a start sent again after
   * a lost answer the same upload: answered as it is now, never a second
   * one; the same key with another declaration is `submission.key_conflict`.
   */
  begin(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    input: unknown
  ): UploadState {
    const alias = fileErrors.parse(
      "file.invalid",
      fileResourceSchema,
      resource
    );
    const declared = fileErrors.parse("file.invalid", beginUploadSchema, input);
    return this.#storage.transactionSync(() => {
      this.#store.bind(storeIdSchema.parse(storeId));
      const begun = this.#db
        .select()
        .from(files)
        .where(
          and(eq(files.ownerId, principal), eq(files.beginKey, declared.key))
        )
        .get();
      if (begun !== undefined) {
        const same =
          begun.resource === alias &&
          begun.name === declared.name &&
          begun.mimeType === declared.type &&
          begun.size === declared.size &&
          begun.sha256 === declared.sha256;
        if (!same) {
          throw submissionErrors.create("submission.key_conflict");
        }
        // Past its time, deleted for it or not yet: expired, as its status
        // says, never an upload to resume.
        const expired =
          (begun.state === "deleted" && begun.deletedHow === "expired") ||
          (begun.state === "uploading" &&
            begun.expiresAt !== null &&
            begun.expiresAt <= Date.now());
        if (expired) {
          throw fileErrors.create("file.upload_expired");
        }
        return this.#stateOf(begun);
      }
      const now = Date.now();
      this.#withinQuotas(principal, declared.size, now);
      const row: FileRow = {
        fileId: crypto.randomUUID(),
        resource: alias,
        ownerId: principal,
        name: declared.name,
        mimeType: declared.type,
        size: declared.size,
        sha256: declared.sha256,
        state: "uploading",
        createdAt: now,
        publishedAt: null,
        deletedAt: null,
        deletedHow: null,
        beginKey: declared.key,
        expiresAt: now + fileLimits.uploadMs,
        purgedAt: null,
      };
      this.#db.insert(files).values(row).run();
      return this.#stateOf(row);
    });
  }

  /** Where `principal`'s upload `fileId` is: what to send again to resume it. */
  status(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    fileId: unknown
  ): UploadState {
    return this.#storage.transactionSync(() =>
      this.#stateOf(this.#ownUpload(storeId, principal, fileId, resource))
    );
  }

  /**
   * Admits chunk `index` of `principal`'s upload `fileId`, `size` bytes:
   * answers a key in R2 of this write's own, never one any other write
   * gets, or null when the chunk is recorded already (sent again after a
   * lost answer). Refused unless the upload is open, the index is one of
   * its chunks and the size exactly that chunk's.
   */
  admitChunk(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    fileId: unknown,
    index: number,
    size: number,
    sha256?: string
  ): string | null {
    return this.#storage.transactionSync(() => {
      const row = this.#ownUpload(storeId, principal, fileId, resource);
      if (row.state !== "uploading") {
        throw fileErrors.create("file.cancelled");
      }
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= chunksOf(row.size) ||
        size !== chunkSize(row.size, index)
      ) {
        throw fileErrors.create("file.content_mismatch");
      }
      const held = this.#db
        .select({ index: fileChunks.index, sha256: fileChunks.sha256 })
        .from(fileChunks)
        .where(
          and(eq(fileChunks.fileId, row.fileId), eq(fileChunks.index, index))
        )
        .get();
      if (held !== undefined) {
        // Held already: kept only if these are the bytes it holds.
        if (sha256 !== undefined && held.sha256 !== sha256) {
          throw fileErrors.create("file.content_mismatch");
        }
        return null;
      }
      const key = `${filesPrefix(storeIdSchema.parse(storeId))}${row.fileId}/${index}.${crypto.randomUUID()}`;
      // Kept until the write settles, for the alarm should it never.
      this.#db
        .insert(fileWrites)
        .values({ key, fileId: row.fileId, issuedAt: Date.now() })
        .run();
      return key;
    });
  }

  /**
   * Records chunk `index` of `fileId` as stored at `key`, with its hash,
   * and says how that went (`ChunkRecord`): `recorded` if this write is
   * the chunk's from now on. Otherwise its writer removes its own object,
   * which nothing else names: `held` when another write recorded the same
   * bytes first (a chunk sent again after its answer was lost, while the
   * first still ran), `mismatch` when it recorded other bytes, `expired`
   * when the alarm took this write for one that never settled while the
   * upload is still open, `ended` when the upload ended meanwhile, isn't
   * theirs, or the store is gone.
   */
  chunkStored(
    storeId: StoreId,
    principal: string,
    fileId: string,
    index: number,
    size: number,
    sha256: string,
    key: string
  ): ChunkRecord {
    sha256HexSchema.parse(sha256);
    try {
      return this.#storage.transactionSync(() => {
        this.#store.bind(storeIdSchema.parse(storeId));
        const row = this.#row(fileId);
        // One the alarm condemned is removing its object: never recorded.
        // Its row stays until the chunk is recorded under its key: a key
        // a writer must remove itself is removed by the alarm should its
        // writer not get to it.
        const issued = this.#db
          .select({ condemned: fileWrites.condemned })
          .from(fileWrites)
          .where(eq(fileWrites.key, key))
          .get();
        if (
          row?.state !== "uploading" ||
          row.ownerId !== principal ||
          !key.startsWith(
            `${filesPrefix(storeIdSchema.parse(storeId))}${fileId}/${index}.`
          )
        ) {
          return "ended";
        }
        // Too slow to settle, though its upload is still open: the chunk
        // is the writer's to send again, under a write of its own.
        if (issued === undefined || issued.condemned) {
          return "expired";
        }
        const recorded = this.#db
          .insert(fileChunks)
          .values({ fileId, index, size, sha256, key })
          .onConflictDoNothing()
          .returning({ key: fileChunks.key })
          .get();
        if (recorded?.key === key) {
          this.#db.delete(fileWrites).where(eq(fileWrites.key, key)).run();
          return "recorded";
        }
        const first = this.#db
          .select({ sha256: fileChunks.sha256 })
          .from(fileChunks)
          .where(
            and(eq(fileChunks.fileId, fileId), eq(fileChunks.index, index))
          )
          .get();
        return first?.sha256 === sha256 ? "held" : "mismatch";
      });
    } catch (error) {
      // A store deleted or unbound meanwhile: not recorded, so removed.
      log.warn("app_file.chunk_unrecorded", errorFields(error));
      return "ended";
    }
  }

  /**
   * The key recorded for chunk `index` of `principal`'s upload `fileId`,
   * or null when none is: what a writer whose `chunkStored` answer was
   * lost asks before it removes its object, which it may do only when
   * the chunk isn't recorded under that object's key.
   */
  chunkKey(
    storeId: StoreId,
    principal: string,
    fileId: string,
    index: number
  ): string | null {
    return this.#storage.transactionSync(() => {
      this.#store.bind(storeIdSchema.parse(storeId));
      const row = this.#row(fileId);
      if (row?.ownerId !== principal) {
        return null;
      }
      const recorded = this.#db
        .select({ key: fileChunks.key })
        .from(fileChunks)
        .where(and(eq(fileChunks.fileId, fileId), eq(fileChunks.index, index)))
        .get();
      return recorded?.key ?? null;
    });
  }

  /**
   * `principal`'s upload `fileId`, all of whose chunks arrived, for its
   * check, claimed for it until `publish` (or `finishClaimMs`); or its
   * state when it is published already (a finish sent again).
   * `file.incomplete` while a chunk is missing. While another finish's
   * check holds the claim, this one waits for it to end, then answers as
   * the upload is then: a finish sent again after a lost answer reads and
   * hashes the file no second time.
   */
  async publishable(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    fileId: unknown
  ): Promise<Publishable | UploadState> {
    for (;;) {
      const now = Date.now();
      const found = this.#storage.transactionSync(
        (): Publishable | UploadState | FinishClaim => {
          const row = this.#ownUpload(storeId, principal, fileId, resource);
          if (row.state !== "uploading") {
            return this.#stateOf(row);
          }
          const chunks = this.#chunks(row.fileId);
          if (chunks.length !== chunksOf(row.size)) {
            throw fileErrors.create("file.incomplete");
          }
          const claim = this.#finishing.get(row.fileId);
          if (claim !== undefined && claim.until > now) {
            return claim;
          }
          const { promise: ended, resolve } = Promise.withResolvers<null>();
          this.#finishing.set(row.fileId, {
            until: now + finishClaimMs,
            ended,
            end: () => {
              resolve(null);
            },
          });
          return {
            chunks: chunks.map(({ key, sha256 }) => ({ key, sha256 })),
            size: row.size,
            sha256: row.sha256,
            mimeType: typeOf(row),
          };
        }
      );
      if (!("ended" in found)) {
        return found;
      }
      // oxlint-disable-next-line no-await-in-loop -- until the check ends, then looked at again
      await Promise.race([found.ended, scheduler.wait(found.until - now)]);
    }
  }

  /**
   * Ends the claim of `principal`'s finish on upload `fileId` whose check
   * failed before it could say (R2 out, say), so the next finish checks
   * at once rather than at the claim's end.
   */
  abandonFinish(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    fileId: unknown
  ): void {
    const row = this.#storage.transactionSync(() =>
      this.#ownUpload(storeId, principal, fileId, resource)
    );
    this.#endClaim(row.fileId);
  }

  /** Ends the claim of a finish on `fileId`, letting any waiting one go on. */
  #endClaim(fileId: string): void {
    const claim = this.#finishing.get(fileId);
    this.#finishing.delete(fileId);
    claim?.end();
  }

  /**
   * Publishes `principal`'s upload `fileId` once its check passed
   * (`verified`), or deletes it as rejected when it didn't. A cancellation
   * that came first wins (`file.cancelled`); a publication that came first
   * is answered again. A published file expires as an orphan until a
   * record holds it.
   */
  publish(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    fileId: unknown,
    verified: boolean
  ): UploadState {
    // Whatever it answers, this finish's check is over.
    try {
      return this.#published(storeId, principal, resource, fileId, verified);
    } finally {
      if (typeof fileId === "string") {
        this.#endClaim(fileId);
      }
    }
  }

  /** `publish`, its claim apart. */
  #published(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    fileId: unknown,
    verified: boolean
  ): UploadState {
    // A rejection is written, then refused once its transaction committed:
    // thrown inside, it would undo the deletion it refuses with.
    const state = this.#storage.transactionSync((): UploadState | null => {
      const row = this.#ownUpload(storeId, principal, fileId, resource);
      if (row.state === "deleted") {
        throw fileErrors.create("file.cancelled");
      }
      if (row.state === "published") {
        return this.#stateOf(row);
      }
      if (!verified) {
        log.warn("app_file.rejected", {
          store: this.#storeId(),
          file: row.fileId,
          principal,
          type: row.mimeType,
        });
        this.#move(row, { state: "deleted", how: "rejected" });
        return null;
      }
      return this.#stateOf(this.#move(row, { state: "published" }));
    });
    if (state === null) {
      throw fileErrors.create("file.content_mismatch");
    }
    return state;
  }

  /**
   * Cancels `principal`'s upload `fileId`: one still uploading is deleted
   * as cancelled; one published first is answered as published, which the
   * uploader then has (spec 10.7.5: finalization won).
   */
  cancel(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    fileId: unknown
  ): UploadState {
    return this.#storage.transactionSync(() => {
      const row = this.#ownUpload(storeId, principal, fileId, resource);
      if (row.state === "uploading") {
        return this.#stateOf(
          this.#move(row, { state: "deleted", how: "cancelled" })
        );
      }
      return this.#stateOf(row);
    });
  }

  /**
   * Whether `reader` may read published file `row` now: their own upload
   * while no record holds it; once one does, only through a record they
   * may read, as anyone else.
   */
  async #readable(reader: FileReader, row: FileRow): Promise<boolean> {
    // The holders a page at a time, in a fixed order, after `after`: every
    // record holding it is looked at, however many there are.
    const pageAfter = (after?: FileHolder) =>
      this.#db
        .select({ tableId: fileRefs.tableId, recordId: fileRefs.recordId })
        .from(fileRefs)
        .where(
          and(
            eq(fileRefs.fileId, row.fileId),
            after === undefined
              ? undefined
              : or(
                  gt(fileRefs.tableId, after.tableId),
                  and(
                    eq(fileRefs.tableId, after.tableId),
                    gt(fileRefs.recordId, after.recordId)
                  )
                )
          )
        )
        .orderBy(asc(fileRefs.tableId), asc(fileRefs.recordId))
        .limit(holdersRead)
        .all();
    // Each page looked at again once the records' check answered: a
    // commit meanwhile that moved the file to other records is checked
    // afresh, never answered for the holders it had before.
    for (let attempt = 0; attempt < readableAttempts; attempt += 1) {
      let after: FileHolder | undefined;
      let held = false;
      let changed = false;
      for (;;) {
        const page = pageAfter(after);
        if (page.length === 0) {
          break;
        }
        held = true;
        // oxlint-disable-next-line no-await-in-loop -- page after page
        const readable = await this.#store.readable(reader, page);
        if (!sameHolders(page, pageAfter(after))) {
          changed = true;
          break;
        }
        if (readable) {
          return true;
        }
        if (page.length < holdersRead) {
          break;
        }
        after = page.at(-1);
      }
      if (!changed) {
        return held ? false : row.ownerId === reader.principal;
      }
    }
    return false;
  }

  /**
   * File `fileId`, uploaded through `resource`, if `reader` may read it
   * now (see the header): what it is, and its recorded chunks to read.
   * `file.not_found` otherwise, the same however it isn't readable.
   */
  async content(
    storeId: StoreId,
    reader: FileReader,
    resource: unknown,
    fileId: unknown
  ): Promise<FileContent> {
    const checked = ids(fileId, resource);
    this.#store.bind(storeIdSchema.parse(storeId));
    const row = this.#row(checked.fileId);
    if (
      row?.state !== "published" ||
      row.resource !== checked.resource ||
      !(await this.#readable(reader, row)) ||
      // Deleted while it was checked: no longer there to read.
      this.#row(checked.fileId)?.state !== "published"
    ) {
      throw notFound();
    }
    return {
      id: row.fileId,
      name: row.name,
      mimeType: typeOf(row),
      size: row.size,
      ownerId: row.ownerId,
      chunks: this.#chunks(row.fileId).map(({ key, sha256 }) => ({
        key,
        sha256,
      })),
    };
  }

  /**
   * Checks `reader` may use each of `fileIds` in a call's arguments: each
   * published, uploaded through one of `resources` (those declaring the
   * use) and readable to them (`file.not_found` otherwise). What a commit
   * then writes is checked again (`index`).
   */
  async usable(
    storeId: StoreId,
    reader: FileReader,
    fileIds: readonly string[],
    resources: readonly string[]
  ): Promise<void> {
    this.#store.bind(storeIdSchema.parse(storeId));
    for (const fileId of fileIds) {
      const row = fileIdSchema.safeParse(fileId).success
        ? this.#row(fileId)
        : undefined;
      if (
        row?.state !== "published" ||
        !resources.includes(row.resource) ||
        // oxlint-disable-next-line no-await-in-loop -- few, each decided apart
        !(await this.#readable(reader, row)) ||
        // Deleted while it was checked: no longer there to use.
        this.#row(row.fileId)?.state !== "published"
      ) {
        throw notFound();
      }
    }
  }

  /**
   * Deletes `principal`'s file `fileId`, uploaded through `resource`: a
   * tombstone at once, its bytes purged after. Refused while a record
   * holds it (`file.referenced`). Deleting a deleted file answers as the
   * first deletion did; a key the person used for another file is
   * `submission.key_conflict`. Every deletion that succeeds under a key
   * keeps it (`sdk_file_delete_keys`), a repeated one too, so a key is
   * one file's for good.
   */
  delete(
    storeId: StoreId,
    principal: string,
    resource: unknown,
    fileId: unknown,
    key?: string
  ): void {
    const checked = ids(fileId, resource);
    this.#storage.transactionSync(() => {
      this.#store.bind(storeIdSchema.parse(storeId));
      if (key !== undefined) {
        const keyed = this.#db
          .select({ fileId: fileDeleteKeys.fileId })
          .from(fileDeleteKeys)
          .where(
            and(
              eq(fileDeleteKeys.ownerId, principal),
              eq(fileDeleteKeys.key, key)
            )
          )
          .get();
        if (keyed !== undefined) {
          if (keyed.fileId !== checked.fileId) {
            throw submissionErrors.create("submission.key_conflict");
          }
          return;
        }
      }
      const row = this.#row(checked.fileId);
      // An unfinished upload isn't a file yet: its uploader cancels it.
      if (
        row === undefined ||
        row.ownerId !== principal ||
        row.resource !== checked.resource ||
        row.state === "uploading"
      ) {
        throw notFound();
      }
      if (row.state === "deleted") {
        if (row.deletedHow !== "deleted") {
          throw notFound();
        }
      } else if (this.#held(row.fileId)) {
        throw fileErrors.create("file.referenced");
      } else {
        this.#move(row, { state: "deleted", how: "deleted" });
      }
      if (key !== undefined) {
        this.#db
          .insert(fileDeleteKeys)
          .values({ ownerId: principal, key, fileId: row.fileId })
          .run();
      }
    });
  }

  /**
   * Keeps which files the records `staged` hold (`sdk_file_refs`), inside
   * a commit's transaction, after its writes: each record's files as its
   * fields hold them under `declared` (its table's descriptors). A file
   * a record didn't hold before must be published, `principal`'s own
   * upload, and uploaded through one of `attachable` (the App's resources
   * declaring `attach`); and, should other records hold it already, one
   * of them must be the writer's to read now (`readable`, in this same
   * transaction): its uploader regains no file through App code once only
   * records they can't read hold it. Otherwise the commit is refused
   * (`file.not_found`, the same however it isn't). A file no record holds
   * after the commit gets its cleanup intent (`expiresAt`); one held again
   * loses it.
   */
  index(
    staged: readonly FileStaged[],
    principal: string,
    declared: (
      table: string
    ) => Readonly<Record<string, ValueDescriptor>> | undefined,
    attachable: readonly string[],
    readable: (holders: readonly FileHolder[]) => boolean
  ): void {
    const touched = new Set<string>();
    // Every record's dropped files first, then what each newly holds: a
    // file moved off a record (deleted, say) in this commit is held by it
    // no more when another record takes it, whatever their order.
    const changes = staged.map(({ table, tableId, recordId, fields }) => {
      const where = and(
        eq(fileRefs.tableId, tableId),
        eq(fileRefs.recordId, recordId)
      );
      const before = new Set(
        this.#db
          .select({ fileId: fileRefs.fileId })
          .from(fileRefs)
          .where(where)
          .all()
          .map(({ fileId }) => fileId)
      );
      const descriptors = declared(table);
      const after =
        fields === null || descriptors === undefined
          ? new Set<string>()
          : recordFiles(descriptors, fields);
      for (const fileId of before) {
        if (!after.has(fileId)) {
          this.#db
            .delete(fileRefs)
            .where(and(where, eq(fileRefs.fileId, fileId)))
            .run();
          touched.add(fileId);
        }
      }
      return { table, tableId, recordId, before, after };
    });
    // Each newly held file decided once, against the records that held it
    // before this commit's additions: a holder the commit itself adds is
    // never proof of access, and the order of its records changes nothing.
    const admitted = new Set<string>();
    const additions: { tableId: string; recordId: string; fileId: string }[] =
      [];
    for (const { table, tableId, recordId, before, after } of changes) {
      for (const fileId of after) {
        if (before.has(fileId)) {
          continue;
        }
        if (!admitted.has(fileId)) {
          if (!this.#attachable(fileId, principal, attachable, readable)) {
            throw fileErrors.create("file.not_found", { table, id: recordId });
          }
          admitted.add(fileId);
        }
        additions.push({ tableId, recordId, fileId });
      }
    }
    for (const addition of additions) {
      this.#db.insert(fileRefs).values(addition).run();
      touched.add(addition.fileId);
    }
    const now = Date.now();
    for (const fileId of touched) {
      this.#db
        .update(files)
        .set({
          expiresAt: this.#held(fileId) ? null : now + fileLimits.orphanMs,
        })
        .where(and(eq(files.fileId, fileId), eq(files.state, "published")))
        .run();
    }
  }

  /**
   * Whether `principal` may newly attach `fileId` (see `index`): published,
   * their own upload, through one of `attachable`, and, should records hold
   * it already, one of them theirs to read now (`readable`).
   */
  #attachable(
    fileId: string,
    principal: string,
    attachable: readonly string[],
    readable: (holders: readonly FileHolder[]) => boolean
  ): boolean {
    const row = fileIdSchema.safeParse(fileId).success
      ? this.#row(fileId)
      : undefined;
    if (
      row?.state !== "published" ||
      row.ownerId !== principal ||
      !attachable.includes(row.resource)
    ) {
      return false;
    }
    const holders = this.#db
      .select({ tableId: fileRefs.tableId, recordId: fileRefs.recordId })
      .from(fileRefs)
      .where(eq(fileRefs.fileId, row.fileId))
      .all();
    return holders.length === 0 || readable(holders);
  }

  /**
   * When the alarm next has files to act on: an audit event to hand over
   * (now), an expiry, or a deleted file's bytes due for purging; null for
   * none.
   */
  nextDue(): number | null {
    const event = this.#db.select({ id: fileEvents.id }).from(fileEvents).get();
    const [expiring] = this.#db
      .select({ at: min(files.expiresAt) })
      .from(files)
      .where(isNotNull(files.expiresAt))
      .all();
    const [unpurged] = this.#db
      .select({ at: min(files.deletedAt) })
      .from(files)
      .where(and(eq(files.state, "deleted"), isNull(files.purgedAt)))
      .all();
    const [unsettled] = this.#db
      .select({ at: min(fileWrites.issuedAt) })
      .from(fileWrites)
      .where(eq(fileWrites.condemned, false))
      .all();
    // Condemned and removed: kept, should a late put land, until a write
    // could no longer land.
    const [condemned] = this.#db
      .select({ at: min(fileWrites.issuedAt) })
      .from(fileWrites)
      .where(
        and(eq(fileWrites.condemned, true), isNotNull(fileWrites.removedAt))
      )
      .all();
    // Condemned but its removal failed: due again at once, which the alarm
    // puts off by its retry wait (store-host.ts, `schedule`).
    const unremoved = this.#db
      .select({ key: fileWrites.key })
      .from(fileWrites)
      .where(and(eq(fileWrites.condemned, true), isNull(fileWrites.removedAt)))
      .get();
    const times = [
      event === undefined ? null : Date.now(),
      expiring?.at,
      typeof unpurged?.at === "number" ? unpurged.at + purgeGraceMs : null,
      typeof unsettled?.at === "number" ? unsettled.at + purgeGraceMs : null,
      typeof condemned?.at === "number" ? condemned.at + writeLifetimeMs : null,
      unremoved === undefined ? null : Date.now(),
    ].filter((time): time is number => typeof time === "number");
    return times.length === 0 ? null : Math.min(...times);
  }

  /**
   * The alarm's work on files: deletes what expired and, checked again in
   * the same transaction, no record holds; then purges the bytes of
   * deleted files whose grace passed, a page at a time; then hands the
   * audit events over.
   */
  async sweep(storeId: StoreId, now = Date.now()): Promise<void> {
    this.#storage.transactionSync(() => {
      const due = this.#db
        .select()
        .from(files)
        .where(and(isNotNull(files.expiresAt), lte(files.expiresAt, now)))
        .limit(sweepPage)
        .all();
      for (const row of due) {
        if (this.#held(row.fileId)) {
          // Held again since: the intent is stale, and goes.
          this.#db
            .update(files)
            .set({ expiresAt: null })
            .where(eq(files.fileId, row.fileId))
            .run();
        } else if (row.state !== "deleted") {
          this.#move(row, {
            state: "deleted",
            how: row.state === "uploading" ? "expired" : "orphaned",
          });
        }
      }
    });
    const purgeable = this.#db
      .select({ fileId: files.fileId })
      .from(files)
      .where(
        and(
          eq(files.state, "deleted"),
          isNull(files.purgedAt),
          lte(files.deletedAt, now - purgeGraceMs)
        )
      )
      .limit(sweepPage)
      .all();
    for (const { fileId } of purgeable) {
      // oxlint-disable-next-line no-await-in-loop -- one file at a time, in order
      await this.#purge(`${filesPrefix(storeId)}${fileId}/`);
      this.#db
        .update(files)
        .set({ purgedAt: Date.now() })
        .where(eq(files.fileId, fileId))
        .run();
      this.#db.delete(fileChunks).where(eq(fileChunks.fileId, fileId)).run();
      // Its writes stay tracked: one that lands after the purge is removed
      // by the alarm, as long as a write might still land.
    }
    if (purgeable.length > 0) {
      log.info("app_file.purged", {
        store: storeId,
        files: purgeable.length,
      });
    }
    await this.#removeUnsettled(now);
    await this.flushEvents();
  }

  /**
   * Hands the audit events waiting in the store to core's audit outbox,
   * a page at a time, each stored once (`storedEvent`), then removes them.
   * One that core already holds is only removed.
   */
  async flushEvents(): Promise<void> {
    for (;;) {
      const rows = this.#db
        .select()
        .from(fileEvents)
        .orderBy(asc(fileEvents.createdAt))
        .limit(eventsPage)
        .all();
      const [first, ...rest] = rows.map(({ event }) =>
        auditEventSchema.parse(JSON.parse(event))
      );
      if (first === undefined) {
        return;
      }
      const db = drizzleD1(this.#env.DB);
      const insert = (event: AuditEvent) =>
        outboxedEventWhere(db, event, not(storedEvent(event.id)));
      // oxlint-disable-next-line no-await-in-loop -- page after page, in order
      await auditedBatch(this.#env, db, [insert(first), ...rest.map(insert)]);
      for (const { id } of rows) {
        this.#db.delete(fileEvents).where(eq(fileEvents.id, id)).run();
      }
    }
  }

  /**
   * Removes the objects of chunk writes that never settled (`fileWrites`)
   * once they have had time to: each condemned first, so a recording that
   * comes after is refused and its writer removes its object; a key a
   * chunk is recorded under keeps its object. A key whose removal failed
   * stays condemned, for the next alarm.
   */
  async #removeUnsettled(now: number): Promise<void> {
    const { keys, done } = this.#storage.transactionSync(() => {
      const due = this.#db
        .select({ key: fileWrites.key, issuedAt: fileWrites.issuedAt })
        .from(fileWrites)
        .where(lte(fileWrites.issuedAt, now - purgeGraceMs))
        // Writes not yet looked at first: those removed already, kept for
        // a late put, never crowd them out of a page.
        .orderBy(asc(fileWrites.condemned), asc(fileWrites.issuedAt))
        .limit(sweepPage)
        .all();
      const condemned: string[] = [];
      // Their tracking goes only once a write could no longer land: an
      // object removed before is removed again should a late put put it
      // back.
      const settled: string[] = [];
      for (const { key, issuedAt } of due) {
        const recorded = this.#db
          .select({ key: fileChunks.key })
          .from(fileChunks)
          .where(eq(fileChunks.key, key))
          .get();
        if (recorded === undefined) {
          // Not removed until its removal succeeds: a failed one is due
          // again at the alarm's next try (`nextDue`).
          this.#db
            .update(fileWrites)
            .set({ condemned: true, removedAt: null })
            .where(eq(fileWrites.key, key))
            .run();
          condemned.push(key);
          if (issuedAt <= now - writeLifetimeMs) {
            settled.push(key);
          }
        } else {
          this.#db.delete(fileWrites).where(eq(fileWrites.key, key)).run();
        }
      }
      return { keys: condemned, done: settled };
    });
    if (keys.length === 0) {
      return;
    }
    await this.#env.FILES.delete(keys);
    const removedAt = Date.now();
    this.#storage.transactionSync(() => {
      this.#db
        .update(fileWrites)
        .set({ removedAt })
        .where(inArray(fileWrites.key, keys))
        .run();
      for (const key of done) {
        this.#db.delete(fileWrites).where(eq(fileWrites.key, key)).run();
      }
    });
    log.info("app_file.unsettled_removed", { objects: keys.length });
  }

  /** Removes every object under `prefix` from R2. */
  async #purge(prefix: string): Promise<void> {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- page after page
      const listed = await this.#env.FILES.list({ prefix, limit: 1000 });
      if (listed.objects.length === 0) {
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- page after page
      await this.#env.FILES.delete(listed.objects.map(({ key }) => key));
      if (!listed.truncated) {
        return;
      }
    }
  }

  /**
   * A deleted store's files' bytes, all of them, from R2 (its purge,
   * store-host.ts), once their audit events are with core; its rows go
   * with the store's tables.
   */
  async purgeStore(storeId: StoreId, now = Date.now()): Promise<void> {
    // A chunk write admitted before the store was deleted may still land:
    // its prefix is purged only once every write has had time to settle,
    // and the purge is retried until then.
    const settling = this.#db
      .select({ key: fileWrites.key })
      .from(fileWrites)
      .where(gt(fileWrites.issuedAt, now - writeLifetimeMs))
      .get();
    if (settling !== undefined) {
      throw new Error("A chunk write of the deleted store may still land");
    }
    try {
      await this.flushEvents();
      await this.#purge(filesPrefix(storeId));
      log.info("app_file.store_purged", { store: storeId });
    } catch (error) {
      log.error("store.files_purge_failed", errorFields(error));
      throw error;
    }
  }
}
