import type { AuditActor } from "@grasp-os/shared/audit";
import type { Provenance } from "@grasp-os/shared/knowledge";

import { drainKnowledgeOutboxSoon } from "../audit-outbox.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { runEngine } from "../workflows/engine.ts";
import { noteProvenance, readerActor } from "./access.ts";
import type { Reader } from "./access.ts";
import { authorize } from "./app-entries.ts";
import type { Readable, ReadRecord } from "./authorize.ts";
import type { CollectionRow } from "./collections.ts";
import { checkWrite } from "./write-rules.ts";

// What Knowledge asks of its host, in one place: the rest of Knowledge
// reaches Grasp's people, roles, teams and Apps, its buckets, audit log,
// secrets and workflow engine only through these ports, so it can move
// into a package of its own that takes them as arguments.

/** Where Knowledge keeps its payloads: an R2 bucket's calls it uses. */
export type BlobStore = Pick<R2Bucket, "delete" | "get" | "head" | "put">;

/** A document version's indexing, as Knowledge asks its host to run it. */
export interface IndexJob {
  documentId: string;
  version: number;
}

/** Knowledge's ports, as core provides them. */
export interface KnowledgePorts {
  /** What `reader` may read now (authorize.ts). */
  authorize: (reader: Reader) => Promise<Readable>;
  /**
   * Called after every read, before what was read is handed over, with
   * the collections it came from (and whether each is sensitive): the host
   * records the read and may act on it (core puts an App or agent that
   * read restricted data in restricted mode first), and answers its
   * provenance. A refusal fails the read.
   */
  onRead: (
    reader: Reader,
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
  /** Who `reader` is, as the host's audit log names them. */
  actorOf: (reader: Reader) => AuditActor;
  /** Payloads (payloads.ts), in a bucket whose jurisdiction the host set. */
  blobs: BlobStore;
  /**
   * The audit log Knowledge's outbox drains into: Knowledge writes each
   * event to its own outbox in the batch of its change (audit.ts).
   */
  audit: {
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

/** Where the engine has a run that has ended. */
const endedStatuses: ReadonlySet<string> = new Set([
  "complete",
  "errored",
  "terminated",
]);

/** Core's ports for Knowledge, over `env`. */
export const portsOf = (env: Env): KnowledgePorts => ({
  authorize: async (reader) => await authorize(env, reader),
  onRead: async (reader, record, ...sources) =>
    await noteProvenance(env, reader, record, ...sources),
  actorOf: readerActor,
  onWrite: async (write) => {
    await checkWrite(env, write);
  },
  blobs: env.BRAIN_OBJECTS,
  audit: {
    drain: () => {
      drainKnowledgeOutboxSoon(env);
    },
  },
  keys: {
    hmac: async (purpose, usages) => await derivedHmacKey(env, purpose, usages),
  },
  jobs: {
    start: async (id, { documentId, version }) => {
      await runEngine(env).createInternal({
        id,
        workflow: "indexing",
        input: { documentId, version },
      });
    },
    status: async (id) => {
      const found = await runEngine(env).status(id);
      return found && (endedStatuses.has(found.status) ? "ended" : "running");
    },
  },
  clock: () => new Date(),
});
