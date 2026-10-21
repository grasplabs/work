/**
 * A stand-in for Stripe's MCP server: a real MCP server (the official
 * SDK's, over Streamable HTTP) at Stripe's URL, answering the console's
 * outbound requests, so the console's client runs unchanged against it.
 * It lists Stripe's write tools beside its reads, as the real one does,
 * and records every tool called, so a test can say none of them ever ran.
 * Only the key it was made with gets in; it answers each customer it holds
 * as Stripe answers its objects, as JSON text.
 *
 * Any other request goes to the stand-in for `fetch` set up before it
 * (the fake Cloudflare API, Access's keys), as test/access.ts chains.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { z } from "zod";

import { stripeMcpUrl } from "../src/billing/stripe.ts";

/** A Stripe object, as its API answers it. */
type StripeObject = Record<string, unknown>;

/** What Stripe holds on one customer. */
export interface FakeCustomer {
  customer: StripeObject;
  subscriptions: StripeObject[];
  invoices: StripeObject[];
}

/**
 * Tools Stripe's MCP server lists that change something: listed here so a
 * client that called one would be caught doing it.
 */
const writeTools = [
  "create_customer",
  "create_invoice",
  "create_invoice_item",
  "finalize_invoice",
  "create_refund",
  "cancel_subscription",
  "update_subscription",
  "create_payment_link",
  "update_dispute",
] as const;

/** Reads the console doesn't need, listed too. */
const otherReads = [
  "list_customers",
  "list_payment_intents",
  "retrieve_balance",
  "search_stripe_resources",
] as const;

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const notFound = (id: string) => ({
  content: [{ type: "text" as const, text: `No such resource: '${id}'` }],
  isError: true,
});

const listInput = {
  customer: z.string().optional(),
  limit: z.number().optional(),
};

/** A Unix time `days` from `now`, in seconds. */
export const daysFrom = (now: Date, days: number): number =>
  Math.floor(now.getTime() / 1000) + days * 86_400;

/** The fake Stripe MCP server for each test in the file, letting in `key` only. */
export const fakeStripeMcp = (key: string) => {
  const state: {
    customers: Map<string, FakeCustomer>;
    /** Every tool called, in order, with its input. */
    called: { tool: string; input: Record<string, unknown> }[];
    /** Every request that reached it. */
    requests: number;
    /** Requests without the key as their bearer token. */
    unkeyed: number;
  } = { customers: new Map(), called: [], requests: 0, unkeyed: 0 };

  /** Everything every customer holds, of one kind, filtered as Stripe filters by customer. */
  const listed = (
    kind: "subscriptions" | "invoices",
    customer: string | undefined
  ): StripeObject[] =>
    [...state.customers.entries()]
      .filter(([id]) => customer === undefined || id === customer)
      .flatMap(([, held]) => held[kind]);

  const server = (): McpServer => {
    const mcp = new McpServer({ name: "stripe", version: "1.0.0" });
    const record = (tool: string, input: Record<string, unknown>) => {
      state.called.push({ tool, input });
    };
    mcp.registerTool(
      "fetch_stripe_resources",
      { inputSchema: { id: z.string() } },
      (input) => {
        record("fetch_stripe_resources", input);
        const held = state.customers.get(input.id);
        return held === undefined ? notFound(input.id) : json(held.customer);
      }
    );
    mcp.registerTool(
      "list_subscriptions",
      { inputSchema: { ...listInput, status: z.string().optional() } },
      (input) => {
        record("list_subscriptions", input);
        return json(listed("subscriptions", input.customer));
      }
    );
    mcp.registerTool("list_invoices", { inputSchema: listInput }, (input) => {
      record("list_invoices", input);
      return json(listed("invoices", input.customer));
    });
    for (const tool of [...writeTools, ...otherReads]) {
      mcp.registerTool(
        tool,
        { inputSchema: z.looseObject({}) },
        (input: Record<string, unknown>) => {
          record(tool, input);
          return json({ id: `${tool}_done` });
        }
      );
    }
    return mcp;
  };

  const answer = async (request: Request): Promise<Response> => {
    state.requests += 1;
    if (request.headers.get("authorization") !== `Bearer ${key}`) {
      state.unkeyed += 1;
      return new Response("Unauthorized", { status: 401 });
    }
    // Stateless, as a server behind a load balancer: no stream to open
    // or session to end, and one server per request.
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server().connect(transport);
    return await transport.handleRequest(request);
  };

  beforeEach(() => {
    const earlier = vi.isMockFunction(globalThis.fetch)
      ? vi.mocked(globalThis.fetch).getMockImplementation()
      : undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith(stripeMcpUrl)) {
        return await answer(request);
      }
      if (earlier === undefined) {
        throw new Error(`Unexpected outbound request to ${request.url}`);
      }
      return await earlier(input, init);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    state.customers.clear();
    state.called = [];
    state.requests = 0;
    state.unkeyed = 0;
  });

  return state;
};
