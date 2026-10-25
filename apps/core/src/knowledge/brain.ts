import type { BrainEvent } from "@grasp-os/brain/events";
import type { Json } from "@grasp-os/brain/json";
import type { Provenance } from "@grasp-os/brain/knowledge";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Readable, ReadRecord } from "./authorize.ts";
import type { CollectionRow } from "./collections.ts";

// The Brain as its modules take it: its database and its host's ports,
// made once per request by the host (core's ports.ts `brainOf`), so no
// module reaches `Env` or the host itself.

/** Where Knowledge keeps its payloads: an R2 bucket's calls it uses. */
export type BlobStore = Pick<R2Bucket, "delete" | "get" | "head" | "put">;

/** A document version's indexing, as Knowledge asks its host to run it. */
export interface IndexJob {
  documentId: string;
  version: number;
}

/**
 * What the Brain asks of its host, in one place: the Brain reaches the
 * host's people, roles, teams and Apps, its buckets, audit log, secrets,
 * job runner and clock only through these. `C` is the host's caller,
 * opaque to the Brain: it hands one to every port that asks who.
 */
export interface BrainPorts<C> {
  /** What `reader` may read now (authorize.ts). */
  authorize: (reader: C) => Promise<Readable>;
  /**
   * Called after every read, before what was read is handed over, with
   * the collections it came from (and whether each is sensitive): the host
   * records the read and may act on it (core puts an App or agent that
   * read restricted data in restricted mode first), and answers its
   * provenance. A refusal fails the read.
   */
  onRead: (
    reader: C,
    record: ReadRecord,
    ...sources: { id: string; sensitive: boolean }[]
  ) => Promise<Provenance>;
  /**
   * Called before every version is written, by anyone: throws to refuse
   * what the host never lets be saved (core's: the Grasp skills but by
   * their sync, a memory file over its limit). `sync` is the host's own
   * sync writing (documents.ts `Write.sync`).
   */
  onWrite: (write: {
    collection: CollectionRow;
    path: string;
    text: string;
    sync: boolean;
  }) => Promise<void>;
  /** Who may recall, as the host decides it (recall.ts). */
  recall: {
    /** Refuses a reader who may not recall at all. */
    require: (reader: C) => Promise<void>;
    /**
     * Whether `error`, thrown by a port, is the host refusing the caller:
     * a recall answers it as `brain.denied`.
     */
    isRefusal: (error: unknown) => boolean;
    /**
     * Who `reader` is, as a string that changes when what the host lets
     * them read changes: part of a recall's access revision.
     */
    key: (reader: C) => Promise<string>;
  };
  /** Who `reader` is, as the host's audit log names them. */
  actorOf: (reader: C) => Json;
  /**
   * The person whose memories `reader`'s commands are (memories.ts), or a
   * refusal (`brain.denied`) for a caller with none.
   */
  ownerOf: (reader: C) => string;
  /** Payloads (payloads.ts), in a bucket whose jurisdiction the host set. */
  blobs: BlobStore;
  /**
   * The audit log Knowledge's outbox drains into: Knowledge writes each
   * event to its own outbox in the batch of its change (audit.ts).
   */
  audit: {
    /**
     * The host's audit event for `entry`, with its ID, as the outbox
     * stores it: what the host's log takes when it drains the outbox.
     */
    eventOf: (entry: BrainEvent) => { id: string; event: string };
    /** Drains the outbox soon, in the background, never failing. */
    drain: () => void;
  };
  /** An HMAC key of the host's own for one `purpose`. */
  keys: {
    hmac: (
      purpose: string,
      usages: ("sign" | "verify")[]
    ) => Promise<CryptoKey>;
  };
  /**
   * Runs indexing jobs (indexing.ts) durably: the host runs `runIndexing`
   * for each, retrying as it says.
   */
  jobs: {
    /** Starts the job `id`; one started already under it is left as it is. */
    start: (id: string, job: IndexJob) => Promise<void>;
    /** Whether the job `id` is running or has ended; undefined if unknown. */
    status: (id: string) => Promise<"running" | "ended" | undefined>;
  };
  /** The time now. */
  clock: () => Date;
}

/** The Brain: its database, and its host's ports for callers `C`. */
export interface Brain<C> {
  db: DrizzleD1Database;
  ports: BrainPorts<C>;
}
