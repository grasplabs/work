import { requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import {
  quotaPolicyReportMaxBytes,
  quotaPolicyReportMaxSkewMs,
  quotaPolicyReportPurpose,
  quotaPolicyReportRequestSchema,
} from "@grasp-os/shared/quota-policy-report";

import { consoleSigned } from "../console-signed.ts";
import { errorResponse } from "../errors.ts";
import { quotaPolicyReport } from "./quotas.ts";

// The quota policy core applies, for the console alone (GRA-600): signed
// with a key derived for this purpose only (console-signed.ts), so no
// other signed request reads it, and nothing an App, a screen or a run
// reaches serves it. Numbers only: the generation, what it lowers, when
// core recorded it. Threat model on GRA-600.

/**
 * The console's request for the policy: 200 with it, once the request is
 * signed, fresh and well formed; 403 for anything else, logged with why.
 */
export const quotaPolicyReportResponse = async (
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
    purpose: quotaPolicyReportPurpose,
    schema: quotaPolicyReportRequestSchema,
    maxBytes: quotaPolicyReportMaxBytes,
    maxSkewMs: quotaPolicyReportMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("quota_policy.report_refused", { reason: asked });
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  return Response.json(await quotaPolicyReport(env), {
    headers: { "cache-control": "no-store" },
  });
};
