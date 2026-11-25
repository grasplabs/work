import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  auth,
  defineConnector,
  page,
  tool,
  v,
} from "../../src/connector/connector.ts";
import {
  effectKeyMetaKey,
  findMetaKey,
  notPerformedMetaKey,
  outcomeUnknownMetaKey,
} from "../../src/connector/manifest.ts";
import type { Connector } from "../../src/connector/server.ts";

// A connector as @grasp-os/sdk/connector writes it, and the MCP server it
// becomes: what it refuses to be defined as, and what a call of each of
// its tools may send and answer. The ways it can go wrong first: a tool
// that writes twice, args that let unknown keys through, a route or scope
// it doesn't declare, a handler that reaches past its routes or writes
// again after its write, and a vendor's answer that isn't what it says.

const host = "api.stock.test";

const keyAuth = auth.apiKey({
  header: "x-api-key",
  account: { url: `https://${host}/v1/account`, id: "/id" },
});

const Stock = v.object({ sku: v.string(), onHand: v.number().integer() });

const getStock = tool({
  description: "Gets the stock of one product",
  readOnly: true,
  reach: "company",
  routes: ["GET /v1/stock/{sku}"],
  args: { sku: v.string().max(64) },
  returns: Stock,
  handler: async ({ sku }, api) =>
    await api.get("/v1/stock/{sku}", { path: { sku }, returns: Stock }),
});

const listStock = tool({
  description: "Lists the stock",
  readOnly: true,
  reach: "company",
  routes: ["GET /v1/stock"],
  args: {
    location: v.string().optional(),
    cursor: v.string().optional(),
  },
  returns: page(Stock),
  handler: async (args, api) => {
    const { data, next_cursor: next } = await api.get("/v1/stock", {
      query: args,
      returns: v.object({
        data: v.array(Stock),
        next_cursor: v.string().nullable(),
      }),
    });
    return { items: data, next };
  },
});

const setStock = tool({
  description: "Sets the stock of one product",
  readOnly: false,
  reach: "company",
  resource: "sku",
  routes: ["GET /v1/stock/{sku}", "PUT /v1/stock/{sku}"],
  args: { sku: v.string(), onHand: v.number().integer() },
  returns: Stock,
  find: async ({ sku }, _call, api) =>
    await api.get("/v1/stock/{sku}", { path: { sku }, returns: Stock }),
  handler: async ({ sku, onHand }, api) =>
    await api.put("/v1/stock/{sku}", {
      path: { sku },
      body: { onHand },
      returns: Stock,
    }),
});

/** A write that, wrongly, reads after it wrote. */
const writeThenRead = tool({
  description: "Sets the stock, then reads it back",
  readOnly: false,
  reach: "company",
  routes: ["GET /v1/stock/{sku}", "PUT /v1/stock/{sku}"],
  args: { sku: v.string() },
  returns: Stock,
  handler: async ({ sku }, api) => {
    await api.put("/v1/stock/{sku}", { path: { sku }, body: { onHand: 1 } });
    return await api.get("/v1/stock/{sku}", { path: { sku }, returns: Stock });
  },
});

/** A read whose handler asks for a route it didn't declare. */
const strayRead = tool({
  description: "Gets one product through another route",
  readOnly: true,
  reach: "company",
  routes: ["GET /v1/stock/{sku}"],
  args: { sku: v.string() },
  returns: Stock,
  handler: async ({ sku }, api) =>
    await api.get("/v1/admin/{sku}", { path: { sku }, returns: Stock }),
});

const stock = defineConnector({
  name: "stock",
  title: "Stock",
  hosts: [host],
  auth: keyAuth,
  tools: {
    "stock.get": getStock,
    "stock.list": listStock,
    "stock.update": setStock,
    "stock.writeThenRead": writeThenRead,
    "stock.stray": strayRead,
  },
});

/** What the vendor was asked, in order. */
const asked: { method: string; url: string; body: string }[] = [];

/** The vendor answers each request with the next of `responses`. */
const vendorAnswers = (...responses: Response[]) => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    asked.push({
      method: request.method,
      url: request.url,
      body: await request.text(),
    });
    return responses.shift() ?? new Response(null, { status: 500 });
  });
};

const rpc = async (
  connector: Connector,
  method: string,
  params: Record<string, unknown>
) => {
  const response = await connector.fetch(
    new Request("https://connector.internal/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
  );
  return z
    .object({ result: z.record(z.string(), z.unknown()) })
    .parse(await response.json()).result;
};

const call = async (
  name: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> = {}
) => await rpc(stock, "tools/call", { name, arguments: args, _meta: meta });

const key = "a".repeat(64);

describe("a tool's definition", () => {
  it("refuses a tool that declares two write routes", () => {
    expect(() =>
      tool({
        description: "Writes twice",
        readOnly: false,
        reach: "own",
        routes: ["POST /v1/a", "PATCH /v1/b"],
        args: {},
        returns: Stock,
        handler: async () => await Promise.resolve({ sku: "a", onHand: 1 }),
      })
    ).toThrow("at most one write route");
  });

  it("refuses a write that both repeats and finds its effect", () => {
    expect(() =>
      tool({
        description: "Both",
        readOnly: false,
        reach: "own",
        routes: ["GET /v1/a", "PUT /v1/a"],
        args: {},
        returns: Stock,
        repeatable: true,
        find: async () => await Promise.resolve(null),
        handler: async () => await Promise.resolve({ sku: "a", onHand: 1 }),
      })
    ).toThrow("either repeats or finds");
  });
});

describe("a connector's definition", () => {
  const withTool =
    (each: ReturnType<typeof tool>, hosts = [host]) =>
    () =>
      defineConnector({
        name: "stock",
        title: "Stock",
        hosts,
        auth: keyAuth,
        tools: { "stock.get": each },
      });

  it("refuses a route to a host it doesn't list, and a bare path among several hosts", () => {
    const elsewhere = tool({
      description: "Elsewhere",
      readOnly: true,
      reach: "own",
      routes: ["GET evil.test/v1/stock"],
      args: {},
      returns: Stock,
      handler: async () => await Promise.resolve({ sku: "a", onHand: 1 }),
    });
    expect(withTool(elsewhere)).toThrow("doesn't list");
    expect(withTool(getStock, [host, "files.stock.test"])).toThrow(
      "names no host"
    );
  });

  it("refuses args that let any key through", () => {
    const open = tool({
      description: "Open",
      readOnly: true,
      reach: "own",
      routes: ["GET /v1/stock"],
      args: { filters: v.record(v.string()) },
      returns: Stock,
      handler: async () => await Promise.resolve({ sku: "a", onHand: 1 }),
    });
    expect(withTool(open)).toThrow("strict objects throughout");
  });

  it("refuses a resource that isn't a string argument, and returns that aren't an object", () => {
    const numbered = tool({
      description: "Numbered",
      readOnly: true,
      reach: "own",
      resource: "id",
      routes: ["GET /v1/stock/{id}"],
      args: { id: v.number() },
      returns: Stock,
      handler: async () => await Promise.resolve({ sku: "a", onHand: 1 }),
    });
    const counted = tool({
      description: "Counted",
      readOnly: true,
      reach: "own",
      routes: ["GET /v1/count"],
      args: {},
      returns: v.number(),
      handler: async () => await Promise.resolve(1),
    });
    expect(withTool(numbered)).toThrow("string argument");
    expect(withTool(counted)).toThrow("returns an object");
  });

  it("refuses a scope its sign-in doesn't ask for", () => {
    expect(() =>
      defineConnector({
        name: "stock",
        title: "Stock",
        hosts: [host],
        auth: auth.oauth2({
          authorizeUrl: "https://auth.stock.test/authorize",
          tokenUrl: "https://auth.stock.test/token",
          scopes: { "stock:read": "Read stock" },
          account: { url: `https://${host}/v1/account`, id: "/id" },
        }),
        tools: {
          "stock.get": tool({
            description: "Gets",
            readOnly: true,
            reach: "own",
            scopes: ["stock:write"],
            routes: ["GET /v1/stock"],
            args: {},
            returns: Stock,
            handler: async () => await Promise.resolve({ sku: "a", onHand: 1 }),
          }),
        },
      })
    ).toThrow("scopes");
  });

  it("makes the manifest connect decides by: its sign-in, routes, recovery and resource", () => {
    expect({
      provider: stock.manifest.provider,
      signIn: stock.manifest.signIn,
      update: stock.manifest.actions["stock.update"],
    }).toMatchObject({
      provider: "stock",
      signIn: { kind: "api_key", name: "Stock", header: "x-api-key" },
      update: {
        readOnly: false,
        reach: "company",
        recovery: "find",
        resource: "sku",
        input: ["sku", "onHand"],
        routes: [
          { method: "GET", host, path: "/v1/stock/{sku}" },
          { method: "PUT", host, path: "/v1/stock/{sku}" },
        ],
      },
    });
  });
});

describe("a call of a tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    asked.length = 0;
  });

  it("sends its declared route, each path parameter one encoded segment, and answers the vendor's data", async () => {
    vendorAnswers(Response.json({ sku: "a/b", onHand: 3 }));
    const result = await call("stock.get", { sku: "a/b" });
    expect({ asked, result: result.structuredContent }).toStrictEqual({
      asked: [
        { method: "GET", url: `https://${host}/v1/stock/a%2Fb`, body: "" },
      ],
      result: { sku: "a/b", onHand: 3 },
    });
  });

  it("pages as items and next, leaving out the query parameters it isn't given", async () => {
    vendorAnswers(
      Response.json({ data: [{ sku: "a", onHand: 1 }], next_cursor: "c2" })
    );
    const result = await call("stock.list", { location: "amsterdam" });
    expect({
      url: asked[0]?.url,
      result: result.structuredContent,
    }).toStrictEqual({
      url: `https://${host}/v1/stock?location=amsterdam`,
      result: { items: [{ sku: "a", onHand: 1 }], next: "c2" },
    });
  });

  it("refuses an argument it doesn't declare, sending nothing", async () => {
    vendorAnswers(Response.json({ sku: "a", onHand: 1 }));
    const result = await call("stock.get", { sku: "a", admin: true });
    expect({ isError: result.isError, asked }).toStrictEqual({
      isError: true,
      asked: [],
    });
  });

  it("fails closed on a vendor's answer that isn't what it declares", async () => {
    vendorAnswers(Response.json({ sku: "a", onHand: "lots" }));
    const read = await call("stock.get", { sku: "a" });
    vendorAnswers(Response.json({ sku: "a", onHand: "lots" }));
    const write = await call(
      "stock.update",
      { sku: "a", onHand: 2 },
      {
        [effectKeyMetaKey]: key,
      }
    );
    expect({
      read: [read.isError, read.structuredContent, read._meta],
      write: [write.isError, write._meta],
    }).toStrictEqual({
      read: [
        true,
        {
          error: {
            code: "failed",
            message: "Stock's answer isn't what the connector expects",
          },
        },
        undefined,
      ],
      write: [true, { [outcomeUnknownMetaKey]: true }],
    });
  });

  it("refuses a route its tool doesn't declare, before it is sent", async () => {
    vendorAnswers(Response.json({ sku: "a", onHand: 1 }));
    const result = await call("stock.stray", { sku: "a" });
    expect({ isError: result.isError, asked }).toStrictEqual({
      isError: true,
      asked: [],
    });
  });

  it("sends nothing after its one write, and leaves that write's outcome unknown", async () => {
    vendorAnswers(
      Response.json({ sku: "a", onHand: 1 }),
      Response.json({ sku: "a", onHand: 1 })
    );
    const result = await call(
      "stock.writeThenRead",
      { sku: "a" },
      {
        [effectKeyMetaKey]: key,
      }
    );
    expect({
      sent: asked.map(({ method }) => method),
      isError: result.isError,
      meta: result._meta,
    }).toStrictEqual({
      sent: ["PUT"],
      isError: true,
      meta: { [outcomeUnknownMetaKey]: true },
    });
  });

  it("says a rate-limited write did nothing", async () => {
    vendorAnswers(new Response(null, { status: 429 }));
    const result = await call(
      "stock.update",
      { sku: "a", onHand: 2 },
      {
        [effectKeyMetaKey]: key,
      }
    );
    expect([result.isError, result._meta]).toStrictEqual([
      true,
      { [notPerformedMetaKey]: true },
    ]);
  });

  it("looks a write's effect up by GET when connect asks it to find it", async () => {
    vendorAnswers(Response.json({ sku: "a", onHand: 2 }));
    const result = await call(
      "stock.update",
      { sku: "a", onHand: 2 },
      {
        [effectKeyMetaKey]: key,
        [findMetaKey]: true,
      }
    );
    expect({
      sent: asked.map(({ method }) => method),
      result: result.structuredContent,
    }).toStrictEqual({ sent: ["GET"], result: { sku: "a", onHand: 2 } });
  });

  it("lists its tools with their schemas and hints, as MCP describes them", async () => {
    const { tools } = await rpc(stock, "tools/list", {});
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "stock.update",
        inputSchema: {
          type: "object",
          properties: { sku: { type: "string" }, onHand: { type: "integer" } },
          required: ["sku", "onHand"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
      })
    );
  });
});
