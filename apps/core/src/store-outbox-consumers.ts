import { dispatchFormSent } from "./app-webhook-queue.ts";
import type { OutboxConsumers } from "./outbox-delivery.ts";
import { dispatchNotifyIntent } from "./workflow-notifications.ts";
import { dispatchStartIntent } from "./workflow-start-intents.ts";

/**
 * The consumers of each business store's outbox (data-store.ts): its
 * mutations' workflow starts (workflow-start-intents.ts) and
 * notifications (workflow-notifications.ts), and the forms screens sent
 * as them, for their App's webhooks (app-webhook-queue.ts), each handed
 * over once its commit landed.
 */
export const storeOutboxConsumers = (env: Env): OutboxConsumers => ({
  "app.form_sent": async (entry) => await dispatchFormSent(env, entry),
  "workflow.start": async (entry) => await dispatchStartIntent(env, entry),
  "workflow.notify": async (entry) => await dispatchNotifyIntent(env, entry),
});
