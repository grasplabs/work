/**
 * A client's AI as its core reports it (core's src/ai-status-report.ts):
 * the providers its organization connected and how their real calls last
 * fared, read live at `aiStatusReportPath`, signed as the quota policy is
 * (src/clients/quota-policy.ts), and said in one line
 * (src/admin/ai-status-words.ts).
 * Read only: staff see it, the organization's admins change it in their
 * own Settings. Never a key or its mask: core doesn't send one.
 */
import {
  aiStatusReportPath,
  aiStatusReportPurpose,
  aiStatusReportSchema,
} from "@grasp-os/shared/ai-status-report";
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import { eq } from "drizzle-orm";

import { adminDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import { askClientCore, signedCoreReport } from "./quota-policy.ts";

/** Active client `clientId`'s AI, as its core reports it; null when unknown or it isn't active. */
export const clientAiStatus = async (
  env: Env,
  clientId: string
): Promise<AiStatusReport | null> => {
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
    "ai_status",
    async (request) =>
      await signedCoreReport(request, {
        path: aiStatusReportPath,
        purpose: aiStatusReportPurpose,
        schema: aiStatusReportSchema,
      })
  );
};
