import { providerTroubles } from "@grasp-os/shared/ai-providers";
import { auditActorSchema, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { platformAiFeatures } from "@grasp-os/shared/platform-ai";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { DurableObject } from "cloudflare:workers";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { drainObjectOutbox } from "./audit-outbox.ts";
import { inList } from "./db/d1.ts";
import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/model-ledger/migrations/migrations.js";
import {
  auditOutbox,
  policy,
  providerHealth,
  requests,
  spend,
} from "./db/model-ledger/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import {
  fairnessSchema,
  maxAskAgainSeconds,
  maxLeaseMs,
} from "./model-admission.ts";
import type { Fairness, ModelShare } from "./model-admission.ts";
import { costMicros, microsPerDollar } from "./model-prices.ts";
import type { PinnedPrice } from "./model-prices.ts";
import { endedLineages, lineagesAsked } from "./run-lineage-ends.ts";

// The model ledger: what the deployment's model requests have spent, a
// Durable Object per deployment, whose storage orders every admission
// strictly. The gateway (models.ts) asks it to admit each provider
// request, every HTTP request, a retry too, before it is sent, and settles
// it once the request ends. Money is whole micros (model-prices.ts) at
// prices pinned to the request when it is admitted. Nothing here limits
// spend: clients pay their providers on their own keys, and admins read
// what was spent (model-spend.ts). Threat model, and how each is closed:
//
// - A run lineage escapes its limit of requests: its scope is keyed by the
//   lineage's root run, so a child run, a run beside it, a retry or a
//   restart counts against the same requests as the rest of the lineage,
//   and its count is kept under one period (`lineagePeriod`), so a new
//   month doesn't start it afresh either.
// - A lineage's request limit kept past a policy change: each admission
//   carries the limit of the policy in force (model-spend.ts) and is
//   checked against it; the lineage's row keeps only its count. An
//   admission under an older generation than one this ledger already saw
//   is refused (`policyBehind`), so nothing is admitted under an older
//   policy once an admission came under a newer one.
// - The ledger fails or can't be reached: the gateway sends nothing
//   unless its admission answered yes. An admission whose answer was lost
//   may have committed: the gateway settles it as `unsent` only if it
//   knows the request was never sent, and otherwise it is charged the
//   most it can cost when it comes due, never lost.
// - Usage is lost: the provider may bill what it already took. Such a
//   request is never counted as nothing: it is charged the most it can
//   cost (`unknown`) when it comes due (`reconcileAt`), on the object's
//   alarm, which outlives the request, the isolate and a restart. A
//   request whose gateway died before settling it is charged the same way.
// - An accepted stream is cut off, its caller talking on: it is charged
//   what it is known to have used (`cut`): the prompt as counted, or its
//   bound, and the answer as relayed, estimated within its cap.
// - A lineage's rows pruned while it can still make requests, or told
//   early that it ended: the alarm prunes a lineage's spend only once
//   core's own records of its runs (`workflow_runs`, which only core
//   writes) say every run of it ended a retention ago; nothing an App or
//   a run passes says so (run-lineage-ends.ts).
// - A request is settled twice, or an ID reused: a request settles once
//   (`state`), later settlements answer the first; an admission repeated
//   with the same input under its ID answers the first, and other input
//   under it is refused.
// - A request can't be read to settle: it is set aside (`quarantined`),
//   logged and audited, and charged nothing.
// - Spend crosses clients: each deployment's core has its own namespace
//   of this object, so no other client's requests reach this ledger.
//
// It also holds the client's requests in flight to fixed limits, in all
// and for one person, in the same transaction: a request's receipt is its
// lease on its slot. That threat model is model-admission.ts's.

/** The object's name: one ledger for the deployment. */
const ledgerName = "deployment";

/** How long a settled request's receipt is kept, for audit and recovery. */
const settledRetentionMs = 90 * 24 * 60 * 60 * 1000;

/** Most requests one alarm reconciles or sweeps at a time. */
const alarmPage = 100;

/** How long the alarm waits before delivering audit events again. */
const auditRetryMs = { first: 5000, most: 15 * 60 * 1000 };

/** How much later a request that failed to reconcile is tried again. */
const reconcileRetryMs = 60 * 60 * 1000;

/** How many failed tries at reconciling a request set it aside. */
const maxReconcileFailures = 3;

/** How often the alarm looks again for receipts to sweep, while any are kept. */
const sweepEveryMs = 24 * 60 * 60 * 1000;

const scopeNames = [
  "deployment",
  "workflow",
  "user",
  "run",
  // An App's model binding, by its App and alias (model-spend.ts).
  "binding",
  // Grasp's own AI features on Grasp's key (models.ts, `platformScopes`):
  // counted apart from every scope of the organization's own.
  "platform",
] as const;

/**
 * The period a run lineage's spend and requests are kept under,
 * whatever month its requests count in for the other scopes: a lineage
 * is counted for its whole life.
 */
const lineagePeriod = "lineage";

/** The period `scope`'s spend counts in, for a request of `period`. */
const periodOf = (scope: LedgerScopeName, period: string): string =>
  scope === "run" ? lineagePeriod : period;

/** Whose spend a scope counts. */
export type LedgerScopeName = (typeof scopeNames)[number];

const microsSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const scopeSchema = z.strictObject({
  scope: z.enum(scopeNames),
  key: z.string().min(1).max(512),
  /** The most requests it may admit; `null` for no limit. */
  limitRequests: z.int().positive().nullable().default(null),
});

/** One scope a request counts against. */
export type LedgerScope = z.input<typeof scopeSchema>;

const ratesShape = {
  input: microsSchema,
  output: microsSchema,
  cacheRead: microsSchema,
  cacheWrite: microsSchema,
};

const priceSchema = z.strictObject({
  version: z.string().min(1).max(128),
  ...ratesShape,
  /** Prices past a prompt size, lowest first (model-prices.ts). */
  tiers: z
    .array(z.strictObject({ inputTokensAbove: microsSchema, ...ratesShape }))
    .max(16)
    .default([]),
});

const periodPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

/**
 * The way a request goes, as recorded with it (models.ts): its transport,
 * the provider, the provider's region and whose key; identifiers only.
 */
const routeSchema = z.strictObject({
  transport: z.string().min(1).max(64),
  provider: z.string().min(1).max(32),
  region: z.string().min(1).max(32),
  credential: z.enum(["organization", "platform"]).optional(),
  /** Which of Grasp's own features a request on its key is for. */
  feature: z.enum(platformAiFeatures).optional(),
});

/** The way a request goes, as recorded with it. */
export type LedgerRoute = z.input<typeof routeSchema>;

/** A request's route as its row keeps it: nulls for one with none. */
const routeColumns = (
  route: z.output<typeof routeSchema> | undefined
): {
  transport: string | null;
  provider: string | null;
  region: string | null;
  credential: string | null;
  feature: string | null;
} => ({
  transport: route?.transport ?? null,
  provider: route?.provider ?? null,
  region: route?.region ?? null,
  credential: route?.credential ?? null,
  feature: route?.feature ?? null,
});

/** How a provider's requests fared last, by whose key: times in ms since the epoch. */
export interface ProviderHealth {
  provider: string;
  credential: string;
  lastOkAt: number | null;
  lastFailedAt: number | null;
  lastFailure: string | null;
  lastStatus: number | null;
  failingClass: string | null;
  failingSince: number | null;
}

/** What one model was charged for one feature on Grasp's keys in one month. */
export interface PlatformSpendByPeriod {
  period: string;
  /** The feature as recorded; null for a request without one. */
  feature: string | null;
  model: string;
  micros: number;
}

const admissionSchema = z
  .strictObject({
    /** The provider request's ID: one per HTTP request. */
    id: z.uuid(),
    /** The UTC month it counts in. */
    period: z.string().regex(periodPattern),
    /**
     * Each scope once, at most one of each kind the gateway counts (the
     * deployment, the workflow, the person, the run, a model binding).
     * Grasp's own
     * (`platform`) goes only with a run's, never beside the organization's.
     */
    scopes: z
      .array(scopeSchema)
      .min(1)
      .max(scopeNames.length - 1)
      .refine(
        (all) =>
          new Set(all.map(({ scope, key }) => `${scope}\n${key}`)).size ===
          all.length,
        { message: "Each scope once" }
      ),
    model: z.string().min(1).max(256),
    price: priceSchema,
    /**
     * The most the request can cost at its price: what it is charged
     * when its usage can't be known.
     */
    reservedMicros: microsSchema,
    actor: auditActorSchema,
    /** When the call is cut off at the latest, in ms since the epoch. */
    deadline: z.int().positive(),
    /**
     * When it is charged the most it can cost unless settled before, in
     * ms since the epoch.
     */
    reconcileAt: z.int().positive(),
    /**
     * How long after it is admitted it holds its shares of the requests in
     * flight at most, below {@link maxLeaseMs}: none for a live
     * transcription, whose socket stays open for minutes (models.ts,
     * `listen`). {@link maxLeaseMs} without one.
     */
    leaseMs: z.int().min(0).max(maxLeaseMs).optional(),
    /**
     * The generation of the quota policy its run lineage's request limit
     * comes from; none for a request with no lineage.
     */
    policyGeneration: z.int().min(0).optional(),
    /** Whose shares of the requests in flight it takes, and how many there are. */
    fair: fairnessSchema,
    /** The way it goes (`routeSchema`); none for a voice model's. */
    route: routeSchema.optional(),
  })
  .refine(({ deadline, reconcileAt }) => deadline <= reconcileAt, {
    message: "A request comes due no sooner than its deadline",
  });

/** A provider request to admit. */
export type Admission = z.input<typeof admissionSchema>;

/** Whether it was admitted, or why not. */
export type Admitted =
  | { ok: true }
  /** Its scope admitted as many requests as it may: refused, for good. */
  | { ok: false; scope: LedgerScopeName; requests: true }
  /**
   * Its quota policy generation is lower than one an admission already
   * carried: refused, to be asked again under the policy in force.
   */
  | { ok: false; policyBehind: true; highest: number }
  /**
   * Its ID was admitted before, for another request or one no longer
   * open: refused.
   */
  | { ok: false; reused: true }
  /**
   * A limit of the requests in flight it is held to is full: refused, to
   * ask again after `retryAfterSeconds` (model-admission.ts).
   */
  | {
      ok: false;
      queued: { waitingFor: ModelShare; retryAfterSeconds: number };
    };

const tokensSchema = z.strictObject({
  input: microsSchema,
  output: microsSchema,
  cacheRead: microsSchema,
  cacheWrite: microsSchema,
});

/**
 * What each way a request fails shows of its provider, by the HTTP class
 * seen (`ProviderTrouble`); none for a refusal of the request itself.
 */
const troubleClasses: Readonly<Record<string, string | undefined>> = {
  auth: "refused",
  quota: "limiting",
  rate_limited: "limiting",
  provider_down: "not_answering",
};

/** How a refused or failed request failed, for its provider's status. */
const failureSchema = z.strictObject({
  kind: z.enum(["auth", "quota", "rate_limited", "refused", "provider_down"]),
  status: z.int().min(100).max(599).optional(),
});

const settlementSchema = z.discriminatedUnion("by", [
  /** It ended, with the provider's whole count of what it used. */
  z.strictObject({ by: z.literal("usage"), tokens: tokensSchema }),
  /** The provider answered with a refusal before taking it on. */
  z.strictObject({
    by: z.literal("refused"),
    failure: failureSchema.optional(),
  }),
  /** It was never sent. */
  z.strictObject({ by: z.literal("unsent") }),
  /**
   * Its caller cut it off mid-answer: what it is known to have used by
   * then, partly estimated (models.ts). `shows`: what it showed of its
   * provider, when the provider was why (its deadline passed with the
   * answer still out), for the provider's status only, never its charge.
   */
  z.strictObject({
    by: z.literal("cut"),
    tokens: tokensSchema,
    shows: z.enum(providerTroubles).optional(),
  }),
  /** It was sent, and what it used can't be known. */
  z.strictObject({
    by: z.literal("unknown"),
    failure: failureSchema.optional(),
    /** What it showed of its provider, as for `cut`: an answer that broke off. */
    shows: z.enum(providerTroubles).optional(),
  }),
]);

/** How a provider request ended, as far as the gateway knows. */
export type Settlement = z.input<typeof settlementSchema>;

/** Where a request stands after a settlement. */
export type Settled =
  | { state: "settled"; chargedMicros: number }
  | { state: "unknown" }
  /** It couldn't be read to settle, and was charged nothing. */
  | { state: "quarantined" }
  | { state: "missing" };

/** What a scope spent in a month, for admins to read. */
export interface ScopeSpend {
  key: string;
  spentMicros: number;
}

/** A request as its row stores it. */
type RequestRow = typeof requests.$inferSelect;

/**
 * Whether a request on `credential` spends its money on `scope`: every
 * scope it counts in, but for a call on Grasp's own key (one of Grasp's
 * features), whose money is Grasp's alone. Such a call still counts as a
 * request in the organization's run scope (a lineage's limit of requests,
 * which bounds every call), but never as money there, so the
 * organization's spend shows only what its own keys cost.
 */
const spendsMoney = (
  scope: LedgerScopeName,
  credential: string | null
): boolean => credential !== "platform" || scope === "platform";

const storedScopesSchema = z.array(scopeSchema);

/** `text` as JSON; `undefined` when it isn't. */
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The prices `row` was pinned to; `undefined` when they can't be read. */
const pricesOf = (row: RequestRow): PinnedPrice | undefined =>
  priceSchema.safeParse(jsonOf(row.prices)).data;

/** The scopes `row` counts against; `undefined` when they can't be read. */
const scopesOf = (row: RequestRow): LedgerScope[] | undefined =>
  storedScopesSchema.safeParse(jsonOf(row.scopes)).data;

/**
 * Who `row` was made for, for the events it causes: the system when that
 * can't be read, so a request is still settled.
 */
const actorOf = (row: RequestRow): AuditActor =>
  auditActorSchema.safeParse(jsonOf(row.actor)).data ?? { type: "system" };

/** The deployment's model ledger, in the EU unless turned off. */
export const modelLedger = (
  env: Pick<Env, "MODEL_LEDGER" | "DURABLE_OBJECT_JURISDICTION">
) => inJurisdiction(env, env.MODEL_LEDGER).getByName(ledgerName);

/** The fingerprint of an admission: everything but its ID. */
const fingerprintOf = async ({
  id: _id,
  ...admission
}: z.output<typeof admissionSchema>): Promise<string> =>
  await sha256Hex(canonicalJson(admission));

export class ModelLedger extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  #auditRetryMs = auditRetryMs.first;

  /** Whether an audit event was stored since the outbox was last delivered. */
  #stored = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
    // On waking, the alarm is set for whatever waits on it: requests to
    // reconcile, receipts or ended lineages to sweep. A ledger whose last
    // alarm ended, and that no admission woke since, still prunes.
    void ctx.blockConcurrencyWhile(async () => {
      await this.#alarmForNext();
    });
  }

  /**
   * Admits one provider request before it is sent: counts it against
   * every one of its scopes in one transaction, or refuses it, counting
   * nothing, when a scope with a limit of requests has made them all, or
   * a share of the requests in flight it is held to is full. Admitting the
   * same request again answers yes without counting it twice.
   */
  async admit(input: Admission): Promise<Admitted> {
    const admission = admissionSchema.parse(input);
    const fingerprint = await fingerprintOf(admission);
    const actor = JSON.stringify(admission.actor);
    const now = Date.now();
    const admitted = this.ctx.storage.transactionSync((): Admitted => {
      const existing = this.#db
        .select({ fingerprint: requests.fingerprint, state: requests.state })
        .from(requests)
        .where(eq(requests.id, admission.id))
        .get();
      if (existing !== undefined) {
        // A repeat of the same admission, while its request is still open
        // and unsettled; never one that settled or whose usage was lost.
        // It holds the one lease it took: no second.
        return existing.fingerprint === fingerprint &&
          existing.state === "dispatched"
          ? { ok: true }
          : { ok: false, reused: true };
      }
      const highest =
        admission.policyGeneration === undefined
          ? undefined
          : this.#policyAhead(admission.policyGeneration);
      if (highest !== undefined) {
        return { ok: false, policyBehind: true, highest };
      }
      const { scopes } = admission;
      // No request comes back but one never sent: a scope out of requests
      // is refused for good.
      const counted = scopes.find(
        (scope) =>
          scope.limitRequests !== null &&
          this.#requestsOf(scope, admission.period) >= scope.limitRequests
      );
      if (counted !== undefined) {
        return { ok: false, scope: counted.scope, requests: true };
      }
      const full = this.#fullFor(admission.fair, now);
      if (full !== undefined) {
        return {
          ok: false,
          queued: { waitingFor: full, retryAfterSeconds: maxAskAgainSeconds },
        };
      }
      this.#db
        .insert(requests)
        .values({
          id: admission.id,
          fingerprint,
          period: admission.period,
          scopes: JSON.stringify(scopes),
          model: admission.model,
          priceVersion: admission.price.version,
          prices: JSON.stringify(admission.price),
          reservedMicros: admission.reservedMicros,
          state: "dispatched",
          actor,
          dispatchedAt: now,
          deadline: admission.deadline,
          reconcileAt: admission.reconcileAt,
          policyGeneration: admission.policyGeneration ?? null,
          subject: admission.fair.subject,
          leaseEndsAt: Math.min(
            admission.deadline,
            now + (admission.leaseMs ?? maxLeaseMs)
          ),
          ...routeColumns(admission.route),
        })
        .run();
      for (const { scope, key } of scopes) {
        this.#db
          .insert(spend)
          .values({
            scope,
            key,
            period: periodOf(scope, admission.period),
            requests: 1,
          })
          .onConflictDoUpdate({
            target: [spend.scope, spend.key, spend.period],
            set: { requests: sql`${spend.requests} + 1` },
          })
          .run();
      }
      return { ok: true };
    });
    if (admitted.ok) {
      await this.#alarmBy(admission.reconcileAt);
    }
    return admitted;
  }

  /**
   * Which limit of the requests in flight a request of `fair` finds full at
   * `now`, the client's or its person's; none when it fits. A request holds
   * its slot while in flight and before its lease ends. Inside the
   * transaction that admits it.
   */
  #fullFor(fair: Fairness, now: number): ModelShare | undefined {
    const held = this.#db
      .select({
        all: sql<number>`count(*)`,
        mine: sql<number>`coalesce(sum(${requests.subject} = ${fair.subject}), 0)`,
      })
      .from(requests)
      .where(
        and(eq(requests.state, "dispatched"), gt(requests.leaseEndsAt, now))
      )
      .get() ?? { all: 0, mine: 0 };
    if (held.all >= fair.shares.client) {
      return "client";
    }
    return held.mine >= fair.shares.person ? "person" : undefined;
  }

  /**
   * Settles one provider request: charges what its usage cost at its
   * pinned prices (one cut off mid-answer what it is known to have used),
   * or nothing when the provider refused it or it was never sent. A
   * request whose usage can't be known waits for reconciliation to charge
   * it the most it can cost. A request settles once; settling it again
   * answers how it settled.
   */
  async settle(id: string, input: Settlement): Promise<Settled> {
    const settlement = settlementSchema.parse(input);
    const settled = this.ctx.storage.transactionSync((): Settled => {
      const row = this.#db
        .select()
        .from(requests)
        .where(eq(requests.id, id))
        .get();
      if (row === undefined) {
        return { state: "missing" };
      }
      if (row.state === "settled") {
        return { state: "settled", chargedMicros: row.chargedMicros ?? 0 };
      }
      if (row.state === "quarantined") {
        return { state: "quarantined" };
      }
      // Once its usage was lost, only reconciliation closes it: no later
      // report, of any kind, settles it for less.
      if (row.state === "unknown") {
        return { state: "unknown" };
      }
      this.#noteProvider(row, settlement);
      if (settlement.by === "unknown") {
        this.#db
          .update(requests)
          .set({ state: "unknown" })
          .where(eq(requests.id, id))
          .run();
        return { state: "unknown" };
      }
      // A refusal or an unsent request costs nothing, prices or not. A
      // count whose prices can't be read is charged the most it can cost,
      // as reconciliation charges a count that was lost.
      const counted =
        settlement.by === "usage" || settlement.by === "cut"
          ? settlement.tokens
          : undefined;
      const prices = counted === undefined ? undefined : pricesOf(row);
      const unpriced = counted !== undefined && prices === undefined;
      let charged = 0;
      if (unpriced) {
        charged = row.reservedMicros;
      } else if (counted !== undefined && prices !== undefined) {
        charged = costMicros(prices, counted);
      }
      if (
        !this.#charge(row, charged, unpriced ? "reconciled" : settlement.by)
      ) {
        return { state: "quarantined" };
      }
      if (unpriced) {
        this.#outbox({
          actor: actorOf(row),
          action: "model.spend.reconciled",
          detail: {
            request: row.id,
            model: row.model,
            period: row.period,
            lost: "prices",
            charged: charged / microsPerDollar,
          },
        });
      }
      return { state: "settled", chargedMicros: charged };
    });
    this.#deliverIfStored();
    await Promise.resolve();
    return settled;
  }

  /**
   * Notes how a request of a provider ended, as it settles, by whose key:
   * worked once it ended with a count, failed once it was refused or
   * failed with a failure named. Nothing for one never sent, or with no
   * key of a provider's.
   */
  #noteProvider(
    {
      provider,
      credential,
    }: { provider: string | null; credential: string | null },
    settlement: z.output<typeof settlementSchema>
  ): void {
    if (provider === null || credential === null) {
      return;
    }
    const now = Date.now();
    let noted: Partial<typeof providerHealth.$inferInsert> | undefined =
      undefined;
    // What the provider shows: nothing once a request worked; for a
    // failure, its class, since the first failure of that class after the
    // last that worked. A refusal of the request itself (another 4xx)
    // says nothing of the provider, and leaves it as it was.
    let failing:
      | { failingClass: string | null; failingSince: SQL | number | null }
      | undefined = undefined;
    let inserted: { failingClass: string | null; failingSince: number | null } =
      { failingClass: null, failingSince: null };
    const shows =
      (settlement.by === "cut" || settlement.by === "unknown") &&
      settlement.shows !== undefined
        ? settlement.shows
        : undefined;
    if (shows !== undefined) {
      // The provider stopped answering, whatever the request is charged.
      noted = { lastFailedAt: now, lastFailure: "provider_down" };
      failing = {
        failingClass: shows,
        failingSince: sql`CASE WHEN ${providerHealth.failingClass} = ${shows} THEN coalesce(${providerHealth.failingSince}, ${now}) ELSE ${now} END`,
      };
      inserted = { failingClass: shows, failingSince: now };
    } else if (settlement.by === "usage" || settlement.by === "cut") {
      noted = { lastOkAt: now };
      failing = { failingClass: null, failingSince: null };
    } else if (
      (settlement.by === "refused" || settlement.by === "unknown") &&
      settlement.failure !== undefined
    ) {
      noted = {
        lastFailedAt: now,
        lastFailure: settlement.failure.kind,
        lastStatus: settlement.failure.status ?? null,
      };
      const trouble = troubleClasses[settlement.failure.kind];
      if (trouble !== undefined) {
        failing = {
          failingClass: trouble,
          failingSince: sql`CASE WHEN ${providerHealth.failingClass} = ${trouble} THEN coalesce(${providerHealth.failingSince}, ${now}) ELSE ${now} END`,
        };
        inserted = { failingClass: trouble, failingSince: now };
      }
    }
    if (noted === undefined) {
      return;
    }
    this.#db
      .insert(providerHealth)
      .values({ provider, credential, ...noted, ...inserted })
      .onConflictDoUpdate({
        target: [providerHealth.provider, providerHealth.credential],
        set: { ...noted, ...failing },
      })
      .run();
  }

  /**
   * Notes that the organization replaced `provider`'s key: its run of
   * failures, which the old key's refusals made, is over until a request
   * with the new key fails. When the last one failed stays.
   */
  async keyReplaced(provider: string): Promise<void> {
    await Promise.resolve();
    this.#db
      .update(providerHealth)
      .set({ failingClass: null, failingSince: null })
      .where(
        and(
          eq(providerHealth.provider, provider),
          eq(providerHealth.credential, "organization")
        )
      )
      .run();
  }

  /**
   * What Grasp's own features were charged on its keys in each of
   * `periods`, by feature and model: settled requests only, at what the
   * ledger charged them (list prices), none that came to nothing. Settled
   * requests are kept 90 days, past the month before this one.
   */
  async platformSpend(
    periods: readonly string[]
  ): Promise<PlatformSpendByPeriod[]> {
    await Promise.resolve();
    const charged = sql<number>`sum(${requests.chargedMicros})`;
    return this.#db
      .select({
        period: requests.period,
        feature: requests.feature,
        model: requests.model,
        micros: charged,
      })
      .from(requests)
      .where(
        and(
          eq(requests.credential, "platform"),
          eq(requests.state, "settled"),
          gt(requests.chargedMicros, 0),
          inArray(requests.period, [...periods])
        )
      )
      .groupBy(requests.period, requests.feature, requests.model)
      .orderBy(desc(charged))
      .all();
  }

  /** How each provider's requests fared last, by whose key (`providerHealth`). */
  async providerHealth(): Promise<ProviderHealth[]> {
    await Promise.resolve();
    return this.#db
      .select()
      .from(providerHealth)
      .orderBy(asc(providerHealth.provider), asc(providerHealth.credential))
      .all();
  }

  /**
   * The higher quota policy generation an earlier admission carried, which
   * an admission under `generation` is behind; none when it may go on, and
   * then it is recorded as the highest. Inside a transaction.
   */
  #policyAhead(generation: number): number | undefined {
    const highest = this.#db
      .select({ generation: policy.generation })
      .from(policy)
      .where(eq(policy.id, 0))
      .get()?.generation;
    if (highest !== undefined && highest > generation) {
      return highest;
    }
    if (highest === undefined || highest < generation) {
      this.#db
        .insert(policy)
        .values({ id: 0, generation })
        .onConflictDoUpdate({ target: policy.id, set: { generation } })
        .run();
    }
    return undefined;
  }

  /**
   * What each of `scopes` spent in `period` (a run lineage: in its whole
   * life), most spent first, at most `limit` each; ties by key,
   * descending.
   */
  async spendOf(
    period: string,
    scopes: readonly LedgerScopeName[],
    limit: number
  ): Promise<Record<string, ScopeSpend[]>> {
    const read: Record<string, ScopeSpend[]> = {};
    for (const scope of scopes) {
      read[scope] = this.#db
        .select({ key: spend.key, spentMicros: spend.spentMicros })
        .from(spend)
        .where(
          and(eq(spend.scope, scope), eq(spend.period, periodOf(scope, period)))
        )
        .orderBy(desc(spend.spentMicros), desc(spend.key))
        .limit(limit)
        .all();
    }
    await Promise.resolve();
    return read;
  }

  /**
   * What `scope` spent in `period` under each of `keys`, for the keys that
   * spent anything: the named ones only, however many the scope has. The
   * keys go to SQLite as one parameter (`inList`).
   */
  async spendOfKeys(
    period: string,
    scope: LedgerScopeName,
    keys: readonly string[]
  ): Promise<ScopeSpend[]> {
    await Promise.resolve();
    if (keys.length === 0) {
      return [];
    }
    return this.#db
      .select({ key: spend.key, spentMicros: spend.spentMicros })
      .from(spend)
      .where(
        and(
          eq(spend.scope, scope),
          eq(spend.period, periodOf(scope, period)),
          inList(spend.key, keys)
        )
      )
      .all();
  }

  /**
   * Reconciles every request that came due without a settlement, charging
   * each the most it can cost; sweeps receipts past their retention; delivers
   * the audit events waiting; and sets itself again for what is next.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let reconciled = 0;
    for (;;) {
      const due = this.#db
        .select()
        .from(requests)
        .where(
          and(
            inArray(requests.state, ["dispatched", "unknown"]),
            lte(requests.reconcileAt, now)
          )
        )
        .orderBy(asc(requests.reconcileAt))
        .limit(alarmPage)
        .all();
      // Whether any row of this page was settled, put off or set aside: a
      // page where none was would be read again as it is.
      let progressed = false;
      for (const row of due) {
        // One row that fails is set aside, never left to stop the rest.
        try {
          const charged = this.ctx.storage.transactionSync(() => {
            if (!this.#charge(row, row.reservedMicros, "reconciled")) {
              return false;
            }
            this.#outbox({
              actor: actorOf(row),
              action: "model.spend.reconciled",
              detail: {
                request: row.id,
                model: row.model,
                period: row.period,
                lost: row.state === "unknown" ? "usage" : "settlement",
                charged: row.reservedMicros / microsPerDollar,
              },
            });
            return true;
          });
          reconciled += charged ? 1 : 0;
          progressed = true;
        } catch (error) {
          log.error("model.reconcile_failed", {
            ...errorFields(error),
            request: row.id,
          });
          progressed = this.#failedToReconcile(row, now) || progressed;
        }
      }
      if (due.length < alarmPage || !progressed) {
        break;
      }
    }
    if (reconciled > 0) {
      log.warn("model.spend_reconciled", { requests: reconciled });
    }
    this.#sweep(now);
    try {
      await this.#pruneLineages(now);
    } catch (error) {
      // Tried again on the next sweep: nothing is lost by keeping them.
      log.error("model.lineage_prune_failed", errorFields(error));
    }
    await this.#drainAudit();
    await this.#alarmForNext();
  }

  /**
   * Deletes the spend of run lineages that have ended, every run of each,
   * at least {@link settledRetentionMs} ago, and that are past the oldest
   * any lineage may grow (the platform's `workflowAgeMs`), as core's own
   * records of the runs say (`endedLineages`): nothing an App or a run
   * passes, so no lineage is ended early, and none is pruned while a late
   * delivery could still start a run in it, whose requests would then
   * count again from nothing. A page of lineages at a time, in key order,
   * so a page of live ones holds up none after it.
   */
  async #pruneLineages(now: number): Promise<void> {
    let after = "";
    for (;;) {
      const page = this.#prunable(after);
      if (page.length === 0) {
        return;
      }
      after = page.at(-1) ?? after;
      // oxlint-disable-next-line no-await-in-loop -- a page at a time
      const ended = await endedLineages(this.env, page, {
        endedBy: now - settledRetentionMs,
        // Past it no run starts in the lineage again (workflows/quotas.ts,
        // `admitChild`): a late delivery of a run's mail starts none whose
        // spend would count from nothing. The platform's, which no quota
        // policy raises.
        startedBy: now - platformLimits.workflowAgeMs,
      });
      if (ended.size > 0) {
        this.#db
          .delete(spend)
          .where(
            and(
              eq(spend.scope, "run"),
              eq(spend.period, lineagePeriod),
              inArray(spend.key, [...ended])
            )
          )
          .run();
        log.info("model.lineages_pruned", { lineages: ended.size });
      }
      if (page.length < lineagesAsked) {
        return;
      }
    }
  }

  /**
   * Run lineages past `after` in key order, at most {@link lineagesAsked}:
   * the ones that may be pruned once ended.
   */
  #prunable(after: string): string[] {
    return this.#db
      .select({ key: spend.key })
      .from(spend)
      .where(
        and(
          eq(spend.scope, "run"),
          eq(spend.period, lineagePeriod),
          gt(spend.key, after)
        )
      )
      .orderBy(asc(spend.key))
      .limit(lineagesAsked)
      .all()
      .map(({ key }) => key);
  }

  /** Deletes settled receipts past their retention, a page at a time. */
  #sweep(now: number): void {
    for (;;) {
      const expired = this.#db
        .select({ id: requests.id })
        .from(requests)
        .where(
          and(
            eq(requests.state, "settled"),
            isNotNull(requests.settledAt),
            lte(requests.settledAt, now - settledRetentionMs)
          )
        )
        .limit(alarmPage)
        .all();
      if (expired.length === 0) {
        return;
      }
      const ids = expired.map(({ id }) => id);
      this.#db.delete(requests).where(inArray(requests.id, ids)).run();
      if (expired.length < alarmPage) {
        return;
      }
    }
  }

  /** Sets the alarm for the next request due, or the next sweep. */
  async #alarmForNext(): Promise<void> {
    const next = this.#db
      .select({ at: requests.reconcileAt })
      .from(requests)
      .where(inArray(requests.state, ["dispatched", "unknown"]))
      .orderBy(asc(requests.reconcileAt))
      .limit(1)
      .get();
    const kept = this.#db
      .select({ id: requests.id })
      .from(requests)
      .where(eq(requests.state, "settled"))
      .limit(1)
      .get();
    // A lineage's spend is pruned on a sweep, receipts or not.
    const lineage = this.#db
      .select({ key: spend.key })
      .from(spend)
      .where(and(eq(spend.scope, "run"), eq(spend.period, lineagePeriod)))
      .limit(1)
      .get();
    const times = [
      next?.at,
      kept === undefined && lineage === undefined
        ? undefined
        : Date.now() + sweepEveryMs,
    ].filter((time) => time !== undefined);
    if (times.length > 0) {
      await this.#alarmBy(Math.min(...times));
    }
  }

  /** The requests `scope` admitted for a request of `period`. */
  #requestsOf({ scope, key }: LedgerScope, period: string): number {
    return (
      this.#db
        .select({ requests: spend.requests })
        .from(spend)
        .where(
          and(
            eq(spend.scope, scope),
            eq(spend.key, key),
            eq(spend.period, periodOf(scope, period))
          )
        )
        .get()?.requests ?? 0
    );
  }

  /**
   * Settles `row` at `charged`, adding it to the spend of each of its
   * scopes. Inside a transaction. False when its scopes can't be read: it
   * is set aside instead.
   */
  #charge(
    row: RequestRow,
    charged: number,
    by: "usage" | "cut" | "refused" | "unsent" | "reconciled"
  ): boolean {
    const scopes = scopesOf(row);
    if (scopes === undefined) {
      this.#quarantine(row);
      return false;
    }
    const changed = this.#db
      .update(requests)
      .set({
        state: "settled",
        chargedMicros: charged,
        settledBy: by,
        settledAt: Date.now(),
      })
      .where(
        and(
          eq(requests.id, row.id),
          inArray(requests.state, ["dispatched", "unknown"])
        )
      )
      .returning({ id: requests.id })
      .all();
    if (changed.length === 0) {
      return true;
    }
    for (const { scope, key } of scopes) {
      const money = spendsMoney(scope, row.credential);
      this.#db
        .update(spend)
        .set({
          spentMicros: sql`${spend.spentMicros} + ${money ? charged : 0}`,
          // A request never sent wasn't made: its count comes back.
          ...(by === "unsent"
            ? { requests: sql`max(${spend.requests} - 1, 0)` }
            : {}),
        })
        .where(
          and(
            eq(spend.scope, scope),
            eq(spend.key, key),
            eq(spend.period, periodOf(scope, row.period))
          )
        )
        .run();
    }
    return true;
  }

  /**
   * Sets aside a request that can't be read to settle: charged nothing,
   * logged and audited. Never throws: it is the fallback.
   */
  #quarantine(row: RequestRow): void {
    log.error("model.request_quarantined", { request: row.id });
    const changed = this.#db
      .update(requests)
      .set({ state: "quarantined" })
      .where(
        and(
          eq(requests.id, row.id),
          inArray(requests.state, ["dispatched", "unknown"])
        )
      )
      .returning({ id: requests.id })
      .all();
    if (changed.length > 0) {
      this.#outbox({
        actor: actorOf(row),
        action: "model.spend.quarantined",
        detail: { request: row.id, model: row.model, period: row.period },
      });
    }
  }

  /**
   * Counts a failed try at reconciling `row`: it is tried again a while
   * from `now`, and after {@link maxReconcileFailures} tries it is set
   * aside, audited. Whether that could
   * be written; never throws.
   */
  #failedToReconcile(row: RequestRow, now: number): boolean {
    const failures = row.reconcileFailures + 1;
    try {
      this.ctx.storage.transactionSync(() => {
        this.#db
          .update(requests)
          .set({
            reconcileFailures: failures,
            reconcileAt: now + reconcileRetryMs,
          })
          .where(eq(requests.id, row.id))
          .run();
        if (failures >= maxReconcileFailures) {
          this.#quarantine(row);
        }
      });
      return true;
    } catch (error) {
      log.error("model.reconcile_retry_failed", {
        ...errorFields(error),
        request: row.id,
      });
      return false;
    }
  }

  /** Stores `entry`'s event in the object's outbox. Inside a transaction. */
  /** Delivers the outbox in the background if anything stored an event since the last delivery. */
  #deliverIfStored(): void {
    if (this.#stored) {
      this.#stored = false;
      this.#deliverAudit();
    }
  }

  #outbox(entry: AuditEntry): void {
    this.#stored = true;
    const event = createAuditEvent(entry, "core");
    this.#db
      .insert(auditOutbox)
      .values({
        id: event.id,
        event: JSON.stringify(event),
        createdAt: new Date(),
      })
      .run();
  }

  /** Delivers the outbox's events to the audit log now, in the background. */
  #deliverAudit(): void {
    this.ctx.waitUntil(this.#drainAudit());
  }

  /**
   * Drains the outbox; while any events are left (the log out of reach),
   * the alarm tries again, waiting longer each time.
   */
  async #drainAudit(): Promise<void> {
    const left = await drainObjectOutbox(this.env, this.ctx.storage.sql);
    if (left === 0) {
      this.#auditRetryMs = auditRetryMs.first;
      return;
    }
    const retryMs = this.#auditRetryMs;
    this.#auditRetryMs = Math.min(retryMs * 2, auditRetryMs.most);
    await this.#alarmBy(Date.now() + retryMs);
  }

  /** Sets the alarm to go at `time` at the latest, never later than it was. */
  async #alarmBy(time: number): Promise<void> {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > time) {
      await this.ctx.storage.setAlarm(time);
    }
  }
}
