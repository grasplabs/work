import { mcpConnectorSource } from "@grasp-os/compiler/connector-source";
import type { McpConnectorFields } from "@grasp-os/compiler/connector-source";
import { mcpManifestSchema } from "@grasp-os/runtime/connector";
import { signCapability } from "@grasp-os/shared/capability";
import { addConnectorSchema, connectionErrors } from "@grasp-os/shared/connect";
import type {
  AddBuiltConnector,
  AddConnector,
  ConnectionPerson,
} from "@grasp-os/shared/connect";
import type { Authority } from "@grasp-os/shared/permissions";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { z } from "zod";

import builtCode from "#test-url-connector";

import { agentFor, clientOrigin, originOf, someone } from "./connect.ts";
import type { Call } from "./connect.ts";
import { linearCopyOrigin, linearMcpFake } from "./linear-mcp-fake.ts";
import type { LinearMcpFake } from "./linear-mcp-fake.ts";
import { urlConnectorPlaceholders } from "./url-connector-placeholders.ts";

// The internet as the tests of connectors served through an MCP server
// see it (src/mcp-connectors.ts, threat model on GRA-1375): Linear's MCP
// server (test/linear-mcp-fake.ts), which the built-in Linear serves; the
// same server at an address of its own, which admins add by its URL; any
// other server a test stands up by its origin; and the DNS resolver
// connect asks when an admin adds one.

/**
 * Linear's server at an address of its own, as a company might run a
 * server like it: what the tests of a connector made from a URL add, since
 * Linear's own address is the built-in Linear's. Put back before each
 * test.
 */
export const linear = linearMcpFake(linearCopyOrigin);

/** Linear's own server, which the built-in Linear serves. */
export const linearItself = linearMcpFake();

/** Other servers a test stands up, by origin. */
export const servers = new Map<
  string,
  (request: Request) => Response | Promise<Response>
>();

/** What each name resolves to (A records), as the fake DNS answers. */
export const dns = new Map<string, string[]>();

/** Every request that left connect but the DNS lookups, as sent. */
export const sent: { url: string; headers: Record<string, string> }[] = [];

const resolve = (url: URL): Response => {
  const name = url.searchParams.get("name") ?? "";
  const type = url.searchParams.get("type") === "AAAA" ? 28 : 1;
  const addresses = type === 1 ? dns.get(name) : [];
  if (addresses === undefined) {
    return Response.json({ Status: 3 });
  }
  return Response.json({
    Status: 0,
    Answer: addresses.map((data) => ({ name, type, TTL: 60, data })),
  });
};

/** Stands the internet up for each test of the file. */
export const mcpInternet = (): void => {
  beforeEach(async () => {
    // Each test adds its servers again, to a server that forgot it.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM connector_blocked_tools"),
      env.DB.prepare("DELETE FROM connectors"),
    ]);
    linear.reset();
    linearItself.reset();
    servers.clear();
    sent.length = 0;
    dns.clear();
    dns.set(new URL(linear.origin).hostname, ["34.120.10.2"]);
    dns.set(new URL(linearItself.origin).hostname, ["34.120.10.1"]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === "cloudflare-dns.com") {
        return resolve(url);
      }
      sent.push({
        url: url.href,
        headers: Object.fromEntries(request.headers),
      });
      const fake = [linear, linearItself].find(
        (each) => each.origin === url.origin
      );
      if (fake !== undefined) {
        return await fake.handle(request);
      }
      const server = servers.get(url.origin);
      return server === undefined
        ? new Response("Not Found", { status: 404 })
        : await server(request);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
};

export const admin = (): ConnectionPerson => someone("admin");

const literal = (value: string): string => JSON.stringify(value);

/**
 * What core sends connect when `person` asks for the connector `request`
 * names, with `origin` as the deployment's (core's connections.ts
 * `addConnector`): its ID, its source generated from the checked fields,
 * and its code as the compiler builds it, with each field put where the
 * compiler put its placeholder (global-setup.ts `writeUrlConnector`).
 * Like core, it refuses fields that aren't a connector's before it
 * builds; it leaves the role and staff for connect to refuse.
 */
export const generatedConnector = (
  person: ConnectionPerson,
  request: AddConnector,
  origin: string = clientOrigin
): AddBuiltConnector => {
  const parsed = addConnectorSchema.safeParse(request);
  if (!parsed.success) {
    throw connectionErrors.create("connection.invalid");
  }
  const { name, url, companyNetwork, auth } = parsed.data;
  const id = `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
  let registration: McpConnectorFields["mcp"]["registration"] = "dcr";
  if (auth.kind === "header") {
    registration = { header: auth.header };
  } else if (auth.client !== undefined) {
    registration = "client";
  }
  const mcp = mcpManifestSchema.safeParse({
    url: new URL(url).href,
    registration,
    ...(companyNetwork === true && { network: "company" }),
  });
  if (!mcp.success) {
    throw connectionErrors.create("connection.invalid");
  }
  const fields = { name: id, title: name, mcp: mcp.data };
  const filled: [string, string][] = [
    [urlConnectorPlaceholders.name, literal(id)],
    [urlConnectorPlaceholders.title, literal(name)],
    [urlConnectorPlaceholders.url, literal(mcp.data.url)],
    [
      urlConnectorPlaceholders.registration,
      // The value of `registration` in the code's `mcp` object literal,
      // so the `network` beside it is written after it there.
      `${
        typeof registration === "string"
          ? literal(registration)
          : `{header:${literal(registration.header)}}`
      }${mcp.data.network === "company" ? ',network:"company"' : ""}`,
    ],
  ];
  let code = builtCode;
  for (const [placeholder, value] of filled) {
    code = code.replace(literal(placeholder), () => value);
  }
  return {
    person,
    origin,
    id,
    source: mcpConnectorSource(fields),
    code,
    compiler: "test",
    ...(auth.kind === "oauth" && auth.client !== undefined
      ? { client: auth.client }
      : {}),
  };
};

/** Adds Linear's server as a connector, as `person` would: its ID. */
export const addLinear = async (
  person: ConnectionPerson = admin(),
  url: string = linear.url
): Promise<string> => {
  const { id } = await exports.default.addConnector(
    generatedConnector(person, {
      name: "Linear",
      url,
      auth: { kind: "oauth" },
    })
  );
  return id;
};

/** Starts connecting `person` to `connector`: Linear's sign-in URL. */
export const startLinear = async (
  connector: string,
  person: ConnectionPerson,
  scope: "personal" | "shared" = "personal"
): Promise<string> => {
  const { url } = await exports.default.startConnection({
    person,
    provider: connector,
    scope,
    origin: clientOrigin,
    returnTo: "/connectors",
  });
  return url;
};

/**
 * Connects `person` to `connector` end to end, as their browser and core
 * would: start, consent at its `server`, come back with its answer.
 */
export const connectLinear = async (
  connector: string,
  person: ConnectionPerson,
  scope: "personal" | "shared" = "personal",
  server: LinearMcpFake = linear
): Promise<string> => {
  const { code, state, iss } = server.consent(
    await startLinear(connector, person, scope)
  );
  const { connectionId } = await exports.default.finishConnection({
    person,
    state,
    code,
    iss,
  });
  return connectionId;
};

/** A held action as `listPendingActions` shows it. */
type HeldAction = Awaited<
  ReturnType<typeof exports.default.listPendingActions>
>[number];

/** A chat's agent acting for `person`, where connect holds writes. */
export const chatAgent = (person: ConnectionPerson): Authority =>
  agentFor(person.userId, "agent-chat", "interactive");

/**
 * Confirms the one action held for `person`, as they would in Grasp, or
 * `listed`, the one they were shown earlier.
 */
export const confirmHeld = async (
  person: ConnectionPerson,
  authority: Authority,
  call: Pick<Call, "connectionId" | "action">,
  listed?: HeldAction
) => {
  const [waiting] =
    listed === undefined
      ? await exports.default.listPendingActions(person, "grasp")
      : [listed];
  return await exports.default.confirmAction({
    person,
    id: waiting?.id ?? "",
    inputHash: waiting?.inputHash ?? "",
    capability: await signCapability(env.CAPABILITY_SIGNING_KEY, authority, {
      ...call,
      idempotencyKey: waiting?.idempotencyKey,
      origin: originOf(authority),
      decision: { kind: "confirm", pendingActionId: waiting?.id ?? "" },
    }),
  });
};

const rpcRequestSchema = z.object({ id: z.number(), method: z.string() });

/** The JSON-RPC request `request` carries: its ID and method. */
export const rpcOf = async (
  request: Request
): Promise<z.infer<typeof rpcRequestSchema>> =>
  rpcRequestSchema.parse(await request.clone().json());

/** An MCP server that takes a fixed key in `x-api-key`, with one read. */
export const keyServer = (origin: string, key: string): string => {
  dns.set(new URL(origin).hostname, ["34.120.10.3"]);
  servers.set(origin, async (request) => {
    if (request.headers.get("x-api-key") !== key) {
      return new Response(null, { status: 401 });
    }
    const { id, method } = await rpcOf(request);
    const result =
      method === "tools/list"
        ? {
            resultType: "complete",
            ttlMs: 300_000,
            tools: [
              {
                name: "list_notes",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }
        : {
            resultType: "complete",
            content: [{ type: "text", text: "[]" }],
          };
    return Response.json({ jsonrpc: "2.0", id, result });
  });
  return `${origin}/mcp`;
};
