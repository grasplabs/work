import { z } from "zod";

import { identifierMaxLength } from "./identifier.ts";

// How a client's Brain is doing, as Grasp's admin reads it from the
// client's core (core's brain-report.ts), for Grasp's staff alone: its
// work queue, its store's size against its limit, its embedding's
// progress, its erasure ledger, and the steps of its tick that failed;
// and the three things staff may do to it: put a parked item back in the
// queue, rebuild the word indexes, and re-embed. The admin asks as it asks for the snapshot: through the
// router's route with the router secret, signed with a key both derive
// from the client's auth secret for each purpose alone (a read's, an
// action's), naming the staff member Cloudflare Access let in, whom
// core's audit log records for every read and every action before it
// answers.
//
// Operational state only, never content: counts, ages, the kinds of work
// (names in code), error codes with their fixed wording, sizes, and
// erasures as counts alone (by kind, reason, and written or not yet). No
// text, no title, no source or work key, no payload, no person's id or
// name, and no erasure singled out: not which, not when, not the SHA-256
// the ledger names one by. Core builds the report field by field and this schema names nothing
// else.

/** Where the admin reads a client's Brain. Behind the router-secret check. */
export const brainReportPath = "/platform/brain";

/** Where the admin acts on a client's Brain. Behind the router-secret check. */
export const brainActionPath = "/platform/brain/action";

/** The purpose a read's signing key is derived for (`hkdfHmacKey`). */
export const brainReportPurpose = "grasp-os brain report key";

/** The purpose an action's signing key is derived for: never a read's. */
export const brainActionPurpose = "grasp-os brain action key";

/** How far from core's clock a request may have been sent. */
export const brainReportMaxSkewMs = 5 * 60 * 1000;

/** The most bytes a request's body may have. */
export const brainReportMaxBytes = 1024;

const staffSchema = z.strictObject({
  email: z.email().max(identifierMaxLength).toLowerCase(),
});

/**
 * A read: when it was sent, so one caught on its way can't be sent later,
 * and the staff member asking, as Cloudflare Access verified them.
 */
export const brainReportRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
  staff: staffSchema,
});
export type BrainReportRequest = z.input<typeof brainReportRequestSchema>;

/**
 * What staff may do to a client's Brain: put the parked item `item` (the
 * queue's own id for it) back in the queue, or rebuild the word indexes.
 */
export const brainActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("requeue"),
    item: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ type: z.literal("rebuild_words") }),
  z.strictObject({ type: z.literal("reembed") }),
]);
export type BrainAction = z.infer<typeof brainActionSchema>;

/** An action, signed as a read is, with what it asks. */
export const brainActionRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
  staff: staffSchema,
  action: brainActionSchema,
});
export type BrainActionRequest = z.input<typeof brainActionRequestSchema>;

/**
 * What an action did: `done`; `nothing`, when no item of that id is
 * parked or a rebuild is under way already; `unavailable`, when the
 * Brain answers nothing now (its ledger is being read).
 */
export const brainActionOutcomes = ["done", "nothing", "unavailable"] as const;
export type BrainActionOutcome = (typeof brainActionOutcomes)[number];

export const brainActionAnswerSchema = z.object({
  outcome: z.enum(brainActionOutcomes),
});
export type BrainActionAnswer = z.infer<typeof brainActionAnswerSchema>;

const isoTime = z.iso.datetime();
const count = z.int().min(0);
/** A kind of work, an error code or a reason: a name in code. */
const codeName = z.string().min(1).max(128);

/** A step of the store's tick that last failed: when, and the store's own code for why. */
const stepFailureSchema = z
  .object({ at: isoTime, reason: z.enum(["timed_out", "failed"]) })
  .nullable();

/** How many erasures of one kind are in the ledger, and how many not yet. */
const erasureCountSchema = z.object({ written: count, unwritten: count });

/** A client's Brain, as staff see it. */
export const brainReportSchema = z.object({
  /** When core read it. */
  now: isoTime,
  queue: z.object({
    /** What waits, by kind, with when the one waiting longest was added. */
    waiting: z
      .array(z.object({ kind: codeName, count, oldestAddedAt: isoTime }))
      .max(256),
    running: count,
    /** Handlers still running past their time. */
    overdue: count,
    /** Why the queue waits for its model, since and until when; null while it answers. */
    paused: z
      .object({ reason: codeName, since: isoTime, until: isoTime })
      .nullable(),
    /** The latest parked first, at most the store's 100. */
    parked: z
      .array(
        z.object({
          /** The queue's own id for it: what a requeue names. */
          item: z.int().positive(),
          kind: codeName,
          attempts: count,
          parks: count,
          /** Parked for good: it no longer comes back by itself. */
          final: z.boolean(),
          error: codeName,
          /** The error's fixed wording, the store's own. */
          message: z.string().max(256),
          parkedAt: isoTime,
        })
      )
      .max(100),
    parkedCount: count,
  }),
  store: z.object({
    /** What the store's SQLite takes. */
    bytes: count,
    /** What one Durable Object holds at most: every write fails at it. */
    limitBytes: count,
  }),
  /** Whether every chunk's words are indexed by the current rules. */
  words: z.enum(["current", "rebuilding"]),
  /** How far the embedding model has come over the current passages: counts only. */
  embedding: z.object({
    /** The model and its build the store embeds for; null while none ships. */
    model: z.string().min(1).max(256).nullable(),
    /** Passages of current versions. */
    chunks: count,
    /** Of those, the ones with vectors of the model. */
    embedded: count,
    /** Of those, the ones the model can't embed, passed over until a re-embed. */
    passedOver: count,
    /** Whether the rebuild for the model is still under way. */
    rebuilding: z.boolean(),
  }),
  ledger: z.object({
    /**
     * `through` once the store read its erasure ledger through; while it
     * replays it after a restore, or can't read it, it answers nothing but
     * this report.
     */
    replay: z.enum(["through", "replaying", "unreadable"]),
    /** Erasures recorded and hidden, still being deleted. */
    erasing: count,
    /** Sources that keep versions but have none current, which nobody can read. */
    sourcesWithoutCurrent: count,
    source: erasureCountSchema,
    person: erasureCountSchema,
    /** How many erasures there are of each reason, in all. */
    byReason: z.object({
      deleted: count,
      retention: count,
      person_erased: count,
      withdrawn: count,
    }),
  }),
  /** The tick's own steps, each with its last failure since the store started. */
  stepsFailed: z.object({
    ledger: stepFailureSchema,
    erase: stepFailureSchema,
    sweep: stepFailureSchema,
    repack: stepFailureSchema,
    reindex: stepFailureSchema,
  }),
});
export type BrainReport = z.infer<typeof brainReportSchema>;

/** The share of its limit from which a store is flagged: room left for repacks and rebuilds. */
export const storeNearLimitShare = 0.8;

/** Whether `store` is near enough its limit to need someone before writes fail. */
export const storeNearLimit = ({
  bytes,
  limitBytes,
}: BrainReport["store"]): boolean => bytes >= limitBytes * storeNearLimitShare;
