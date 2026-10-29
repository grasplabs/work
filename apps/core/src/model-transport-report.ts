import { requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import {
  modelTransportReportMaxBytes,
  modelTransportReportMaxSkewMs,
  modelTransportReportPurpose,
  modelTransportReportRequestSchema,
} from "@grasp-os/shared/model-transport-report";
import type { ModelTransportReport } from "@grasp-os/shared/model-transport-report";
import { modelErrors } from "@grasp-os/shared/models";

import { consoleSigned } from "./console-signed.ts";
import { errorResponse } from "./errors.ts";
import { modelLedger } from "./model-ledger.ts";
import type { EffectiveRoute } from "./model-routing.ts";
import {
  effectiveRoutes,
  missingProviderKeys,
  transportConfigOf,
  transportsOf,
} from "./model-routing.ts";
import { gatewaySettings, models } from "./models.ts";
import type { ModelsEnv } from "./models.ts";

// The deployment's model transport, for the admin alone: the transport in
// force, the route each allowed model takes and where it runs (the
// residency catalog's entry), the keys it names but lacks (names only),
// how each transport fared last (the model ledger's record, as requests
// settle), and on request a probe: one small call through the gateway, as
// any call goes, admitted, budgeted and audited like the rest
// (`platform: "transport_probe"`). Signed with a key derived for this
// purpose only (console-signed.ts), as the spend report is. Metadata only.

/** The line the probe asks for: no one's data. */
const probeInput = "Reply with the single word OK.";

/** The longest answer the probe takes: a word. */
const probeTokens = 16;

/** How long the probe may take. */
const probeTimeoutMs = 30_000;

/** One probe through the gateway along `route`, as its metadata. */
const probe = async (
  env: ModelsEnv,
  route: EffectiveRoute,
  staff: string | undefined,
  requestId: string
): Promise<NonNullable<ModelTransportReport["probe"]>> => {
  const started = Date.now();
  const { model, transport, region } = route;
  try {
    await models(env).call({
      model,
      input: probeInput,
      maxTokens: probeTokens,
      timeoutMs: probeTimeoutMs,
      purpose: "platform.transport_probe",
      trigger: { type: "system", ...(staff === undefined ? {} : { staff }) },
      work: { platform: "transport_probe" },
      requestId,
    });
    return {
      model,
      ok: true,
      error: null,
      transport,
      region,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      model,
      ok: false,
      error: modelErrors.codeOf(error) ?? "model.failed",
      transport,
      region,
      ms: Date.now() - started,
    };
  }
};

/** The report, with a probe of the first allowed model when `probing`. */
const transportReport = async (
  env: ModelsEnv,
  { probe: probing, staff }: { probe: boolean; staff?: string },
  requestId: string
): Promise<ModelTransportReport> => {
  const config = transportConfigOf(env);
  const settings = gatewaySettings(env);
  const transports =
    config === undefined ? undefined : transportsOf(env, settings.gateway);
  const routes =
    transports === undefined
      ? []
      : await effectiveRoutes(transports, settings.models);
  const health = await modelLedger(env).transportHealth();
  const probed = routes.find(({ allowed }) => allowed);
  return {
    valid: config !== undefined,
    residency: config?.residency ?? "global",
    primary: config?.primary.kind ?? null,
    failover: config?.failover.map(({ kind }) => kind) ?? [],
    routes,
    missingKeys: config === undefined ? [] : missingProviderKeys(env, config),
    health,
    probe:
      probing && probed !== undefined
        ? await probe(env, probed, staff, requestId)
        : null,
  };
};

/**
 * The admin's request for the report: 200 with it, once the request is
 * signed, fresh and well formed; 403 for anything else, logged with why.
 */
export const modelTransportReportResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const asked = await consoleSigned(request, env, {
    purpose: modelTransportReportPurpose,
    schema: modelTransportReportRequestSchema,
    maxBytes: modelTransportReportMaxBytes,
    maxSkewMs: modelTransportReportMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("model_transport.report_refused", { reason: asked });
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  return Response.json(await transportReport(env, asked, requestId), {
    headers: { "cache-control": "no-store" },
  });
};
