import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import type { ApiRequest } from "../../src/connector/api.ts";
import {
  attachedFiles,
  attachments,
  auth,
  contentAs,
  defineConnector,
  event,
  page,
  sync,
  tool,
  v,
} from "../../src/connector/connector.ts";
import {
  attachmentsMetaKey,
  changeMetaKey,
  confirmedMetaKey,
  effectKeyMetaKey,
  findMetaKey,
  maxChangeBytes,
  notPerformedMetaKey,
  outcomeUnknownMetaKey,
  provenanceMetaKey,
  stampMetaKey,
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
  find: async ({ sku }, api) =>
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

/** A write that, wrongly, sends its write while a read is still out. */
const writeDuringRead = tool({
  description: "Reads and sets the stock at once",
  readOnly: false,
  reach: "company",
  routes: ["GET /v1/stock/{sku}", "PUT /v1/stock/{sku}"],
  args: { sku: v.string() },
  returns: Stock,
  handler: async ({ sku }, api) => {
    const [, written] = await Promise.all([
      api.get("/v1/stock/{sku}", { path: { sku } }),
      api.put("/v1/stock/{sku}", {
        path: { sku },
        body: { onHand: 1 },
        returns: Stock,
      }),
    ]);
    return written;
  },
});

/** A write whose lookup, wrongly, sends the write. */
const findByWriting = tool({
  description: "Sets the stock, and finds it by setting it again",
  readOnly: false,
  reach: "company",
  routes: ["GET /v1/stock/{sku}", "PUT /v1/stock/{sku}"],
  args: { sku: v.string() },
  returns: Stock,
  find: async ({ sku }, api) =>
    await api.put("/v1/stock/{sku}", {
      path: { sku },
      body: { onHand: 1 },
      returns: Stock,
    }),
  handler: async ({ sku }, api) =>
    await api.put("/v1/stock/{sku}", {
      path: { sku },
      body: { onHand: 1 },
      returns: Stock,
    }),
});

/** A write that, wrongly, reads while its write is still out. */
const readDuringWrite = tool({
  description: "Sets the stock and reads it at once",
  readOnly: false,
  reach: "company",
  routes: ["GET /v1/stock/{sku}", "PUT /v1/stock/{sku}"],
  args: { sku: v.string() },
  returns: Stock,
  handler: async ({ sku }, api) => {
    const [written] = await Promise.all([
      api.put("/v1/stock/{sku}", {
        path: { sku },
        body: { onHand: 1 },
        returns: Stock,
      }),
      api.get("/v1/stock/{sku}", { path: { sku } }),
    ]);
    return written;
  },
});

/** A write that, wrongly, holds a read's refusal and throws it after its write. */
const throwAfterWrite = tool({
  description: "Reads the stock, sets it, then fails as the read did",
  readOnly: false,
  reach: "company",
  routes: ["GET /v1/stock/{sku}", "PUT /v1/stock/{sku}"],
  args: { sku: v.string() },
  returns: Stock,
  handler: async ({ sku }, api) => {
    const read = await api
      .get("/v1/stock/{sku}", { path: { sku } })
      .then(() => {})
      .catch((error: unknown) => error);
    await api.put("/v1/stock/{sku}", { path: { sku }, body: { onHand: 1 } });
    throw read;
  },
});

/** A write whose vendor answers it with text. */
const deleteStock = tool({
  description: "Deletes one product's stock",
  readOnly: false,
  reach: "company",
  routes: ["DELETE /v1/stock/{sku}"],
  args: { sku: v.string() },
  returns: v.object({ answer: v.string() }),
  handler: async ({ sku }, api) => ({
    answer: String(await api.delete("/v1/stock/{sku}", { path: { sku } })),
  }),
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
    "stock.writeDuringRead": writeDuringRead,
    "stock.findByWriting": findByWriting,
    "stock.delete": deleteStock,
    "stock.throwAfterWrite": throwAfterWrite,
    "stock.readDuringWrite": readDuringWrite,
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

  it("takes events and syncs as typed, and refuses one that reads off its hosts", () => {
    const restocked = event({
      description: "A product is back in stock",
      filter: { location: v.string() },
      payload: Stock,
      id: ({ sku }) => sku,
      poll: {
        routes: ["GET /v1/restocks"],
        handler: async (_filter, cursor) =>
          await Promise.resolve({ events: [], cursor }),
      },
    });
    const stockAt = (route: `GET ${string}`) =>
      sync({
        model: Stock,
        id: ({ sku }) => sku,
        mode: "full",
        routes: [route],
        handler: async () =>
          await Promise.resolve({
            upserts: [],
            deletes: [],
            checkpoint: {},
            more: false,
          }),
      });
    const products = stockAt("GET /v1/stock");
    const offHosts = stockAt("GET evil.test/v1/stock");
    const withSyncs = (syncs: Parameters<typeof defineConnector>[0]["syncs"]) =>
      defineConnector({
        name: "stock",
        title: "Stock",
        hosts: [host],
        auth: keyAuth,
        tools: { "stock.get": getStock },
        events: { restocked },
        syncs,
      });
    const writing = { ...products };
    // As plain JavaScript could declare it: its types say GET.
    Reflect.set(writing, "routes", ["POST /v1/stock"]);
    expect(() => withSyncs({ products })).not.toThrow();
    expect(() => withSyncs({ products: offHosts })).toThrow("doesn't list");
    expect(() => withSyncs({ products: writing })).toThrow("only reads");
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

  it("is its provider's, its name unless it names one, and asks by class for nothing beyond its scopes", () => {
    const named = defineConnector({
      name: "stock-suite",
      provider: "stock",
      title: "Stock",
      hosts: [host],
      auth: keyAuth,
      tools: { "stock.get": getStock },
    });
    expect([named.manifest.provider, stock.manifest.provider]).toStrictEqual([
      "stock",
      "stock",
    ]);
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
          rights: {
            signIn: [],
            classes: {
              "read-own": ["stock:read"],
              "change-own": ["stock:write"],
              "read-company": [],
              "change-company": [],
              "reach-others": [],
              "read-others": [],
            },
          },
        }),
        tools: { "stock.get": getStock },
      })
    ).toThrow("among its scopes");
  });
});

describe("a call of a tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    asked.length = 0;
  });

  it("sends its declared route, each path parameter one encoded segment, and answers the vendor's data", async () => {
    vendorAnswers(Response.json({ sku: "a b", onHand: 3 }));
    const result = await call("stock.get", { sku: "a b" });
    expect({ asked, result: result.structuredContent }).toStrictEqual({
      asked: [
        { method: "GET", url: `https://${host}/v1/stock/a%20b`, body: "" },
      ],
      result: { sku: "a b", onHand: 3 },
    });
  });

  it("refuses a path parameter that would be no segment of its own as the egress does, sending nothing", async () => {
    vendorAnswers(Response.json({ sku: "a", onHand: 1 }));
    const values = ["..", ".", "", "urn:li:1", "50%", "a;b"];
    const results = await Promise.all(
      values.map(
        async (sku) =>
          await call(
            "stock.update",
            { sku, onHand: 1 },
            { [effectKeyMetaKey]: key }
          )
      )
    );
    expect({
      refusals: results.map(({ isError, structuredContent, _meta }) => ({
        isError,
        structuredContent,
        _meta,
      })),
      asked,
    }).toMatchObject({
      refusals: values.map(() => ({
        isError: true,
        structuredContent: { error: { code: "egress_refused" } },
        _meta: undefined,
      })),
      asked: [],
    });
  });

  it("leaves out the fields a vendor's answer has beyond what the request reads", async () => {
    vendorAnswers(
      Response.json({ sku: "a", onHand: 3, warehouse: { id: "w1" } }),
      Response.json({
        data: [{ sku: "a", onHand: 1, added: "2026-11-25" }],
        next_cursor: null,
        total: 1,
      }),
      Response.json({ sku: "a", onHand: 2, updatedBy: "someone" })
    );
    const read = await call("stock.get", { sku: "a" });
    const list = await call("stock.list", {});
    const write = await call(
      "stock.update",
      { sku: "a", onHand: 2 },
      { [effectKeyMetaKey]: key }
    );
    expect([
      read.structuredContent,
      list.structuredContent,
      write.structuredContent,
    ]).toStrictEqual([
      { sku: "a", onHand: 3 },
      { items: [{ sku: "a", onHand: 1 }], next: null },
      { sku: "a", onHand: 2 },
    ]);
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

  it("sends no write while a read is still out, and says nothing was done", async () => {
    vendorAnswers(Response.json({ sku: "a", onHand: 1 }));
    const result = await call(
      "stock.writeDuringRead",
      { sku: "a" },
      { [effectKeyMetaKey]: key }
    );
    expect({
      sent: asked.map(({ method }) => method),
      isError: result.isError,
      meta: result._meta,
    }).toStrictEqual({
      sent: ["GET"],
      isError: true,
      meta: { [notPerformedMetaKey]: true },
    });
  });

  it("answers a write's text where the vendor answers with text", async () => {
    vendorAnswers(new Response("Deleted", { status: 200 }));
    const result = await call(
      "stock.delete",
      { sku: "a" },
      { [effectKeyMetaKey]: key }
    );
    expect(result.structuredContent).toStrictEqual({ answer: "Deleted" });
  });

  it("leaves the outcome unknown once its write went out, whatever it throws after", async () => {
    const after = async (read: Response) => {
      vendorAnswers(read, Response.json({ sku: "a", onHand: 1 }));
      const result = await call(
        "stock.throwAfterWrite",
        { sku: "a" },
        { [effectKeyMetaKey]: key }
      );
      return [result._meta, result.content];
    };
    const unknown = [
      { [outcomeUnknownMetaKey]: true },
      [{ type: "text", text: "The action's outcome is unknown" }],
    ];
    expect([
      await after(new Response(null, { status: 429 })),
      await after(new Response(null, { status: 404 })),
    ]).toStrictEqual([unknown, unknown]);
    expect(asked.map(({ method }) => method)).toStrictEqual([
      "GET",
      "PUT",
      "GET",
      "PUT",
    ]);
  });

  it("leaves the outcome unknown for a request refused while its write is out", async () => {
    vendorAnswers(Response.json({ sku: "a", onHand: 1 }));
    const result = await call(
      "stock.readDuringWrite",
      { sku: "a" },
      { [effectKeyMetaKey]: key }
    );
    expect({
      sent: asked.map(({ method }) => method),
      meta: result._meta,
    }).toStrictEqual({
      sent: ["PUT"],
      meta: { [outcomeUnknownMetaKey]: true },
    });
  });

  it("says a rate-limited write did nothing, and a refused one failed", async () => {
    vendorAnswers(
      new Response(null, { status: 429 }),
      new Response(null, { status: 400 })
    );
    const write = async () =>
      await call(
        "stock.update",
        { sku: "a", onHand: 2 },
        { [effectKeyMetaKey]: key }
      );
    const throttled = await write();
    const refused = await write();
    expect([
      [throttled.isError, throttled._meta],
      [refused.isError, refused._meta],
    ]).toStrictEqual([
      [true, { [notPerformedMetaKey]: true }],
      [true, undefined],
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

  it("lets a lookup send none of its tool's writes", async () => {
    vendorAnswers(Response.json({ sku: "a", onHand: 1 }));
    const result = await call(
      "stock.findByWriting",
      { sku: "a" },
      { [effectKeyMetaKey]: key, [findMetaKey]: true }
    );
    expect({ isError: result.isError, asked }).toStrictEqual({
      isError: true,
      asked: [],
    });
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

// Notes: tools that answer items and files, take files, and report what
// they changed, as the old connector kit's tools could.

const Note = v.object({ id: v.string(), text: v.string() });

const FileAnswer = v.object({
  name: v.string(),
  contentType: v.string(),
  encoding: v.enum(["text", "base64"]),
  content: v.string(),
});

const Sheet = v.object({ sheetId: v.string(), title: v.string() });

const notesTools = {
  "sheets.get": tool({
    description: "Gets one sheet",
    readOnly: true,
    reach: "own",
    idField: "sheetId",
    routes: ["GET /v1/sheets/{sheetId}"],
    args: { sheetId: v.string() },
    returns: Sheet,
    handler: async ({ sheetId }, api) =>
      await api.get("/v1/sheets/{sheetId}", {
        path: { sheetId },
        returns: Sheet,
      }),
  }),
  "notes.list": tool({
    description: "Lists notes",
    readOnly: true,
    reach: "own",
    routes: ["GET /v1/notes"],
    args: {},
    returns: page(Note),
    handler: async (_args, api) =>
      await api.get("/v1/notes", { returns: page(Note) }),
  }),
  "notes.get": tool({
    description: "Gets one note",
    readOnly: true,
    reach: "own",
    answersItem: true,
    routes: ["GET /v1/notes/{id}"],
    args: { id: v.string() },
    returns: v.object({ id: v.string().optional(), text: v.string() }),
    handler: async ({ id }, api) =>
      await api.get("/v1/notes/{id}", {
        path: { id },
        returns: v.object({ id: v.string().optional(), text: v.string() }),
      }),
  }),
  "notes.read": tool({
    description: "Reads a note's file",
    readOnly: true,
    reach: "own",
    answersFile: true,
    routes: ["GET /v1/notes/{id}/file"],
    redirects: { "GET /v1/notes/{id}/file": ["*.files.notes.test"] },
    args: { id: v.string(), as: v.enum(["text", "base64"]) },
    returns: FileAnswer,
    handler: async ({ id, as }, api) => ({
      name: "note.bin",
      contentType: "application/octet-stream",
      ...contentAs(
        await api.get("/v1/notes/{id}/file", { path: { id }, as: "bytes" }),
        as
      ),
    }),
  }),
  "notes.send": tool({
    description: "Sends a note with files",
    readOnly: false,
    reach: "others",
    takesFiles: true,
    describe: {
      title: "Send a note",
      fields: [
        { label: "Text", arg: "text" },
        { label: "Files", arg: "attachments" },
      ],
    },
    routes: ["POST /v1/notes"],
    args: { text: v.string(), attachments },
    returns: v.object({
      id: v.string(),
      files: v.array(v.object({ name: v.string(), bytes: v.number() })),
      stamp: v.string().nullable(),
      confirmed: v.boolean(),
    }),
    handler: async ({ text, attachments: named }, api, toolCall) => {
      const files = attachedFiles(named, toolCall);
      const { id } = await api.post("/v1/notes", {
        body: { text, files: files.map(({ name }) => name) },
        returns: v.object({ id: v.string() }),
      });
      return {
        id,
        files: files.map(({ name, bytes }) => ({
          name,
          bytes: bytes.byteLength,
        })),
        stamp: toolCall.stamp,
        confirmed: toolCall.confirmed,
      };
    },
  }),
  "notes.edit": tool({
    description: "Changes a note's text, reporting the change some times",
    readOnly: false,
    reach: "own",
    routes: ["PUT /v1/notes/{id}"],
    args: {
      id: v.string(),
      text: v.string(),
      times: v.number().integer(),
    },
    returns: Note,
    handler: async ({ id, text, times }, api, toolCall) => {
      const note = await api.put("/v1/notes/{id}", {
        path: { id },
        body: { text },
        returns: Note,
      });
      for (let time = 0; time < times; time += 1) {
        toolCall.changed({ before: { text: "old" }, after: { text } });
      }
      return note;
    },
  }),
};

const notes = defineConnector({
  name: "notes",
  title: "Notes",
  hosts: [host],
  auth: keyAuth,
  tools: notesTools,
});

const callNotes = async (
  name: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> = {}
) => await rpc(notes, "tools/call", { name, arguments: args, _meta: meta });

/** The requests the vendor saw, answering each with `answer`'s next. */
const vendorSees = (answer: () => Response): Request[] => {
  const seen: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push(new Request(input, init));
    return await Promise.resolve(answer());
  });
  return seen;
};

const hexOf = async (bytes: Uint8Array): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const base64Of = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes));

/** A declaration as plain JavaScript could make it, past its types. */
const declared = (
  base: Parameters<typeof tool>[0],
  extra: Record<string, unknown>
): ReturnType<typeof tool> => {
  const declaration = { ...base };
  for (const [name, value] of Object.entries(extra)) {
    Reflect.set(declaration, name, value);
  }
  return tool(declaration);
};

describe("what a tool declares of items, files and confirmation", () => {
  const withNotes = (each: ReturnType<typeof tool>) => () =>
    defineConnector({
      name: "notes",
      title: "Notes",
      hosts: [host],
      auth: keyAuth,
      tools: { "notes.one": each },
    });

  const aRead = {
    description: "Reads",
    readOnly: true,
    reach: "own",
    routes: ["GET /v1/notes/{id}"],
    args: { id: v.string(), as: v.enum(["text", "base64"]), attachments },
    returns: v.object({ id: v.string() }).extend(FileAnswer.shape),
    handler: async () =>
      await Promise.resolve({
        id: "n1",
        name: "a",
        contentType: "text/plain",
        encoding: "text" as const,
        content: "",
      }),
  } as const;

  const aWrite = {
    ...aRead,
    readOnly: false,
    routes: ["GET /v1/notes/{id}", "PUT /v1/notes/{id}"],
  } as const;

  it("makes the manifest's card, items, files and redirects", () => {
    const { actions } = notes.manifest;
    expect({
      send: actions["notes.send"],
      get: actions["notes.get"]?.answersItem,
      read: [actions["notes.read"]?.answersFile, actions["notes.read"]?.routes],
    }).toMatchObject({
      send: {
        takesFiles: true,
        describe: {
          title: "Send a note",
          fields: [
            { label: "Text", input: "text" },
            { label: "Files", input: "attachments" },
          ],
        },
        contract: {
          input: {
            properties: {
              attachments: {
                type: "array",
                items: { properties: { file: { type: "string" } } },
              },
            },
          },
        },
      },
      get: true,
      read: [
        true,
        [
          {
            method: "GET",
            host,
            path: "/v1/notes/{id}/file",
            redirects: ["*.files.notes.test"],
          },
        ],
      ],
    });
  });

  it("refuses a card that names an arg it doesn't have, or one twice", () => {
    const naming = (fields: readonly { label: string; arg: string }[]) =>
      withNotes(declared(aWrite, { describe: { title: "Change", fields } }));
    expect(naming([{ label: "Note", arg: "id" }])).not.toThrow();
    expect(naming([{ label: "Who", arg: "owner" }])).toThrow(
      "describes only its own input properties"
    );
    expect(
      naming([
        { label: "Note", arg: "id" },
        { label: "Again", arg: "id" },
      ])
    ).toThrow("describes only its own input properties");
  });

  it("takes provenance only from a field its answer has", () => {
    expect(withNotes(declared(aRead, { idField: "name" }))).not.toThrow();
    expect(withNotes(declared(aRead, { idField: "sheetId" }))).toThrow(
      "its idField is a field of its answer"
    );
  });

  it("lets only a read answer an item or a file, and only a write take files", () => {
    expect(withNotes(declared(aWrite, { answersItem: true }))).toThrow(
      "Only a read-only action answers an item"
    );
    expect(withNotes(declared(aWrite, { answersFile: true }))).toThrow(
      "Only a read-only action answers a file"
    );
    expect(withNotes(declared(aRead, { takesFiles: true }))).toThrow(
      "Only a write takes files"
    );
    expect(withNotes(declared(aWrite, { takesFiles: true }))).not.toThrow();
  });

  it("refuses a write that takes files without exactly the SDK's attachments", () => {
    const own = {
      ...aWrite,
      args: { id: v.string(), attachments: v.array(Note).optional() },
    };
    const none = { ...aWrite, args: { id: v.string() } };
    expect(withNotes(declared(own, { takesFiles: true }))).toThrow(
      "takes files has the SDK's `attachments`"
    );
    expect(withNotes(declared(none, { takesFiles: true }))).toThrow(
      "takes files has the SDK's `attachments`"
    );
  });

  it("refuses a read that answers a file without the shape contentAs makes", () => {
    const textOnly = {
      ...aRead,
      args: { id: v.string(), as: v.enum(["text"]) },
    };
    const noContent = { ...aRead, returns: v.object({ id: v.string() }) };
    expect(withNotes(declared(aRead, { answersFile: true }))).not.toThrow();
    expect(withNotes(declared(textOnly, { answersFile: true }))).toThrow(
      "answers a file takes `as`"
    );
    expect(withNotes(declared(noContent, { answersFile: true }))).toThrow(
      "answers a file takes `as`"
    );
  });

  it("follows redirects only from its own GET routes, to redirect hosts", () => {
    expect(() =>
      declared(aWrite, {
        redirects: { "GET /v1/elsewhere": ["*.files.notes.test"] },
      })
    ).toThrow("redirects are for its own GET routes");
    expect(() =>
      declared(aWrite, {
        redirects: { "PUT /v1/notes/{id}": ["*.files.notes.test"] },
      })
    ).toThrow("redirects are for its own GET routes");
    expect(
      withNotes(
        declared(aWrite, {
          redirects: { "GET /v1/notes/{id}": ["files.notes.test"] },
        })
      )
    ).toThrow("Not a redirect host");
  });
});

describe("a call of a tool that answers items and files", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names what it read: each item's id, else the answer's own, else none", async () => {
    const answers = [
      {
        items: [
          { id: "n1", text: "a" },
          { id: "n2", text: "b" },
        ],
        next: null,
      },
      { id: "n3", text: "c" },
      { sheetId: "s1", title: "Invoices" },
      { sku: "a", onHand: 1 },
    ];
    vendorSees(() => Response.json(answers.shift()));
    const list = await callNotes("notes.list", {});
    const item = await callNotes("notes.get", { id: "n3" });
    const sheet = await callNotes("sheets.get", { sheetId: "s1" });
    const stockRead = await call("stock.get", { sku: "a" });
    expect([
      list._meta,
      item._meta,
      sheet._meta,
      stockRead._meta,
    ]).toStrictEqual([
      { [provenanceMetaKey]: ["n1", "n2"] },
      { [provenanceMetaKey]: ["n3"] },
      { [provenanceMetaKey]: ["s1"] },
      { [provenanceMetaKey]: [] },
    ]);
  });

  it("fails a read that answers an item without naming exactly one", async () => {
    vendorSees(() => Response.json({ text: "no id" }));
    const unnamed = await callNotes("notes.get", { id: "n1" });
    vi.restoreAllMocks();
    vendorSees(() => Response.json({ id: "", text: "empty id" }));
    const empty = await callNotes("notes.get", { id: "n1" });
    expect([
      [unnamed.isError, unnamed._meta],
      [empty.isError, empty._meta],
    ]).toStrictEqual([
      [true, undefined],
      [true, undefined],
    ]);
  });

  it("answers a file's exact bytes as base64 or text, from a bytes answer", async () => {
    const bytes = new Uint8Array([0, 255, 128, 10]);
    vendorSees(() => new Response(bytes));
    const base64 = await callNotes("notes.read", { id: "n1", as: "base64" });
    const text = await callNotes("notes.read", { id: "n1", as: "text" });
    expect([base64.structuredContent, text.structuredContent]).toStrictEqual([
      {
        name: "note.bin",
        contentType: "application/octet-stream",
        encoding: "base64",
        content: base64Of(bytes),
      },
      {
        error: {
          code: "not_text",
          message: "This isn't text: read it as base64",
        },
      },
    ]);
  });
});

describe("a call of a write that takes files", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const one = new TextEncoder().encode("one");
  const two = new TextEncoder().encode("two!");

  const entryOf = async (name: string, bytes: Uint8Array) => ({
    name,
    type: "text/plain",
    size: bytes.byteLength,
    sha256: await hexOf(bytes),
  });

  const send = async (
    named: unknown[],
    sent?: Record<string, string>,
    meta: Record<string, unknown> = {}
  ) =>
    await callNotes(
      "notes.send",
      { text: "hi", attachments: named },
      {
        [effectKeyMetaKey]: key,
        ...(sent === undefined ? {} : { [attachmentsMetaKey]: sent }),
        ...meta,
      }
    );

  it("gives the handler each file with its checked bytes, the stamp, and whether its person confirmed it", async () => {
    const seen = vendorSees(() => Response.json({ id: "n1" }));
    const stamp = "b".repeat(32);
    const result = await send(
      [await entryOf("one.txt", one), await entryOf("two.txt", two)],
      {
        [await hexOf(one)]: base64Of(one),
        [await hexOf(two)]: base64Of(two),
      },
      { [stampMetaKey]: stamp, [confirmedMetaKey]: true }
    );
    expect({
      body: await seen[0]?.text(),
      result: result.structuredContent,
      provenance: result._meta,
    }).toStrictEqual({
      body: JSON.stringify({ text: "hi", files: ["one.txt", "two.txt"] }),
      result: {
        id: "n1",
        files: [
          { name: "one.txt", bytes: 3 },
          { name: "two.txt", bytes: 4 },
        ],
        stamp,
        confirmed: true,
      },
      provenance: { [provenanceMetaKey]: ["n1"] },
    });
  });

  it("refuses files that aren't exactly those its digests name, sending nothing", async () => {
    const seen = vendorSees(() => Response.json({ id: "n1" }));
    const entry = await entryOf("one.txt", one);
    const results = await Promise.all([
      send([entry], {}),
      send([entry]),
      send([entry], {
        [entry.sha256]: base64Of(one),
        [await hexOf(two)]: base64Of(two),
      }),
      send([entry], { [entry.sha256]: base64Of(two) }),
      send([{ ...entry, size: 4 }], { [entry.sha256]: base64Of(one) }),
      send([{ ...entry, name: "../one.txt" }], {
        [entry.sha256]: base64Of(one),
      }),
      send([], { [entry.sha256]: base64Of(one) }),
    ]);
    expect({
      results: results.map(({ isError, content }) => [isError, content]),
      seen: seen.length,
    }).toStrictEqual({
      results: results.map(() => [
        true,
        [
          {
            type: "text",
            text: "Invalid input: the attached files don't match",
          },
        ],
      ]),
      seen: 0,
    });
  });

  it("refuses files sent to a tool that takes none", async () => {
    const seen = vendorSees(() => Response.json({ id: "n1", text: "x" }));
    const result = await callNotes(
      "notes.edit",
      { id: "n1", text: "x", times: 0 },
      { [effectKeyMetaKey]: key, [attachmentsMetaKey]: {} }
    );
    expect([result.isError, result.content, seen.length]).toStrictEqual([
      true,
      [{ type: "text", text: "Invalid input: this tool takes no files" }],
      0,
    ]);
  });
});

describe("a call of a write that reports its change", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const edit = async (text: string, times: number) =>
    await callNotes(
      "notes.edit",
      { id: "n1", text, times },
      { [effectKeyMetaKey]: key }
    );

  it("passes the change it reports on, for the audit", async () => {
    vendorSees(() => Response.json({ id: "n1", text: "new" }));
    const result = await edit("new", 1);
    expect(result._meta).toStrictEqual({
      [provenanceMetaKey]: ["n1"],
      [changeMetaKey]: { before: { text: "old" }, after: { text: "new" } },
    });
  });

  it("leaves the outcome unknown for a change reported twice or past the limit, once its write went out", async () => {
    const seen = vendorSees(() => Response.json({ id: "n1", text: "x" }));
    const twice = await edit("x", 2);
    const large = await edit("x".repeat(maxChangeBytes), 1);
    expect({
      results: [
        [twice.isError, twice._meta],
        [large.isError, large._meta],
      ],
      sent: seen.map(({ method }) => method),
    }).toStrictEqual({
      results: [
        [true, { [outcomeUnknownMetaKey]: true }],
        [true, { [outcomeUnknownMetaKey]: true }],
      ],
      sent: ["PUT", "PUT"],
    });
  });
});

describe("what a request sends", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A write whose one request is `request`, and what the vendor saw. */
  const sending = async (
    request: ApiRequest<undefined> & { as?: undefined }
  ) => {
    const seen = vendorSees(() => Response.json({}));
    const connector = defineConnector({
      name: "files",
      title: "Files",
      hosts: [host],
      auth: keyAuth,
      tools: {
        "files.put": tool({
          description: "Puts a file",
          readOnly: false,
          reach: "own",
          routes: ["PUT /v1/files/{id}"],
          args: {},
          returns: v.object({}),
          handler: async (_args, api) => {
            await api.put("/v1/files/{id}", { ...request, path: { id: "f1" } });
            return {};
          },
        }),
      },
    });
    const result = await rpc(connector, "tools/call", {
      name: "files.put",
      arguments: {},
      _meta: { [effectKeyMetaKey]: key },
    });
    return { result, seen };
  };

  const refusedBeforeSending = async (
    request: ApiRequest<undefined> & { as?: undefined }
  ) => {
    const { result, seen } = await sending(request);
    return [result.isError, result._meta, seen.length];
  };
  const refusal = [true, { [notPerformedMetaKey]: true }, 0];

  it("adds its headers", async () => {
    const { seen } = await sending({
      headers: { "if-match": 'W/"etag 1"', prefer: "return=minimal" },
      body: { a: 1 },
    });
    const [request] = seen;
    expect([
      request?.headers.get("if-match"),
      request?.headers.get("prefer"),
      request?.headers.get("content-type"),
    ]).toStrictEqual(['W/"etag 1"', "return=minimal", "application/json"]);
  });

  it("refuses a header the egress or the body sets, or one that isn't a lowercase token with a visible value", async () => {
    const names = [
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
      "x-forwarded-for",
      "x-forwarded-host",
      "x-http-method-override",
      "grasp-egress",
      "If-Match",
      "if match",
      "",
    ];
    const values = ["a\r\nx-evil: 1", "a\nb", "tab\there", "é"];
    const refusals = await Promise.all([
      ...names.map(
        async (name) => await refusedBeforeSending({ headers: { [name]: "1" } })
      ),
      ...values.map(
        async (value) =>
          await refusedBeforeSending({ headers: { "if-match": value } })
      ),
    ]);
    expect(refusals).toStrictEqual([...names, ...values].map(() => refusal));
  });

  it("sends a string or bytes body as it is, under its media type", async () => {
    const bytes = new Uint8Array([0, 255, 1]);
    const html = await sending({
      body: "<p>hi</p>",
      contentType: 'text/html; charset="utf-8"',
    });
    const binary = await sending({
      body: bytes,
      contentType: "application/octet-stream",
    });
    const json = await sending({ body: "plain" });
    expect([
      html.seen[0]?.headers.get("content-type"),
      await html.seen[0]?.text(),
      binary.seen[0]?.headers.get("content-type"),
      new Uint8Array((await binary.seen[0]?.arrayBuffer()) ?? []),
      await json.seen[0]?.text(),
    ]).toStrictEqual([
      'text/html; charset="utf-8"',
      "<p>hi</p>",
      "application/octet-stream",
      bytes,
      '"plain"',
    ]);
  });

  it("refuses bytes without a media type, a media type without a string or bytes body, and one that isn't a media type", async () => {
    const malformed = [
      "text",
      "text/",
      "/html",
      "text/html; charset",
      'text/html; charset="utf-8',
      "text /html",
      "text/html\r\nx-evil: 1",
      "text/html; charset=a b",
    ];
    const refusals = await Promise.all([
      refusedBeforeSending({ body: new Uint8Array([1]) }),
      refusedBeforeSending({ contentType: "text/plain" }),
      refusedBeforeSending({ body: { a: 1 }, contentType: "text/plain" }),
      ...malformed.map(
        async (contentType) =>
          await refusedBeforeSending({ body: "x", contentType })
      ),
    ]);
    expect(refusals).toStrictEqual([1, 2, 3, ...malformed].map(() => refusal));
  });

  it("refuses an answer read as bytes that also names returns", async () => {
    const request = {};
    Reflect.set(request, "as", "bytes");
    Reflect.set(request, "returns", v.object({}));
    await expect(refusedBeforeSending(request)).resolves.toStrictEqual(refusal);
  });
});
