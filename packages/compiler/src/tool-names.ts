import { httpMethods } from "@grasp-os/runtime/connector";

// How a connector's tool is named: from its route, never by choice (the
// mirror rule, GRA-2319). A tool is one route of the vendor's API, and its
// name follows from that route, so two connectors for one API, written
// apart, name their tools alike:
//
// - The family is the route's collection: its literal segments, joined by
//   dots (`GET /deals/{id}/followers` is the family `deals.followers`). A
//   route is a path under the API's base path (`/api/v2`), which the
//   connector declares once and its HTTP client puts in front of every
//   route, so a version or an `/api` prefix never names a tool.
// - The action is `list` for GET on a collection that answers a page, `get`
//   for GET on an item, `create` for POST on a collection, `update` for
//   PATCH or PUT on an item and `delete` for DELETE on an item. A route ends
//   on an item when its last segment is a parameter.
// - Any other route takes the vendor's operation name as its action. So do
//   two operations that would otherwise take the same name (PATCH and PUT
//   on one item), which only a spec can say.
//
// The generator names what it generates with this, and the mirror check
// holds every other tool to it.

/** The methods a connector's route may take, as the SDK has them. */
export type HttpMethod = (typeof httpMethods)[number];

/** The actions a route's method and shape name; any other is the vendor's. */
export const standardActions: ReadonlySet<string> = new Set([
  "list",
  "get",
  "create",
  "update",
  "delete",
]);

export type Segment =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "parameter"; readonly name: string };

export interface Route {
  readonly method: HttpMethod;
  /** The path as the route declares it, under the API's base path. */
  readonly path: string;
  readonly segments: readonly Segment[];
}

/**
 * A literal segment: RFC 3986's unreserved characters, never `.` or `..`
 * (checked apart), so no route can climb out of the API's base path or
 * carry a query, a fragment or an encoded character.
 */
const literalSegment = /^[A-Za-z0-9._~-]+$/u;

/** A parameter segment: the whole segment, one plain name. */
const parameterSegment = /^\{(?<name>[A-Za-z_]\w{0,63})\}$/u;

/**
 * A part of a tool's name: a family's segment or an action. What an MCP
 * tool's name may hold, less the dot that joins the parts.
 */
const namePart = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** A tool's whole name: MCP's own limit on its length. */
export const nameMaxLength = 128;

const methods: ReadonlySet<string> = new Set(httpMethods);

export const isRouteMethod = (text: string): text is HttpMethod =>
  methods.has(text);

/** The action each method takes on an item. */
const itemActions: Partial<Readonly<Record<HttpMethod, string>>> = {
  GET: "get",
  PATCH: "update",
  PUT: "update",
  DELETE: "delete",
};

/** Whether `text` may be a part of a tool's name. */
export const isNamePart = (text: string): boolean =>
  namePart.test(text) && !(text in Object.prototype);

/**
 * Reads a path as segments, or undefined for one no route may take: not
 * absolute, an empty, dot or encoded segment, a parameter beside text in
 * one segment, or the same parameter twice.
 */
export const pathSegments = (path: string): Segment[] | undefined => {
  if (!path.startsWith("/")) {
    return undefined;
  }
  const parts = path === "/" ? [] : path.slice(1).split("/");
  const segments: Segment[] = [];
  const names = new Set<string>();
  for (const part of parts) {
    const parameter = parameterSegment.exec(part)?.groups?.name;
    if (parameter !== undefined) {
      if (names.has(parameter)) {
        return undefined;
      }
      names.add(parameter);
      segments.push({ kind: "parameter", name: parameter });
    } else if (literalSegment.test(part) && part !== "." && part !== "..") {
      segments.push({ kind: "literal", text: part });
    } else {
      return undefined;
    }
  }
  return segments;
};

/** A route as a tool declares it, its path whatever shape it takes. */
export interface DeclaredRoute {
  readonly method: HttpMethod;
  /** The host it names, where its connector has several. */
  readonly host: string | undefined;
  readonly path: string;
}

/**
 * Reads a declared route, `GET /deals`, or undefined. A route that names
 * its host (`GET api.example.com/deals`, where a connector has several) is
 * read by its path.
 */
export const readRoute = (route: string): DeclaredRoute | undefined => {
  const space = route.indexOf(" ");
  const method = route.slice(0, space);
  const target = route.slice(space + 1);
  const slash = target.indexOf("/");
  if (space === -1 || slash === -1 || !isRouteMethod(method)) {
    return undefined;
  }
  return {
    method,
    host: slash === 0 ? undefined : target.slice(0, slash),
    path: target.slice(slash),
  };
};

/** What a route's name is made from, or why no name follows from it. */
export type RouteName =
  | {
      readonly family: string;
      /** Undefined where the vendor's operation name is the action. */
      readonly action: string | undefined;
    }
  | { readonly problem: string };

/**
 * The family and the standard action of a route. `pages` says whether the
 * route answers a page, which makes GET on a collection `list`.
 */
export const routeName = (route: Route, pages: boolean): RouteName => {
  const family = route.segments.flatMap((segment) =>
    segment.kind === "literal" ? [segment.text] : []
  );
  const rest = route.segments;
  if (family.length === 0) {
    return { problem: `${route.path} names no collection.` };
  }
  const unnamed = family.find((part) => !isNamePart(part));
  if (unnamed !== undefined) {
    return {
      problem: `The segment ${JSON.stringify(unnamed)} of ${route.path} can't be part of a tool's name.`,
    };
  }
  const item = rest.at(-1)?.kind === "parameter";
  const { method } = route;
  let action: string | undefined;
  if (item) {
    action = itemActions[method];
  } else if (method === "GET" && pages) {
    action = "list";
  } else if (method === "POST") {
    action = "create";
  }
  return { family: family.join("."), action };
};

/** A tool's name from its family and action, or undefined if too long. */
export const toolName = (
  family: string,
  action: string
): string | undefined => {
  const name = `${family}.${action}`;
  return name.length <= nameMaxLength ? name : undefined;
};
