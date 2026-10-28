import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import type { Readable, ReadRecord } from "./authorize.ts";
import type { CollectionRow } from "./collections.ts";
import type { BrainSourceRef, MemoryRecord } from "./contract.ts";
import type { BrainEvent } from "./events.ts";
import type { Json } from "./json.ts";
import type { Provenance } from "./knowledge.ts";
import type { MemoryAudience } from "./memories.ts";

/** What a lesson's wording is written from: what the lesson holds. */
export interface LessonFacts {
  taskType: string;
  versions: readonly string[];
  failures: number;
  completions: number;
  evidenceStatus: "supported" | "contested";
  instruction: string;
}

// The Brain as its modules take it: its database and its host's ports,
// made once per request by the host (core's ports.ts `brainOf`), so no
// module reaches `Env` or the host itself.

/** Where Knowledge keeps its payloads: an R2 bucket's calls it uses. */
export type BlobStore = Pick<R2Bucket, "delete" | "get" | "head" | "put">;

/** A collection, as the host decides whether its skills may be selected. */
export interface SkillCollection {
  id: string;
  access: string;
  owner: string;
  source: string;
}

/**
 * Why a collection's skills may be selected: shipped with the release
 * (read-only to everyone), or written only by the host's admins.
 */
export type SkillAuthority = "shipped" | "admins";

/** A document version's indexing, as Knowledge asks its host to run it. */
export interface IndexJob {
  documentId: string;
  version: number;
}

/**
 * A source version's entity linking (entities.ts), as the Brain asks its
 * host to run it: `source` is the link job's (`doc:<id>`, `mem:<id>`).
 */
export interface LinkJob {
  source: string;
  version: number;
}

/** What a recall hands its host's reranker (`BrainPorts.rerank`). */
export interface RerankRequest {
  /** The question, in the caller's words. */
  question: string;
  /** The best of what the lanes found, in fused order, each by its item's ID. */
  candidates: { id: string; text: string }[];
  /** The collections the candidates come from, for the model rules. */
  provenance: string[];
  /** How long the reranker may take. */
  deadlineMs: number;
}

/**
 * What the Brain asks of its host, in one place: the Brain reaches the
 * host's people, roles, teams and Apps, its buckets, audit log, secrets,
 * job runner and clock only through these. `C` is the host's caller,
 * opaque to the Brain: it hands one to every port that asks who.
 */
/**
 * What one may do with a learning suite (eval-suites.ts, GRA-311), each
 * apart: a designer proposes versions and reads their development and
 * validation cases; an evaluator calibrates and reads every split, the
 * sealed final one alone; an optimizer reads the development cases of an
 * accepted version alone; publication reads results, never a case. Its
 * owner accepts and retires it.
 */
export type EvalCapability =
  | "designer"
  | "evaluator"
  | "optimizer"
  | "publication";

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
  /**
   * The deployment's reranker (GRA-304), where the host has one: orders
   * `request`'s candidates by how well each answers its question, through
   * the host's model gateway, on `reader`'s budget and under the model
   * rules for what `request.provenance` names, within `deadlineMs`. Its
   * answer is untrusted: the IDs in order, checked by the recall. Absent:
   * no recall reranks.
   */
  rerank?: (reader: C, request: RerankRequest) => Promise<unknown>;
  /**
   * The audiences `reader` is in now, by the host's IDs for them (core's:
   * the chats others share that count them, while they are a member): a
   * shared session's events reach only these (outcomes.ts).
   */
  audiences: (reader: C) => Promise<readonly string[]>;
  /** Who `reader` is, as the host's audit log names them. */
  actorOf: (reader: C) => Json;
  /** Skills (skills.ts), as the host decides who may use them. */
  skills: {
    /**
     * The capabilities `reader` holds now, by the host's names for them
     * (core's: from its grants): a skill whose manifest requires one they
     * lack is never selected. The Brain compares; it never grants.
     */
    capabilities: (reader: C) => Promise<readonly string[]>;
    /**
     * Which of `collections` may hold a selectable skill, and why (core's:
     * the shipped skills, and collections only admins write): a skill
     * anyone else can write is never selected, whatever its manifest says.
     * A collection left out holds none.
     */
    authorityOf: (
      collections: readonly SkillCollection[]
    ) => Promise<Readonly<Record<string, SkillAuthority>>>;
  };
  /**
   * The person whose memories `reader`'s commands are (memories.ts), or a
   * refusal (`brain.denied`) for a caller with none.
   */
  ownerOf: (reader: C) => string;
  /**
   * Whether `reader` may publish a record into `target`, resting on
   * `refs` (GRA-298): the host's decision, refused as `brain.denied` (the
   * scope isn't theirs) or `brain.not_found` (a reference the scope's
   * whole audience couldn't read). The Brain asks; it never decides.
   */
  mayPublish: (
    reader: C,
    target: { scope: "team" | "company" | "session"; scopeId: string | null },
    refs: readonly BrainSourceRef[]
  ) => Promise<void>;
  /**
   * Whether `reader` may retire `record` (GRA-298): the host's decision,
   * refused as `brain.not_found` (alike for one they can't see and one
   * that isn't theirs to retire). A person's own record reaches it only
   * when it is the caller's own (GRA-1177).
   */
  mayRetire: (
    reader: C,
    record: {
      scope: "person" | "team" | "company" | "session";
      scopeId: string | null;
      ownerId: string;
    }
  ) => Promise<void>;
  /**
   * Memory records in a recall (GRA-298), as the host decides whom they
   * serve: the Brain matches within what it answers and widens nothing.
   */
  /**
   * A model's wording of a lesson for a person (GRA-301, lessons.ts),
   * through the host's model gateway under its own budget: given only
   * what the lesson holds, never a task's content or anyone's identity.
   * Throws to refuse (`brain.budget_exceeded` when its budget is spent).
   */
  wordLesson: (facts: LessonFacts) => Promise<string>;
  /**
   * What `reader` may do with learning suite `suiteId` (eval-suites.ts,
   * GRA-311), as the host grants it: none when the host grants none.
   */
  evaluation?: {
    capabilities: (
      reader: C,
      suiteId: string
    ) => Promise<readonly EvalCapability[]>;
    /** Security gates every suite's decision policy must hold. */
    mandatedGates?: readonly string[];
  };
  memories: {
    /**
     * Whom `reader`'s recall serves: the scopes it may read (none for a
     * reader that reads no memory) and the people who read its answer.
     */
    audienceOf: (
      reader: C
    ) => Promise<{ audience: MemoryAudience; people: readonly string[] }>;
    /**
     * The collections every one of `people` may read now, as the host
     * decides it (GRA-1085): a memory record resting on any other is left
     * out of a shared read in the query itself (memories.ts,
     * `citesReadable`), before `keep` checks what is found again.
     */
    readableBy: (reader: C, people: readonly string[]) => Promise<string[]>;
    /**
     * Of `records`, found for `people`, those the host keeps now, in the
     * same order: each with who published it, when that isn't the reader
     * (null when it is), and the collections it rests on, each sensitive
     * or not, for the read the Brain records of those it hands over.
     */
    keep: (
      reader: C,
      people: readonly string[],
      records: readonly (MemoryRecord & { ownerId: string })[]
    ) => Promise<
      (MemoryRecord & {
        by: string | null;
        cites: { id: string; sensitive: boolean }[];
      })[]
    >;
  };
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
   * Extracts the entities `text` mentions, through the host's own model
   * gateway (its rules, budgets and audit): the Brain never calls a model
   * provider itself. Answers what `extractedEntitiesSchema` (entities.ts)
   * takes, which the Brain validates again and checks against the text;
   * throws when it can't, and the linking job retries.
   */
  extractEntities: (text: string) => Promise<unknown>;
  /**
   * Runs indexing jobs (indexing.ts) and linking jobs (entities.ts)
   * durably: the host runs `runIndexing` or `runLinking` for each,
   * retrying as it says.
   */
  jobs: {
    /** Starts the job `id`; one started already under it is left as it is. */
    start: (id: string, job: IndexJob | LinkJob) => Promise<void>;
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

/**
 * The Brain over `database`, its own D1 database (migrated from
 * src/db/migrations), with the host's `ports`: what every module takes.
 * Cheap: a host makes one per request.
 */
export const createBrain = <C>(
  database: D1Database,
  ports: BrainPorts<C>
): Brain<C> => ({ db: drizzle(database), ports });
