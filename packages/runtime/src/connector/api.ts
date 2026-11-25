import type { AnySchema } from "../common/value-schema.ts";
import type { Infer } from "../common/value-types.ts";
import type { Route } from "./manifest.ts";
import { providerFetch } from "./provider.ts";
import { isWriteMethod, ToolError } from "./server.ts";

// How a connector's handler reaches its vendor: by the routes its tool
// declares, never by URL. The handler names a route as declared (its path
// template, and its host where the connector has several) and gives its
// path parameters, query and body; the client builds the URL, encodes each
// parameter as one path segment, and sends it through `fetch`, whose only
// way out of the isolate is connect's egress. The token is added there,
// never here.
//
// It sends at most one write per call, as the call's last request: once a
// write went out, any further request is refused. Connect's "nothing was
// done" (a 429 to the one write) and "outcome unknown" rest on that.

/** The HTTP methods a route may have. */
export const routeMethods = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type RouteMethod = (typeof routeMethods)[number];

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
  /** Sent as JSON. */
  body?: unknown;
  /**
   * What the answer is: it is checked against it and typed by it. Without
   * it the answer is `unknown`; the tool's `returns` checks what the
   * handler makes of it either way.
   */
  returns?: Returns;
}

/** An answer, as the request's `returns` types it. */
export type ApiAnswer<Returns extends AnySchema | undefined> =
  Returns extends AnySchema ? Infer<Returns> : unknown;

type Send = <Returns extends AnySchema | undefined = undefined>(
  route: string,
  request?: ApiRequest<Returns>
) => Promise<ApiAnswer<Returns>>;

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

const isRouteMethod = (method: string): method is RouteMethod =>
  routeMethods.some((each) => each === method);

/**
 * The route `text` names on the connector's `hosts`: a path on its only
 * host (`GET /v1/items`), or on the host it names
 * (`GET api.example.com/v1/items`). Throws when it names neither; the
 * manifest checks the path.
 */
export const routeOf = (text: string, hosts: readonly string[]): Route => {
  const { method = "", target = "" } = routeText.exec(text)?.groups ?? {};
  if (!isRouteMethod(method)) {
    throw new Error(`"${text}" is not a route: METHOD /path`);
  }
  const [onlyHost] = hosts;
  if (target.startsWith("/")) {
    if (hosts.length !== 1 || onlyHost === undefined) {
      throw new Error(`"${text}" names no host, and the connector has several`);
    }
    return { method, host: onlyHost, path: target };
  }
  const slash = target.indexOf("/");
  const host = target.slice(0, Math.max(slash, 0));
  if (slash === -1 || !hosts.includes(host)) {
    throw new Error(`"${text}" names a host the connector doesn't list`);
  }
  return { method, host, path: target.slice(slash) };
};

const parameter = /\{(?<name>[A-Za-z_]\w*)\}/gu;

/** `path` with each `{name}` replaced by its value, encoded as one segment. */
const filledPath = (
  path: string,
  values: Readonly<Record<string, string | number>>
): string =>
  path.replaceAll(parameter, (_match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined) {
      throw new Error(`No value for the path parameter {${name}}`);
    }
    return encodeURIComponent(String(value));
  });

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
 * The API one call of a tool may use: its `routes` on the connector's
 * `hosts`, at the vendor called `name` in the errors a caller sees.
 */
export const apiFor = (
  name: string,
  hosts: readonly string[],
  routes: readonly Route[]
): Api => {
  const vendor = providerFetch({
    name,
    errorCodeOf,
    invalidStatuses: [400, 422],
  });
  let wrote = false;
  const send =
    (method: RouteMethod): Send =>
    async <Returns extends AnySchema | undefined = undefined>(
      route: string,
      request: ApiRequest<Returns> = {}
    ): Promise<ApiAnswer<Returns>> => {
      const target = routeOf(`${method} ${route}`, hosts);
      if (
        !routes.some(
          (each) =>
            each.method === target.method &&
            each.host === target.host &&
            each.path === target.path
        )
      ) {
        throw new Error(`${method} ${route} isn't one of the tool's routes`);
      }
      if (wrote) {
        throw new Error("A tool sends at most one write, as its last request");
      }
      const url = new URL(
        `https://${target.host}${filledPath(target.path, request.path ?? {})}`
      );
      url.search = queryOf(request.query ?? {}).toString();
      const write = isWriteMethod(method);
      wrote = write;
      const response = await vendor.fetch(
        url,
        request.body === undefined
          ? { method }
          : {
              method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request.body),
            }
      );
      const answer = jsonOf(await response.text());
      const checked =
        answer === undefined || request.returns === undefined
          ? { value: answer }
          : request.returns["~standard"].validate(answer);
      if (checked.issues === undefined && checked.value !== undefined) {
        // SAFETY: checked against `returns` where it is given, which is
        // what types it; `unknown` otherwise.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        return checked.value as ApiAnswer<Returns>;
      }
      const message = `${name}'s answer isn't what the connector expects`;
      // A write the vendor took went through, and what it made can't be told.
      throw new ToolError(message, { code: "failed", outcomeUnknown: write });
    };
  return {
    get: send("GET"),
    head: send("HEAD"),
    post: send("POST"),
    put: send("PUT"),
    patch: send("PATCH"),
    delete: send("DELETE"),
  };
};
