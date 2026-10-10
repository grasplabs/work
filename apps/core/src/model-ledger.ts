import { auditActorSchema, createAuditEvent } from "@grasp-os/shared/audit";
import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
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

const priceSchema = z.strictObject({
  version: z.string().min(1).max(128),
  input: microsSchema,
  output: microsSchema,
  cacheRead: microsSchema,
  cacheWrite: microsSchema,
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
  /** Its ID was admitted before for another request: refused, reserving nothing. */
  | { ok: false; reused: true };

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
  | { state: "missing" };

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

/** The prices `row` was pinned to. */
const pricesOf = (row: RequestRow): PinnedPrice =>
  priceSchema.parse(JSON.parse(row.prices));

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
        .select({ fingerprint: requests.fingerprint })
        .from(requests)
        .where(eq(requests.id, admission.id))
        .get();
      if (existing !== undefined) {
        return {
          admitted:
            existing.fingerprint === fingerprint
              ? ({ ok: true } as const)
              : ({ ok: false, reused: true } as const),
          alerted: 0,
        };
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
      if (settlement.by === "unknown") {
        this.#db
          .update(requests)
          .set({ state: "unknown" })
          .where(eq(requests.id, id))
          .run();
        return { settled: { state: "unknown" } as const, alerted: 0 };
      }
      const charged =
        settlement.by === "usage"
          ? costMicros(pricesOf(row), settlement.tokens)
          : 0;
      return {
        settled: { state: "settled", chargedMicros: charged } as const,
        alerted: this.#charge(row, charged, settlement.by),
      };
    });
    if (alerted > 0) {
      this.#deliverAudit();
    }
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
        this.ctx.storage.transactionSync(() => {
          this.#charge(row, row.reservedMicros, "reconciled");
          this.#outbox({
            actor: auditActorSchema.parse(JSON.parse(row.actor)),
            action: "model.spend.reconciled",
            detail: {
              request: row.id,
              model: row.model,
              period: row.period,
              lost: row.state === "unknown" ? "usage" : "settlement",
              charged: row.reservedMicros / microsPerDollar,
            },
          });
        });
        reconciled += 1;
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
      this.#db
        .delete(requests)
        .where(
          inArray(
            requests.id,
            expired.map(({ id }) => id)
          )
        )
        .run();
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
  ): number {
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
    const scopes = storedScopesSchema.parse(JSON.parse(row.scopes));
    const actor = auditActorSchema.parse(JSON.parse(row.actor));
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
