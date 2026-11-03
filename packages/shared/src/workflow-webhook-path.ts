// Where a workflow's webhook trigger takes deliveries (core's
// workflows/webhook-triggers.ts), apart and with nothing imported: the
// router limits requests to it (apps/router) without loading the
// triggers' schemas.

/**
 * Where webhook triggers take deliveries: `<path>/<token>`, each token 128
 * random bits of its trigger's own.
 */
export const workflowWebhookPath = "/api/workflow-webhooks";
