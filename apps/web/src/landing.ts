import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

import { readWithin } from "./core-connection.ts";
import type { CoreConnection } from "./core-connection.ts";

// Where someone signed in is held while their company's onboarding isn't
// behind it (`onboardingBehind`, @grasp-os/shared/onboarding-flow, as core
// answers it): its admins in the onboarding (/setup), which is all of
// theirs to finish, and everyone else on a page that asks them to wait
// (/waiting). Asked on the way to every page of the platform, so nobody
// finds it by an address before it is ready. Core decides who may read or
// do what, as ever; this only keeps the pages closed until then.

/** The connections whose company has its onboarding behind it: it stays behind. */
const behindOn = new WeakSet<object>();

/**
 * Whether the onboarding is behind the company on `core`, as core says:
 * asked on the way to each page until it is, then known. Core out of
 * reach for it holds nobody: each page then shows its own reads failing.
 */
export const onboardingIsBehind = async (
  core: Pick<CoreConnection, "withSession">
): Promise<boolean> => {
  if (behindOn.has(core)) {
    return true;
  }
  try {
    const behind = await readWithin(
      core,
      async (session) => await session.onboarding.behind()
    );
    if (behind) {
      behindOn.add(core);
    }
    return behind;
  } catch {
    return true;
  }
};

/** The onboarding's own page under Settings, which its admins keep: who was asked, and the links. */
const onboardingSettings = "/settings/onboarding";

/**
 * Where someone on their way to `path` goes instead while the onboarding
 * isn't behind the company: `/setup` for its admins, `/waiting` for
 * everyone else; null to go on, once it is behind them.
 */
export const heldWhileOnboarding = ({
  path,
  identity,
  behind,
}: {
  path: string;
  identity: Pick<Identity, "role" | "staff" | "onboardingOnly">;
  /** Whether the onboarding is behind the company, as core says. */
  behind: boolean;
}): "/setup" | "/waiting" | null => {
  if (behind) {
    return null;
  }
  if (!isMemberAdmin(identity) || identity.onboardingOnly === true) {
    return "/waiting";
  }
  return path === onboardingSettings ? null : "/setup";
};
