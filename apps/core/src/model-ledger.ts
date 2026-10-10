import { auditActorSchema, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
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
//   scopes (the deployment, the workflow, the person, the run) in one
//   synchronous transaction that first checks each scope's spend plus
//   what is reserved plus the bound against its limit. Nothing else runs
//   in between, so reservations never oversubscribe a limit, and a scope
//   without room refuses the whole request: no partial reservation.
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
// - A request is settled twice, or an ID reused: a request settles once
//   (`state`), later settlements answer the first; an admission repeated
//   with the same input under its ID answers the first, and other input
//   under it is refused. A release that would leave a scope's
//   reservations below nothing is refused by the database (`CHECK`).
// - A model with no safe price or output bound: the gateway admits no
//   such request against a budget (model-prices.ts); its price and bound
//   are pinned here when admitted, so a later catalog never reprices it.
// - Duplicate alerts or audit entries: an alert's row is keyed by scope,
//   month, kind and threshold value, and its event is stored in this
//   object's outbox only when that insert added the row, in the same
//   transaction as the spend that reached it.
// - Spend crosses clients: each deployment's core has its own namespace
//   of this object, so no other client's requests reach this ledger.

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

/** How often the alarm looks again for receipts to sweep, while any are kept. */
const sweepEveryMs = 24 * 60 * 60 * 1000;

const scopeNames = ["deployment", "workflow", "user", "run"] as const;

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
  /** What its alerts name, as audit detail: the workflow or the person. */
  names: z.record(z.string(), z.string()),
});

/** One scope a request counts against, with its budget when admitted. */
export type LedgerScope = z.infer<typeof scopeSchema>;

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

const admissionSchema = z.strictObject({
  /** The provider request's ID: one per HTTP request. */
  id: z.uuid(),
  /** The UTC month it counts in. */
  period: z.string().regex(periodPattern),
  /** Each scope once. */
  scopes: z
    .array(scopeSchema)
    .min(1)
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
  /** When it is charged in full unless settled before, in ms since the epoch. */
  reconcileAt: z.int().positive(),
});

/** A provider request to admit. */
export type Admission = z.input<typeof admissionSchema>;

/** Whether it was admitted, or which scope has no room. */
export type Admitted =
  | { ok: true }
  | { ok: false; scope: LedgerScopeName }
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

/** A request set aside because it couldn't be read, for a person to settle. */
export interface QuarantinedRequest {
  id: string;
  model: string;
  period: string;
  reservedMicros: number;
  dispatchedAt: number;
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
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
    const { admitted, alerted } = this.ctx.storage.transactionSync(() => {
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
      let alertedNow = 0;
      for (const { scope, row } of rows) {
        alertedNow += this.#alert(
          scope,
          admission.period,
          row.spentMicros,
          admission.actor
        );
      }
      const full = rows.find(
        ({ scope, row }) =>
          scope.limitMicros !== null &&
          row.spentMicros + row.reservedMicros + admission.reservedMicros >
            scope.limitMicros
      );
      if (full !== undefined) {
        return {
          admitted: { ok: false, scope: full.scope.scope } as const,
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
          reconcileAt: admission.reconcileAt,
        })
        .run();
      for (const { scope, key } of admission.scopes) {
        this.#db
          .insert(requestScopes)
          .values({ requestId: admission.id, scope, key })
          .run();
        this.#db
          .insert(spend)
          .values({
            scope,
            key,
            period: admission.period,
            reservedMicros: admission.reservedMicros,
          })
          .onConflictDoUpdate({
            target: [spend.scope, spend.key, spend.period],
            set: {
              reservedMicros: sql`${spend.reservedMicros} + excluded.reserved_micros`,
            },
          })
          .run();
      }
      return { admitted: { ok: true } as const, alerted: alertedNow };
    });
    if (admitted.ok) {
      await this.#alarmBy(admission.reconcileAt);
    }
    if (alerted > 0) {
      this.#deliverAudit();
    }
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
    const { settled, alerted } = this.ctx.storage.transactionSync(() => {
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
    if (alerted > 0) {
      this.#deliverAudit();
    }
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
    await Promise.resolve();
    return rows;
  }

  /**
   * Settles a quarantined request as a person decided: releases what it
   * holds, or charges all of it, against the scopes its admission
   * recorded apart from its JSON (`request_scopes`), and audits who did,
   * in one transaction. A request that isn't quarantined (settled since,
   * say) is left as it is, and answered as it stands.
   */
  async resolveQuarantined(
    id: string,
    how: "release" | "charge",
    by: AuditActor
  ): Promise<Settled> {
    const actor = auditActorSchema.parse(by);
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
      if (row.state !== "quarantined") {
        return { state: row.state === "unknown" ? "unknown" : "missing" };
      }
      const charged = how === "charge" ? row.reservedMicros : 0;
      this.#db
        .update(requests)
        .set({
          state: "settled",
          chargedMicros: charged,
          settledBy: "decided",
          settledAt: Date.now(),
        })
        .where(eq(requests.id, id))
        .run();
      const keys = this.#db
        .select({ scope: requestScopes.scope, key: requestScopes.key })
        .from(requestScopes)
        .where(eq(requestScopes.requestId, id))
        .all();
      for (const { scope, key } of keys) {
        this.#db
          .update(spend)
          .set({
            reservedMicros: sql`${spend.reservedMicros} - ${row.reservedMicros}`,
            spentMicros: sql`${spend.spentMicros} + ${charged}`,
          })
          .where(
            and(
              eq(spend.scope, scope),
              eq(spend.key, key),
              eq(spend.period, row.period)
            )
          )
          .run();
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
        },
      });
      return { state: "settled", chargedMicros: charged };
    });
    this.#deliverAudit();
    await Promise.resolve();
    return settled;
  }

  /**
   * What each of `scopes` spent and holds in `period`, most spent first,
   * at most `limit` each; ties by key, descending.
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
        .where(and(eq(spend.scope, scope), eq(spend.period, period)))
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
        } catch (error) {
          // Its scopes can be read, so it isn't quarantined: it is tried
          // again later, and the rest go on now.
          log.error("model.reconcile_failed", {
            ...errorFields(error),
            request: row.id,
          });
          this.#retryLater(row.id, now);
        }
      }
      if (due.length < alarmPage) {
        break;
      }
    }
    if (reconciled > 0) {
      log.warn("model.spend_reconciled", { requests: reconciled });
    }
    this.#sweep(now);
    await this.#drainAudit();
    await this.#alarmForNext();
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
    const times = [
      next?.at,
      kept === undefined ? undefined : Date.now() + sweepEveryMs,
    ].filter((time) => time !== undefined);
    if (times.length > 0) {
      await this.#alarmBy(Math.min(...times));
    }
  }

  /** The spend row of `scope` in `period`, or none spent yet. */
  #spendOf(
    { scope, key }: LedgerScope,
    period: string
  ): { spentMicros: number; reservedMicros: number } {
    return (
      this.#db
        .select({
          spentMicros: spend.spentMicros,
          reservedMicros: spend.reservedMicros,
        })
        .from(spend)
        .where(
          and(
            eq(spend.scope, scope),
            eq(spend.key, key),
            eq(spend.period, period)
          )
        )
        .get() ?? { spentMicros: 0, reservedMicros: 0 }
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
    const scopes = scopesOf(row);
    if (scopes === undefined) {
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
    for (const scope of scopes) {
      const after = this.#db
        .update(spend)
        .set({
          reservedMicros: sql`${spend.reservedMicros} - ${row.reservedMicros}`,
          spentMicros: sql`${spend.spentMicros} + ${charged}`,
        })
        .where(
          and(
            eq(spend.scope, scope.scope),
            eq(spend.key, scope.key),
            eq(spend.period, row.period)
          )
        )
        .returning({ spentMicros: spend.spentMicros })
        .get();
      if (after === undefined) {
        throw new Error("A request's scope has no spend to settle against");
      }
      alerted += this.#alert(scope, row.period, after.spentMicros, actor);
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
          period,
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
          period,
          limit: (scope.limitMicros ?? 0) / microsPerDollar,
          threshold: value / microsPerDollar,
          ...scope.names,
        },
      });
      log.warn(`model.budget_${threshold.kind}`, {
        scope: scope.scope,
        period,
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

  /** Looks at an open request again a while from `now`, after it failed to reconcile. */
  #retryLater(id: string, now: number): void {
    try {
      this.#db
        .update(requests)
        .set({ reconcileAt: now + reconcileRetryMs })
        .where(eq(requests.id, id))
        .run();
    } catch (error) {
      log.error("model.reconcile_retry_failed", {
        ...errorFields(error),
        request: id,
      });
    }
  }

  /** Stores `entry`'s event in the object's outbox. Inside a transaction. */
  #outbox(entry: AuditEntry): void {
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
