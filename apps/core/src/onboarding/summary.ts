import { requestErrors } from "@grasp-os/shared/errors";
import { log } from "@grasp-os/shared/log";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import {
  onboardingSummaryMaxBytes,
  onboardingSummaryMaxSkewMs,
  onboardingSummaryPurpose,
  onboardingSummaryRequestSchema,
} from "@grasp-os/shared/onboarding-summary";
import type { OnboardingSummary } from "@grasp-os/shared/onboarding-summary";

import { consoleSigned } from "../console-signed.ts";
import { errorResponse } from "../errors.ts";
import { gateView } from "./gate.ts";
import { closesOn, dayOf } from "./rules.ts";
import { onboardingStore } from "./store.ts";

// The onboarding as the console's grid shows it (GRA-325): where it
// stands, in numbers only, for the console alone (console-signed.ts). The
// console holds no client data, and nothing here is any: no name, no team,
// no word anyone said, and no number for anything smaller than the whole.

const dayMs = 24 * 60 * 60 * 1000;

/** Whole days from one ISO day to another. */
const daysBetween = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / dayMs
  );

/** The onboarding as the console shows it, from what core holds, at `now`. */
export const summaryOf = (
  view: OnboardingView,
  gate: GateView,
  now: string
): OnboardingSummary => {
  const today = dayOf(now);
  const { plan, roster } = view;
  const started = plan !== null && today >= plan.start;
  const over = plan !== null && today > closesOn(plan);
  const stage = (): OnboardingSummary["stage"] => {
    if (roster === null && gate.open) {
      return "none";
    }
    if (gate.open) {
      return "open";
    }
    if (gate.ready || over) {
      return "waiting";
    }
    return started ? "interviews" : "preparing";
  };
  const closed = !gate.open;
  const needs = [
    closed && !view.agreed,
    view.paused,
    closed && gate.ready,
  ].filter(Boolean).length;
  return {
    stage: stage(),
    day:
      plan !== null && started && !over
        ? daysBetween(plan.start, today) + 1
        : null,
    days: plan?.days ?? null,
    known: gate.known,
    needs,
  };
};

/**
 * The console's request for the summary: 200 with it, once the request is
 * signed, fresh and well formed; 403 for anything else, logged with why.
 */
export const onboardingSummaryResponse = async (
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
    purpose: onboardingSummaryPurpose,
    schema: onboardingSummaryRequestSchema,
    maxBytes: onboardingSummaryMaxBytes,
    maxSkewMs: onboardingSummaryMaxSkewMs,
  });
  if (typeof asked === "string") {
    log.info("onboarding.summary.refused", { reason: asked });
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const now = new Date().toISOString();
  const view = await onboardingStore(env).view(now);
  const gate = await gateView(env, view, now);
  return Response.json(summaryOf(view, gate, now), {
    headers: { "cache-control": "no-store" },
  });
};
