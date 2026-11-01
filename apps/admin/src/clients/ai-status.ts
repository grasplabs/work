/**
 * A client's AI as its core reports it (core's src/ai-status-report.ts):
 * the providers its organization connected and how their real calls last
 * fared, read live at `aiStatusReportPath`, signed for
 * (src/clients/core-report.ts), and said in one line
 * (src/admin/ai-status-words.ts); with what Grasp's own AI features cost
 * on its keys (src/clients/platform-spend.ts).
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
import { askClientCore, signedCoreReport } from "./core-report.ts";

/** Client `clientId`'s AI, as its core reports it now; null when it doesn't answer. */
export const readAiStatus = async (
  env: Env,
  clientId: string
): Promise<AiStatusReport | null> =>
  await askClientCore(
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
  return await readAiStatus(env, clientId);
};
