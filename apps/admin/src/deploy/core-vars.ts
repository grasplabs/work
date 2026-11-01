/**
 * The vars a placed client's core is uploaded with (src/hosting/operation.ts):
 * what the admin derives for it (src/deploy/core-config.ts) and the change
 * core records, checked as core would take them.
 */
import type { PlatformChange } from "@grasp-os/shared/platform-change";

import { checkDeployedConfig, onboardingSender } from "./core-config.ts";

/**
 * The only address client `clientId`'s mail may be from: the onboarding
 * sender's, which its `EMAIL` binding is locked to.
 */
export const mailSenderOf = (
  context: { router: { domain: string } },
  clientId: string
): string => onboardingSender(clientId, context.router.domain).address;

/**
 * Client `clientId`'s core vars: its `derived` config and `change` as
 * `PLATFORM_CHANGE`, checked as `checkDeployedConfig` says.
 */
export const configuredCoreVars = (
  clientId: string,
  derived: Readonly<Record<string, unknown>>,
  change: PlatformChange
): Record<string, unknown> => {
  const vars = { ...derived, PLATFORM_CHANGE: change };
  // Never a SIGN_IN no admin can sign in with.
  checkDeployedConfig(clientId, vars);
  return vars;
};
