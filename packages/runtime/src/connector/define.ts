import type { ToolReach } from "@grasp-os/shared/connect";
import { isRecord } from "@grasp-os/shared/json";

import { jsonSchemaOf } from "../common/json-schema.ts";
import type { JsonValue, ValueDescriptor } from "../common/value-descriptor.ts";
import type { AnySchema } from "../common/value-schema.ts";
import type {
  Infer,
  InferInput,
  ObjectOutput,
  ValueShape,
} from "../common/value-types.ts";
import { v } from "../common/values.ts";
import { apiFor, routeOf } from "./api.ts";
import type { Api, RouteText } from "./api.ts";
import type { ActionManifest, Route } from "./manifest.ts";
import { provenanceMetaKey, resourceMetaKey } from "./protocol.ts";
import {
  callMetaOf,
  checkOneWrite,
  contractSchemaOf,
  failure,
  isClosed,
  isWriteMethod,
  lookUp,
  recoveryOf,
  runFailure,
  serveConnector,
  ToolError,
} from "./server.ts";
import type { CallResult, Connector, JsonObject, Tool } from "./server.ts";
import type {
  AccountLookup,
  DeclaredRights,
  IdTokenCheck,
  SignInInput,
  TenantKind,
} from "./sign-in.ts";
import { isDeliveringPath } from "./tool-rules.ts";

// How a connector is written (@grasp-os/sdk/connector): its tools, each one
// route of the vendor's API with `v` for its arguments and what it
// returns, and how a person signs in to the vendor. `defineConnector` makes
// it the MCP server connect loads into an isolate for each call, and the
// manifest connect decides by before it runs anything.

/** What a call gives a handler besides its arguments and the API. */
export interface ToolCall {
  /**
   * The call's effect key, for a write connect may recover: the same for
   * every attempt of one call, different for any other. A tool that finds
   * its effect (`find`) gives it to the vendor, as a tag on what it makes.
   * Null for a read.
   */
  key: string | null;
}

/** A tool's arguments, as its handler gets them. */
export type ToolArgs<Args extends ValueShape> = ObjectOutput<Args>;

interface ToolBase<Args extends ValueShape, Returns extends AnySchema> {
  description: string;
  /**
   * Whom it reaches: `own`, only the person it acts for; `company`, what
   * the company keeps together; `others`, other people; `conversations`,
   * what other people said where the person was. Say the furthest any call
   * can reach: its class follows from this and `readOnly`.
   */
  reach: ToolReach;
  /** The OAuth scopes it needs, among those its connector's `auth` asks for. */
  scopes?: readonly string[];
  /**
   * The only requests it may send, as `"METHOD /path"` with `{name}` for a
   * path parameter. At most one is a write (not GET or HEAD).
   */
  routes: readonly RouteText[];
  /** Strict: a call with any other argument is refused. */
  args: Args;
  /** An object; the answer is checked against it before anyone sees it. */
  returns: Returns;
  /**
   * The one argument that names the record a call acts on (a mailbox, a
   * board), so a permission can be held to one. A path parameter of that
   * name is held to the record the call's permission names.
   */
  resource?: Extract<keyof Args, string>;
  handler: (
    args: ToolArgs<Args>,
    api: Api,
    call: ToolCall
  ) => Promise<InferInput<Returns>>;
}

/** A tool that only reads: it has no effect to recover. */
interface ReadTool<
  Args extends ValueShape,
  Returns extends AnySchema,
> extends ToolBase<Args, Returns> {
  readOnly: true;
  repeatable?: never;
  find?: never;
}

/**
 * A tool that writes. Without `repeatable` or `find` a call whose outcome
 * is unknown stays unknown, and connect never sends it twice.
 */
interface WriteTool<
  Args extends ValueShape,
  Returns extends AnySchema,
> extends ToolBase<Args, Returns> {
  readOnly: false;
  /**
   * Sending it twice changes nothing (it sets a state, or the vendor keeps
   * the call's key), so connect may send a call of unknown outcome again.
   */
  repeatable?: true;
  /**
   * Looks the effect of the call with `call.key` up instead of carrying it
   * out: what the handler would have answered if it happened, null only if
   * it certainly didn't. Its `api` has only the tool's reads.
   */
  find?: (
    args: ToolArgs<Args>,
    api: Api,
    call: { key: string }
  ) => Promise<InferInput<Returns> | null>;
}

export type ToolDeclaration<
  Args extends ValueShape,
  Returns extends AnySchema,
> = ReadTool<Args, Returns> | WriteTool<Args, Returns>;

/** A tool, as `tool` declares it and `defineConnector` takes it. */
export interface ConnectorTool {
  readonly scopes: readonly string[];
  /** Its routes as declared, under the connector's `base`. */
  readonly routes: readonly RouteText[];
  /** Each argument's descriptor. */
  readonly args: Readonly<Record<string, ValueDescriptor>>;
  readonly returns: ValueDescriptor;
  /** The tool as the runtime's server serves it, named `name` on `connector`. */
  readonly serve: (
    name: string,
    connector: Pick<ConnectorDeclaration, "title" | "hosts" | "base">
  ) => Tool;
}

const methodOf = (route: string): string => route.split(" ", 1)[0] ?? "";

/** One list answer: its items, and where the next page starts, or null. */
export const page = <const Item extends AnySchema>(item: Item) =>
  v.object({ items: v.array(item), next: v.string().nullable() });

/** A checkpoint a sync or an event's poll keeps between reads. */
export type Checkpoint = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * An event type: what a workflow can start on. Declared and typed here;
 * connect reads it from Phase 3 of the connector layer on.
 */
export interface EventDeclaration<
  Filter extends ValueShape,
  Payload extends AnySchema,
> {
  description: string;
  filter: Filter;
  payload: Payload;
  /** The same for one occurrence however it arrives, so it's passed on once. */
  id: (payload: Infer<Payload>) => string;
  poll: {
    routes: readonly `GET ${string}`[];
    handler: (
      filter: ObjectOutput<Filter>,
      cursor: string | null,
      api: Api
    ) => Promise<{ events: InferInput<Payload>[]; cursor: string | null }>;
  };
}

/**
 * An event or a sync, as `event` and `sync` declare it and
 * `defineConnector` takes it: the routes it reads, so far. Its own types
 * stay where it is declared, as a tool's do (`ConnectorTool`).
 */
export interface ConnectorReader {
  readonly routes: readonly `GET ${string}`[];
}

/** An event type (`EventDeclaration`). */
export const event = <
  const Filter extends ValueShape,
  const Payload extends AnySchema,
>(
  declaration: EventDeclaration<Filter, Payload>
): ConnectorReader => ({ routes: declaration.poll.routes });

/**
 * Records kept in step with the vendor's: one page at a time from a
 * checkpoint. Declared and typed here; connect reads it from Phase 4 of
 * the connector layer on.
 */
export interface SyncDeclaration<Model extends AnySchema> {
  model: Model;
  id: (record: Infer<Model>) => string;
  mode: "incremental" | "full";
  routes: readonly `GET ${string}`[];
  handler: (
    checkpoint: Checkpoint | null,
    api: Api
  ) => Promise<{
    upserts: InferInput<Model>[];
    deletes: string[];
    checkpoint: Checkpoint;
    more: boolean;
  }>;
}

/** A sync (`SyncDeclaration`). */
export const sync = <const Model extends AnySchema>(
  declaration: SyncDeclaration<Model>
): ConnectorReader => ({ routes: declaration.routes });

/** How a person signs in to the vendor, as connect runs it. */
export interface ConnectorAuth {
  readonly signIn: DistributiveOmit<SignInInput, "name">;
}

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown
  ? Omit<Value, Key>
  : never;

/**
 * Where connect reads whose account a sign-in is: an HTTPS GET on one of
 * the connector's hosts, and JSON Pointers into its answer.
 */
export type AccountDeclaration = AccountLookup;

/**
 * Where connect reads whose account a sign-in is from the OpenID ID token:
 * its issuer (`{tenant}` filled), the claim of the account's stable ID,
 * the claims its name and address are read from, the first that is there,
 * the claims that must say what they say here (`{tenant}` filled,
 * compared without case) or be `true`, and those that must be absent or
 * the issuer itself.
 */
export type IdTokenDeclaration = IdTokenCheck;

/**
 * What a consent asks for by the tool classes the company has on (each
 * scope among the sign-in's `scopes`): `signIn` always, each class's
 * while it is on, `implied` what a scope takes in besides itself, and
 * `sharedMailbox` while a shared mailbox is pointed at (`reach` only with
 * Reach others on too).
 */
export type RightsDeclaration = DeclaredRights;

/** OAuth 2.0 with the authorization code, PKCE and refresh. */
export type OAuth2Declaration = {
  /** May hold `{tenant}` past its host, as `tokenUrl` may. */
  authorizeUrl: string;
  tokenUrl: string;
  /** RFC 7009; without one, disconnecting deletes the tokens only. */
  revokeUrl?: string;
  /** Each scope it may ask for, and what it allows. */
  scopes: Readonly<Record<string, string>>;
  /** Parameters the authorization request adds; values may hold `{tenant}`. */
  params?: Readonly<Record<string, string>>;
  /**
   * The kind of the organization's own tenant at the vendor (`guid`, an
   * Entra tenant ID; `domain`, a hosted domain): the flow is pinned to it.
   * Only a provider the deployment has a tenant for can be pinned.
   */
  tenant?: TenantKind;
  rights?: RightsDeclaration;
  /** A prefix the token answer may put on a scope (a URL ending in `/`). */
  scopePrefix?: string;
  /** Scopes a renewed token must hold, or its connection is asked to reconnect. */
  renewalRequires?: readonly string[];
  /** `account`: revoking one token revokes the account's whole grant. */
  grant?: "account";
} & (
  | { account: AccountDeclaration; idToken?: never }
  | { idToken: IdTokenDeclaration; account?: never }
);

/** The sign-ins connect runs for a connector. Connector code never sees a token. */
export const auth = Object.freeze({
  /** OAuth 2.0 with the authorization code, PKCE and refresh. */
  oauth2: ({
    authorizeUrl,
    tokenUrl,
    revokeUrl,
    scopes,
    params,
    renewalRequires,
    ...rest
  }: OAuth2Declaration): ConnectorAuth => ({
    signIn: {
      kind: "oauth2",
      authorizationEndpoint: authorizeUrl,
      tokenEndpoint: tokenUrl,
      ...(revokeUrl === undefined ? {} : { revocationEndpoint: revokeUrl }),
      scopes: Object.keys(scopes),
      ...(params === undefined ? {} : { authorizationParams: { ...params } }),
      ...(renewalRequires === undefined
        ? {}
        : { renewalRequires: [...renewalRequires] }),
      ...rest,
    },
  }),
  /** A key the person pastes, sent in `header`, after `prefix` if it has one. */
  apiKey: (declaration: {
    header: string;
    prefix?: string;
    account: AccountDeclaration;
  }): ConnectorAuth => ({
    signIn: { kind: "api_key", ...declaration },
  }),
});

export interface ConnectorDeclaration {
  /** Its name: lowercase, as permissions and the catalogue name it. */
  name: string;
  /**
   * Whose connections its calls get, and whose sign-in its `auth` is:
   * its `name` unless it says otherwise.
   */
  provider?: string;
  /** Its vendor's name, as people read it: `Pipedrive`. */
  title: string;
  /** Every host it may reach, exactly. */
  hosts: readonly string[];
  /**
   * The path every route is under (`/api/v2`), or none: routes are
   * declared without it and the API puts it in front, so a version or an
   * `/api` prefix never names a tool.
   */
  base?: string;
  /**
   * The vendor's OpenAPI spec its tools are generated from: where it was
   * read, its SHA-256, and the security scheme it was read for where the
   * generator was given one. Connect's build holds the tools to it.
   */
  openapi?: {
    readonly url: string;
    readonly sha256: string;
    readonly scheme?: string;
  };
  auth: ConnectorAuth;
  tools: Readonly<Record<string, ConnectorTool>>;
  events?: Readonly<Record<string, ConnectorReader>>;
  syncs?: Readonly<Record<string, ConnectorReader>>;
}

/** Where a value didn't fit, without the value. */
const issuesText = (
  issues: readonly { code: string; path: readonly PropertyKey[] }[]
): string =>
  issues
    .map(({ code, path }) =>
      path.length === 0 ? code : `${code} at ${path.map(String).join(".")}`
    )
    .join("; ");

const asJsonObject = (schema: Record<string, JsonValue>): JsonObject => schema;

/** A declared tool as the runtime's server serves it. */
const toolOf = <Args extends ValueShape, Returns extends AnySchema>(
  connector: Pick<ConnectorDeclaration, "title" | "hosts" | "base">,
  name: string,
  declaration: ToolDeclaration<Args, Returns>
): Tool => {
  const { readOnly, reach, resource, handler } = declaration;
  const routes: Route[] = declaration.routes.map((route) =>
    routeOf(route, connector.hosts, connector.base)
  );
  const args = v.object(declaration.args);
  const { returns } = declaration;
  if (returns.descriptor.kind !== "object" || returns.descriptor.nullable) {
    throw new Error(`${name}: it returns an object`);
  }
  const inputSchema = asJsonObject(jsonSchemaOf(args.descriptor));
  const outputSchema = asJsonObject(
    jsonSchemaOf(returns.descriptor, { exact: true })
  );
  if (!isClosed(inputSchema)) {
    throw new Error(`${name}: its args must be strict objects throughout`);
  }
  const properties = isRecord(inputSchema.properties)
    ? inputSchema.properties
    : {};
  const resourceProperty =
    resource === undefined ? undefined : properties[resource];
  if (
    resource !== undefined &&
    (typeof resourceProperty !== "object" ||
      resourceProperty === null ||
      Reflect.get(resourceProperty, "type") !== "string")
  ) {
    throw new Error(`${name}: its resource must be a string argument`);
  }
  const action: ActionManifest = {
    description: declaration.description,
    routes,
    readOnly,
    reach,
    recovery: recoveryOf(name, declaration),
    resource: resource ?? null,
    input: Object.keys(properties),
    contract: {
      input: contractSchemaOf(inputSchema),
      output: contractSchemaOf(outputSchema),
    },
  };
  const reads = routes.filter(({ method }) => !isWriteMethod(method));
  const find =
    declaration.readOnly || declaration.find === undefined
      ? undefined
      : declaration.find;
  const call = async (input: unknown, sent: unknown): Promise<CallResult> => {
    const parsed = args["~standard"].validate(input);
    if (parsed.issues !== undefined) {
      return failure(`Invalid input: ${issuesText(parsed.issues)}`);
    }
    const meta = callMetaOf(sent);
    if (meta.attachments !== undefined && !meta.find) {
      return failure("Invalid input: this tool takes no files");
    }
    let output: unknown;
    if (meta.find) {
      const looked = await lookUp(
        find === undefined
          ? undefined
          : async (data: typeof parsed.value, effect: { key: string }) => {
              const found = await find(
                data,
                apiFor(connector.title, connector.hosts, reads, connector.base)
                  .api,
                effect
              );
              return found === null ? null : { output: found };
            },
        parsed.value,
        meta.key
      );
      if (!("output" in looked)) {
        return looked;
      }
      ({ output } = looked);
    } else {
      const { api, wrote } = apiFor(
        connector.title,
        connector.hosts,
        routes,
        connector.base
      );
      try {
        output = await handler(parsed.value, api, { key: meta.key });
      } catch (error) {
        // Once its write may have done something, whatever the handler
        // throws leaves the outcome unknown: a read's refusal rethrown
        // after the write can't say that nothing, or nothing yet, was done.
        return runFailure(
          wrote() && error instanceof ToolError && !error.outcomeUnknown
            ? new ToolError("The action's outcome is unknown", {
                outcomeUnknown: true,
              })
            : error,
          readOnly
        );
      }
    }
    const checked = returns["~standard"].validate(output);
    if (
      checked.issues !== undefined ||
      typeof checked.value !== "object" ||
      checked.value === null
    ) {
      // A write that got this far sent its write: it went through, but
      // what it made can't be told.
      return failure(
        "The connector's result isn't what it declares",
        undefined,
        readOnly ? "failed" : "outcomeUnknown"
      );
    }
    // Connect reads structured content only, so the output isn't sent a
    // second time as text.
    return {
      content: [],
      // SAFETY: an object, checked just above against an object schema.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      structuredContent: checked.value as JsonObject,
      _meta: { [provenanceMetaKey]: [] },
    };
  };
  return {
    name,
    action,
    description: {
      name,
      description: declaration.description,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        openWorldHint: true,
      },
      _meta: resource === undefined ? {} : { [resourceMetaKey]: resource },
    },
    call,
  };
};

/**
 * A tool: one route of the vendor's API. Throws if it declares more than
 * one write, or both `repeatable` and `find`.
 */
export const tool = <
  const Args extends ValueShape,
  const Returns extends AnySchema,
>(
  declaration: ToolDeclaration<Args, Returns>
): ConnectorTool => {
  checkOneWrite(
    "A tool",
    declaration.routes.map((route) => ({ method: methodOf(route) }))
  );
  recoveryOf("A tool", declaration);
  return {
    scopes: declaration.scopes ?? [],
    routes: declaration.routes,
    args: Object.fromEntries(
      Object.entries(declaration.args).map(([name, schema]) => [
        name,
        schema.descriptor,
      ])
    ),
    returns: declaration.returns.descriptor,
    serve: (name, connector) => toolOf(connector, name, declaration),
  };
};

/** A connector written on the SDK: its server, and what it declares. */
export interface DefinedConnector extends Connector {
  /** Read by connect's build, which holds its tools to the mirror rule. */
  readonly declaration: ConnectorDeclaration;
}

/**
 * A connector: its manifest, and the MCP server connect runs it as. Throws
 * if a tool breaks the connector contract (a route to a host it doesn't
 * list, args that aren't strict, a scope its sign-in doesn't ask for), or
 * an event or a sync reads a route off its hosts, or one whose path
 * delivers to people.
 */
export const defineConnector = (
  declaration: ConnectorDeclaration
): DefinedConnector => {
  const {
    name,
    title,
    hosts,
    base,
    tools,
    events = {},
    syncs = {},
  } = declaration;
  for (const { routes } of [
    ...Object.values(events),
    ...Object.values(syncs),
  ]) {
    for (const route of routes) {
      const { method, path } = routeOf(route, hosts, base);
      if (method !== "GET") {
        throw new Error(`"${route}": an event or a sync only reads, by GET`);
      }
      // Delivery only, as a sync's manifest is checked: never or change words
      // would refuse real reads (a drive item's permissions, a start token).
      if (isDeliveringPath(path)) {
        throw new Error(
          `"${route}": an event or a sync runs on its own, so its path may not deliver to people`
        );
      }
    }
  }
  const scopes = new Set(Object.values(tools).flatMap((each) => each.scopes));
  return {
    ...serveConnector(
      {
        name,
        provider: declaration.provider ?? name,
        signIn: { ...declaration.auth.signIn, name: title },
        scopes: [...scopes],
        hosts,
      },
      Object.entries(tools).map(([toolName, each]) =>
        each.serve(toolName, declaration)
      )
    ),
    declaration,
  };
};
