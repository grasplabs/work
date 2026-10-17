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
 * An endpoint without a query string: one connect posts a secret to, with
 * nothing to mix it into, or the authorization endpoint, whose parameters
 * are connect's and the record's `authorizationParams`, every one checked.
 */
const plainEndpointSchema = endpointSchema.refine(
  (value) => urlOf(value)?.search === "",
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

/** An OAuth scope: RFC 6749 §3.3's characters. */
const scopeSchema = z.string().regex(/^[!#-[\]-~]{1,256}$/u);

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

/** A display name, as the catalog will show it. */
const appNameSchema = z.string().min(1).max(64);

/**
 * OAuth 2.0's authorization code grant with PKCE (S256) and refresh
 * tokens, with Grasp's own app at the provider (its credentials are the
 * deployment's, by the provider's name).
 */
const oauth2SignInSchema = z.strictObject({
  kind: z.literal("oauth2"),
  name: appNameSchema,
  authorizationEndpoint: plainEndpointSchema,
  tokenEndpoint: plainEndpointSchema,
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
  account: accountLookupSchema,
});

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
