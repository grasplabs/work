import { consentCode, directoryControlUrl } from "./connect-providers.ts";
import type { Idp } from "./idp.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { routed, signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// The organization's directory in core's tests (GRA-369): who the fake
// Graph holds in the tenant, and an admin who connected it.

const isFetcher = (value: unknown): value is Fetcher =>
  typeof value === "object" && value !== null && "fetch" in value;

/** Sets the fake Graph's directory (`directoryControlUrl`). */
const setDirectory = async (fields: Record<string, unknown>): Promise<void> => {
  const providers = testBinding("CONNECT_PROVIDERS");
  if (!isFetcher(providers)) {
    throw new TypeError("Expected the providers Worker as CONNECT_PROVIDERS");
  }
  await providers.fetch(directoryControlUrl, {
    method: "POST",
    body: JSON.stringify(fields),
  });
};

/**
 * Who is in the tenant's directory, from now on, as Graph has them, and
 * who it holds deleted (`deleted`, none by default), every page answered.
 */
export const directoryHolds = async (
  users: Record<string, unknown>[],
  deleted: Record<string, unknown>[] = []
): Promise<void> => {
  await setDirectory({
    users,
    failAt: null,
    loopAt: null,
    deleted,
    deletedFailAt: null,
    deletedFailStatus: 500,
    deletedFailBody: null,
    deletedNext: null,
  });
};

/**
 * Has Graph answer the page of its deleted users that starts at offset
 * `from` with HTTP `status` (a server error by default), and `body` as it
 * is when given (Graph's error otherwise), until `directoryHolds` is
 * called again.
 */
export const deletedFailAt = async (
  from: number,
  status = 500,
  body: string | null = null
): Promise<void> => {
  await setDirectory({
    deletedFailAt: from,
    deletedFailStatus: status,
    deletedFailBody: body,
  });
};

/**
 * Has every page of Graph's deleted users link on to `next`, until
 * `directoryHolds` is called again.
 */
export const deletedLinksTo = async (next: string): Promise<void> => {
  await setDirectory({ deletedNext: next });
};

/**
 * Has Graph answer the page of the directory's reads that starts at offset
 * `from` with a next link back to that same page, until `directoryHolds`
 * is called again.
 */
export const directoryLoopsAt = async (from: number): Promise<void> => {
  await setDirectory({ loopAt: from });
};

/**
 * Has Graph fail the page of the directory's reads that starts at offset
 * `from` (a hundred to a page), until `directoryHolds` is called again.
 */
export const directoryFailsAt = async (from: number): Promise<void> => {
  await setDirectory({ failAt: from });
};

/**
 * The tenant's groups, from now on, as Graph has them, with each group's
 * members, nested groups' included, by the group's lower-case ID.
 */
export const directoryGroupsHold = async (
  groups: Record<string, unknown>[],
  members: Record<string, Record<string, unknown>[]> = {}
): Promise<void> => {
  await setDirectory({
    groups,
    members,
    groupFail: null,
    groupFailStatus: 500,
  });
};

/**
 * Has Graph fail every page of the group `groupId`'s members with HTTP
 * `status` (a server error unless told), until `directoryGroupsHold`.
 */
export const directoryGroupFails = async (
  groupId: string,
  status = 500
): Promise<void> => {
  await setDirectory({
    groupFail: groupId.toLowerCase(),
    groupFailStatus: status,
  });
};

/** A group as Graph answers the directory's group calls: a private, assigned security group unless told. */
export const directoryGroup = (
  fields: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id: crypto.randomUUID(),
  displayName: "Finance",
  groupTypes: [],
  securityEnabled: true,
  mailEnabled: false,
  visibility: "Private",
  isAssignableToRole: false,
  onPremisesSyncEnabled: null,
  ...fields,
});

/**
 * What Entra answers the directory's app was granted, from now on, at
 * connecting and at each renewal: `scope`, or `directoryGranted` for null.
 */
export const directoryGrants = async (scope: string | null): Promise<void> => {
  await setDirectory({ granted: scope });
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

/**
 * Who is in the Workspace's directory, from now on, as Google's Admin SDK
 * has them, and who it holds deleted (`deleted`, none by default), every
 * page answered.
 */
export const googleDirectoryHolds = async (
  users: Record<string, unknown>[],
  deleted: Record<string, unknown>[] = []
): Promise<void> => {
  await setDirectory({
    google: users,
    googleDeleted: deleted,
    googleFailAt: null,
    googleRefused: null,
    googleDeletedRefused: null,
  });
};

/**
 * Has Google refuse only the reads of its deleted users with HTTP
 * `status`, the people read answered, until `googleDirectoryHolds` is
 * called again.
 */
export const googleDeletedRefuses = async (status: number): Promise<void> => {
  await setDirectory({ googleDeletedRefused: status });
};

/**
 * Has Google fail the page of the people that starts at offset `from` (a
 * hundred to a page), until `googleDirectoryHolds` is called again.
 */
export const googleDirectoryFailsAt = async (from: number): Promise<void> => {
  await setDirectory({ googleFailAt: from });
};

/**
 * Has Google refuse every read with HTTP `status`, as it refuses a token
 * of someone who isn't an admin (403), until `googleDirectoryHolds` is
 * called again.
 */
export const googleDirectoryRefuses = async (status: number): Promise<void> => {
  await setDirectory({ googleRefused: status });
};

/** A Google user ID, as the Admin SDK and Google's ID tokens give it: 21 digits. */
export const googleId = (): string =>
  [...crypto.getRandomValues(new Uint8Array(21))]
    .map((byte, index) => (index === 0 ? 1 + (byte % 9) : byte % 10))
    .join("");

/** Someone in the Workspace, as the Admin SDK answers the directory's reads. */
export const googleDirectoryUser = (
  fields: Record<string, unknown> = {}
): Record<string, unknown> => {
  const id = googleId();
  return {
    id,
    primaryEmail: `person-${id}@acme.test`,
    name: { fullName: "Someone" },
    suspended: false,
    archived: false,
    organizations: [],
    ...fields,
  };
};

/** What the directory's Google client asks for, as Google answers it granted. */
const googleDirectoryGranted =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/admin.directory.user.readonly";

/**
 * An admin who connected the Workspace's directory from the company step,
 * consenting with an account of `domain`'s Workspace: their API.
 */
export const connectedGoogleDirectory = async (
  idp: Idp,
  domain = "acme.test"
) => {
  const admin = await signedInApi(idp, "admin");
  const { url } = await admin.api.onboarding.connectDirectory(
    "google",
    companyStep
  );
  const authorization = new URL(url);
  const response = await routed(
    `/api/connections/callback?${new URLSearchParams({
      code: consentCode(
        authorization,
        domain,
        googleId(),
        googleDirectoryGranted
      ),
      state: authorization.searchParams.get("state") ?? "",
    }).toString()}`,
    { headers: { cookie: admin.session } }
  );
  return {
    admin,
    back: new URL(response.headers.get("location") ?? ""),
  };
};
