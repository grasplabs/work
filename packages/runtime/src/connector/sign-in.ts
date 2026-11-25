import { companyToolClassSchema } from "@grasp-os/shared/connect";
import { z } from "zod";

// How a person signs in to an app that isn't one of the suites connect
// handles itself (Microsoft 365, Google Workspace): its provider record.
// A native connector for such an app carries the record in its manifest,
// so a new app is one connector package, its record included, and never a
// change to connect: connect runs one generic OAuth 2.0 flow, and one
// API-key sign-in, for every record.
//
// A record is data only, checked here at build time and again by connect
// when it loads the release: nothing in it is code connect runs, and it
// can't name anything of connect's (a secret, a binding, another app's
// record). What it can't be trusted with, connect decides itself (threat
// model AP1 to AP9, in connect's test/app-sign-in.test.ts):
//
// - Every endpoint is HTTPS on a DNS name, on its default port, with no
//   credentials or fragment in the URL: the client secret, a code or a
//   token never goes out in the clear, or to an address a name hides.
// - The redirect URI, the state, the PKCE challenge, the client ID and the
//   scope are connect's to set: the authorization parameters a record adds
//   may not name them (nor may its authorization endpoint carry a query),
//   so it can't send the code elsewhere, weaken PKCE or ask for more than
//   its scopes.
// - Its client credentials are found by its provider's name in the
//   deployment's `APP_OAUTH_CLIENTS`, never by a name the record gives.
// - The account lookup, which carries the token or key, goes only to one
//   of the connector's own hosts, as its calls do.
// - An API key goes in the one header the record names, never in the URL,
//   and never in a header that would carry it somewhere else.
//
// A record may also say what the suites' sign-ins need (AP10 to AP18, in
// connect's test/declared-sign-in.test.ts):
//
// - A tenant, of one of the kinds connect knows (`tenantKinds`): the flow
//   is pinned to the organization's own, which fills `{tenant}` in its
//   endpoints' paths, its parameters, its issuer and its claims. A tenant
//   is a GUID or a DNS name, nothing else, and `{tenant}` is never in an
//   endpoint's host: it can't name another host, a path segment of its
//   own, a query or a fragment.
// - The account from the OpenID ID token the token endpoint answers with,
//   instead of a lookup: its issuer, exactly, for Grasp's client, and the
//   claims the record names. A pinned record's check always names the
//   tenant (in a claim, or in every issuer), so an account of another
//   tenant is never taken.
// - Its scopes by tool class: every one of its `scopes` asked for by
//   some class, its sign-in or a shared mailbox, and nothing else, and a
//   renewal requiring only what every consent asks for.
// - A prefix a token answer may put on its scopes, stripped from its start
//   only, and never one of its own scopes' starts.

/** Where a pinned sign-in puts the organization's tenant. */
const tenantPlaceholder = "{tenant}";

/**
 * The kinds of tenant a sign-in may be pinned to, as connect gets them
 * (lowercase): an Entra tenant ID (a GUID), or a hosted domain (a DNS
 * name). Neither holds a `/`, `?`, `#`, `@`, `:` or `%`, or is a dot
 * segment, so filled into a path or a parameter it stays one segment, or
 * one value.
 */
export const tenantKinds = {
  guid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  domain: /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u,
} as const;
export type TenantKind = keyof typeof tenantKinds;

// SAFETY: the keys of `tenantKinds`, a constant with two, as its type has them.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const tenantKindNames = Object.keys(tenantKinds) as [
  TenantKind,
  ...TenantKind[],
];

/** `value` with `tenant` for each `{tenant}`. */
export const withTenant = (value: string, tenant: string): string =>
  value.replaceAll(tenantPlaceholder, tenant);

/** Two tenants a template is checked with: what changes between them is the tenant's. */
const checkedTenants = ["tenant", "other-tenant"] as const;

/**
 * A DNS name as a URL has it (lowercase): two labels or more and a
 * top-level label starting with a letter, so never an IP address.
 */
const hostPattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** `value` as a URL, if it is one. */
const urlOf = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/** Whether `value` is an HTTPS URL on a DNS name, as an endpoint must be. */
const isEndpoint = (value: string): boolean => {
  const url = urlOf(value);
  return (
    url !== undefined &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.hash === "" &&
    hostPattern.test(url.hostname) &&
    // As written: no case, escapes or dot segments the parser would change.
    url.href === value
  );
};

const endpointSchema = z
  .string()
  .max(512)
  .refine(isEndpoint, "Not an HTTPS endpoint on a DNS name");

/**
 * An endpoint that may hold `{tenant}`, past its host: filled with any
 * tenant it is an endpoint, always on the same origin.
 */
const isEndpointTemplate = (value: string): boolean => {
  const filled = checkedTenants.map((tenant) => withTenant(value, tenant));
  const origins = new Set(filled.map((each) => urlOf(each)?.origin));
  return filled.every(isEndpoint) && origins.size === 1;
};

const endpointTemplateSchema = z
  .string()
  .max(512)
  .refine(isEndpointTemplate, "Not an HTTPS endpoint on a DNS name");

/**
 * An endpoint without a query string: one connect posts a secret to, with
 * nothing to mix it into, or the authorization endpoint, whose parameters
 * are connect's and the record's `authorizationParams`, every one checked.
 */
const plainEndpointSchema = endpointSchema.refine(
  (value) => urlOf(value)?.search === "",
  "An endpoint without a query string"
);

/** A plain endpoint that may hold `{tenant}` (`isEndpointTemplate`). */
const plainEndpointTemplateSchema = endpointTemplateSchema.refine(
  (value) => urlOf(withTenant(value, checkedTenants[0]))?.search === "",
  "An endpoint without a query string"
);

/**
 * Authorization request parameters connect sets itself, and a record may
 * not add or change, in any case: where the code goes, the state and PKCE
 * that bind it to the flow, the client, the scopes, and the request object
 * forms that could carry any of those past connect.
 */
export const reservedAuthorizationParams: ReadonlySet<string> = new Set([
  "response_type",
  "client_id",
  "client_secret",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "code_verifier",
  "nonce",
  "request",
  "request_uri",
  "response_mode",
  // What could ask for more than the record's scopes (RFC 9396, RFC 8707,
  // OpenID Connect's claims).
  "authorization_details",
  "resource",
  "claims",
]);

const paramNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/u)
  .refine(
    (name) => !reservedAuthorizationParams.has(name),
    "A parameter connect sets itself"
  );

/** A scope token (RFC 6749 §3.3): `1*NQCHAR`. */
export const scopeToken = /^[!#-[\]-~]+$/u;

/** An OAuth scope: a scope token. */
const scopeSchema = z.string().max(256).regex(scopeToken);

/**
 * An RFC 6901 JSON pointer into the account lookup's answer, such as
 * `/data/id`: plain property names and array indexes only.
 */
const pointerSchema = z.string().regex(/^(?:\/[\w.-]{1,64}){1,8}$/u);

/**
 * How connect learns which account a token or key is for: one GET, with
 * the token or key, to a URL on one of the connector's hosts, whose JSON
 * answer names the account's stable ID, and maybe its name and email
 * address. The email address, as the app vouches for it, is what makes a
 * personal connection the person's own: without one, the app's accounts
 * are connected only as shared ones, by an admin.
 */
export const accountLookupSchema = z.strictObject({
  url: endpointSchema,
  id: pointerSchema,
  name: pointerSchema.optional(),
  email: pointerSchema.optional(),
});
export type AccountLookup = z.infer<typeof accountLookupSchema>;

/**
 * An OpenID issuer: an HTTPS URL on a DNS name, with no query or fragment,
 * or a bare DNS name (as Google also names itself), compared exactly.
 * `{tenant}` may stand in its path, never in its host.
 */
const isIssuer = (value: string): boolean => {
  const hosts = checkedTenants.map((tenant) => {
    const filled = withTenant(value, tenant);
    if (hostPattern.test(filled)) {
      return filled;
    }
    const url = urlOf(filled);
    const plain =
      url !== undefined &&
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      url.search === "" &&
      url.hash === "" &&
      hostPattern.test(url.hostname) &&
      (url.href === filled || url.href === `${filled}/`);
    return plain ? url.hostname : undefined;
  });
  return hosts[0] !== undefined && hosts[0] === hosts[1];
};

const issuerSchema = z
  .string()
  .max(512)
  .refine(isIssuer, "Not an issuer: an HTTPS URL or a DNS name");

/**
 * An ID token's claim, by name. `iss` and `aud` are connect's to check:
 * the record's issuer, and Grasp's client.
 */
const claimNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u)
  .refine((name) => name !== "iss" && name !== "aud", "A claim connect checks");

/**
 * How connect learns which account a token is for from the OpenID ID token
 * the token endpoint answers with (OpenID Connect Core §3.1.3.7): issued by
 * `issuer` (one of them, exactly) for Grasp's client, with each of
 * `claims` as it says (a string, compared without case, or `true`), and
 * each of `sameIssuer` absent or the issuer itself. `subject` names the
 * account's stable ID; `name` and `email` the claims its name and its
 * address are read from, the first that is there.
 */
const idTokenSchema = z.strictObject({
  issuer: z.union([issuerSchema, z.array(issuerSchema).min(1).max(8)]),
  subject: claimNameSchema,
  name: z.array(claimNameSchema).min(1).max(4).optional(),
  email: z.array(claimNameSchema).min(1).max(4).optional(),
  claims: z
    .record(
      claimNameSchema,
      z.union([z.string().min(1).max(256), z.literal(true)])
    )
    .optional(),
  sameIssuer: z.array(claimNameSchema).min(1).max(4).optional(),
});
export type IdTokenCheck = z.infer<typeof idTokenSchema>;

/** Scopes, each once. */
const scopeListSchema = z
  .array(scopeSchema)
  .max(64)
  .refine((scopes) => new Set(scopes).size === scopes.length, "A scope twice");

/**
 * What a consent asks for by the tool classes a company has on: the
 * sign-in's always, and each class's while it is on; `implied`, what each
 * scope takes in besides itself; `sharedMailbox`, what a shared mailbox
 * asks for while one is pointed at, to read it, and to send from it with
 * Reach others on.
 */
const rightsSchema = z
  .strictObject({
    signIn: scopeListSchema,
    classes: z.record(companyToolClassSchema, scopeListSchema),
    implied: z.record(scopeSchema, scopeListSchema).optional(),
    sharedMailbox: z
      .strictObject({ read: scopeListSchema, reach: scopeListSchema })
      .optional(),
  })
  .refine(
    ({ implied = {} }) => {
      const takesIn = new Map(
        Object.entries(implied).map(([scope, each]) => [
          scope.toLowerCase(),
          new Set(each.map((one) => one.toLowerCase())),
        ])
      );
      return [...takesIn].every(
        ([scope, own]) =>
          !own.has(scope) &&
          [...own].every((each) =>
            [...(takesIn.get(each) ?? [])].every((further) => own.has(further))
          )
      );
    },
    // Connect follows one step of it: closed, that step is the whole of
    // what a scope takes in, and no scope reaches itself.
    "A scope lists everything it takes in, through the scopes it takes in, and never itself"
  );
export type DeclaredRights = z.infer<typeof rightsSchema>;

/** Every scope `rights` names. */
const rightsScopes = ({
  signIn,
  classes,
  implied = {},
  sharedMailbox,
}: DeclaredRights): string[] => [
  ...signIn,
  ...Object.values(classes).flat(),
  ...Object.entries(implied).flatMap(([scope, takesIn]) => [scope, ...takesIn]),
  ...(sharedMailbox === undefined
    ? []
    : [...sharedMailbox.read, ...sharedMailbox.reach]),
];

/** A display name, as the catalog will show it. */
const appNameSchema = z.string().min(1).max(64);

/**
 * OAuth 2.0's authorization code grant with PKCE (S256) and refresh
 * tokens, with Grasp's own app at the provider (its credentials are the
 * deployment's, by the provider's name).
 */
const oauth2SignInSchema = z
  .strictObject({
    kind: z.literal("oauth2"),
    name: appNameSchema,
    authorizationEndpoint: plainEndpointTemplateSchema,
    tokenEndpoint: plainEndpointTemplateSchema,
    /** RFC 7009; without one, disconnecting deletes the tokens only. */
    revocationEndpoint: plainEndpointSchema.optional(),
    /** Exactly what connect asks for: the connector's scopes are among them. */
    scopes: z.array(scopeSchema).min(1).max(64),
    /** How the scopes are joined: RFC 6749 says a space; some apps a comma. */
    scopeSeparator: z.enum([" ", ","]).default(" "),
    /** Parameters the authorization request adds to connect's own. */
    authorizationParams: z
      .record(paramNameSchema, z.string().min(1).max(256))
      .default({}),
    /** How the client authenticates at the token endpoint (RFC 6749 §2.3.1). */
    clientAuthentication: z
      .enum(["client_secret_post", "client_secret_basic"])
      .default("client_secret_post"),
    /** Whose account a token is for: a lookup's, or the ID token's. */
    account: accountLookupSchema.optional(),
    idToken: idTokenSchema.optional(),
    /** The kind of the organization's own tenant, which pins the flow to it. */
    tenant: z.enum(tenantKindNames).optional(),
    /** What a consent asks for by tool class; without it, all of `scopes`. */
    rights: rightsSchema.optional(),
    /** A prefix a token answer may put on a scope, stripped as they're compared. */
    scopePrefix: endpointSchema.optional(),
    /** Scopes a renewal must hold, or its connection is asked to reconnect. */
    renewalRequires: scopeListSchema.optional(),
    /** `account`: revoking one token revokes the account's whole grant. */
    grant: z.literal("account").optional(),
  })
  .refine(
    ({ scopes, scopeSeparator }) =>
      scopes.every((scope) => !scope.includes(scopeSeparator)),
    // Joined, it would be two scopes at the app, and not the ones checked.
    "A scope can't hold the separator it is joined with"
  )
  .refine(
    ({ account, idToken }) =>
      (account === undefined) !== (idToken === undefined),
    "An account lookup or an ID token, one of them"
  )
  .refine(
    ({ scopes }) =>
      new Set(scopes.map((scope) => scope.toLowerCase())).size ===
      scopes.length,
    // Compared without case, they would be one.
    "A scope twice, in another case"
  )
  .refine(
    ({ idToken, scopes, rights }) =>
      idToken === undefined || (rights?.signIn ?? scopes).includes("openid"),
    // Asked by class, every consent asks for its sign-in.
    "An ID token is asked for with the openid scope, in every consent"
  )
  .refine(
    ({ tenant, idToken }) =>
      tenant === undefined ||
      (idToken !== undefined &&
        (Object.values(idToken.claims ?? {}).some(
          (each) => typeof each === "string" && each.includes(tenantPlaceholder)
        ) ||
          [idToken.issuer]
            .flat()
            .every((each) => each.includes(tenantPlaceholder)))),
    // Else an account of any tenant would do: one issuer without the
    // tenant takes every tenant's tokens.
    "A pinned sign-in checks its tenant in a claim, or in every issuer"
  )
  .refine(
    ({
      tenant,
      authorizationEndpoint,
      tokenEndpoint,
      authorizationParams,
      idToken,
    }) =>
      tenant !== undefined ||
      ![
        authorizationEndpoint,
        tokenEndpoint,
        ...Object.values(authorizationParams),
        ...[idToken?.issuer ?? []].flat(),
        ...Object.values(idToken?.claims ?? {}),
      ].some(
        (each) => typeof each === "string" && each.includes(tenantPlaceholder)
      ),
    "Only a pinned sign-in has a tenant to fill"
  )
  .refine(
    ({ scopes, rights, renewalRequires = [] }) =>
      [
        ...(rights === undefined ? [] : rightsScopes(rights)),
        ...renewalRequires,
      ].every((scope) => scopes.includes(scope)),
    "Its rights and what a renewal requires are among its scopes"
  )
  .refine(
    ({ scopes, rights }) => {
      if (rights === undefined) {
        return true;
      }
      const { signIn, classes, sharedMailbox } = rights;
      const asked = new Set([
        ...signIn,
        ...Object.values(classes).flat(),
        ...(sharedMailbox === undefined
          ? []
          : [...sharedMailbox.read, ...sharedMailbox.reach]),
      ]);
      return scopes.every((scope) => asked.has(scope));
    },
    // Else it is never asked for.
    "Every scope is asked for by its sign-in, a class or a shared mailbox"
  )
  .refine(
    ({ rights, renewalRequires = [] }) =>
      rights === undefined ||
      renewalRequires.every((scope) => rights.signIn.includes(scope)),
    // A class turned off leaves its scopes out of the consent: required at
    // each renewal, connecting again could never give them.
    "With rights, a renewal requires only what its sign-in asks for"
  )
  .refine(
    ({ scopes, scopePrefix }) =>
      scopePrefix === undefined ||
      (scopePrefix.endsWith("/") &&
        scopes.every(
          (scope) => !scope.toLowerCase().startsWith(scopePrefix.toLowerCase())
        )),
    // Stripped, it would make one scope another's name.
    "A scope prefix is a URL ending in /, which no scope starts with"
  );

/**
 * Header names an API key can't go in: those the runtime or a proxy acts
 * on, or that would carry it somewhere else (a cookie jar, a forwarded
 * request), and the egress's own.
 */
const refusedKeyHeaders: ReadonlySet<string> = new Set([
  "cookie",
  "host",
  "connection",
  "content-length",
  "content-type",
  "forwarded",
  "proxy-authorization",
  "te",
  "transfer-encoding",
  "upgrade",
  "grasp-egress",
]);

const keyHeaderSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/u)
  .refine(
    (name) => !refusedKeyHeaders.has(name) && !name.startsWith("x-forwarded"),
    "Not a header an API key may go in"
  );

/**
 * An API key the person gives, sent on every request in one header:
 * `authorization` with a `Bearer ` prefix, say, or `x-api-key` alone.
 */
const apiKeySignInSchema = z.strictObject({
  kind: z.literal("api_key"),
  name: appNameSchema,
  header: keyHeaderSchema,
  /** Text before the key in the header, such as `Bearer `. */
  prefix: z
    .string()
    .regex(/^[!-~]{1,32} ?$/u)
    .optional(),
  account: accountLookupSchema,
});

/** The host an endpoint names, once it is one (`isEndpoint`). */
export const endpointHost = (value: string): string | undefined =>
  urlOf(value)?.hostname;

/** An app's provider record: how a person signs in to it. */
export const signInSchema = z.discriminatedUnion("kind", [
  oauth2SignInSchema,
  apiKeySignInSchema,
]);
export type SignIn = z.output<typeof signInSchema>;
export type SignInInput = z.input<typeof signInSchema>;
