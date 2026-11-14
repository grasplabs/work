import { z } from "zod";

import { identifierMaxLength } from "./identifier.ts";

// How a client's Brain is doing, as Grasp's admin reads it from the
// client's core (core's brain-report.ts), for Grasp's staff alone: its
// work queue, its store's size against its limit, its embedding's
// progress, its erasure ledger, the steps of its tick that failed, and
// how its recall does by each way (counts), and what its model calls
// spent this month by purpose, as the model gateway recorded them;
// the three things staff may do to it: put a parked item back in the
// queue, rebuild the word indexes, and re-embed; and whether one source
// or one person, named as the client gave it, was erased. The admin asks as it asks for the snapshot: through the
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
// else. The one exception is asked for by name: staff give a source's key
// or a person's id, as the client gave it to them, and get whether it was
// erased and when, nothing more, with the lookup in the client's audit
// log before it is answered.

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

/** Where the admin asks whether something was erased from a client's Brain. Behind the router-secret check. */
export const brainErasurePath = "/platform/brain/erasure";

/** The purpose an erasure lookup's signing key is derived for: never a read's or an action's. */
export const brainErasurePurpose = "grasp-os brain erasure key";

/** The most bytes an erasure lookup's body may have: a key of 256 characters, each escaped. */
export const brainErasureMaxBytes = 2048;

/** A source's key or a person's id, as the client gave it to staff. */
const erasedNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((name) => name.isWellFormed(), {
    message: "Holds an unpaired surrogate",
  });

/**
 * What staff look up: a source, by the Brain's key for it (its producer,
 * ":", and the producer's id, as `upload:…`), or a person, by their id.
 */
export const brainErasureLookupSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("source"), key: erasedNameSchema }),
  z.strictObject({ kind: z.literal("person"), id: erasedNameSchema }),
]);
export type BrainErasureLookup = z.infer<typeof brainErasureLookupSchema>;

/** A lookup, signed as a read is, with what it names. */
export const brainErasureRequestSchema = z.strictObject({
  sentAt: z.iso.datetime(),
  staff: staffSchema,
  lookup: brainErasureLookupSchema,
});
export type BrainErasureRequest = z.input<typeof brainErasureRequestSchema>;

/**
 * What a lookup answers besides `erased`: `erasing` while it is recorded
 * but not done; `not_erased` when the ledger holds no erasure of it, alike
 * whether it ever existed; `skipped` when core recorded its erasure of a
 * person from the Brain as skipped, so it is not done and not tried again;
 * `unavailable` while the Brain can't read its ledger, or applies it after
 * a restore.
 */
export const brainErasureStates = [
  "erasing",
  "not_erased",
  "skipped",
  "unavailable",
] as const;

/**
 * Whether it was erased, and nothing else: `erased`, with when the ledger
 * recorded it, once every part of the store and its queue is done; or one
 * of `brainErasureStates`. What core answers. Fields it doesn't name are
 * dropped, so an admin reads a core of a newer release that adds one.
 */
export const brainErasureAnswerSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("erased"), at: z.iso.datetime() }),
  z.object({ state: z.enum(brainErasureStates) }),
]);
export type BrainErasureAnswer = z.infer<typeof brainErasureAnswerSchema>;

/** Every state this release answers. */
const answeredStates = new Set<string>(["erased", ...brainErasureStates]);

/**
 * An answer as the admin reads it: core's, or `unknown` for a state this
 * release doesn't name (a core of a newer release, on a faster channel),
 * which the admin says it can't read, rather than refusing the answer. A
 * state it names that comes malformed is refused as before.
 */
export const brainErasureReadSchema = z.union([
  brainErasureAnswerSchema,
  z
    .object({
      state: z.string().refine((state) => !answeredStates.has(state)),
    })
    .transform(() => ({ state: "unknown" as const })),
]);
export type BrainErasureRead = z.infer<typeof brainErasureReadSchema>;

const isoTime = z.iso.datetime();
const count = z.int().min(0);
/** A kind of work, an error code or a reason: a name in code. */
const codeName = z.string().min(1).max(128);

/**
 * The steps of the store's tick, in the tick's order: every one the
 * store's overview names (core's brain-next.ts holds the two to the same
 * keys, so one the store adds and the report doesn't carry fails to
 * compile).
 */
export const brainSteps = [
  "ledger",
  "erase",
  "sweep",
  "repack",
  "reindex",
  "embedding",
] as const;
export type BrainStep = (typeof brainSteps)[number];

/**
 * The ways recall searches by, in the order staff read them: every one
 * the store's overview names (core's brain-next.ts holds the two to the
 * same keys, as the steps).
 */
export const brainSearchWays = [
  "words",
  "exact",
  "entities",
  "meaning",
] as const;
export type BrainSearchWay = (typeof brainSearchWays)[number];

/**
 * Why a recall went without the question's vector though a model runs:
 * every reason the store counts (held to its keys as the ways are).
 */
export const brainWithoutMeaningReasons = [
  "timed_out",
  "failed",
  "refused",
  "unusable",
] as const;
export type BrainWithoutMeaningReason =
  (typeof brainWithoutMeaningReasons)[number];

/** A step of the store's tick that last failed: when, and the store's own code for why. */
const stepFailureSchema = z
  .object({ at: isoTime, reason: z.enum(["timed_out", "failed"]) })
  .nullable();

/** How many recalls searched by a way, and how many it failed. */
const wayCountSchema = z.object({ recalls: count, failed: count });

/** How many erasures of one kind are in the ledger, and how many not yet. */
const erasureCountSchema = z.object({ written: count, unwritten: count });

/**
 * What the Brain's model calls used in a UTC month, by purpose, as core's
 * model gateway recorded each answered request: the Brain keeps no spend
 * figures of its own. Totals only, never who asked or what was said. An
 * overview: nothing limits it, and on the client's own keys the provider's
 * invoice is the bill.
 */
export const brainModelSpendSchema = z.object({
  /** The UTC month, such as `2026-11`. */
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),
  /** Each purpose that was used, the dearest first; empty when none was. */
  purposes: z.array(
    z.object({
      /** What the calls were for, a name in code (`brain.recall_analysis`), at most the gateway's 64. */
      purpose: z.string().min(1).max(64),
      calls: count,
      inputTokens: count,
      outputTokens: count,
      /** US dollars at the provider's list prices, as the gateway priced them. */
      cost: z.number().min(0),
    })
  ),
});
export type BrainModelSpend = z.infer<typeof brainModelSpendSchema>;

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
  stepsFailed: z.record(z.enum(brainSteps), stepFailureSchema),
  /**
   * Recall since the store started (`since`), counts alone: per way, how
   * many recalls searched by it and how many it failed; and how many
   * recalls went without the question's vector, by why. Totals only:
   * keyed by way and reason, never by a person or a store, so the figures
   * of several stores add field by field.
   */
  recall: z.object({
    since: isoTime,
    ways: z.object({
      words: wayCountSchema,
      exact: wayCountSchema,
      /**
       * Core always sends it; optional only so the admin reads a core of
       * an older release (one on a slower channel) and shows the rest of
       * its report.
       */
      entities: wayCountSchema.optional(),
      meaning: wayCountSchema,
    }),
    withoutMeaning: z.record(z.enum(brainWithoutMeaningReasons), count),
  }),
  /**
   * People's own stores (what one person alone may read), as each last
   * told core of itself when its tick ended: totals across them only,
   * never a store, a person or anything a store holds. `recall` above is
   * the shared store's, which every recall searches. Core always sends
   * it; optional only so the admin reads a core of an older release (one
   * on a slower channel) and shows the rest of its report.
   */
  ownStores: z
    .object({
      /** Stores that hold anything, as their own work last found them. */
      stores: count,
      /** Items waiting in their queues. */
      waiting: count,
      /** When the item waiting longest across them was added; null while none waits. */
      oldestWaitingAt: isoTime.nullable(),
      /** Items parked in their queues. */
      parked: count,
      /** Stores whose last tick failed a step, whose queue is paused, or whose ledger isn't read through. */
      failing: count,
      /** Stores whose rebuild for the shipped model isn't done. */
      notRebuilt: count,
      /** Stores near what one object holds. */
      nearLimit: count,
    })
    .optional(),
  /**
   * What the Brain's model calls spent this month, by purpose. Core
   * always sends it; optional only so the admin reads a core of an older
   * release and shows the rest of its report.
   */
  modelSpend: brainModelSpendSchema.optional(),
});
export type BrainReport = z.infer<typeof brainReportSchema>;

/** The share of its limit from which a store is flagged: room left for repacks and rebuilds. */
export const storeNearLimitShare = 0.8;

/** Whether `store` is near enough its limit to need someone before writes fail. */
export const storeNearLimit = ({
  bytes,
  limitBytes,
}: BrainReport["store"]): boolean => bytes >= limitBytes * storeNearLimitShare;
