import { dispatchAppNotifyIntent } from "./app-notifications.ts";
import { dispatchFormSent } from "./app-webhook-queue.ts";
import type { OutboxConsumers } from "./outbox-delivery.ts";
import { dispatchSendEventIntent } from "./workflow-event-sends.ts";
import { dispatchStartIntent } from "./workflow-start-intents.ts";

/**
 * The consumers of each business store's outbox (data-store.ts): its
 * mutations' workflow starts (workflow-start-intents.ts),
 * events sent to workflow runs (workflow-event-sends.ts), sends to people
 * (app-notifications.ts), and the forms pages sent
 * as them, for their App's webhooks (app-webhook-queue.ts), each handed
 * over once its commit landed.
 */
export const storeOutboxConsumers = (env: Env): OutboxConsumers => ({
  "app.form_sent": async (entry) => await dispatchFormSent(env, entry),
  "app.notify": async (entry) => await dispatchAppNotifyIntent(env, entry),
  "workflow.start": async (entry) => await dispatchStartIntent(env, entry),
  "workflow.send_event": async (entry) =>
    await dispatchSendEventIntent(env, entry),
});
