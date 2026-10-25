import { consentCode, directoryControlUrl } from "./connect-providers.ts";
import type { Idp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The organization's directory in core's tests (GRA-369): who the fake
// Graph holds in the tenant, and an admin who connected it.

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Who is in the tenant's directory, from now on, as Graph has them. */
export const directoryHolds = async (
  users: Record<string, unknown>[]
): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  await providers.fetch(directoryControlUrl, {
    method: "POST",
    body: JSON.stringify({ users }),
  });
};

/** Someone in Entra, as Graph answers the directory's reads. */
export const directoryUser = (
  fields: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: crypto.randomUUID(),
  displayName: "Someone",
  mail: null,
  department: null,
  jobTitle: null,
  accountEnabled: true,
  userType: "Member",
  manager: null,
  ...fields,
});

/** Where the onboarding's company step sends the browser back to. */
export const companyStep = "/setup?step=company";

/**
 * An admin who connected the directory from the company step: their API,
 * and where the browser came back to.
 */
export const connectedDirectory = async (idp: Idp) => {
  const admin = await signedInApi(idp, "admin");
  const { url } = await admin.api.onboarding.connectDirectory(
    "microsoft",
    companyStep
  );
  const authorization = new URL(url);
  const response = await routed(
    `/api/connections/callback?${new URLSearchParams({
      code: consentCode(
        authorization,
        acmeTenant,
        `directory-${crypto.randomUUID()}`
      ),
      state: authorization.searchParams.get("state") ?? "",
    }).toString()}`,
    { headers: { cookie: admin.session } }
  );
  return {
    admin,
    authorization,
    back: new URL(response.headers.get("location") ?? ""),
  };
};
