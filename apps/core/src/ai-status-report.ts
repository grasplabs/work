import {
  aiProviderIdSchema,
  providerTroubles,
} from "@grasp-os/shared/ai-providers";
import type { AiProviderId } from "@grasp-os/shared/ai-providers";
import {
  aiStatusReportMaxBytes,
  aiStatusReportMaxSkewMs,
  aiStatusReportPurpose,
  aiStatusReportRequestSchema,
} from "@grasp-os/shared/ai-status-report";
import type {
  AiProviderStatus,
  AiStatusReport,
  PlatformMonthSpend,
} from "@grasp-os/shared/ai-status-report";
import { requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import { platformAiFeatures } from "@grasp-os/shared/platform-ai";
import { z } from "zod";

import { readModelChoice } from "./ai-model-choice.ts";
import { consoleSigned } from "./console-signed.ts";
import { errorResponse } from "./errors.ts";
import { parseModelRef } from "./model-catalog.ts";
import { modelLedger } from "./model-ledger.ts";
import type { PlatformSpendByPeriod, ProviderHealth } from "./model-ledger.ts";

// The organization's AI, for the admin alone: which providers it
// connected, its default model's first, and how each one's calls last
// fared, as the model ledger noted them from real calls
// (`providerHealth`), with how Grasp's own keys fared for its platform
// features, and what those features cost on Grasp's keys this month and
// last (`platformSpend`, the ledger's charges). Staff read it as one line
// on the organization's Setup and as its spend on its AI use; it changes
// nothing. Signed with a key derived for this purpose only
// (console-signed.ts); nothing an App, a
// screen or a run reaches serves it. Provider ids, models, times and
// amounts only: never a key, its mask or an endpoint's address, which only
// connect and the organization's admins see, and nothing of what a call
// carried.

/** How `provider`'s calls fared by `kind`'s key, from the ledger's health. */
const statusOf = (
  health: readonly ProviderHealth[],
  provider: AiProviderId,
  kind: AiProviderStatus["kind"]
): AiProviderStatus => {
  const found = health.find(
    (row) => row.provider === provider && row.credential === kind
  );
  return {
    provider,
    kind,
    lastOkAt: found?.lastOkAt ?? null,
    lastFailedAt: found?.lastFailedAt ?? null,
    lastFailure: found?.lastFailure?.slice(0, 64) ?? null,
    failingClass:
      z.enum(providerTroubles).safeParse(found?.failingClass).data ?? null,
    failingSince: found?.failingSince ?? null,
  };
};

/** The most rows a month's spend carries, the dearest first. */
const monthSpendRows = 64;

/** The UTC month `monthsBack` months before `now`'s, such as `2026-09`. */
const periodOf = (now: Date, monthsBack: number): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1))
    .toISOString()
    .slice(0, 7);

/** `period`'s rows of what the ledger charged, the dearest first. */
const monthSpend = (
  rows: readonly PlatformSpendByPeriod[],
  period: string
): PlatformMonthSpend => ({
  period,
  rows: rows
    .filter((row) => row.period === period)
    .slice(0, monthSpendRows)
    .map(({ feature, model, micros }) => ({
      // A feature this core doesn't know reads as unrecorded, never as another.
      feature: platformAiFeatures.find((known) => known === feature) ?? null,
      model,
      micros,
    })),
});

/** The organization's providers and Grasp's, as the admin reads them. */
const aiStatus = async (env: Env): Promise<AiStatusReport> => {
  const now = new Date();
  const thisMonth = periodOf(now, 0);
  const lastMonth = periodOf(now, 1);
  const [keys, health, choice, spend] = await Promise.all([
    env.CONNECT.aiProviderKeys(),
    modelLedger(env).providerHealth(),
    readModelChoice(env),
    modelLedger(env).platformSpend([thisMonth, lastMonth]),
  ]);
  const chosen =
    choice?.defaultModel === null || choice === null
      ? undefined
      : parseModelRef(choice.defaultModel)?.provider;
  const connected = keys
    .map(({ provider }) => provider)
    // Its default model's provider first; the rest as connect lists them.
    .toSorted(
      (one, other) => Number(other === chosen) - Number(one === chosen)
    );
  const platform = health.flatMap(({ provider, credential }) => {
    const id = aiProviderIdSchema.safeParse(provider);
    return credential === "platform" && id.success ? [id.data] : [];
  });
  return {
    providers: [
      ...connected.map((provider) =>
        statusOf(health, provider, "organization")
      ),
      ...platform.map((provider) => statusOf(health, provider, "platform")),
    ],
    platformSpend: {
      thisMonth: monthSpend(spend, thisMonth),
      lastMonth: monthSpend(spend, lastMonth),
    },
  };
};

/**
 * The admin's request for the organization's AI: 200 with it, once the
 * request is signed, fresh and well formed; 403 for anything else, logged
 * with why.
 */
export const aiStatusReportResponse = async (
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
    purpose: aiStatusReportPurpose,
    schema: aiStatusReportRequestSchema,
    maxBytes: aiStatusReportMaxBytes,
    maxSkewMs: aiStatusReportMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("ai_status.report_refused", { reason: asked });
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  return Response.json(await aiStatus(env), {
    headers: { "cache-control": "no-store" },
  });
};
