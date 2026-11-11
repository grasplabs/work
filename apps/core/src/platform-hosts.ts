import { usualHostProviders } from "@grasp-os/shared/ai-providers";
import type { AiProviderId } from "@grasp-os/shared/ai-providers";

/**
 * The providers whose platform features this deployment sends to their
 * usual host, not their EU data residency host (`PLATFORM_AI_USUAL_HOSTS`):
 * none, but on a staging deployment set up for testing with a key of an
 * account that has no EU residency. What the gateway routes by, records
 * as the call's region, and tells the organization's admins of where a
 * feature runs.
 */
export const usualHostsOf = (
  env: Pick<Env, "PLATFORM_AI_USUAL_HOSTS">
): AiProviderId[] => usualHostProviders(env.PLATFORM_AI_USUAL_HOSTS);
