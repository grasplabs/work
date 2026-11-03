import {
  connectErrors,
  connectionErrors,
  createHttpConnectionSchema,
} from "@grasp-os/shared/connect";
import type {
  ConnectorContract,
  ConnectorContractAction,
} from "@grasp-os/shared/connect";
import {
  httpActionSchemas,
  httpActionsOf,
  httpContract,
  httpGetInputSchema,
  httpInputProperties,
  httpLimits,
  httpPathOf,
  httpProvider,
  httpReadMethods,
  httpSendInputSchema,
  httpSendMethods,
  isPrivateAddress,
  isSettableHeader,
} from "@grasp-os/shared/http-connections";
import type {
  HttpAction,
  HttpAnswer,
  HttpConnectionSummary,
  HttpMethod,
} from "@grasp-os/shared/http-connections";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import { and, eq, inArray, isNotNull, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { recordEvents } from "./audit.ts";
import {
  auditRefusal,
  connectionEvent,
  refuseStaff,
} from "./connection-audit.ts";
import type { Connection } from "./connections.ts";
import { connections, httpConnections } from "./db/schema.ts";
import { McpError } from "./mcp.ts";
import type { McpServer, McpTool, McpToolResult } from "./mcp.ts";
import { resealBatchSize, vaultFor } from "./vault.ts";

// HTTP connections (GRA-1478): an outside API an admin approves, which
// Apps and JSON workflows call as a connector resource, through connect,
// as one more kind of connection (`serverKind: "http"`): granted as any
// connection is, by a permission naming its actions (`get`, `send`),
// checked by core and signed into each call's capability, carried out by
// call.ts like any other call (held for a person who is there when it
// sends, keyed in a workflow run, audited). What only an HTTP connection
// needs is here. Threat model, written before the code, and how each is
// closed:
//
// - Reaching inside a network (SSRF): the origin is exactly
//   `https://host[:port]`, never an IP address or a private name
//   (`originRefusal`, the rules links and outbound webhooks go by). Its
//   host is resolved (DNS over HTTPS, `resolvedPublic`) when it is
//   approved and again before every call; any address outside the public
//   internet (loopback, private, link-local, carrier-grade NAT, unique
//   local, metadata) refuses it, as does a name that resolves to nothing.
//   Between that lookup and the fetch the name could be rebound: on
//   Cloudflare, connect's `global_fetch_strictly_public` refuses a private
//   address whatever the name; on plain workerd, its network's
//   `allow = ["public"]` does.
// - Leaving what the admin approved: every request goes to the origin
//   itself, with a method the admin allowed and a path under one of the
//   admin's prefixes, compared segment by segment after the URL parser,
//   with dot segments, encoded slashes, backslashes and anything the
//   parser would rewrite refused before (`httpPathOf`). A redirect off the
//   origin, or off the allowed paths, is refused, never followed; a read
//   follows one on them (at most `httpLimits.redirects`), a send none.
// - The credential leaking: it is sealed with the vault for this
//   connection, origin and header, never returned by any RPC, never
//   logged or audited, and sent only to the origin. A call can't set the
//   credential's header, `authorization`, cookies, `host`, hop-by-hop or
//   forwarding headers, or a method override (`isSettableHeader`). A
//   response's `set-cookie` and the credential's header are dropped.
// - Holding connect up, or flooding it: each call has `timeoutMs`
//   (redirects included); a request body is at most `requestBodyBytes`
//   and a response's is read up to `responseBodyBytes`, counted as it
//   arrives, then the call fails.
// - Exfiltration from restricted data: a call from a context that read
//   restricted data is held for its person like any change, reads too
//   (policy.ts), as a Composio call is: its path and query go to a third
//   party.
// - A call nobody can trace: each one is audited by call.ts's
//   `connection.call` with its method, path (no query), status and the
//   response's size (`HttpTrace`); never headers or bodies.

/** An HTTP connection's approved request rules, and its sealed credential. */
export type HttpConfig = typeof httpConnections.$inferSelect;

/** What a call sent and got, for the audit log (call.ts). */
export interface HttpTrace {
  method?: string;
  /** The path, without its query, which may hold the API's own secrets. */
  path?: string;
  status?: number;
  /** The response body's bytes, as read. */
  bytes?: number;
}

/** Where connect asks DNS: Cloudflare's resolver, over HTTPS. */
const dnsResolver = "https://cloudflare-dns.com/dns-query";

/** How long one DNS lookup may take. */
const dnsTimeoutMs = 5000;

/** DNS record types: an IPv4 and an IPv6 address. */
const addressTypes = { A: 1, AAAA: 28 } as const;

/** The addresses DNS answers for `host` of `type`, or undefined on failure. */
const addressesOf = async (
  host: string,
  type: keyof typeof addressTypes
): Promise<string[] | undefined> => {
  let response: Response;
  try {
    response = await fetch(
      `${dnsResolver}?name=${encodeURIComponent(host)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        redirect: "manual",
        signal: AbortSignal.timeout(dnsTimeoutMs),
      }
    );
  } catch {
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    return undefined;
  }
  if (typeof answer !== "object" || answer === null) {
    return undefined;
  }
  const status: unknown = Reflect.get(answer, "Status");
  const records: unknown = Reflect.get(answer, "Answer");
  // 0 is an answer (NOERROR), 3 a name that doesn't exist (NXDOMAIN).
  if (status === 3) {
    return [];
  }
  if (status !== 0) {
    return undefined;
  }
  if (records === undefined) {
    return [];
  }
  if (!Array.isArray(records)) {
    return undefined;
  }
  return records.flatMap((record: unknown) => {
    if (typeof record !== "object" || record === null) {
      return [];
    }
    const recordType: unknown = Reflect.get(record, "type");
    const data: unknown = Reflect.get(record, "data");
    return recordType === addressTypes[type] && typeof data === "string"
      ? [data]
      : [];
  });
};

/** Why a host can't be reached, or `public` when it can. */
export type HostReach = "public" | "private" | "unresolved";

/**
 * Whether `host` leads only to public internet addresses, as DNS answers
 * now: `private` if any of its addresses is outside it, `unresolved` if
 * it has none, or DNS couldn't be asked.
 */
export const resolvedPublic = async (host: string): Promise<HostReach> => {
  const [v4, v6] = await Promise.all([
    addressesOf(host, "A"),
    addressesOf(host, "AAAA"),
  ]);
  if (v4 === undefined || v6 === undefined) {
    return "unresolved";
  }
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) {
    return "unresolved";
  }
  return addresses.some((address) => isPrivateAddress(address))
    ? "private"
    : "public";
};

/** The context a credential is sealed for: its connection, origin and header. */
const credentialContext = (
  config: Pick<
    HttpConfig,
    "connectionId" | "origin" | "credentialHeader" | "credentialKind"
  >
): string =>
  `http:${config.connectionId}\n${config.origin}\n${config.credentialHeader}\n${config.credentialKind}`;

/** The pathPrefixes as one audit value: within an identifier's length. */
const auditList = (values: readonly string[]): string =>
  values.join(" ").slice(0, 256);

/**
 * Approves an HTTP connection, for an admin who isn't staff: its origin
 * checked (the schema) and its host resolved to public addresses only,
 * its credential sealed, the connection and its rules written in one
 * batch with `connection.connect`. Refusals are audited too.
 */
export const createHttpConnection = async (
  env: Env,
  request: unknown
): Promise<{ connectionId: string }> => {
  const { person, connection } = connectionErrors.parse(
    "connection.invalid",
    createHttpConnectionSchema,
    request
  );
  const base = { provider: httpProvider, scope: "shared" };
  await refuseStaff(env, person, base);
  if (!isAdmin(person.role)) {
    await auditRefusal(env, person, "connection.connect", {
      ...base,
      outcome: "refused",
      reason: "role.forbidden",
    });
    throw roleErrors.create("role.forbidden");
  }
  const { hostname } = new URL(connection.origin);
  const reach = await resolvedPublic(hostname);
  if (reach !== "public") {
    await auditRefusal(env, person, "connection.connect", {
      ...base,
      origin: connection.origin,
      outcome: "refused",
      reason: `host_${reach}`,
    });
    throw connectionErrors.create("connection.http_origin_refused");
  }
  const vault = await vaultFor(env);
  if (vault === undefined) {
    throw connectionErrors.create("connection.provider_unavailable");
  }
  const { credential } = connection;
  const header =
    credential.kind === "bearer" ? "authorization" : credential.header;
  const secret =
    credential.kind === "bearer" ? credential.token : credential.secret;
  const connectionId = crypto.randomUUID();
  const now = new Date();
  const config: HttpConfig = {
    connectionId,
    name: connection.name,
    origin: connection.origin,
    pathPrefixes: connection.pathPrefixes,
    methods: connection.methods,
    credentialHeader: header,
    credentialKind: credential.kind,
    sealed: null,
    createdAt: now,
  };
  config.sealed = await vault.seal(secret, credentialContext(config));
  const db = drizzle(env.DB);
  await recordEvents(
    env,
    [
      connectionEvent(person, "connection.connect", connectionId, {
        ...base,
        outcome: "ok",
        name: connection.name,
        origin: connection.origin,
        methods: connection.methods.join(" "),
        pathPrefixes: auditList(connection.pathPrefixes),
        credentialHeader: header,
      }),
    ],
    [
      db.insert(connections).values({
        id: connectionId,
        provider: httpProvider,
        scope: "shared",
        ownerUserId: null,
        status: "active",
        serverKind: "http",
        server: connection.origin,
        accountName: connection.name,
        connectedBy: person.userId,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(httpConnections).values(config),
    ]
  );
  log.info("http.connection_created", { connectionId });
  return { connectionId };
};

/** The rules of HTTP connection `connectionId`, if it is one. */
export const httpConfigOf = async (
  env: Env,
  connectionId: string
): Promise<HttpConfig | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(httpConnections)
    .where(eq(httpConnections.connectionId, connectionId))
    .get();

/** The methods `config` allows, of those Grasp knows. */
const httpMethodsOf = (config: Pick<HttpConfig, "methods">): HttpMethod[] =>
  [...httpReadMethods, ...httpSendMethods].filter((method) =>
    config.methods.includes(method)
  );

/** How each HTTP connection of `ids` is listed, by its ID. */
export const httpSummaries = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, HttpConnectionSummary>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(httpConnections)
    .where(inArray(httpConnections.connectionId, [...ids]));
  return new Map(
    rows.map((row) => [
      row.connectionId,
      {
        name: row.name,
        origin: row.origin,
        pathPrefixes: row.pathPrefixes,
        methods: httpMethodsOf(row),
        credentialHeader: row.credentialHeader,
      },
    ])
  );
};

/** The actions `config` serves: `get` with a read method, `send` with a send one. */
const actionsOf = (config: Pick<HttpConfig, "methods">): HttpAction[] =>
  httpActionsOf(config.methods);

/** The contract `config` serves: its actions, with their schemas. */
export const httpServedContract = (
  config: Pick<HttpConfig, "methods">
): ConnectorContract => {
  const actions: Record<string, ConnectorContractAction> = {};
  for (const action of actionsOf(config)) {
    const { input, output } = httpActionSchemas[action];
    actions[action] = {
      tool: action,
      readOnly: action === "get",
      input: JSON.stringify(input),
      output: JSON.stringify(output),
    };
  }
  return { contract: httpContract, actions };
};

/** The tool of `action`, if `config` serves it. */
export const httpTool = (
  config: Pick<HttpConfig, "methods">,
  action: string
): McpTool | undefined => {
  const served = actionsOf(config).find((each) => each === action);
  if (served === undefined) {
    return undefined;
  }
  return {
    name: served,
    readOnly: served === "get",
    resourceField: undefined,
    inputProperties: [...httpInputProperties[served]],
  };
};

/** One request, as connect will send it. */
interface HttpPlan {
  action: HttpAction;
  method: HttpMethod;
  url: URL;
  pathname: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** Refuses a request, before anything goes out. */
const refused = (reason: string): Error => {
  log.warn("http.refused", { reason });
  return connectErrors.create("connect.http_refused", { reason });
};

/**
 * The request `input` asks of `action`, if `config` allows it exactly:
 * a method it allows, a path under its prefixes on its own origin, and
 * headers a call may set. Thrown as `connect.http_refused` otherwise.
 */
export const httpPlanOf = (
  config: HttpConfig,
  action: string,
  input: Readonly<Record<string, Json>>
): HttpPlan => {
  let read:
    | ReturnType<typeof httpGetInputSchema.safeParse>
    | ReturnType<typeof httpSendInputSchema.safeParse>;
  if (action === "get") {
    read = httpGetInputSchema.safeParse(input);
  } else if (action === "send") {
    read = httpSendInputSchema.safeParse(input);
  } else {
    throw refused("action");
  }
  if (!read.success) {
    throw refused("input");
  }
  const method: HttpMethod = read.data.method ?? "GET";
  if (!httpMethodsOf(config).includes(method)) {
    throw refused("method");
  }
  const path = httpPathOf(read.data.path, config.pathPrefixes);
  if (!path.ok) {
    throw refused(path.reason);
  }
  const url = new URL(read.data.path, config.origin);
  if (url.origin !== config.origin) {
    throw refused("path");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(read.data.headers ?? {})) {
    const lower = name.toLowerCase();
    if (
      !isSettableHeader(lower, config.credentialHeader) ||
      Object.hasOwn(headers, lower)
    ) {
      throw refused("header");
    }
    headers[lower] = value;
  }
  const body = "body" in read.data ? read.data.body : undefined;
  return {
    action: action === "get" ? "get" : "send",
    method,
    url,
    pathname: path.pathname,
    headers,
    body,
  };
};

/** Where a call's request is traced: on its progress (call.ts). */
interface Traced {
  http?: HttpTrace;
}

/**
 * Checks a call of an HTTP connection before it is held or claimed: its
 * request is one the connection allows, and its host leads only to the
 * public internet now. What it is goes on `progress.http`, for the audit
 * log. Nothing for a call of any other connection.
 */
export const requireHttpRequest = async (
  env: Env,
  connection: Pick<Connection, "id" | "serverKind">,
  action: string,
  input: Readonly<Record<string, Json>>,
  progress: Traced
): Promise<void> => {
  if (connection.serverKind !== "http") {
    return;
  }
  progress.http ??= {};
  const trace = progress.http;
  const config = await httpConfigOf(env, connection.id);
  if (config === undefined) {
    throw connectErrors.create("connect.connection_inactive");
  }
  const plan = httpPlanOf(config, action, input);
  trace.method = plan.method;
  trace.path = plan.pathname.slice(0, 256);
  const reach = await resolvedPublic(plan.url.hostname);
  if (reach !== "public") {
    throw refused(`host_${reach}`);
  }
};

/**
 * Response headers never handed back: cookies (with the credential's
 * header, below), and those that no longer hold for the body as text.
 */
const droppedResponseHeaders = new Set([
  "set-cookie",
  "set-cookie2",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

/** A response's body as text, read up to the limit; undefined past it. */
const boundedText = async (response: Response): Promise<string | undefined> => {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream, read in turn
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    const value: unknown = chunk.value;
    if (!(value instanceof Uint8Array)) {
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await reader.cancel();
      return undefined;
    }
    bytes += value.byteLength;
    if (bytes > httpLimits.responseBodyBytes) {
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
};

/** A refusal the server makes itself, with nothing sent: taken at its word. */
const notSent = (reason: string): McpToolResult => ({
  output: JSON.stringify({ code: "connect.http_refused", reason }),
  provenance: [],
  isError: true,
  notPerformed: true,
  outcomeUnknown: false,
  effectAbsent: false,
  change: undefined,
});

/** Where a redirect leads, if it is one a `get` follows: on the origin and paths. */
const followable = (
  config: HttpConfig,
  from: URL,
  response: Response
): URL | "refused" => {
  const location = response.headers.get("location");
  let target: URL | undefined;
  try {
    target = location === null ? undefined : new URL(location, from);
  } catch {
    target = undefined;
  }
  if (
    target === undefined ||
    target.origin !== config.origin ||
    target.username !== "" ||
    target.password !== "" ||
    !httpPathOf(`${target.pathname}${target.search}`, config.pathPrefixes).ok
  ) {
    return "refused";
  }
  return target;
};

/** Whether `status` is a redirect (304 Not Modified leads nowhere). */
const isRedirect = (status: number): boolean =>
  status >= 300 && status < 400 && status !== 304;

/**
 * Sends `plan` with the credential, following a read's redirects on the
 * origin and its paths, within the time limit: the answer, or a refusal
 * of a redirect anywhere else. Throws `McpError` when no answer came: a
 * send may then have acted (call.ts spends its key).
 */
const send = async (
  config: HttpConfig,
  credential: string,
  plan: HttpPlan,
  trace: HttpTrace
): Promise<McpToolResult> => {
  const signal = AbortSignal.timeout(httpLimits.timeoutMs);
  const headers: Record<string, string> = {
    "user-agent": "Grasp-HTTP/1",
    ...plan.headers,
    [config.credentialHeader]:
      config.credentialKind === "bearer" ? `Bearer ${credential}` : credential,
  };
  let { url } = plan;
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- redirects, in turn
      response = await fetch(url, {
        method: plan.method,
        headers,
        body: plan.body,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw new McpError("The request didn't get an answer", error);
    }
    if (!isRedirect(response.status) || plan.action !== "get") {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- once per hop
    await response.body?.cancel();
    const target = followable(config, url, response);
    if (target === "refused") {
      trace.status = response.status;
      // Only a read follows: it is refused as such, nothing kept.
      throw refused("redirect");
    }
    if (hop >= httpLimits.redirects) {
      trace.status = response.status;
      throw refused("redirects");
    }
    url = target;
  }
  trace.status = response.status;
  let body: string | undefined;
  try {
    body = await boundedText(response);
  } catch (error) {
    throw new McpError("The answer couldn't be read", error);
  }
  if (body === undefined) {
    // A send went out and was answered: never taken as nothing done.
    return {
      ...notSent("too_large"),
      notPerformed: plan.action === "get",
    };
  }
  trace.bytes = new TextEncoder().encode(body).byteLength;
  const answerHeaders: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (!droppedResponseHeaders.has(name) && name !== config.credentialHeader) {
      answerHeaders[name] = value;
    }
  }
  // A send's redirect is its answer, never followed: where it leads is
  // left out unless that is on the connection's own origin and paths.
  if (
    isRedirect(response.status) &&
    followable(config, url, response) === "refused"
  ) {
    delete answerHeaders.location;
  }
  const answer: HttpAnswer = {
    status: response.status,
    headers: answerHeaders,
    body,
  };
  return {
    output: JSON.stringify(answer),
    provenance: [],
    isError: false,
    notPerformed: false,
    outcomeUnknown: false,
    effectAbsent: false,
    change: undefined,
  };
};

/**
 * The "server" of an HTTP connection, as call.ts reaches every server:
 * its two tools, carried out by connect itself. Every check is made again
 * here, whatever call.ts checked, and the credential is opened only now.
 */
export const httpServer = (
  env: Env,
  connection: Pick<Connection, "id">,
  progress: Traced
): McpServer => {
  progress.http ??= {};
  const trace = progress.http;
  const configNow = async (): Promise<HttpConfig> => {
    const config = await httpConfigOf(env, connection.id);
    if (config === undefined) {
      throw connectErrors.create("connect.connection_inactive");
    }
    return config;
  };
  return {
    tool: async (name) => {
      const tool = httpTool(await configNow(), name);
      return tool === undefined
        ? undefined
        : { name: tool.name, inputProperties: tool.inputProperties };
    },
    tools: async () => {
      const config = await configNow();
      return actionsOf(config).map((action) => ({
        name: action,
        inputSchema: httpActionSchemas[action].input,
        outputSchema: httpActionSchemas[action].output,
      }));
    },
    call: async (name, input) => {
      const config = await configNow();
      let plan: HttpPlan;
      try {
        plan = httpPlanOf(config, name, input);
      } catch {
        return notSent("request");
      }
      // Its host was resolved as the call was checked (`requireHttpRequest`,
      // on every carry-out, a held action's confirmation too); from then
      // on connect's fetch reaches public addresses only (see the header).
      const vault = await vaultFor(env);
      if (vault === undefined || config.sealed === null) {
        return notSent("credential");
      }
      let credential: string;
      try {
        credential = await vault.open(config.sealed, credentialContext(config));
      } catch (error) {
        log.error("http.credential_unreadable", errorFields(error));
        return notSent("credential");
      }
      return await send(config, credential, plan, trace);
    },
  };
};

/**
 * Seals again, with the current key, the HTTP credentials the previous
 * key sealed, a batch at a time (src/clock.ts).
 */
export const resealHttpCredentials = async (env: Env): Promise<void> => {
  const vault = await vaultFor(env);
  if (vault?.sealedWithPrevious === undefined) {
    return;
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(httpConnections)
    .where(
      and(
        isNotNull(httpConnections.sealed),
        like(httpConnections.sealed, vault.sealedWithPrevious)
      )
    )
    .limit(resealBatchSize);
  for (const row of rows) {
    if (row.sealed === null) {
      continue;
    }
    const context = credentialContext(row);
    let secret: string;
    try {
      // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
      secret = await vault.open(row.sealed, context);
    } catch (error) {
      // Left as it is: its calls fail until an admin approves it again.
      log.error("http.credential_unreadable", errorFields(error));
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    const sealed = await vault.seal(secret, context);
    // oxlint-disable-next-line no-await-in-loop -- a small batch, in turn
    await db
      .update(httpConnections)
      .set({ sealed })
      .where(
        and(
          eq(httpConnections.connectionId, row.connectionId),
          eq(httpConnections.sealed, row.sealed)
        )
      );
  }
};
