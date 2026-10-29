/**
 * How core's model gateway reaches models (core's src/models.ts): every
 * model call goes to the deployment's AI Gateway over the AI binding,
 * with these headers on each request. The release build declares what
 * they mean in the manifest (`declaredModelTransport`, read from this
 * same object), so the admin verifies a release's model transport from
 * the release itself (apps/admin/src/hosting/release-checks.ts) and the
 * declaration can't drift from what core sends.
 */

/** What core sends AI Gateway with every model call, besides auth and metadata. */
export const modelGatewayTransportHeaders = {
  /** The gateway logs metadata, never prompts or answers. */
  "cf-aig-collect-log-payload": "false",
  /**
   * Never an answer from the gateway's cache: a cached answer is one
   * person's, and would be served to another.
   */
  "cf-aig-skip-cache": "true",
} as const;

/** A release's model transport, as its manifest declares it (`modelTransport`). */
export interface ModelTransport {
  /** Through the deployment's AI Gateway, over the AI binding. */
  via: "ai_gateway";
  /** Whether the gateway may log prompts and answers. */
  payloadLogging: boolean;
  /** Whether the gateway may answer from its cache. */
  cache: boolean;
}

/** What `headers`, as core sends them, mean for the manifest's `modelTransport`. */
export const declaredModelTransport = (
  headers: Readonly<Record<string, string>> = modelGatewayTransportHeaders
): ModelTransport => ({
  via: "ai_gateway",
  payloadLogging: headers["cf-aig-collect-log-payload"] !== "false",
  cache: headers["cf-aig-skip-cache"] !== "true",
});
