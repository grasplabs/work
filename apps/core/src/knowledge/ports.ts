import { drainKnowledgeOutboxSoon } from "../audit-outbox.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { runEngine } from "../workflows/engine.ts";
import type { Reader } from "./access.ts";
import { authorize } from "./app-entries.ts";
import type { Readable } from "./authorize.ts";

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
