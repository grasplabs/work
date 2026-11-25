import { validateValue } from "../common/value-interpreter.ts";
import type { AnySchema } from "../common/value-schema.ts";
import type { Infer } from "../common/value-types.ts";
import { egressHeader, httpMethods, pathMatches } from "./manifest.ts";
import type { Route } from "./manifest.ts";
import { providerFetch, segment } from "./provider.ts";
import { isWriteMethod, ToolError } from "./server.ts";

// How a connector's handler reaches its vendor: by the routes its tool
// declares, never by URL. The handler names a route as declared (its path
// template, and its host where the connector has several) and gives its
// path parameters, query and body; the client builds the URL, encodes each
// parameter as one path segment, and sends it through `fetch`, whose only
// way out of the isolate is connect's egress. The token is added there,
// never here.
//
// It sends at most one write per call, as the call's last request: a write
// waits for no answer still out, and once it went out any further request
// is refused. Connect's "nothing was done" (a 429 to the one write) and
// "outcome unknown" rest on that.

/** The HTTP methods a route may have. */
export type RouteMethod = (typeof httpMethods)[number];

/** A route as a tool declares it: `"GET /v1/stock/{sku}"`. */
export type RouteText = `${RouteMethod} ${string}`;

/** A query parameter's value; an undefined or null one is left out. */
export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

/** One request to a declared route. */
export interface ApiRequest<Returns extends AnySchema | undefined> {
  /** A value for each `{name}` segment of the route, one segment each. */
  path?: Readonly<Record<string, string | number>>;
  query?: Readonly<Record<string, QueryValue>>;
  /**
   * Headers the request adds, such as `if-match` or `prefer`: lowercase
   * names, values of visible ASCII and spaces. Never one the egress or the
   * body sets (`refusedHeaders`).
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * Sent as JSON; or, with `contentType`, a string or bytes sent as they
   * are. Bytes need `contentType`.
   */
  body?: unknown;
  /**
   * The media type a string or bytes `body` goes out as, such as
   * `text/html` (RFC 9110 `media-type`). Only with such a body.
   */
  contentType?: string;
  /**
   * What the answer is: it is checked against it and typed by it. Without
   * it the answer is `unknown`; the tool's `returns` checks what the
   * handler makes of it either way.
   */
  returns?: Returns;
  /** `bytes`: the answer is the body's exact bytes, without `returns`. */
  as?: "bytes";
}

/** An answer, as the request's `returns` types it. */
export type ApiAnswer<Returns extends AnySchema | undefined> =
  Returns extends AnySchema ? Infer<Returns> : unknown;

interface Send {
  (
    route: string,
    request: ApiRequest<undefined> & { as: "bytes" }
  ): Promise<Uint8Array>;
  <Returns extends AnySchema | undefined = undefined>(
    route: string,
    request?: ApiRequest<Returns> & { as?: undefined }
  ): Promise<ApiAnswer<Returns>>;
}

/** The vendor's API, as one tool's routes allow it. */
export interface Api {
  get: Send;
  head: Send;
  post: Send;
  put: Send;
  patch: Send;
  delete: Send;
}

const routeText = /^(?<method>[A-Z]+) (?<target>\S+)$/u;

/** A base path: literal segments, each after a slash, none a dot segment. */
const basePath = /^(?:\/(?!\.\.?(?:\/|$))[\w.~-]+)+$/u;

const isRouteMethod = (method: string): method is RouteMethod =>
  httpMethods.some((each) => each === method);

/**
 * The route `text` names on the connector's `hosts`, under its `base`
 * path: a path on its only host (`GET /items`), or on the host it names
 * (`GET api.example.com/items`), with `base` in front. Throws when it
 * names neither, or `base` isn't a path; the manifest checks the path.
 */
export const routeOf = (
  text: string,
  hosts: readonly string[],
  base = ""
): Route => {
  if (base !== "" && !basePath.test(base)) {
    throw new Error(`"${base}" is not a base path: /api/v2`);
  }
  const { method = "", target = "" } = routeText.exec(text)?.groups ?? {};
  if (!isRouteMethod(method)) {
    throw new Error(`"${text}" is not a route: METHOD /path`);
  }
  const [onlyHost] = hosts;
  if (target.startsWith("/")) {
    if (hosts.length !== 1 || onlyHost === undefined) {
      throw new Error(`"${text}" names no host, and the connector has several`);
    }
    return { method, host: onlyHost, path: `${base}${target}` };
  }
  const slash = target.indexOf("/");
  const host = target.slice(0, Math.max(slash, 0));
  if (slash === -1 || !hosts.includes(host)) {
    throw new Error(`"${text}" names a host the connector doesn't list`);
  }
  return { method, host, path: `${base}${target.slice(slash)}` };
};

const parameter = /\{(?<name>[A-Za-z_]\w*)\}/gu;

/**
 * Headers a request can't add: the credential and the connection, which
 * are the egress's (it strips them, or answers with `grasp-egress`
 * itself); the body's own, which `contentType` and the body set; the
 * hops a proxy records; and method overrides, which some vendors honour
 * on a POST, making it a method the route doesn't declare.
 */
const refusedHeaders: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  "content-type",
  "transfer-encoding",
  "te",
  "upgrade",
  "forwarded",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  egressHeader,
]);

/** A header name: RFC 9110 `token`, lowercase. */
const headerName = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u;

/** A header value: visible ASCII and spaces, so no CR or LF. */
const headerValue = /^[\u0020-\u007E]*$/u;

/**
 * RFC 9110's `media-type`, exactly: `type "/" subtype`, each a `token`,
 * then `*( OWS ";" OWS [ parameter ] )`, where a parameter's value is a
 * `token` or a `quoted-string`.
 */
const mediaType =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:[ \t]*;[ \t]*(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+=(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]+|"(?:[\t !#-[\]-~\u0080-\u00FF]|\\[\t \u0021-\u007E\u0080-\u00FF])*"))?)*$/u;

/** Why `headers` can't be sent, if they can't. */
const headersRefusal = (
  headers: Readonly<Record<string, string>>
): string | undefined => {
  for (const [name, value] of Object.entries(headers)) {
    if (!headerName.test(name) || !headerValue.test(value)) {
      return "A header has a lowercase token for its name, and visible ASCII and spaces for its value";
    }
    if (refusedHeaders.has(name) || name.startsWith("x-forwarded-")) {
      return `A request can't set the ${name} header`;
    }
  }
  return undefined;
};

/**
 * What `body` goes out as: JSON; or, with `contentType`, a string or
 * bytes as they are. Undefined when it can't go out.
 */
const bodyOf = ({
  body,
  contentType,
}: Pick<ApiRequest<undefined>, "body" | "contentType">):
  | { headers: Record<string, string>; body?: string | Uint8Array<ArrayBuffer> }
  | undefined => {
  if (contentType === undefined) {
    if (body instanceof Uint8Array) {
      return undefined;
    }
    return body === undefined
      ? { headers: {} }
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        };
  }
  if (
    !mediaType.test(contentType) ||
    !(typeof body === "string" || body instanceof Uint8Array)
  ) {
    return undefined;
  }
  return {
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : new Uint8Array(body),
  };
};

/** The headers and body `request` goes out with, or why it can't go out. */
const outgoing = (
  request: ApiRequest<AnySchema | undefined>
):
  | { headers: Record<string, string>; body?: string | Uint8Array<ArrayBuffer> }
  | string => {
  const refusal = headersRefusal(request.headers ?? {});
  if (refusal !== undefined) {
    return refusal;
  }
  if (request.as === "bytes" && request.returns !== undefined) {
    return "An answer read as bytes has no returns";
  }
  const sent = bodyOf(request);
  if (sent === undefined) {
    return "A body is JSON, or a string or bytes with a contentType, which is a media type";
  }
  return { ...sent, headers: { ...request.headers, ...sent.headers } };
};

/**
 * `path` with each `{name}` replaced by its value, encoded; undefined if a
 * value is missing.
 */
const filledPath = (
  path: string,
  values: Readonly<Record<string, string | number>>
): string | undefined => {
  let complete = true;
  const filled = path.replaceAll(parameter, (_match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) {
      complete = false;
      return "";
    }
    return segment(String(value));
  });
  return complete ? filled : undefined;
};

const queryOf = (
  query: Readonly<Record<string, QueryValue>>
): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    for (const each of [value].flat()) {
      if (each !== undefined && each !== null) {
        params.append(name, String(each));
      }
    }
  }
  return params;
};

/** The code a vendor's error answer names, where it names one. */
const errorCodeOf = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const error: unknown = Reflect.get(body, "error");
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : (error ?? Reflect.get(body, "code"));
  return typeof code === "string" ? code : undefined;
};

/** A vendor's answer as JSON: null for an empty one, undefined for one that isn't. */
const jsonOf = (text: string): unknown => {
  if (text === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * A vendor's answer to a request: checked against its `returns` and typed
 * by it where it has one, else the JSON, or the text where it isn't JSON.
 * Fields `returns` doesn't name are left out, so a field the vendor adds
 * never breaks a call.
 */
const answerOf = <Returns extends AnySchema | undefined>(
  text: string,
  returns: Returns | undefined,
  name: string,
  write: boolean
): ApiAnswer<Returns> => {
  const answer = jsonOf(text);
  if (returns === undefined) {
    // SAFETY: `unknown` without `returns`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return (answer === undefined ? text : answer) as ApiAnswer<Returns>;
  }
  const checked =
    answer === undefined
      ? undefined
      : validateValue(returns.descriptor, answer, { unknownFields: "drop" });
  if (checked !== undefined && checked.issues === undefined) {
    // SAFETY: checked against `returns`, which is what types it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return checked.value as ApiAnswer<Returns>;
  }
  // A write the vendor took went through, and what it made can't be told.
  throw new ToolError(`${name}'s answer isn't what the connector expects`, {
    code: "failed",
    outcomeUnknown: write,
  });
};

/**
 * The API one call of a tool may use: its `routes` on the connector's
 * `hosts` under its `base`, at the vendor called `name` in the errors a
 * caller sees.
 */
export const apiFor = (
  name: string,
  hosts: readonly string[],
  routes: readonly Route[],
  base = ""
): { api: Api; wrote: () => boolean } => {
  const vendor = providerFetch({
    name,
    errorCodeOf,
    invalidStatuses: [400, 422],
  });
  let wrote = false;
  /** Whether the write's own answer says it did nothing. */
  let writeDidNothing = false;
  /** Whether the write may have done something: sent, and not refused. */
  const took = (): boolean => wrote && !writeDidNothing;
  let pending = 0;
  /**
   * The connector's own mistake, refused before anything is sent: nothing
   * was done, unless its write may have done something before it.
   */
  const refused = (message: string): ToolError =>
    new ToolError(message, {
      code: "failed",
      notPerformed: !took(),
      outcomeUnknown: took(),
    });
  const send = (method: RouteMethod): Send => {
    const sendOne = async (
      route: string,
      request: ApiRequest<AnySchema | undefined> = {}
    ): Promise<unknown> => {
      let target: Route;
      try {
        target = routeOf(`${method} ${route}`, hosts, base);
      } catch {
        throw refused(`${method} ${route} isn't one of the tool's routes`);
      }
      if (
        !routes.some(
          (each) =>
            each.method === target.method &&
            each.host === target.host &&
            each.path === target.path
        )
      ) {
        throw refused(`${method} ${route} isn't one of the tool's routes`);
      }
      const write = isWriteMethod(method);
      if (wrote || (write && pending > 0)) {
        throw refused("A tool sends at most one write, as its last request");
      }
      const path = filledPath(target.path, request.path ?? {});
      const url = new URL(`https://${target.host}${path ?? ""}`);
      // Egress's own rule: each value is one segment of plain text, so a
      // value it would refuse is refused here, before anything is sent, as
      // the egress refuses it: an input no call can send, not a mistake of
      // the connector's to try again.
      if (path === undefined || !pathMatches(target.path, url.pathname)) {
        throw new ToolError(
          `${method} ${route} needs a value for each path parameter: one segment, not "." or "..", with no character egress refuses (/ \\ ? # % ; : or a control)`,
          { code: "egress_refused" }
        );
      }
      url.search = queryOf(request.query ?? {}).toString();
      const sent = outgoing(request);
      if (typeof sent === "string") {
        throw refused(sent);
      }
      wrote = write;
      pending += 1;
      let answer: string | Uint8Array;
      try {
        const response = await vendor.fetch(url, { method, ...sent });
        answer =
          request.as === "bytes"
            ? new Uint8Array(await response.arrayBuffer())
            : await response.text();
      } catch (error) {
        // Refused (a throttle, a 4xx, egress) rather than lost on the way.
        writeDidNothing ||=
          write && error instanceof ToolError && !error.outcomeUnknown;
        throw error;
      } finally {
        pending -= 1;
      }
      return typeof answer === "string"
        ? answerOf(answer, request.returns, name, write)
        : answer;
    };
    // SAFETY: bytes for `as: "bytes"`, else the answer `returns` checked
    // and types, as `Send`'s overloads say.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return sendOne as Send;
  };
  return {
    api: {
      get: send("GET"),
      head: send("HEAD"),
      post: send("POST"),
      put: send("PUT"),
      patch: send("PATCH"),
      delete: send("DELETE"),
    },
    wrote: took,
  };
};
