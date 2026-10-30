import { webhookTargetOf } from "@grasp-os/shared/app-link-limits";
import {
  appWebhookInputSchema,
  appWebhookLimits,
  signedTextOf,
  webhookErrors,
} from "@grasp-os/shared/app-webhooks";
import type {
  AppWebhook,
  AppWebhookInput,
  AppWebhookPayload,
  AppWebhooksApi,
  WebhookOutcome,
} from "@grasp-os/shared/app-webhooks";
import { actorOf } from "@grasp-os/shared/audit";
import { toBase64Url, toHex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { appFor, editableApp } from "./apps.ts";
import {
  auditedBatch,
  outboxedIfChanged,
  outboxedWhere,
} from "./audit-outbox.ts";
import { appWebhookDeliveries, appWebhooks } from "./db/core/schema.ts";
import { derivedHmacKey } from "./derived-keys.ts";
import {
  backoffMs,
  defaultBudgetMs,
  defaultMaxAttempts,
} from "./outbox-delivery.ts";
import {
  requireMemberAdmin,
  requireStillAdmin,
  stillAdminSql,
} from "./permissions.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import { requireNotStaff } from "./sharing.ts";

// A company's webhooks for an App (GRA-1208): https URLs its builders give
// it, which Grasp POSTs the App's events to (`form_sent`, `published`,
// `changed`). Core keeps them, queues each delivery in its outbox,
// `app_webhook_deliveries`, in the batch of the change it reports where
// it can, signs it, and asks connect to send it (connect's webhooks.ts);
// the cron trigger drains it every minute. Threat model, and how each is
// closed:
//
// - Core reaching the internet itself: it never does. Every delivery is
//   connect's `webhookPost`, which checks the URL again and sends it.
// - A webhook reaching inside a network (SSRF): a URL is taken only when
//   it is one a link could open, under its own origin (`webhookTargetOf`:
//   https only, no userinfo, no IP address, no private network name),
//   checked here as it is added and by connect as each delivery goes; a
//   redirect is a failure, never followed (connect's webhooks.ts).
// - A forged delivery: each is signed, HMAC-SHA256 of its timestamp and
//   body (`signedTextOf`) with the webhook's secret. The secret is made
//   from the webhook's ID and a key of core's own (`webhookSecretOf`,
//   derived-keys.ts), so it is never stored: shown once, to the builder
//   who added the webhook, and never again. Rotating the auth secret
//   changes every webhook's secret.
// - A delivery taken twice, or lost: its ID is its idempotency key, the
//   same on every attempt; an event is queued once per webhook (`dedupe`:
//   the audit event of a publish or version change, the key of a form's
//   submission), and a drain holds a delivery under a lease while it
//   sends it and settles it only while it still holds it. A failure is
//   tried again, backing off as outbox-delivery.ts does, until
//   `defaultMaxAttempts`; then it is given up, audited.
// - The App's data leaving before anyone said it may (exfiltration): a
//   delivery carries IDs and the event only, until an admin approves the
//   webhook's URL (`approveWebhook`, never Grasp staff, and only while
//   still an admin as it is written). Only then does a form's delivery
//   carry its values, and only one queued after the approval: values are
//   kept with a delivery only when the webhook was approved as it was
//   queued. A URL is never changed, only removed and added again, so an
//   approval is always of the URL it was given for. A delivery's values
//   are cleared once it settles.
// - Someone who doesn't build the App sending its events elsewhere: only
//   its builders add a webhook (`editableApp`, never Grasp staff); its
//   builders and the workspace's admins remove one, with every delivery
//   still waiting. At most `appWebhookLimits.perApp` per App, and
//   `appWebhookLimits.waiting` deliveries waiting per webhook.
// - A change nobody can trace: adding, approving and removing a webhook
//   are audited with the change; each delivery connect sends is audited
//   there (`webhook.call`), and one given up here
//   (`app.webhook.undeliverable`). An entry names the URL by its origin
//   only: its path or query may hold the receiver's own secret.

const secretPurpose = "grasp-os app webhook secret";

/** The prefix of a webhook's secret, so it is recognised wherever it is pasted. */
const secretPrefix = "gwhsec_";

/** The secret of the webhook `id`: never stored, made again when needed. */
export const webhookSecretOf = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  id: string
): Promise<string> => {
  const key = await derivedHmacKey(env, secretPurpose, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(id)
  );
  return `${secretPrefix}${toBase64Url(new Uint8Array(mac))}`;
};

/** The signature of a delivery: `v1=`, HMAC-SHA256 with `secret`, in hex. */
export const webhookSignatureOf = async (
  secret: string,
  timestamp: number,
  body: string
): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedTextOf(timestamp, body))
  );
  return `v1=${toHex(new Uint8Array(mac))}`;
};

type WebhookRow = typeof appWebhooks.$inferSelect;
type DeliveryRow = typeof appWebhookDeliveries.$inferSelect;

/** The origin of a webhook's URL, as audit entries name it. */
const originOf = (url: string): string => new URL(url).origin;

/** A webhook as its settings list it. */
const toWebhook = (row: WebhookRow): AppWebhook => ({
  id: row.id,
  app: appIdSchema.parse(row.appId),
  url: row.url,
  events: row.events,
  approved:
    row.approvedBy === null || row.approvedAt === null
      ? null
      : { by: row.approvedBy, at: row.approvedAt.toISOString() },
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

/** The webhook `id` of App `app`, if it has it. */
const webhookOf = async (
  env: Env,
  app: string,
  id: unknown
): Promise<WebhookRow | undefined> =>
  typeof id === "string"
    ? await drizzle(env.DB)
        .select()
        .from(appWebhooks)
        .where(and(eq(appWebhooks.id, id), eq(appWebhooks.appId, app)))
        .get()
    : undefined;

/** App `app`'s webhooks, oldest first, for its builders and admins. */
export const listWebhooks = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppWebhook[]> => {
  const found = await appFor(env, by, app, "builder");
  const rows = await drizzle(env.DB)
    .select()
    .from(appWebhooks)
    .where(eq(appWebhooks.appId, found.id))
    .orderBy(asc(appWebhooks.createdAt), asc(appWebhooks.id));
  return rows.map((row) => toWebhook(row));
};

/**
 * Adds a webhook to App `app`, for one of its builders, never Grasp staff:
 * the webhook, unapproved, and its secret, this once. Audited as
 * `app.webhook.added`.
 */
export const addWebhook = async (
  env: Env,
  by: Identity,
  app: unknown,
  input: unknown
): Promise<{ webhook: AppWebhook; secret: string }> => {
  requireNotStaff(by);
  const found = await editableApp(env, by, app);
  const { url, events }: AppWebhookInput = webhookErrors.parse(
    "webhook.invalid",
    appWebhookInputSchema,
    input
  );
  const target = webhookTargetOf(url);
  if (!target.ok) {
    throw webhookErrors.create("webhook.invalid_url");
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const db = drizzle(env.DB);
  const count = sql`(SELECT count(*) FROM ${appWebhooks} WHERE ${appWebhooks.appId} = ${found.id})`;
  const [inserted] = await auditedBatch(env, db, [
    db
      .insert(appWebhooks)
      .select(
        sql`SELECT ${id}, ${found.id}, ${target.url}, ${JSON.stringify(events)}, ${by.userId}, ${now}, NULL, NULL
          WHERE ${count} < ${appWebhookLimits.perApp}`
      )
      .returning(),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "app.webhook.added",
      target: { type: "app", id: found.id },
      detail: { webhook: id, origin: target.origin, events: events.join(",") },
    }),
  ]);
  const [row] = inserted;
  if (row === undefined) {
    throw webhookErrors.create("webhook.full");
  }
  return { webhook: toWebhook(row), secret: await webhookSecretOf(env, id) };
};

/**
 * Lets App `app`'s data go to its webhook `id`'s URL, for an admin of the
 * workspace, never Grasp staff, and only while still one as it is
 * written. Approving one approved changes nothing. Audited as
 * `app.webhook.approved`.
 */
export const approveWebhook = async (
  env: Env,
  by: Identity,
  app: unknown,
  id: unknown
): Promise<AppWebhook> => {
  requireMemberAdmin(by);
  const found = await appFor(env, by, app, "builder");
  const row = await webhookOf(env, found.id, id);
  if (row === undefined) {
    throw webhookErrors.create("webhook.not_found");
  }
  if (row.approvedAt !== null) {
    return toWebhook(row);
  }
  const db = drizzle(env.DB);
  const [updated] = await auditedBatch(env, db, [
    db
      .update(appWebhooks)
      .set({ approvedBy: by.userId, approvedAt: new Date() })
      .where(
        and(
          eq(appWebhooks.id, row.id),
          isNull(appWebhooks.approvedAt),
          stillAdminSql(by)
        )
      )
      .returning(),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "app.webhook.approved",
      target: { type: "app", id: found.id },
      detail: { webhook: row.id, origin: originOf(row.url) },
    }),
  ]);
  const [approved] = updated;
  if (approved !== undefined) {
    return toWebhook(approved);
  }
  await requireStillAdmin(env, by);
  // Approved by another admin meanwhile, or removed.
  const now = await webhookOf(env, found.id, row.id);
  if (now === undefined) {
    throw webhookErrors.create("webhook.not_found");
  }
  return toWebhook(now);
};

/**
 * Removes App `app`'s webhook `id`, with every delivery still waiting, for
 * the App's builders and the workspace's admins, never Grasp staff.
 * Audited as `app.webhook.removed`.
 */
export const removeWebhook = async (
  env: Env,
  by: Identity,
  app: unknown,
  id: unknown
): Promise<void> => {
  requireNotStaff(by);
  const found = await appFor(env, by, app, "builder");
  const row = await webhookOf(env, found.id, id);
  if (row === undefined) {
    throw webhookErrors.create("webhook.not_found");
  }
  const db = drizzle(env.DB);
  await auditedBatch(env, db, [
    db
      .delete(appWebhookDeliveries)
      .where(eq(appWebhookDeliveries.webhookId, row.id)),
    db.delete(appWebhooks).where(eq(appWebhooks.id, row.id)),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "app.webhook.removed",
      target: { type: "app", id: found.id },
      detail: { webhook: row.id, origin: originOf(row.url) },
    }),
  ]);
};

/** The body of `delivery`, for `webhook`: IDs, and values only if approved. */
const payloadOf = (
  delivery: DeliveryRow,
  webhook: WebhookRow
): AppWebhookPayload => {
  const payload: AppWebhookPayload = {
    id: delivery.id,
    event: delivery.event,
    app: appIdSchema.parse(delivery.appId),
    occurredAt: delivery.occurredAt.toISOString(),
  };
  if (delivery.version !== null) {
    payload.version = delivery.version;
  }
  if (delivery.submission !== null) {
    payload.submission = delivery.submission;
  }
  if (webhook.approvedAt === null) {
    return payload;
  }
  if (delivery.operation !== null) {
    payload.operation = delivery.operation;
  }
  if (delivery.values !== null) {
    payload.values = delivery.values;
  }
  if (delivery.valuesLeftOut) {
    payload.valuesLeftOut = true;
  }
  return payload;
};

/** Most deliveries one drain takes at a time. */
const deliveriesPerRead = 25;

/** How long a drain holds a delivery it sends before another may take it. */
const deliveryLeaseMs = 60_000;

/** The delivery `id`, claimed under a lease until `lease`, if it is due. */
const claimed = async (
  env: Env,
  id: string,
  now: number,
  lease: number
): Promise<DeliveryRow | undefined> => {
  const [row] = await drizzle(env.DB)
    .update(appWebhookDeliveries)
    .set({ deliveryAt: new Date(lease) })
    .where(
      and(
        eq(appWebhookDeliveries.id, id),
        isNull(appWebhookDeliveries.deliveredAt),
        or(
          isNull(appWebhookDeliveries.deliveryAt),
          lte(appWebhookDeliveries.deliveryAt, new Date(now))
        )
      )
    )
    .returning();
  return row;
};

/** That `delivery` is still held under `lease`, unsettled, as SQL. */
const stillHeld = (delivery: DeliveryRow, lease: number) =>
  and(
    eq(appWebhookDeliveries.id, delivery.id),
    isNull(appWebhookDeliveries.deliveredAt),
    eq(appWebhookDeliveries.deliveryAt, new Date(lease))
  );

/**
 * Settles `delivery` for good with `outcome`, while held, its values
 * cleared; one given up is audited and logged.
 */
const settle = async (
  env: Env,
  delivery: DeliveryRow,
  lease: number,
  { outcome, attempts }: { outcome: string; attempts: number }
): Promise<void> => {
  const at = Date.now();
  const db = drizzle(env.DB);
  const settled = db
    .update(appWebhookDeliveries)
    .set({
      attempts,
      deliveredAt: new Date(at),
      outcome,
      values: null,
    })
    .where(stillHeld(delivery, lease));
  if (outcome === "delivered") {
    await settled;
    return;
  }
  log.error("app.webhook.undeliverable", {
    delivery: delivery.id,
    attempts,
    outcome,
  });
  await auditedBatch(env, db, [
    settled,
    outboxedWhere(
      db,
      {
        actor: { type: "system" },
        action: "app.webhook.undeliverable",
        target: { type: "app", id: delivery.appId },
        detail: {
          webhook: delivery.webhookId,
          delivery: delivery.id,
          event: delivery.event,
          attempts,
          outcome,
        },
      },
      sql`EXISTS (SELECT 1 FROM ${appWebhookDeliveries}
        WHERE ${appWebhookDeliveries.id} = ${delivery.id}
          AND ${appWebhookDeliveries.deliveredAt} = ${at})`
    ),
  ]);
};

/** Signs `delivery` for `webhook` and has connect send it. */
const send = async (
  env: Env,
  delivery: DeliveryRow,
  webhook: WebhookRow
): Promise<WebhookOutcome> => {
  const body = JSON.stringify(payloadOf(delivery, webhook));
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = await webhookSecretOf(env, webhook.id);
  return await env.CONNECT.webhookPost({
    url: webhook.url,
    app: delivery.appId,
    webhook: webhook.id,
    delivery: delivery.id,
    event: delivery.event,
    timestamp,
    signature: await webhookSignatureOf(secret, timestamp, body),
    body,
  });
};

/** How a drain goes. */
export interface WebhookDrainOptions {
  /** How long it goes on sending: checked before each delivery. */
  budgetMs?: number;
  /** How many failed attempts give a delivery up. */
  maxAttempts?: number;
}

/**
 * Sends the webhook deliveries that are due, oldest first, each held
 * under a lease while it is, until none are due or the budget is spent:
 * how many were delivered. One that fails is tried again later, backing
 * off; one connect refuses, or that failed `maxAttempts` times, is given
 * up, audited.
 */
export const drainWebhookDeliveries = async (
  env: Env,
  {
    budgetMs = defaultBudgetMs,
    maxAttempts = defaultMaxAttempts,
  }: WebhookDrainOptions = {}
): Promise<number> => {
  const ends = Date.now() + budgetMs;
  const db = drizzle(env.DB);
  const tried = new Set<string>();
  let delivered = 0;
  while (Date.now() < ends) {
    const now = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- one read after another
    const due = await db
      .select({ id: appWebhookDeliveries.id })
      .from(appWebhookDeliveries)
      .where(
        and(
          isNull(appWebhookDeliveries.deliveredAt),
          or(
            isNull(appWebhookDeliveries.deliveryAt),
            lte(appWebhookDeliveries.deliveryAt, new Date(now))
          )
        )
      )
      .orderBy(asc(appWebhookDeliveries.occurredAt))
      .limit(deliveriesPerRead);
    const fresh = due.filter(({ id }) => !tried.has(id));
    if (fresh.length === 0) {
      break;
    }
    for (const { id } of fresh) {
      tried.add(id);
      if (Date.now() >= ends) {
        break;
      }
      const lease = Date.now() + deliveryLeaseMs;
      // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
      const delivery = await claimed(env, id, Date.now(), lease);
      if (delivery === undefined) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
      const webhook = await db
        .select()
        .from(appWebhooks)
        .where(eq(appWebhooks.id, delivery.webhookId))
        .get();
      if (webhook === undefined) {
        // Removed as it was claimed: its deliveries go with it.
        continue;
      }
      const attempts = delivery.attempts + 1;
      let outcome: WebhookOutcome;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
        outcome = await send(env, delivery, webhook);
      } catch (error) {
        log.warn("app.webhook.send_failed", errorFields(error));
        outcome = { outcome: "failed", reason: "network" };
      }
      if (outcome.outcome === "delivered") {
        // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
        await settle(env, delivery, lease, { outcome: "delivered", attempts });
        delivered += 1;
      } else if (outcome.outcome === "refused" || attempts >= maxAttempts) {
        // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
        await settle(env, delivery, lease, {
          outcome: `${outcome.outcome}:${outcome.reason}`,
          attempts,
        });
      } else {
        // oxlint-disable-next-line no-await-in-loop -- one delivery at a time
        await db
          .update(appWebhookDeliveries)
          .set({
            attempts,
            deliveryAt: new Date(Date.now() + backoffMs(attempts)),
          })
          .where(stillHeld(delivery, lease));
      }
    }
  }
  return delivered;
};

/** A signed-in person's `apps.webhooks`. */
export class AppWebhooksRpc extends CoreRpcTarget implements AppWebhooksApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(app: string): Promise<AppWebhook[]> {
    return await withPerson(
      this.#check,
      async (by) => await listWebhooks(this.#env, by, app)
    );
  }

  async add(
    app: string,
    webhook: AppWebhookInput
  ): Promise<{ webhook: AppWebhook; secret: string }> {
    return await withPerson(
      this.#check,
      async (by) => await addWebhook(this.#env, by, app, webhook)
    );
  }

  async approve(app: string, webhook: string): Promise<AppWebhook> {
    return await withPerson(
      this.#check,
      async (by) => await approveWebhook(this.#env, by, app, webhook)
    );
  }

  async remove(app: string, webhook: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await removeWebhook(this.#env, by, app, webhook);
    });
  }
}
