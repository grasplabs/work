import type { AccountLookup } from "@grasp-os/connector-kit/sign-in";
import {
  appProviderSchema,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { OAuthProvider } from "@grasp-os/shared/connect";
import { landscapeProviderSchema } from "@grasp-os/shared/landscape";
import type { LandscapeProvider } from "@grasp-os/shared/landscape";
import { log } from "@grasp-os/shared/log";
import { z } from "zod";

import { appRecord } from "./bundled-connectors.ts";
import type { AppRecord } from "./bundled-connectors.ts";
import { idTokenClaims, lookupAccount } from "./oauth-client.ts";
import type { TokenSet } from "./oauth-client.ts";

// The providers people connect accounts from, as config records: one
// generic OAuth flow (src/oauth.ts) runs them all, and one API-key sign-in
// those that take a key.
//
// The suites, Microsoft 365 and Google Workspace, are configured here.
// Grasp owns one multi-tenant app per suite; its client ID and secret are
// Worker secrets on connect (threat model Q1), and a suite whose secrets
// are unset can't be connected. Every suite is pinned to the
// organization's own tenant, from the deployment's sign-in config: the
// flow asks the provider for that tenant only where the provider can do
// so, and the account in the ID token must be in it (threat model CN5).
// Accounts outside the organization can't be connected, personal ones
// included.
//
// Every other app is described by the provider record its native
// connector carries (the connector kit's sign-in.ts), and nothing here
// changes for a new one. Its client ID and secret, for OAuth, are its
// entry in `APP_OAUTH_CLIENTS`, found by its provider's name alone, so no
// record reaches another app's secret (AP6). An app has no tenant: the
// account is the one the app's own lookup names.

/** The client credentials of Grasp's app at a provider. */
export interface OAuthClientCredentials {
  id: string;
  secret: string;
}

/** The account a token is for, from its ID token. */
export interface ProviderAccount {
  /** Stable at the provider: an Entra object ID, a Google subject. */
  id: string;
  /** For people: an email address or user principal name. */
  name: string | null;
  /**
   * Its email address, as the provider vouches for it: Google's verified
   * email, or the address the organization's own tenant gives it.
   */
  email: string | null;
}

/** Where a call's credential goes on a request, and what it says. */
export interface Credential {
  /** A lowercase header name. */
  header: string;
  value: string;
}

/** An OAuth access token, as a request carries it. */
export const bearer = (accessToken: string): Credential => ({
  header: "authorization",
  value: `Bearer ${accessToken}`,
});

/** A provider people connect with the OAuth authorization code flow. */
export interface OAuthProviderConfig {
  kind: "oauth";
  id: string;
  /** The native connector that carries out the connection's actions. */
  server: string;
  /**
   * Whether the flow is pinned to the organization's tenant at the
   * provider (the suites). An app has none: its tenant is always `""`.
   */
  pinned: boolean;
  /** Whether `tenant` is a tenant of this provider's kind. */
  isTenant: (tenant: string) => boolean;
  authorizationEndpoint: (tenant: string) => string;
  tokenEndpoint: (tenant: string) => string;
  /** RFC 7009 revocation; none where the provider has no such endpoint. */
  revocationEndpoint?: string;
  scopes: readonly string[];
  /** How the scope parameter joins `scopes`. */
  scopeSeparator: string;
  /**
   * The access a token must be granted, exactly: tokens granted more than
   * `allowed`, or less than `required`, are refused
   * (`connection.scopes_refused`). For a connection that must hold no
   * more than it asks for, as the landscape's; none for the rest.
   */
  granted?: {
    allowed: ReadonlySet<string>;
    required: readonly string[];
  };
  /** Only shared connections, never a person's own (the landscape's). */
  sharedOnly?: boolean;
  /** Parameters the authorization request adds to the standard ones. */
  authorizationParams: (tenant: string) => Record<string, string>;
  /** How the client authenticates at the token and revocation endpoints. */
  clientAuthentication: "client_secret_post" | "client_secret_basic";
  client: (env: Env) => OAuthClientCredentials | undefined;
  /**
   * The account subject the tokens name, whatever else they say: to tell
   * whether a live connection holds the same grant before revoking tokens
   * that won't be kept. None for an app: only its lookup names one.
   */
  subject?: (tokens: TokenSet) => string | undefined;
  /**
   * The account the tokens are for, if they come from this provider for
   * Grasp's app and the account is in `tenant`; `null` otherwise.
   */
  account: (
    tokens: TokenSet,
    tenant: string,
    clientId: string
  ) => Promise<ProviderAccount | null>;
}

/** An app people connect with an API key they give. */
export interface ApiKeyProviderConfig {
  kind: "api_key";
  id: string;
  server: string;
  /** The key, as a call's requests carry it. */
  credential: (key: string) => Credential;
  /** The account the key is for, as the app says; `null` if it refused it. */
  account: (key: string) => Promise<ProviderAccount | null>;
}

export type ProviderConfig = OAuthProviderConfig | ApiKeyProviderConfig;

const credentials = (
  id: string | undefined,
  secret: string | undefined
): OAuthClientCredentials | undefined =>
  id === undefined || id === "" || secret === undefined || secret === ""
    ? undefined
    : { id, secret };

const guidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const domainPattern = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;

/** Just the subject of an ID token, however the rest of it looks. */
const oidOnly = z.object({ oid: z.string().min(1) });
const subOnly = z.object({ sub: z.string().min(1) });

const microsoftClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  tid: z.string(),
  oid: z.string().min(1),
  /** Set for a B2B guest: the tenant that really signed them in. */
  idp: z.string().optional(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
});

const googleClaims = z.object({
  iss: z.string(),
  aud: z.string(),
  sub: z.string().min(1),
  hd: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
});

const googleIssuers = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

const microsoftLogin = "https://login.microsoftonline.com";

/**
 * The Entra account an ID token is for, if it comes from Entra for the
 * client `clientId` and the account is homed in `tenant`.
 */
// oxlint-disable-next-line require-await -- an app's lookup is async
const entraAccount: OAuthProviderConfig["account"] = async (
  { idToken },
  tenant,
  clientId
) => {
  const parsed = microsoftClaims.safeParse(idTokenClaims(idToken));
  if (!parsed.success) {
    return null;
  }
  const {
    iss,
    aud,
    tid,
    oid,
    idp,
    email,
    preferred_username: name,
  } = parsed.data;
  // A guest is homed in another tenant: not an account of the organization.
  const inTenant =
    tid.toLowerCase() === tenant &&
    iss.toLowerCase() === `${microsoftLogin}/${tenant}/v2.0` &&
    (idp === undefined || idp === iss) &&
    aud === clientId;
  return inTenant
    ? { id: oid, name: name ?? null, email: email ?? name ?? null }
    : null;
};

/**
 * Microsoft 365, through Entra ID's v2 endpoints for the organization's own
 * tenant, so the sign-in page offers only its accounts. Entra has no token
 * revocation endpoint: disconnecting deletes the tokens, and they lapse.
 */
const microsoft: OAuthProviderConfig = {
  kind: "oauth",
  id: "microsoft",
  server: "microsoft-365",
  pinned: true,
  isTenant: (tenant) => guidPattern.test(tenant),
  authorizationEndpoint: (tenant) =>
    `${microsoftLogin}/${tenant}/oauth2/v2.0/authorize`,
  tokenEndpoint: (tenant) => `${microsoftLogin}/${tenant}/oauth2/v2.0/token`,
  // What the Microsoft 365 connector needs: mail (the person's own and
  // shared mailboxes), calendars, and files in OneDrive and SharePoint.
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    "Calendars.Read",
    "Calendars.Read.Shared",
    "Files.Read.All",
    "Sites.Read.All",
  ],
  scopeSeparator: " ",
  authorizationParams: () => ({ response_mode: "query" }),
  clientAuthentication: "client_secret_post",
  client: (env) =>
    credentials(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET),
  subject: ({ idToken }) => oidOnly.safeParse(idTokenClaims(idToken)).data?.oid,
  account: entraAccount,
};

/** What the landscape's Microsoft connection reads Graph with, and only that. */
const landscapeScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  // The tenant's enterprise apps, with their publishers.
  "Application.Read.All",
  // The grants people and admins gave them.
  "DelegatedPermissionGrant.Read.All",
  // The names of the people who gave them.
  "User.ReadBasic.All",
] as const;

/**
 * The application landscape's read-only admin connection to Entra
 * (GRA-539), kept apart from Microsoft 365's mail, calendar and files.
 * It signs in with an app registration of its own
 * (`MICROSOFT_LANDSCAPE_CLIENT_*`): Entra puts every scope a person ever
 * granted an app into each token it issues for it, so a token of the
 * Microsoft 365 app could carry mail. A token granted anything beyond
 * these scopes, or short of the reads, is refused all the same.
 */
const microsoftLandscape: OAuthProviderConfig = {
  ...microsoft,
  id: "microsoft-landscape",
  // No connector: its connection takes no calls, only core's sync reads it.
  server: "microsoft-landscape",
  scopes: landscapeScopes,
  granted: {
    // Entra names the OpenID scopes in its answer, or leaves them out.
    allowed: new Set(landscapeScopes.map((scope) => scope.toLowerCase())),
    required: [
      "Application.Read.All",
      "DelegatedPermissionGrant.Read.All",
      "User.ReadBasic.All",
    ],
  },
  sharedOnly: true,
  client: (env) =>
    credentials(
      env.MICROSOFT_LANDSCAPE_CLIENT_ID,
      env.MICROSOFT_LANDSCAPE_CLIENT_SECRET
    ),
};

/** The landscape's connections, by provider. */
const landscapeProviders: Readonly<
  Record<LandscapeProvider, OAuthProviderConfig>
> = {
  "microsoft-landscape": microsoftLandscape,
};

/**
 * Google Workspace. Google can only hint at the domain (`hd`), so the ID
 * token's `hd` is what counts. `access_type=offline` with `prompt=consent`
 * is how Google gives a refresh token every time.
 */
const google: OAuthProviderConfig = {
  kind: "oauth",
  id: "google",
  server: "google-workspace",
  pinned: true,
  isTenant: (tenant) => domainPattern.test(tenant),
  authorizationEndpoint: () => "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: () => "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
  // What the Google Workspace connector needs: Gmail (read, label, draft,
  // send), calendar events and Drive, read-only where it only reads.
  scopes: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  scopeSeparator: " ",
  authorizationParams: (tenant) => ({
    access_type: "offline",
    prompt: "consent",
    hd: tenant,
  }),
  clientAuthentication: "client_secret_post",
  client: (env) => credentials(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  subject: ({ idToken }) => subOnly.safeParse(idTokenClaims(idToken)).data?.sub,
  // oxlint-disable-next-line require-await -- an app's lookup is async
  account: async ({ idToken }, tenant, clientId) => {
    const parsed = googleClaims.safeParse(idTokenClaims(idToken));
    if (!parsed.success) {
      return null;
    }
    const { iss, aud, sub, hd, email, email_verified: verified } = parsed.data;
    const inTenant =
      googleIssuers.has(iss) &&
      aud === clientId &&
      hd?.toLowerCase() === tenant &&
      verified === true;
    return inTenant
      ? { id: sub, name: email ?? null, email: email ?? null }
      : null;
  },
};

/** The suites, by provider. */
export const providers: Readonly<Record<OAuthProvider, OAuthProviderConfig>> = {
  microsoft,
  google,
};

/**
 * Grasp's OAuth apps at the apps, by provider: one Worker secret, JSON,
 * which the console delivers as it does the suites' secrets. Each entry
 * is read on its own, so one that's broken leaves only its own app unset.
 */
const appClientsSchema = z.record(z.string(), z.unknown());
const appClientSchema = z.strictObject({
  id: z.string().min(1).max(512),
  secret: z.string().min(1).max(4096),
});

/**
 * Grasp's client at the app `provider`, from `APP_OAUTH_CLIENTS`, by that
 * name only. A map that doesn't parse, or an entry that doesn't, leaves
 * that app unset, and is logged by its name, never its value.
 */
const appClient = (
  env: Env,
  provider: string
): OAuthClientCredentials | undefined => {
  const raw = env.APP_OAUTH_CLIENTS;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  let value: unknown = undefined;
  try {
    value = JSON.parse(raw);
  } catch {
    // Refused below, as anything else that isn't the map.
  }
  const clients = appClientsSchema.safeParse(value);
  if (!clients.success) {
    log.error("config.invalid", { var: "APP_OAUTH_CLIENTS" });
    return undefined;
  }
  if (!Object.hasOwn(clients.data, provider)) {
    return undefined;
  }
  const client = appClientSchema.safeParse(clients.data[provider]);
  if (!client.success) {
    log.error("config.invalid", { var: "APP_OAUTH_CLIENTS", provider });
    return undefined;
  }
  return client.data;
};

/** The account an app's lookup names, with `credential`. */
const lookedUp =
  (lookup: AccountLookup) =>
  async (credential: Credential): Promise<ProviderAccount | null> =>
    await lookupAccount(lookup, credential);

/** An app, as its record describes it. */
const appProvider = ({
  provider,
  server,
  signIn,
}: AppRecord): ProviderConfig => {
  const lookup = lookedUp(signIn.account);
  if (signIn.kind === "api_key") {
    const credential = (key: string): Credential => ({
      header: signIn.header,
      value: `${signIn.prefix ?? ""}${key}`,
    });
    return {
      kind: "api_key",
      id: provider,
      server,
      credential,
      account: async (key) => await lookup(credential(key)),
    };
  }
  return {
    kind: "oauth",
    id: provider,
    server,
    pinned: false,
    isTenant: (tenant) => tenant === "",
    authorizationEndpoint: () => signIn.authorizationEndpoint,
    tokenEndpoint: () => signIn.tokenEndpoint,
    ...(signIn.revocationEndpoint === undefined
      ? {}
      : { revocationEndpoint: signIn.revocationEndpoint }),
    scopes: signIn.scopes,
    scopeSeparator: signIn.scopeSeparator,
    authorizationParams: () => ({ ...signIn.authorizationParams }),
    clientAuthentication: signIn.clientAuthentication,
    client: (env) => appClient(env, provider),
    // No ID token is trusted from an app: its lookup names the account,
    // and it has no subject apart from that.
    account: async ({ accessToken }) => await lookup(bearer(accessToken)),
  };
};

/** The provider `id` names: a suite, the landscape's, or an app of this release. */
export const providerFor = (id: string): ProviderConfig | undefined => {
  const suite = oauthProviderSchema.safeParse(id);
  if (suite.success) {
    return providers[suite.data];
  }
  const landscape = landscapeProviderSchema.safeParse(id);
  if (landscape.success) {
    return landscapeProviders[landscape.data];
  }
  const record = appProviderSchema.safeParse(id).success
    ? appRecord(id)
    : undefined;
  return record === undefined ? undefined : appProvider(record);
};

/** How Entra may prefix a Microsoft Graph scope in a token's answer. */
const graphScopePrefix = "https://graph.microsoft.com/";

/**
 * Whether `tokens` were granted exactly the access `provider` asks for,
 * where it must hold no more (`granted`): every scope the provider's
 * answer lists among those allowed, and every one required among them.
 * An answer that lists none is refused: nobody can tell what it holds.
 */
export const grantedAsAsked = (
  { granted }: OAuthProviderConfig,
  { scope }: TokenSet
): boolean => {
  if (granted === undefined) {
    return true;
  }
  if (scope === undefined) {
    return false;
  }
  const scopes = new Set(
    scope
      .split(" ")
      .filter((each) => each !== "")
      // Entra may name Graph's scopes by their full URI.
      .map((each) => each.toLowerCase().replace(graphScopePrefix, ""))
  );
  return (
    [...scopes].every((each) => granted.allowed.has(each)) &&
    granted.required.every((each) => scopes.has(each.toLowerCase()))
  );
};
