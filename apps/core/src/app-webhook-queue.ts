import { appWebhookLimits } from "@grasp-os/shared/app-webhooks";
import type { AppWebhookEvent } from "@grasp-os/shared/app-webhooks";
import { errorFields, log } from "@grasp-os/shared/log";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { appWebhookDeliveries, appWebhooks } from "./db/core/schema.ts";

// Queuing an App's events for its webhooks (app-webhooks.ts has the threat
// model): from the batch of a publish or a version made current, and after
// a form's submission answered. Apart, so the App's own modules queue
// without reaching the webhooks' settings.

/** That webhook `webhook` has room for another delivery waiting, as SQL. */
const roomFor = (webhook: SQL | string): SQL =>
  sql`(SELECT count(*) FROM ${appWebhookDeliveries}
    WHERE ${appWebhookDeliveries.webhookId} = ${webhook}
      AND ${appWebhookDeliveries.deliveredAt} IS NULL) < ${appWebhookLimits.waiting}`;

/** That webhook row `webhook` takes `event`, as SQL. */
const takes = (event: AppWebhookEvent): SQL =>
  sql`EXISTS (SELECT 1 FROM json_each(${appWebhooks.events}) WHERE value = ${event})`;

/**
 * A delivery of `event` of App `app` to each of its webhooks that takes
 * it, once per webhook under `dedupe`, queued only if `condition` holds as
 * the statement runs: for the batch of the change it reports (a publish,
 * a version made current), so the change and its deliveries are kept
 * together or not at all. It carries IDs only.
 */
export const queuedWebhookDeliveries = (
  db: DrizzleD1Database,
  {
    app,
    event,
    dedupe,
    version = null,
  }: {
    app: string;
    event: Exclude<AppWebhookEvent, "form_sent">;
    dedupe: string;
    version?: number | null;
  },
  condition: SQL
) =>
  db
    .insert(appWebhookDeliveries)
    .select(
      sql`SELECT lower(hex(randomblob(16))), ${appWebhooks.id}, ${appWebhooks.appId}, ${event}, ${dedupe}, ${Date.now()}, ${version}, NULL, NULL, NULL, 0, 0, NULL, NULL, NULL
        FROM ${appWebhooks}
        WHERE ${appWebhooks.appId} = ${app}
          AND ${takes(event)}
          AND ${roomFor(sql`${appWebhooks.id}`)}
          AND ${condition}`
    )
    .onConflictDoNothing();

/** A form's submission, as core answered it, for its webhooks. */
export interface FormSent {
  app: string;
  /** The submission's idempotency key. */
  key: string;
  /** The public function it was sent to. */
  operation: string;
  values: unknown;
}

/**
 * Queues `form_sent` for each of App `app`'s webhooks that takes it, once
 * per submission key: with the form's values only for a webhook approved
 * now, IDs only for any other, and its values left out when they wouldn't
 * fit a delivery. Never throws: the form's answer doesn't depend on its
 * webhooks.
 */
export const queueFormSent = async (
  env: Env,
  { app, key, operation, values }: FormSent
): Promise<void> => {
  try {
    const db = drizzle(env.DB);
    const webhooks = await db
      .select({ id: appWebhooks.id, approvedAt: appWebhooks.approvedAt })
      .from(appWebhooks)
      .where(and(eq(appWebhooks.appId, app), takes("form_sent")));
    if (webhooks.length === 0) {
      return;
    }
    const json = JSON.stringify(values ?? null);
    // Room for the rest of the body, as `payloadOf` writes it.
    const fits =
      new TextEncoder().encode(json).byteLength <=
      appWebhookLimits.bodyBytes - 1024;
    const now = new Date();
    const statements = webhooks.map(({ id, approvedAt }) =>
      db
        .insert(appWebhookDeliveries)
        .select(
          sql`SELECT ${crypto.randomUUID().replaceAll("-", "")}, ${id}, ${app}, 'form_sent', ${`form_sent:${key}`}, ${now.getTime()}, NULL, ${key}, ${approvedAt === null ? null : operation}, ${approvedAt !== null && fits ? json : null}, ${approvedAt !== null && !fits ? 1 : 0}, 0, NULL, NULL, NULL
            WHERE ${roomFor(id)}`
        )
        .onConflictDoNothing()
    );
    const [first, ...rest] = statements;
    if (first !== undefined) {
      await db.batch([first, ...rest]);
    }
  } catch (error) {
    log.error("app.webhook.queue_failed", { app, ...errorFields(error) });
  }
};
