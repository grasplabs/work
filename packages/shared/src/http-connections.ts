import { z } from "zod";

import { isPrivateHost, originRefusal } from "./app-link-limits.ts";
import type { Json } from "./json.ts";

// HTTP connections (GRA-1478): an outside API an admin approves, reached by
// Apps and JSON workflows only through connect, as one more kind of
// connection. What is decided here is pure: the contract every HTTP
// connection serves, the limits, and whether a request stays on what the
// admin approved. Connect (http-connections.ts) holds the credential,
// resolves the host and sends; its header has the threat model.
//
// A connection is one exact `https` origin (no IP address, no private
// network name), the methods it allows, the path prefixes it allows (`/`
// for all of it) and one credential, sent in the header the admin named.
// It is never edited: a different origin, path or credential is another
// connection, so a grant always covers what the admin approved.

/** The contract every HTTP connection serves (connect's contracts.ts). */
export const httpContract = "http.request@1";

/** The connection's provider, as connect records it. */
export const httpProvider = "http";

/** The methods a `get` sends: reads, which never change anything. */
export const httpReadMethods = ["GET", "HEAD"] as const;

/** The methods a `send` sends: each may change something. */
export const httpSendMethods = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Every method an admin may allow. */
export const httpMethods = [...httpReadMethods, ...httpSendMethods] as const;
export type HttpMethod = (typeof httpMethods)[number];

/**
 * The contract's two actions, each also its tool, the name a permission
 * allows: `get`, a read; `send`, a change, which a person confirms where
 * they are there, and which needs an idempotency key in a workflow run.
 */
export const httpActions = ["get", "send"] as const;
export type HttpAction = (typeof httpActions)[number];

/** What an HTTP connection and each of its calls may take. */
export const httpLimits = {
  /** The longest connection name. */
  nameChars: 64,
  /** The most path prefixes a connection allows. */
  pathPrefixes: 16,
  /** The longest path prefix. */
  prefixChars: 256,
  /** The longest path, query included, of one request. */
  pathChars: 2048,
  /** The most headers a request sets itself. */
  headers: 32,
  /** The longest value of one of them. */
  headerValueChars: 2048,
  /** The longest credential. */
  secretChars: 4096,
  /**
   * The most UTF-8 bytes of a request's body: within the 64 KiB connect
   * takes of a call's whole input.
   */
  requestBodyBytes: 48 * 1024,
  /** The most bytes of a response's body read; past it, the call fails. */
  responseBodyBytes: 512 * 1024,
  /** How long one call may take, redirects included. */
  timeoutMs: 15_000,
  /** The most redirects on the origin a `get` follows. */
  redirects: 3,
} as const;

/** A header name, as HTTP's token: letters, digits and dashes. */
const headerNamePattern = /^[A-Za-z0-9-]{1,64}$/u;

/**
 * Headers a call can't set: the credential is connect's to add, a method
 * or URL override would turn a read into a change or reach another path
 * than the one checked, and the rest would change the
 * connection itself or speak for someone else.
 */
const refusedHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "expect",
  "forwarded",
  "via",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "x-real-ip",
  "x-original-url",
  "x-rewrite-url",
  "x-override-url",
  "x-original-method",
  "x-host",
]);

/** Prefixes of headers a call can't set (see `refusedHeaders`). */
const refusedHeaderPrefixes = ["proxy-", "x-forwarded-", "cf-", "sec-"];

/** Whether a call may set header `name` (lower case) beside `credential`. */
export const isSettableHeader = (name: string, credential: string): boolean =>
  headerNamePattern.test(name) &&
  name === name.toLowerCase() &&
  name !== credential &&
  !refusedHeaders.has(name) &&
  !refusedHeaderPrefixes.some((prefix) => name.startsWith(prefix));

/**
 * A header value or credential: visible ASCII, spaces and tabs only. No
 * line breaks or controls, which could add a header, and nothing past
 * ASCII, which `Headers` refuses only once the request is built, after an
 * idempotency key would be spent.
 */
const headerValuePattern = /^[\t\u0020-\u007E]*$/u;

/**
 * Characters a path may not hold: whitespace and controls, which the URL
 * parser strips or rewrites, a backslash, read as a slash, and a fragment.
 */
const notInPath =
  // oxlint-disable-next-line no-control-regex -- controls are what it refuses
  /[\u0000- \u007F-\u009F\\#]/u;

/**
 * Escapes a server may decode into a dot or a separator after the path was
 * checked (`/api/..%2fadmin`): refused outright, whatever the server does.
 */
const decodedSeparators = /%(?:2e|2f|5c|00)/iu;

/** A base nobody reaches: only the path and query of a parse are read. */
const pathBase = "https://path.invalid";

/**
 * The path `path` as sent, if it is one exactly as the URL standard would
 * send it: starting with one `/`, with no dot segments, encoded separators
 * or anything the parser would rewrite. Its pathname apart, to match.
 */
const parsedPath = (
  path: unknown
): { pathname: string; search: string } | undefined => {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > httpLimits.pathChars ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    !path.isWellFormed() ||
    notInPath.test(path) ||
    decodedSeparators.test(path)
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(path, pathBase);
  } catch {
    return undefined;
  }
  // Nothing the parser rewrote: no dot segment, no stray `?`, no encoding.
  if (url.origin !== pathBase || `${url.pathname}${url.search}` !== path) {
    return undefined;
  }
  return { pathname: url.pathname, search: url.search };
};

/** Whether `pathname` is under `prefix`, segment for segment. */
const isUnder = (pathname: string, prefix: string): boolean => {
  if (prefix === "/") {
    return true;
  }
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === base || pathname.startsWith(`${base}/`);
};

/** Why a path isn't one to send under `prefixes`, or its pathname if it is. */
export const httpPathOf = (
  path: unknown,
  prefixes: readonly string[]
):
  | { ok: true; pathname: string }
  | { ok: false; reason: "path" | "prefix" } => {
  const parsed = parsedPath(path);
  if (parsed === undefined) {
    return { ok: false, reason: "path" };
  }
  return prefixes.some((prefix) => isUnder(parsed.pathname, prefix))
    ? { ok: true, pathname: parsed.pathname }
    : { ok: false, reason: "prefix" };
};

/** A path prefix an admin may allow: a path of its own, with no query. */
const prefixSchema = z
  .string()
  .max(httpLimits.prefixChars)
  .refine((prefix) => {
    const parsed = parsedPath(prefix);
    return parsed !== undefined && parsed.search === "";
  }, "A path prefix starts with / and holds no query, dot segments or encoded separators");

/** An origin an admin may approve: exactly `https://host[:port]`, public. */
export const httpOriginSchema = z
  .string()
  .refine(
    (origin) => originRefusal(origin) === undefined,
    "An https origin, exactly as written (https://api.example.com), on a public host name"
  );

/** The credential connect sends with every request, in one header. */
export const httpCredentialSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("bearer"),
    token: z
      .string()
      .min(1)
      .max(httpLimits.secretChars)
      .regex(headerValuePattern),
  }),
  z.strictObject({
    kind: z.literal("header"),
    /** The header it goes in, such as `x-api-key`. */
    header: z
      .string()
      .regex(headerNamePattern)
      .transform((name) => name.toLowerCase())
      .refine(
        (name) =>
          name === "authorization" || isSettableHeader(name, "authorization"),
        "Not a header a credential can go in"
      ),
    secret: z
      .string()
      .min(1)
      .max(httpLimits.secretChars)
      .regex(headerValuePattern),
  }),
]);
export type HttpCredential = z.input<typeof httpCredentialSchema>;

/** An HTTP connection, as an admin approves it. */
export const httpConnectionSchema = z.strictObject({
  /** What people call it, such as `Billing API`. */
  name: z.string().trim().min(1).max(httpLimits.nameChars),
  origin: httpOriginSchema,
  /** The paths it allows, each with everything under it: `/` for all. */
  pathPrefixes: z
    .array(prefixSchema)
    .min(1)
    .max(httpLimits.pathPrefixes)
    .refine((prefixes) => new Set(prefixes).size === prefixes.length)
    .default(["/"]),
  methods: z
    .array(z.enum(httpMethods))
    .min(1)
    .refine((methods) => new Set(methods).size === methods.length),
  credential: httpCredentialSchema,
});
export type HttpConnectionInput = z.input<typeof httpConnectionSchema>;

/** An HTTP connection as it is listed: never its credential. */
export interface HttpConnectionSummary {
  name: string;
  origin: string;
  pathPrefixes: string[];
  methods: HttpMethod[];
  /** The header its credential goes in; never the credential. */
  credentialHeader: string;
}

/** The headers a call sets itself: names in lower case. */
const headersSchema = z
  .record(
    z.string().regex(headerNamePattern),
    z.string().max(httpLimits.headerValueChars).regex(headerValuePattern)
  )
  .refine((headers) => Object.keys(headers).length <= httpLimits.headers);

/** A `get`'s input. */
export const httpGetInputSchema = z.strictObject({
  method: z.enum(httpReadMethods).optional(),
  path: z.string().min(1).max(httpLimits.pathChars),
  headers: headersSchema.optional(),
});

/** A `send`'s input. */
export const httpSendInputSchema = z.strictObject({
  method: z.enum(httpSendMethods),
  path: z.string().min(1).max(httpLimits.pathChars),
  headers: headersSchema.optional(),
  body: z
    .string()
    .refine(
      (body) =>
        new TextEncoder().encode(body).byteLength <= httpLimits.requestBodyBytes
    )
    .optional(),
});

/** What both actions answer: the response's status, headers and text. */
export interface HttpAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The JSON Schema of the headers a call sets. */
const headersJsonSchema: Json = {
  type: "object",
  additionalProperties: {
    type: "string",
    maxLength: httpLimits.headerValueChars,
  },
};

/** The JSON Schema of a request's path. */
const pathJsonSchema: Json = {
  type: "string",
  minLength: 1,
  maxLength: httpLimits.pathChars,
  description:
    "The path and query, starting with /, under one of the connection's path prefixes.",
};

/**
 * The JSON Schemas of each action's input and output, as the contract
 * serves them (connect's contracts.ts) and the release's catalog contract
 * describes them (core's release-contracts.ts): one source, so the two are
 * always equal.
 */
export const httpActionSchemas: Readonly<
  Record<HttpAction, { input: Json; output: Json }>
> = {
  get: {
    input: {
      type: "object",
      properties: {
        method: { type: "string", enum: [...httpReadMethods] },
        path: pathJsonSchema,
        headers: headersJsonSchema,
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        status: { type: "integer", minimum: 100, maximum: 599 },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string" },
      },
      required: ["status", "headers", "body"],
      additionalProperties: false,
    },
  },
  send: {
    input: {
      type: "object",
      properties: {
        method: { type: "string", enum: [...httpSendMethods] },
        path: pathJsonSchema,
        headers: headersJsonSchema,
        body: { type: "string" },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        status: { type: "integer", minimum: 100, maximum: 599 },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string" },
      },
      required: ["status", "headers", "body"],
      additionalProperties: false,
    },
  },
};

/** The actions a connection allowing `methods` serves. */
export const httpActionsOf = (methods: readonly string[]): HttpAction[] =>
  httpActions.filter((action) =>
    (action === "get" ? httpReadMethods : httpSendMethods).some((method) =>
      methods.includes(method)
    )
  );

/** The properties each action's input may hold. */
export const httpInputProperties: Readonly<
  Record<HttpAction, readonly string[]>
> = {
  get: ["method", "path", "headers"],
  send: ["method", "path", "headers", "body"],
};

/**
 * Whether resolved address `address` (an IPv4 or IPv6 address, as DNS
 * answers it) is outside the public internet, by the rules links and
 * webhooks go by (`isPrivateHost`). One that can't be read counts as
 * private.
 */
export const isPrivateAddress = (address: string): boolean => {
  const host = address.includes(":") ? `[${address}]` : address;
  let hostname: string;
  try {
    ({ hostname } = new URL(`https://${host}/`));
  } catch {
    return true;
  }
  const literal =
    hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname);
  return !literal || isPrivateHost(hostname);
};
