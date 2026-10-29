/**
 * A client's model spend this month as its core's ledger counts it
 * against the deployment budget the admin's spend ceiling sets (GRA-141),
 * read live from its core at `modelSpendReportPath` (core's
 * src/model-spend-report.ts), signed as the quota policy is
 * (src/clients/quota-policy.ts). Unknown (null) when its core can't be
 * asked or doesn't answer: never an estimate in its place.
 */
import {
  modelSpendReportPath,
  modelSpendReportPurpose,
  modelSpendReportSchema,
} from "@grasp-os/shared/model-spend-report";
import type { ModelSpendReport } from "@grasp-os/shared/model-spend-report";
import { eq } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { askClientCore, signedCoreReport } from "./quota-policy.ts";

/** Active client `clientId`'s spend this month; null when unknown or it isn't active. */
export const clientModelSpend = async (
  env: Env,
  clientId: string
): Promise<ModelSpendReport | null> => {
  const client = await adminDatabase(env.DB)
    .select({ status: clients.status })
    .from(clients)
    .where(eq(clients.id, clientId))
    .get();
  if (client?.status !== "active") {
    return null;
  }
  return await askClientCore(
    env,
    clientId,
    "model_spend",
    async (request) =>
      await signedCoreReport(request, {
        path: modelSpendReportPath,
        purpose: modelSpendReportPurpose,
        schema: modelSpendReportSchema,
      })
  );
};
