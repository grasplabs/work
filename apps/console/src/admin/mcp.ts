/**
 * Grasp's admin as an MCP server, for Grasp's staff only (GRA-656): the
 * read-only tools of `@grasp-os/shared/admin/admin-tools`, served at
 * `POST /mcp` so Claude, ChatGPT or a bot can ask what the admin's pages
 * show. Threat model, and how each is closed:
 *
 * - Who can reach it. The route sits behind `withAccess` like every page
 *   (src/access.ts): the console verifies the Access JWT itself, and
 *   without one, or with one Access never issued, for another application
 *   or naming no person (a service token), nothing here runs. An MCP
 *   client signs in through Access's Managed OAuth, which hands the
 *   console the same Access JWT as a browser's sign-in: there is no other
 *   credential, no token the console keeps, and no key to leak.
 * - A cross-site request riding a staff member's Access cookie. Only
 *   `POST /mcp` with a JSON body and no `Origin` is let past the console's
 *   CSRF rule (`isMcpRequest`, src/access.ts): a browser sends `Origin`
 *   on every POST, so a page elsewhere can't call a tool with someone's
 *   cookie. A browser's own request from the console keeps its `Origin`
 *   and takes the ordinary rule.
 * - A revoked staff member. Access stops them at the edge once they are
 *   out of its policy and their sessions are revoked; the console checks
 *   expiry on every request, so the application's session length bounds
 *   any JWT already issued (decision D2 on GRA-656).
 * - A tool changing something, or saying what someone said. The tools
 *   are pure reads over the admin's views (`callAdminTool`): counts and
 *   team names, never interview text. This module adds no tool and holds
 *   no write path to the console's database or to any core.
 * - Bad input. Each call's arguments are checked against the tool's own
 *   schema before anything is read; a bad one is a tool error that reads
 *   nothing.
 * - Cost. Listing reads nothing. A call reads every client once, a few
 *   at a time within the grid's deadline (`clientAdmins`), and is limited
 *   per staff member (`ADMIN_MCP_RATE_LIMIT`, 30 a minute, each call one
 *   count): over it is a 429 that reads nothing. A request carries one
 *   message; a batch is refused, so no request holds more than one call.
 *   Cloudflare counts the limit per location, so a person whose requests
 *   reach several locations gets up to that much at each.
 * - What an answer says. It goes to an outside model, often beside tools
 *   that can act: its text carries ids, roles and numbers, a company's
 *   names only as data in its structured content, and no person's name
 *   or research text at all (`callAdminTool`, decision D5 on GRA-656).
 * - Audit. Each call is recorded as `admin.mcp.call` by the staff member,
 *   before anything is read: the tool and the identifiers it was asked
 *   about, never free text beyond the organization asked for. Each core
 *   records its own `admin.snapshot.read` naming the same person.
 */
import { Validator } from "@cfworker/json-schema";
import type { Schema } from "@cfworker/json-schema";
import {
  ADMIN_MCP_INSTRUCTIONS,
  ADMIN_TOOLS,
  callAdminTool,
} from "@grasp-os/shared/admin/admin-tools";
import type { AdminToolAnswer } from "@grasp-os/shared/admin/admin-tools";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { log } from "@grasp-os/shared/log";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { clientAdmins } from "../clients/admin.ts";
import type { AdminReadOptions } from "../clients/admin.ts";
import type { LiveOptions } from "../clients/grid.ts";
import { audit, consoleDatabase } from "../db/act.ts";
import { platformsAnswer } from "./platform-answer.ts";
import { organizationsOf } from "./views.ts";

/** Where the admin's MCP is served. */
export const adminMcpPath = "/mcp";

/** The most a request's body may be: a JSON-RPC message or a small batch. */
const maxBodyBytes = 64 * 1024;

/** The longest organization name or id a call's audit keeps. */
const maxAuditedText = 100;

/** A tool's input schema as the validator takes it: plain JSON Schema. */
const schemaOf = (inputSchema: object): Schema =>
  // SAFETY: each `inputSchema` in ADMIN_TOOLS is a literal JSON Schema
  // object (`type`, `properties`, `required`, `additionalProperties`).
  inputSchema;

/**
 * The admin's tools whose data the console doesn't hold yet: the
 * integrations to build, which nothing records until GRA-689 S1. Served,
 * it would answer that there is nothing, which a model would take as so;
 * until then it isn't served at all.
 */
const unfed: ReadonlySet<string> = new Set(["integrations_to_build"]);

/** The tools this MCP serves: the admin's, but those it can't feed yet. */
export const servedTools = ADMIN_TOOLS.filter((tool) => !unfed.has(tool.name));

/** Each served tool's argument check, compiled once per isolate. */
const validators = new Map<string, Validator>(
  servedTools.map((tool) => [
    tool.name,
    new Validator(schemaOf(tool.inputSchema), "2020-12"),
  ])
);

/** What a call's audit keeps of its arguments: the identifiers, bounded. */
const auditedArguments = (
  input: Record<string, unknown>
): Record<string, string> =>
  Object.fromEntries(
    ["organization", "phase", "measure"].flatMap((key) => {
      const value = input[key];
      return typeof value === "string"
        ? [[key, value.slice(0, maxAuditedText)]]
        : [];
    })
  );

/** A tool's answer as MCP carries it. */
const resultOf = (answer: AdminToolAnswer): CallToolResult => ({
  content: [{ type: "text", text: answer.text }],
  ...(answer.structured === undefined
    ? {}
    : { structuredContent: answer.structured }),
  ...(answer.failed === true ? { isError: true } : {}),
});

const toolError = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** What answering a call takes, apart from the staff member. */
export interface AdminMcpOptions {
  /** How every client is read: the grid's limits, unless a test says otherwise. */
  reads?: AdminReadOptions;
  /** How the platforms tool reads each account's live columns: the grid's, unless a test says otherwise. */
  live?: LiveOptions;
  /** The day the digest counts to; today, in UTC, unless a test says otherwise. */
  today?: () => string;
}

/** Every organization whose core answered, as the admin's pages see it now. */
const viewsNow = async (
  env: Env,
  staff: Staff,
  reads: AdminReadOptions | undefined
): Promise<AdminView[]> =>
  organizationsOf(await clientAdmins(env, staff, reads)).flatMap(({ view }) =>
    view === null ? [] : [view]
  );

/**
 * The MCP server for one request, answering as `staff`. The tools are the
 * admin's own, with their JSON Schemas as written, so they're served
 * through the protocol's request handlers rather than registered as
 * Zod-typed tools.
 */
const serverFor = (
  env: Env,
  staff: Staff,
  options: AdminMcpOptions
): McpServer => {
  const mcp = new McpServer(
    { name: "grasp-admin", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: ADMIN_MCP_INSTRUCTIONS,
    }
  );
  const { server } = mcp;
  // Listing reads nothing.
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: servedTools.map((tool) => ({ ...tool })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const input = request.params.arguments ?? {};
    const validator = validators.get(name);
    if (validator === undefined) {
      return toolError(`There is no tool ${name}.`);
    }
    const checked = validator.validate(input);
    if (!checked.valid) {
      return toolError(
        `The arguments don't fit ${name}'s schema: ${checked.errors
          .map((error) => error.error)
          .join("; ")}`
      );
    }
    // Recorded before anything is read, so a call that fails is still an
    // audited attempt.
    await audit(consoleDatabase(env.DB), staff, {
      action: "admin.mcp.call",
      target: name,
      detail: auditedArguments(input),
    });
    // Every company's platform comes from the console's own records, as
    // the Platform page reads them: it reads no core.
    if (name === "platforms") {
      return resultOf(await platformsAnswer(env, new Date(), options.live));
    }
    const views = await viewsNow(env, staff, options.reads);
    const today = options.today?.() ?? new Date().toISOString().slice(0, 10);
    return resultOf(callAdminTool(name, input, views, today));
  });
  return mcp;
};

const plain = (
  status: number,
  text: string,
  headers: Record<string, string> = {}
) =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

/** The request's body as JSON, or why it can't be one. */
const bodyOf = async (
  request: Request
): Promise<{ body: unknown } | { refused: Response }> => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBodyBytes) {
    return { refused: plain(413, "Too large.") };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBodyBytes) {
    return { refused: plain(413, "Too large.") };
  }
  try {
    const body: unknown = JSON.parse(text);
    return { body };
  } catch {
    return { refused: plain(400, "Not JSON.") };
  }
};

/** A JSON-RPC message, as far as whether it calls a tool. */
const messageSchema = z.object({ method: z.unknown() }).loose();

/** Whether `body`, one JSON-RPC message, calls a tool. */
const callsTool = (body: unknown): boolean =>
  messageSchema.safeParse(body).data?.method === "tools/call";

/**
 * Answers one request to the admin's MCP from `staff`, whom Access
 * verified: stateless Streamable HTTP, a JSON answer per POST. GET (a
 * standing event stream) and DELETE (ending a session) have nothing to
 * serve without sessions.
 */
export const adminMcp = async (
  request: Request,
  staff: Staff,
  env: Env,
  options: AdminMcpOptions = {}
): Promise<Response> => {
  if (request.method !== "POST") {
    return plain(405, "Method not allowed.", { allow: "POST" });
  }
  const read = await bodyOf(request);
  if ("refused" in read) {
    return read.refused;
  }
  // One message a request: the protocol dropped batches (2025-06-18), and
  // a batch would run several calls under one of the limit's counts.
  if (Array.isArray(read.body)) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "Send one message a request." },
      },
      { status: 400, headers: { "cache-control": "no-store" } }
    );
  }
  if (callsTool(read.body)) {
    const { success } = await env.ADMIN_MCP_RATE_LIMIT.limit({
      key: staff.email,
    });
    if (!success) {
      log.warn("admin.mcp_limited", { staff: staff.email });
      return plain(429, "Too many calls: wait a minute.", {
        "retry-after": "60",
      });
    }
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  // One server and transport per request: nothing outlives it.
  await serverFor(env, staff, options).connect(transport);
  return await transport.handleRequest(request, { parsedBody: read.body });
};
