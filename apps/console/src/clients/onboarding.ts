/**
 * A client's onboarding, as its card on the grid shows it: what its core
 * answers at `onboardingSummaryPath`, numbers only (core's
 * src/onboarding/summary.ts). Only the console may ask: the request is
 * signed with the key both derive from the client's auth secret, as a
 * platform update notice is (src/rollout/activity.ts), and goes through
 * the router's route with the router secret, as the health check does.
 */
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { toHex } from "@grasp-os/shared/encoding";
import {
  onboardingSummaryPath,
  onboardingSummaryPurpose,
  onboardingSummarySchema,
} from "@grasp-os/shared/onboarding-summary";
import type { OnboardingSummary } from "@grasp-os/shared/onboarding-summary";
import { platformUpdateSignatureHeader } from "@grasp-os/shared/platform-change";
import { routerSecretHeader } from "@grasp-os/shared/router";

const encoder = new TextEncoder();

/**
 * What a client's onboarding shows: its summary; `unreachable` when its
 * core can't be asked from here (no route, or a release from before the
 * summary), which is known, not missing; null when its core didn't answer.
 */
export type OnboardingCell = OnboardingSummary | "unreachable" | null;

/** What asking a client's core takes. */
export interface SummaryRequest {
  coreUrl: string;
  routerSecret: string;
  /** The client's core auth secret, the signing key's source. */
  authSecret: string;
  signal: AbortSignal;
}

/** Client core's onboarding summary, signed for, as `OnboardingCell` says. */
export const onboardingSummaryOf = async ({
  coreUrl,
  routerSecret,
  authSecret,
  signal,
}: SummaryRequest): Promise<OnboardingCell> => {
  const body = JSON.stringify({ sentAt: new Date().toISOString() });
  const key = await hkdfHmacKey(authSecret, onboardingSummaryPurpose, ["sign"]);
  const signature = toHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))
  );
  const response = await fetch(`${coreUrl}${onboardingSummaryPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [routerSecretHeader]: routerSecret,
      [platformUpdateSignatureHeader]: signature,
    },
    body,
    signal,
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return "unreachable";
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const parsed = onboardingSummarySchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
};
