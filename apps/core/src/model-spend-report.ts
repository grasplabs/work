import { requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import {
  modelSpendReportMaxBytes,
  modelSpendReportMaxSkewMs,
  modelSpendReportPurpose,
  modelSpendReportRequestSchema,
} from "@grasp-os/shared/model-spend-report";
import type { ModelSpendReport } from "@grasp-os/shared/model-spend-report";

import { consoleSigned } from "./console-signed.ts";
import { errorResponse } from "./errors.ts";
import { budgetPeriods } from "./model-budgets.ts";
import { modelLedger } from "./model-ledger.ts";
import { microsPerDollar } from "./model-prices.ts";

// The deployment's model spend this month, for the admin alone (GRA-141):
// what the model ledger charged the deployment's budget, the one the
// admin's spend ceiling sets, so staff see spend against the ceiling as
// the gateway holds it. Signed with a key derived for this purpose only
// (console-signed.ts), as the quota policy report is; nothing an App, a
// screen or a run reaches serves it. Numbers only.

/** What the ledger charged the deployment this month. */
const deploymentSpend = async (env: Env): Promise<ModelSpendReport> => {
  const { month } = budgetPeriods(env);
  const spent = await modelLedger(env).spendOf(month, ["deployment"], 1);
  const micros = (spent.deployment ?? []).reduce(
    (sum, { spentMicros }) => sum + spentMicros,
    0
  );
  return { month, spent: micros / microsPerDollar };
};

/**
 * The admin's request for the spend: 200 with it, once the request is
 * signed, fresh and well formed; 403 for anything else, logged with why.
 */
export const modelSpendReportResponse = async (
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
    purpose: modelSpendReportPurpose,
    schema: modelSpendReportRequestSchema,
    maxBytes: modelSpendReportMaxBytes,
    maxSkewMs: modelSpendReportMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("model_spend.report_refused", { reason: asked });
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  return Response.json(await deploymentSpend(env), {
    headers: { "cache-control": "no-store" },
  });
};
