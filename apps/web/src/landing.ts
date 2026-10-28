import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";

// Where someone lands right after signing in: where they were going, as
// ever, except that a company's admin whose organization is still
// onboarding goes straight into the onboarding (/setup) instead of the
// home page, rather than finding it by its address. Only right after
// signing in: an admin who leaves the onboarding for the app stays there.
// Which pages anyone may open is decided where it always is (the routes
// and core); this only picks the first page.

/** Where this tab notes that it went to sign in, until it is back. */
const signingInKey = "grasp.signing-in";

/** Notes, as this tab leaves for the IdP, that whoever comes back has just signed in. */
export const noteSigningIn = (): void => {
  try {
    sessionStorage.setItem(signingInKey, "1");
  } catch {
    // Storage refused: they land where they were going, as ever.
  }
};

/** Whether this tab just came back from signing in: true once, and forgotten as it is read. */
export const takeJustSignedIn = (): boolean => {
  try {
    const just = sessionStorage.getItem(signingInKey) !== null;
    sessionStorage.removeItem(signingInKey);
    return just;
  } catch {
    return false;
  }
};

/**
 * Where to send someone who just signed in on their way to `path`: to the
 * onboarding when they are the company's admin, were going to the home
 * page, and their organization has not finished onboarding (Grasp has not
 * given its go: `open` false); null to go on where they were going. Asked
 * only for an admin, and only when that's what it turns on.
 */
export const landingAfterSignIn = async ({
  path,
  identity,
  open,
}: {
  path: string;
  identity: Pick<Identity, "role" | "staff" | "onboardingOnly">;
  /** Whether the organization finished onboarding; asked only when it matters. */
  open: () => Promise<boolean>;
}): Promise<"/setup" | null> => {
  const companyAdmin =
    isAdmin(identity.role) &&
    !identity.staff &&
    identity.onboardingOnly !== true;
  if (path !== "/" || !companyAdmin) {
    return null;
  }
  return (await open()) ? null : "/setup";
};
