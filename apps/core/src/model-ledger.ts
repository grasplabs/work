import {
  auditActorSchema,
  auditDetailMaxKeys,
  auditIdentifierMaxLength,
  createAuditEvent,
} from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
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
import { drizzle } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import { drainObjectOutbox } from "./audit-outbox.ts";
import { migrateOnWake } from "./db/migrate.ts";
import migrations from "./db/model-ledger/migrations/migrations.js";
import {
  alerts,
  auditOutbox,
  requestScopes,
  requests,
  spend,
} from "./db/model-ledger/schema.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { costMicros, microsPerDollar } from "./model-prices.ts";
import type { PinnedPrice } from "./model-prices.ts";
import { endedLineages, lineagesAsked } from "./run-lineage-ends.ts";

// The model ledger: the one authority for what the deployment's model
// requests may spend and have spent, a Durable Object per deployment,
// whose storage orders every admission strictly. The gateway (models.ts)
// asks it to admit each provider request, every HTTP request, a retry
// too, before it is sent, and settles it once the request ends. Money is
// whole micros (model-prices.ts) at prices pinned to the request when it
// is admitted. Threat model, and how each is closed:
//
// - Concurrent requests overspend a budget: an admission reserves the
//   request's most possible cost (its bound) against every one of its
//   scopes (the deployment, the workflow, the person, the run lineage, a
//   model binding's month and day) in one synchronous transaction that
//   first checks each scope's spend plus what is reserved plus the bound
//   against its limit, and its requests against its request limit.
//   Nothing else runs in between, so
//   reservations never oversubscribe a limit, and a scope without room
//   refuses the whole request: no partial reservation.
// - A run lineage escapes its limits: its scope is keyed by the lineage's
//   root run, so a child run, a run beside it, a retry or a restart counts
//   against the same spend and requests as the rest of the lineage, and
//   its spend and alerts are kept under one period (`lineagePeriod`), so
//   a new month doesn't start it afresh either. Each request records, per
//   scope, the period it reserved against (`request_scopes.period`), and
//   settles, is rebuilt and is summed against exactly that, never one
//   worked out again later: so a request settles against what it
//   reserved, whatever later releases change. One admitted before periods
//   were recorded reserved every scope under its own month, a run's on
//   the run's monthly row, and settles there, never on a lineage's row. A
//   lineage whose spend row was lost lost its request count too: rebuilt,
//   it is used up.
// - The ledger fails or can't be reached: the gateway sends nothing
//   unless its admission answered yes. An admission whose answer was lost
//   may have committed: the gateway releases it only if it knows the
//   request was never sent (`unsent`), and otherwise it is charged in
//   full when it comes due, never lost.
// - Usage is lost, or an accepted stream is cancelled: the provider may
//   bill what it already took, and an accepted request can go on after
//   it is cancelled. Such a request is never charged nothing: its whole
//   reservation stays held (`unknown`), and reconciliation charges it in
//   full when it comes due (`reconcileAt`), on the object's alarm, which
//   outlives the request, the isolate and a restart. A request whose
//   gateway died before settling it is charged the same way.
// - A retry releases an unknown earlier cost: every provider request has
//   its own ID and reservation; a retry is admitted, reserved and settled
//   on its own, and nothing settles one request by another's outcome.
// - A lineage's rows pruned while it can still spend, or told early that
//   it ended: the alarm prunes a lineage's spend and alerts only once
//   core's own records of its runs (`workflow_runs`, which only core
//   writes) say every run of it ended a retention ago, and no open
//   request reserves against it; nothing an App or a run passes says so
//   (run-lineage-ends.ts).
// - A request is settled twice, or an ID reused: a request settles once
//   (`state`), later settlements answer the first; an admission repeated
//   with the same input under its ID answers the first, and other input
//   under it is refused. A release that would leave a scope's
//   reservations below nothing is refused by the database (`CHECK`).
// - A request is held because its spend is damaged (that `CHECK` failed,
//   or a scope's spend is gone): a person can still release it, which
//   rebuilds what a damaged scope holds from the open requests on it, so
//   theirs isn't lost with it, audited with each damaged scope; it is
//   never charged (`resolveQuarantined`).
// - A person decides a request someone already decided: the first
//   decision stands, and the second is answered with it, never as done.
// - A model with no safe price or output bound: the gateway admits no
//   such request against a budget (model-prices.ts); its price and bound
//   are pinned here when admitted, so a later catalog never reprices it.
// - Duplicate alerts or audit entries: an alert's row is keyed by scope,
//   month, kind and threshold value, and its event is stored in this
//   object's outbox only when that insert added the row, in the same
//   transaction as the spend that reached it.
// - Spend crosses clients: each deployment's core has its own namespace
//   of this object, so no other client's requests reach this ledger.
// - A refusal tells a caller about other people's requests: a scope held
//   only by requests under way answers which scopes are full and when the
//   soonest request under way in each reaches its deadline, and nothing
//   else of them (whose, which model, how much, how many). The gateway
//   passes on a wait derived from that time only when every full scope
//   is the caller's own (their user scope, their run); for a shared scope
//   it passes on a fixed wait, and to a guest, whose user scope is the
//   member who invited them, it says only that the budget is used up
//   (models.ts).

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

/** How many failed tries at reconciling a request set it aside for a person. */
const maxReconcileFailures = 3;

/**
 * The members a decision's audit event has besides its damaged scopes:
 * `request`, `model`, `period`, `charged` and `damaged`.
 */
const decisionMembers = 5;

/**
 * The detail members a decision's audit event may spend on its damaged
 * scopes, four or five each (`damaged.N.requests` only for a lineage
 * recreated used up): whole scopes are listed while they fit, so the event
 * stays within its limit however many scopes stored data names, and
 * `damaged` counts all.
 */
const damagedMembers = auditDetailMaxKeys - decisionMembers;

/** How often the alarm looks again for receipts to sweep, while any are kept. */
const sweepEveryMs = 24 * 60 * 60 * 1000;

const scopeNames = [
  "deployment",
  "workflow",
  "user",
  "run",
  "binding",
  "binding_day",
] as const;

/**
 * The period a run lineage's spend, requests and alerts are kept under,
 * whatever month its requests count in for the other scopes: a lineage
 * is counted for its whole life.
 */
const lineagePeriod = "lineage";

/** The period `scope`'s spend counts in, for a request of `period`. */
const periodOf = (scope: LedgerScopeName, period: string): string =>
  scope === "run" ? lineagePeriod : period;

/**
 * The period a request reserved against for one of its scopes: the one
 * its admission recorded, or, for a request admitted before periods were
 * recorded, its own month, which is what every one of its scopes then
 * reserved under (a run's too, on the run's monthly row).
 */
const reservedPeriod = (
  kept: { period: string | null },
  row: { period: string }
): string => kept.period ?? row.period;

/** `reservedPeriod` in SQL, over a request joined to its scopes. */
const reservedPeriodSql = sql`coalesce(${requestScopes.period}, ${requests.period})`;

/** Whose spend a scope counts. */
export type LedgerScopeName = (typeof scopeNames)[number];

const microsSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const scopeSchema = z.strictObject({
  scope: z.enum(scopeNames),
  key: z.string().min(1).max(512),
  /** The most it may spend this month; `null` without a budget: counted only. */
  limitMicros: microsSchema.nullable(),
  /** Where admins are alerted; `null` without a budget. */
  alertMicros: microsSchema.nullable(),
  /** The most requests it may admit; `null` for no limit. */
  limitRequests: z.int().positive().nullable().default(null),
  /** What its alerts name, as audit detail: the workflow or the person. */
  names: z.record(z.string(), z.string()),
});

/** One scope a request counts against, with its budget when admitted. */
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

const admissionSchema = z
  .strictObject({
    /** The provider request's ID: one per HTTP request. */
    id: z.uuid(),
    /** The UTC month it counts in. */
    period: z.string().regex(periodPattern),
    /**
     * Each scope once, at most one of each kind the gateway counts (the
     * deployment, the workflow, the person, the run, a model binding's
     * month and day): a bound that also keeps a decision's audit event
     * within its detail limit.
     */
    scopes: z
      .array(scopeSchema)
      .min(1)
      .max(scopeNames.length)
      .refine(
        (all) =>
          new Set(all.map(({ scope, key }) => `${scope}\n${key}`)).size ===
          all.length,
        { message: "Each scope once" }
      ),
    model: z.string().min(1).max(256),
    price: priceSchema,
    /** The most the request can cost at its price. */
    reservedMicros: microsSchema,
    actor: auditActorSchema,
    /**
     * When the call is cut off at the latest, in ms since the epoch: until
     * then it may settle for less than it reserved.
     */
    deadline: z.int().positive(),
    /** When it is charged in full unless settled before, in ms since the epoch. */
    reconcileAt: z.int().positive(),
  })
  .refine(({ deadline, reconcileAt }) => deadline <= reconcileAt, {
    message: "A request comes due no sooner than its deadline",
  });

/** A provider request to admit. */
export type Admission = z.input<typeof admissionSchema>;

/**
 * Whether it was admitted, or which scope has no room. A refusal with
 * `heldUntil` is one whose room is held only by requests still under way,
 * which may settle for less than they reserved: `heldBy` names every
 * scope without room, and `heldUntil` is when room is hoped back, in ms
 * since the epoch (`#refusal`). Without it, spend leaves no room.
 */
export type Admitted =
  | { ok: true }
  | { ok: false; scope: LedgerScopeName }
  | {
      ok: false;
      scope: LedgerScopeName;
      heldBy: LedgerScopeName[];
      heldUntil: number;
    }
  /** It admitted as many requests as it may: refused, for good. */
  | { ok: false; scope: LedgerScopeName; requests: true }
  /**
   * Its ID was admitted before, for another request or one no longer
   * open: refused, reserving nothing.
   */
  | { ok: false; reused: true }
  /** No price for its input or output, against a budget: refused. */
  | { ok: false; unpriced: true };

const tokensSchema = z.strictObject({
  input: microsSchema,
  output: microsSchema,
  cacheRead: microsSchema,
  cacheWrite: microsSchema,
});

const settlementSchema = z.discriminatedUnion("by", [
  /** It ended, with the provider's whole count of what it used. */
  z.strictObject({ by: z.literal("usage"), tokens: tokensSchema }),
  /** The provider answered with a refusal before taking it on. */
  z.strictObject({ by: z.literal("refused") }),
  /** It was never sent. */
  z.strictObject({ by: z.literal("unsent") }),
  /** It was sent, and what it used can't be known. */
  z.strictObject({ by: z.literal("unknown") }),
]);

/** How a provider request ended, as far as the gateway knows. */
export type Settlement = z.input<typeof settlementSchema>;

/** Where a request stands after a settlement. */
export type Settled =
  | { state: "settled"; chargedMicros: number }
  | { state: "unknown" }
  /** It couldn't be read to settle, and holds its reservation. */
  | { state: "quarantined" }
  | { state: "missing" };

/** What a person decides about a held request. */
export type HeldHow = "release" | "charge";

/**
 * What a person's decision on a held request came to: `decided` now, at
 * what it charged; `already_decided` by an earlier decision, someone
 * else's maybe, which stands, with what it decided and when; and
 * `release_only` for a charge refused on a request whose spend is damaged,
 * still held. `not_held` for a request that exists but was never set aside
 * (the gateway settled it); `missing` for none.
 */
export type Decided =
  | { state: "decided"; how: HeldHow; chargedMicros: number }
  | {
      state: "already_decided";
      how: HeldHow;
      chargedMicros: number;
      decidedAt: number;
    }
  | { state: "release_only" }
  | { state: "not_held" }
  | { state: "missing" };

const namesSchema = z.record(z.string(), z.string());

/** A request set aside because it couldn't be read, for a person to settle. */
export interface QuarantinedRequest {
  id: string;
  model: string;
  period: string;
  reservedMicros: number;
  dispatchedAt: number;
  /** Its spend is damaged: it can only be released (`resolveQuarantined`). */
  releaseOnly: boolean;
}

/** What a scope spent and holds in a month, for admins to read. */
export interface ScopeSpend {
  key: string;
  spentMicros: number;
  reservedMicros: number;
}

/** A request as its row stores it. */
type RequestRow = typeof requests.$inferSelect;

const storedScopesSchema = z.array(scopeSchema);

/** The two thresholds a budget alerts at. */
const thresholds = [
  { kind: "alert", of: (scope: LedgerScope) => scope.alertMicros },
  { kind: "exhausted", of: (scope: LedgerScope) => scope.limitMicros },
] as const;

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

/** The scopes `row` reserved against; `undefined` when they can't be read. */
const scopesOf = (row: RequestRow): LedgerScope[] | undefined =>
  storedScopesSchema.safeParse(jsonOf(row.scopes)).data;

/**
 * Who `row` was made for, for the events it causes: the system when that
 * can't be read, so a request is still settled and alerted on.
 */
const actorOf = (row: RequestRow): AuditActor =>
  auditActorSchema.safeParse(jsonOf(row.actor)).data ?? { type: "system" };

/**
 * What an earlier decision on `row` came to, for a later one: the decision
 * that stands when a person settled it, and `not_held` when it was never
 * held for one (still under way, or settled by the gateway).
 */
const decidedBefore = (row: RequestRow): Decided => {
  if (
    row.state !== "settled" ||
    (row.settledBy !== "released" && row.settledBy !== "charged")
  ) {
    return { state: "not_held" };
  }
  return {
    state: "already_decided",
    how: row.settledBy === "charged" ? "charge" : "release",
    chargedMicros: row.chargedMicros ?? 0,
    decidedAt: row.settledAt ?? 0,
  };
};

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
   * Admits one provider request before it is sent: reserves its most
   * possible cost against every one of its scopes in one transaction, or
   * refuses it, reserving nothing, when any scope with a limit lacks room
   * for it. Alerts admins first to every threshold a scope's spend has
   * reached without an alert (a limit lowered below this month's spend).
   * Admitting the same request again answers yes without reserving twice.
   */
  async admit(input: Admission): Promise<Admitted> {
    const admission = admissionSchema.parse(input);
    const fingerprint = await fingerprintOf(admission);
    const actor = JSON.stringify(admission.actor);
    const now = Date.now();
    const { admitted } = this.ctx.storage.transactionSync(() => {
      const existing = this.#db
        .select({ fingerprint: requests.fingerprint, state: requests.state })
        .from(requests)
        .where(eq(requests.id, admission.id))
        .get();
      if (existing !== undefined) {
        // A repeat of the same admission, while its request is still open
        // and unsettled; never one that settled or whose usage was lost.
        return {
          admitted:
            existing.fingerprint === fingerprint &&
            existing.state === "dispatched"
              ? ({ ok: true } as const)
              : ({ ok: false, reused: true } as const),
          alerted: 0,
        };
      }
      const { price } = admission;
      const unpriced = [price, ...price.tiers].some(
        (rates) => rates.input === 0 || rates.output === 0
      );
      if (
        unpriced &&
        admission.scopes.some(({ limitMicros }) => limitMicros !== null)
      ) {
        return { admitted: { ok: false, unpriced: true } as const, alerted: 0 };
      }
      const rows = admission.scopes.map((scope) => ({
        scope,
        row: this.#spendOf(scope, admission.period),
      }));
      // No request comes back but one never sent: a scope out of requests
      // is refused whatever its spend.
      const counted = rows.find(
        ({ scope, row }) =>
          scope.limitRequests !== null && row.requests >= scope.limitRequests
      );
      if (counted !== undefined) {
        return {
          admitted: {
            ok: false,
            scope: counted.scope.scope,
            requests: true,
          } as const,
          alerted: 0,
        };
      }
      let alertedNow = 0;
      for (const { scope, row } of rows) {
        alertedNow += this.#alert(
          scope,
          admission.period,
          row.spentMicros,
          admission.actor
        );
      }
      const full = rows.filter(
        ({ scope, row }) =>
          scope.limitMicros !== null &&
          row.spentMicros + row.reservedMicros + admission.reservedMicros >
            scope.limitMicros
      );
      if (full.length > 0) {
        return {
          admitted: this.#refusal(
            full,
            admission.period,
            admission.reservedMicros,
            now
          ),
          alerted: alertedNow,
        };
      }
      this.#db
        .insert(requests)
        .values({
          id: admission.id,
          fingerprint,
          period: admission.period,
          scopes: JSON.stringify(admission.scopes),
          model: admission.model,
          priceVersion: admission.price.version,
          prices: JSON.stringify(admission.price),
          reservedMicros: admission.reservedMicros,
          state: "dispatched",
          actor,
          dispatchedAt: now,
          deadline: admission.deadline,
          reconcileAt: admission.reconcileAt,
        })
        .run();
      for (const {
        scope,
        key,
        limitMicros,
        alertMicros,
        limitRequests,
        names,
      } of admission.scopes) {
        this.#db
          .insert(requestScopes)
          .values({
            requestId: admission.id,
            scope,
            key,
            limitMicros,
            alertMicros,
            names: JSON.stringify(names),
            period: periodOf(scope, admission.period),
            limitRequests: limitRequests ?? null,
          })
          .run();
        this.#db
          .insert(spend)
          .values({
            scope,
            key,
            period: periodOf(scope, admission.period),
            reservedMicros: admission.reservedMicros,
            requests: 1,
          })
          .onConflictDoUpdate({
            target: [spend.scope, spend.key, spend.period],
            set: {
              reservedMicros: sql`${spend.reservedMicros} + excluded.reserved_micros`,
              requests: sql`${spend.requests} + 1`,
            },
          })
          .run();
      }
      return { admitted: { ok: true } as const, alerted: alertedNow };
    });
    if (admitted.ok) {
      await this.#alarmBy(admission.reconcileAt);
    }
    this.#deliverIfStored();
    return admitted;
  }

  /**
   * Settles one provider request: charges what its usage cost at its
   * pinned prices, or nothing when the provider refused it or it was
   * never sent, and releases its reservation. A request whose usage
   * can't be known keeps its whole reservation until reconciliation
   * charges it in full. A request settles once; settling it again
   * answers how it settled.
   */
  async settle(id: string, input: Settlement): Promise<Settled> {
    const settlement = settlementSchema.parse(input);
    const { settled } = this.ctx.storage.transactionSync(() => {
      const row = this.#db
        .select()
        .from(requests)
        .where(eq(requests.id, id))
        .get();
      if (row === undefined) {
        return { settled: { state: "missing" } as const, alerted: 0 };
      }
      if (row.state === "settled") {
        return {
          settled: {
            state: "settled",
            chargedMicros: row.chargedMicros ?? 0,
          } as const,
          alerted: 0,
        };
      }
      if (row.state === "quarantined") {
        return { settled: { state: "quarantined" } as const, alerted: 0 };
      }
      // Once its usage was lost, only reconciliation closes it: no later
      // report, of any kind, releases what it holds.
      if (row.state === "unknown") {
        return { settled: { state: "unknown" } as const, alerted: 0 };
      }
      if (settlement.by === "unknown") {
        this.#db
          .update(requests)
          .set({ state: "unknown" })
          .where(eq(requests.id, id))
          .run();
        return { settled: { state: "unknown" } as const, alerted: 0 };
      }
      // A refusal or an unsent request costs nothing, prices or not. A
      // count whose prices can't be read is charged the whole reservation,
      // as reconciliation charges a count that was lost.
      const prices = settlement.by === "usage" ? pricesOf(row) : undefined;
      const unpriced = settlement.by === "usage" && prices === undefined;
      let charged = 0;
      if (unpriced) {
        charged = row.reservedMicros;
      } else if (settlement.by === "usage" && prices !== undefined) {
        charged = costMicros(prices, settlement.tokens);
      }
      const alertedNow = this.#charge(
        row,
        charged,
        unpriced ? "reconciled" : settlement.by
      );
      if (unpriced && alertedNow !== "quarantined") {
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
      return alertedNow === "quarantined"
        ? { settled: { state: "quarantined" } as const, alerted: 0 }
        : {
            settled: { state: "settled", chargedMicros: charged } as const,
            alerted: alertedNow,
          };
    });
    this.#deliverIfStored();
    await Promise.resolve();
    return settled;
  }

  /** The requests set aside because they couldn't be read, oldest first, at most `limit`. */
  async quarantined(limit: number): Promise<QuarantinedRequest[]> {
    const rows = this.#db
      .select({
        id: requests.id,
        model: requests.model,
        period: requests.period,
        reservedMicros: requests.reservedMicros,
        dispatchedAt: requests.dispatchedAt,
      })
      .from(requests)
      .where(eq(requests.state, "quarantined"))
      .orderBy(asc(requests.dispatchedAt))
      .limit(limit)
      .all();
    const listed = rows.map((row) => ({
      ...row,
      releaseOnly: this.#heldScopes(row).some(({ damaged }) => damaged),
    }));
    await Promise.resolve();
    return listed;
  }

  /**
   * Settles a quarantined request as a person decided: releases what it
   * holds, or charges all of it, against the scopes its admission
   * recorded apart from its JSON (`request_scopes`), and audits who did,
   * in one transaction. A request already decided is left as it is, and
   * answered with that decision.
   *
   * A request can be held because its spend is damaged: a scope's spend
   * row missing, or holding less than the request reserved, which only
   * the ledger's own data going wrong leaves behind. Settling it as usual
   * would take that spend below nothing, which the `CHECK` refuses, so it
   * would stay held until the month rolled over. Such a request can only
   * be released. Each damaged scope's reservation is then rebuilt from the
   * ledger's own records, what the other open requests on it reserve, so
   * they still settle and are counted: never cleared to nothing, which
   * would take theirs with it. A missing row is recreated only when other
   * requests hold against it. The audit event names each damaged scope,
   * what it held and what it was rebuilt to. Never charged: a charge would
   * count money against a spend row that is already wrong, so it is
   * refused, the request still held.
   */
  async resolveQuarantined(
    id: string,
    how: HeldHow,
    by: AuditActor
  ): Promise<Decided> {
    const actor = auditActorSchema.parse(by);
    const settled = this.ctx.storage.transactionSync((): Decided => {
      const row = this.#db
        .select()
        .from(requests)
        .where(eq(requests.id, id))
        .get();
      if (row === undefined) {
        return { state: "missing" };
      }
      if (row.state !== "quarantined") {
        return decidedBefore(row);
      }
      const counted = this.#heldScopes(row);
      const damaged = counted.some((one) => one.damaged);
      if (damaged) {
        log.error("model.held_spend_damaged", { request: id, how });
        if (how === "charge") {
          return { state: "release_only" };
        }
      }
      const charged = how === "charge" ? row.reservedMicros : 0;
      this.#db
        .update(requests)
        .set({
          state: "settled",
          chargedMicros: charged,
          settledBy: how === "charge" ? "charged" : "released",
          settledAt: Date.now(),
        })
        .where(eq(requests.id, id))
        .run();
      // Each damaged scope, flat as audit detail is: `damaged.0.scope`, …
      const rebuilt: Record<string, string | number | null> = {};
      let rebuiltScopes = 0;
      let listing = true;
      for (const { kept, holds, damaged: isDamaged } of counted) {
        if (!isDamaged) {
          this.#settleHeldScope(kept, row, charged, actor);
          continue;
        }
        const after = this.#rebuildScope(kept, row, holds);
        const at = `damaged.${rebuiltScopes}`;
        rebuiltScopes += 1;
        const members: Record<string, string | number | null> = {
          [`${at}.scope`]: kept.scope,
          [`${at}.key`]: kept.key.slice(0, auditIdentifierMaxLength),
          [`${at}.held`]: holds === undefined ? null : holds / microsPerDollar,
          [`${at}.rebuilt`]:
            after.micros === null ? null : after.micros / microsPerDollar,
          ...(after.requests === undefined
            ? {}
            : { [`${at}.requests`]: after.requests }),
        };
        // Listed in order while whole scopes fit: none after the first
        // left out.
        listing &&=
          Object.keys(rebuilt).length + Object.keys(members).length <=
          damagedMembers;
        if (listing) {
          Object.assign(rebuilt, members);
        }
      }
      this.#outbox({
        actor,
        action:
          how === "charge" ? "model.spend.charged" : "model.spend.released",
        detail: {
          request: id,
          model: row.model,
          period: row.period,
          charged: charged / microsPerDollar,
          damaged: rebuiltScopes,
          ...rebuilt,
        },
      });
      return { state: "decided", how, chargedMicros: charged };
    });
    this.#deliverIfStored();
    await Promise.resolve();
    return settled;
  }

  /**
   * Releases, or charges, what `row` holds against the healthy scope
   * `kept`, in the period it reserved against, and alerts admins to
   * any threshold a charge takes it past. Inside a transaction.
   */
  #settleHeldScope(
    kept: typeof requestScopes.$inferSelect,
    row: RequestRow,
    charged: number,
    actor: AuditActor
  ): void {
    const after = this.#db
      .update(spend)
      .set({
        reservedMicros: sql`${spend.reservedMicros} - ${row.reservedMicros}`,
        spentMicros: sql`${spend.spentMicros} + ${charged}`,
      })
      .where(
        and(
          eq(spend.scope, kept.scope),
          eq(spend.key, kept.key),
          eq(spend.period, reservedPeriod(kept, row))
        )
      )
      .returning({ spentMicros: spend.spentMicros })
      .get();
    // A charge counts towards its budgets' alerts, as any spend does.
    if (after !== undefined && charged > 0) {
      this.#alert(
        {
          scope: kept.scope,
          key: kept.key,
          limitMicros: kept.limitMicros,
          alertMicros: kept.alertMicros,
          names: namesSchema.safeParse(jsonOf(kept.names)).data ?? {},
        },
        row.period,
        after.spentMicros,
        actor
      );
    }
  }

  /**
   * Rebuilds the damaged spend of `kept`, which holds `holds` (none when
   * its row is missing), in the period `row` reserved against: its
   * reservation becomes what the other open requests on it reserve. A
   * missing row is recreated only when they reserve something, or when it
   * is a run lineage's: the row took the lineage's count with it, so it
   * comes back used up (`requests` at its limit), and the lineage makes no
   * more requests. What it rebuilt to, none when nothing was written, and
   * the count it set. Inside a transaction.
   */
  #rebuildScope(
    kept: typeof requestScopes.$inferSelect,
    row: { period: string },
    holds: number | undefined
  ): { micros: number | null; requests?: number } {
    const period = reservedPeriod(kept, row);
    const micros = this.#openReservations({ ...kept, period });
    if (holds !== undefined) {
      this.#db
        .update(spend)
        .set({ reservedMicros: micros })
        .where(
          and(
            eq(spend.scope, kept.scope),
            eq(spend.key, kept.key),
            eq(spend.period, period)
          )
        )
        .run();
      return { micros };
    }
    const exhausted =
      period === lineagePeriod ? (kept.limitRequests ?? undefined) : undefined;
    if (micros === 0 && exhausted === undefined) {
      return { micros: null };
    }
    this.#db
      .insert(spend)
      .values({
        scope: kept.scope,
        key: kept.key,
        period,
        reservedMicros: micros,
        requests: exhausted ?? 0,
      })
      .run();
    return exhausted === undefined
      ? { micros }
      : { micros, requests: exhausted };
  }

  /**
   * The scopes `row` reserved against (`request_scopes`), each with what
   * its spend holds in the period it reserved against, and whether that
   * spend is damaged: missing, or holding less than `row` alone reserved.
   */
  #heldScopes(row: { id: string; period: string; reservedMicros: number }): {
    kept: typeof requestScopes.$inferSelect;
    holds: number | undefined;
    damaged: boolean;
  }[] {
    return this.#db
      .select()
      .from(requestScopes)
      .where(eq(requestScopes.requestId, row.id))
      .all()
      .map((kept) => {
        const holds = this.#db
          .select({ reservedMicros: spend.reservedMicros })
          .from(spend)
          .where(
            and(
              eq(spend.scope, kept.scope),
              eq(spend.key, kept.key),
              eq(spend.period, reservedPeriod(kept, row))
            )
          )
          .get()?.reservedMicros;
        return {
          kept,
          holds,
          damaged: holds === undefined || holds < row.reservedMicros,
        };
      });
  }

  /**
   * What the open requests (under way, lost or held) reserve against
   * `kept`'s scope in `period`, each by the period it reserved against
   * (`reservedPeriod`): what that spend should hold, by the ledger's own
   * records. Inside a transaction.
   */
  #openReservations(kept: {
    scope: LedgerScopeName;
    key: string;
    period: string;
  }): number {
    return (
      this.#db
        .select({
          reserved: sql<number>`coalesce(sum(${requests.reservedMicros}), 0)`,
        })
        .from(requests)
        .innerJoin(requestScopes, eq(requestScopes.requestId, requests.id))
        .where(
          and(
            inArray(requests.state, ["dispatched", "unknown", "quarantined"]),
            eq(requestScopes.scope, kept.scope),
            eq(requestScopes.key, kept.key),
            sql`${reservedPeriodSql} = ${kept.period}`
          )
        )
        .get()?.reserved ?? 0
    );
  }

  /**
   * What each of `scopes` spent and holds in `period` (a run lineage: in
   * its whole life), most spent first, at most `limit` each; ties by key,
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
        .select({
          key: spend.key,
          spentMicros: spend.spentMicros,
          reservedMicros: spend.reservedMicros,
        })
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
   * Reconciles every reservation that came due without a settlement,
   * charging each in full; sweeps receipts past their retention; delivers
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
            if (
              this.#charge(row, row.reservedMicros, "reconciled") ===
              "quarantined"
            ) {
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
   * Deletes the spend and alerts of run lineages that have ended, every
   * run of each, at least {@link settledRetentionMs} ago, as core's own
   * records of the runs say (`endedLineages`): nothing an App or a run
   * passes, so no lineage is ended early. A lineage any open request
   * (under way, lost or held for a person) still reserves against keeps
   * its rows, checked again as they are deleted. A page of lineages at a
   * time, in key order, so a page of live ones holds up none after it.
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
      const ended = await endedLineages(
        this.env,
        page,
        now - settledRetentionMs
      );
      if (ended.size > 0) {
        this.ctx.storage.transactionSync(() => {
          for (const key of this.#prunable("", [...ended])) {
            this.#db
              .delete(spend)
              .where(
                and(
                  eq(spend.scope, "run"),
                  eq(spend.key, key),
                  eq(spend.period, lineagePeriod)
                )
              )
              .run();
            this.#db
              .delete(alerts)
              .where(
                and(
                  eq(alerts.scope, "run"),
                  eq(alerts.key, key),
                  eq(alerts.period, lineagePeriod)
                )
              )
              .run();
          }
        });
        log.info("model.lineages_pruned", { lineages: ended.size });
      }
      if (page.length < lineagesAsked) {
        return;
      }
    }
  }

  /**
   * Run lineages past `after` in key order, at most {@link lineagesAsked}
   * (or those of `only`), whose spend holds nothing and that no open
   * request reserves against: the ones that may be pruned once ended.
   */
  #prunable(after: string, only?: readonly string[]): string[] {
    return this.#db
      .select({ key: spend.key })
      .from(spend)
      .where(
        and(
          eq(spend.scope, "run"),
          eq(spend.period, lineagePeriod),
          gt(spend.key, after),
          only === undefined ? undefined : inArray(spend.key, [...only]),
          eq(spend.reservedMicros, 0),
          sql`not exists (
            select 1 from ${requestScopes}
            join ${requests} on ${requests.id} = ${requestScopes.requestId}
            where ${requestScopes.scope} = 'run'
              and ${requestScopes.key} = ${spend.key}
              and ${reservedPeriodSql} = ${lineagePeriod}
              and ${requests.state} in ('dispatched', 'unknown', 'quarantined')
          )`
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
      this.ctx.storage.transactionSync(() => {
        this.#db
          .delete(requestScopes)
          .where(inArray(requestScopes.requestId, ids))
          .run();
        this.#db.delete(requests).where(inArray(requests.id, ids)).run();
      });
      if (expired.length < alarmPage) {
        return;
      }
    }
  }

  /** Sets the alarm for the next reservation due, or the next sweep. */
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

  /**
   * Why a request of `bound` is refused by the scopes in `full`, each
   * without room for it. Room comes back only from requests still under
   * way (`dispatched`, before their deadline): they settle at what they
   * used, often far less than they hold. Every other reservation is as
   * good as spent: a request whose usage was lost, or past its deadline
   * (in the grace before it comes due, or due), is charged in full, and a
   * quarantined one waits for a person. A scope that has no room even
   * once all those under way release theirs is out of budget, whatever
   * the other scopes say. When every full scope would have room, the
   * refusal says when: the soonest deadline of the requests under way in
   * each scope, the latest of those across scopes. Optimistic, as the
   * soonest may not free enough on its own; the gateway bounds the wait
   * it passes on. Only scope names and a time: nothing of whose requests
   * they are, or what they hold. Inside a transaction.
   */
  #refusal(
    full: readonly {
      scope: LedgerScope;
      row: { spentMicros: number; reservedMicros: number };
    }[],
    period: string,
    bound: number,
    now: number
  ): Admitted & { ok: false } {
    let heldUntil = 0;
    for (const { scope, row } of full) {
      const underWay = this.#db
        .select({
          releasable: sql<number>`coalesce(sum(${requests.reservedMicros}), 0)`,
          soonest: sql<number | null>`min(${requests.deadline})`,
        })
        .from(requests)
        .innerJoin(requestScopes, eq(requestScopes.requestId, requests.id))
        .where(
          and(
            eq(requests.state, "dispatched"),
            // Those that reserved against this very spend: a lineage's in
            // whatever month they count in.
            sql`${reservedPeriodSql} = ${periodOf(scope.scope, period)}`,
            gt(requests.deadline, now),
            eq(requestScopes.scope, scope.scope),
            eq(requestScopes.key, scope.key)
          )
        )
        .get();
      const releasable = underWay?.releasable ?? 0;
      const held = row.reservedMicros - releasable;
      if (
        underWay?.soonest === null ||
        underWay?.soonest === undefined ||
        row.spentMicros + held + bound > (scope.limitMicros ?? 0)
      ) {
        return { ok: false, scope: scope.scope };
      }
      heldUntil = Math.max(heldUntil, underWay.soonest);
    }
    const [first] = full;
    if (first === undefined) {
      throw new Error("A refusal needs a scope without room");
    }
    return {
      ok: false,
      scope: first.scope.scope,
      heldBy: full.map(({ scope }) => scope.scope),
      heldUntil,
    };
  }

  /** The spend row of `scope` for a request of `period`, or none spent yet. */
  #spendOf(
    { scope, key }: LedgerScope,
    period: string
  ): { spentMicros: number; reservedMicros: number; requests: number } {
    return (
      this.#db
        .select({
          spentMicros: spend.spentMicros,
          reservedMicros: spend.reservedMicros,
          requests: spend.requests,
        })
        .from(spend)
        .where(
          and(
            eq(spend.scope, scope),
            eq(spend.key, key),
            eq(spend.period, periodOf(scope, period))
          )
        )
        .get() ?? { spentMicros: 0, reservedMicros: 0, requests: 0 }
    );
  }

  /**
   * Settles `row` at `charged`: releases its reservation from each of its
   * scopes and adds the charge to their spend, then alerts admins to each
   * threshold that reached. Inside a transaction. Returns how many alerts
   * it stored.
   */
  #charge(
    row: RequestRow,
    charged: number,
    by: "usage" | "refused" | "unsent" | "reconciled"
  ): number | "quarantined" {
    // What it reserved against, as its admission recorded it apart from
    // its JSON: the one record a person's decision on it walks too, so a
    // scope settles here exactly when it would there. Stored data that
    // can't be read, its JSON or no scope at all, is held for a person.
    const kept = this.#db
      .select()
      .from(requestScopes)
      .where(eq(requestScopes.requestId, row.id))
      .all();
    if (scopesOf(row) === undefined || kept.length === 0) {
      this.#quarantine(row);
      return "quarantined";
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
      return 0;
    }
    const actor = actorOf(row);
    let alerted = 0;
    for (const scope of kept) {
      const after = this.#db
        .update(spend)
        .set({
          reservedMicros: sql`${spend.reservedMicros} - ${row.reservedMicros}`,
          spentMicros: sql`${spend.spentMicros} + ${charged}`,
          // A request never sent wasn't made: its count comes back.
          ...(by === "unsent"
            ? { requests: sql`max(${spend.requests} - 1, 0)` }
            : {}),
        })
        .where(
          and(
            eq(spend.scope, scope.scope),
            eq(spend.key, scope.key),
            eq(spend.period, reservedPeriod(scope, row))
          )
        )
        .returning({ spentMicros: spend.spentMicros })
        .get();
      if (after === undefined) {
        throw new Error("A request's scope has no spend to settle against");
      }
      alerted += this.#alert(
        {
          scope: scope.scope,
          key: scope.key,
          limitMicros: scope.limitMicros,
          alertMicros: scope.alertMicros,
          names: namesSchema.safeParse(jsonOf(scope.names)).data ?? {},
        },
        row.period,
        after.spentMicros,
        actor
      );
    }
    return alerted;
  }

  /**
   * Alerts admins to each threshold of `scope` that `spentMicros` reached
   * without an alert at that value this month: stores the alert's row,
   * and its event only if that added the row. Inside a transaction.
   * Returns how many it stored.
   */
  #alert(
    scope: LedgerScope,
    period: string,
    spentMicros: number,
    actor: AuditActor
  ): number {
    let stored = 0;
    const counted = periodOf(scope.scope, period);
    for (const threshold of thresholds) {
      const value = threshold.of(scope);
      if (value === null || spentMicros < value) {
        continue;
      }
      const added = this.#db
        .insert(alerts)
        .values({
          scope: scope.scope,
          key: scope.key,
          period: counted,
          kind: threshold.kind,
          thresholdMicros: value,
        })
        .onConflictDoNothing()
        .returning({ kind: alerts.kind })
        .all();
      if (added.length === 0) {
        continue;
      }
      this.#outbox({
        actor,
        action: `model.budget.${threshold.kind}`,
        detail: {
          scope: scope.scope,
          period: counted,
          limit: (scope.limitMicros ?? 0) / microsPerDollar,
          threshold: value / microsPerDollar,
          ...scope.names,
        },
      });
      log.warn(`model.budget_${threshold.kind}`, {
        scope: scope.scope,
        period: counted,
      });
      stored += 1;
    }
    return stored;
  }

  /**
   * Sets aside a request that can't be read to settle: it keeps holding its
   * reservation, as what it holds can't be told, and is logged for a
   * person to look at. Never throws: it is the fallback.
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
        detail: {
          request: row.id,
          model: row.model,
          period: row.period,
          held: row.reservedMicros / microsPerDollar,
        },
      });
    }
  }

  /**
   * Counts a failed try at reconciling `row`: it is tried again a while
   * from `now`, and after {@link maxReconcileFailures} tries it is set
   * aside for a person, audited, with what it holds. Whether that could
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
