import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  auth,
  defineConnector,
  event,
  page,
  sync,
  tool,
  v,
} from "../../src/connector/connector.ts";
import { connectorManifestSchema } from "../../src/connector/manifest.ts";
import {
  effectKeyMetaKey,
  findMetaKey,
  notPerformedMetaKey,
  outcomeUnknownMetaKey,
} from "../../src/connector/protocol.ts";
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
const zeroStock = tool({
  description: "Zeroes one product's stock",
  readOnly: false,
  reach: "company",
  routes: ["POST /v1/stock/{sku}/zero"],
  args: { sku: v.string() },
  returns: v.object({ answer: v.string() }),
  handler: async ({ sku }, api) => ({
    answer: String(await api.post("/v1/stock/{sku}/zero", { path: { sku } })),
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
    "stock.zero": zeroStock,
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

  const named = (name: string, each: ReturnType<typeof tool>) => () =>
    defineConnector({
      name: "stock",
      title: "Stock",
      hosts: [host],
      auth: keyAuth,
      tools: { [name]: each },
    });

  /** A tool that answers the stock, declared as `changes` say. */
  const declared = (
    changes: Pick<
      Parameters<typeof tool>[0],
      "readOnly" | "reach" | "routes" | "args"
    >
  ) =>
    tool({
      description: "Declared",
      ...changes,
      returns: Stock,
      handler: async () => await Promise.resolve({ sku: "a", onHand: 1 }),
    });

  it("refuses a read that sends a write, names a change, or tells people it calls its own", () => {
    const read = { readOnly: true, reach: "own" } as const;
    expect(
      named(
        "stock.get",
        declared({ ...read, routes: ["POST /v1/stock/query"], args: {} })
      )
    ).toThrow(
      "stock.get: it is read-only, so it sends only GET and HEAD requests"
    );
    expect(
      named(
        "send_message",
        declared({ ...read, routes: ["GET /v1/stock/send"], args: {} })
      )
    ).toThrow(
      "send_message: it is read-only, but its name says it changes something"
    );
    expect(
      named(
        "get_x",
        declared({
          ...read,
          routes: ["GET /v1/stock/report"],
          args: { recipients: v.array(v.string()) },
        })
      )
    ).toThrow("get_x: its input names people or places it reaches");
  });

  it("refuses what Grasp never runs, by its name or a DELETE, and a message declared as its author's own", () => {
    const write = { readOnly: false, reach: "own" } as const;
    const addressed = declared({
      ...write,
      routes: ["POST /v1/notices"],
      args: { to: v.string() },
    });
    expect(named("stock.softDelete", setStock)).toThrow(
      "stock.softDelete: Grasp never runs it"
    );
    expect(
      named(
        "stock.zero",
        // A connector written without types still can't declare a DELETE.
        // @ts-expect-error -- DELETE is no route method
        declared({ ...write, routes: ["DELETE /v1/stock/{sku}"], args: {} })
      )
    ).toThrow("DELETE");
    expect(
      named(
        "notice.send",
        declared({
          ...write,
          routes: ["POST /v1/notices"],
          args: { username: v.string() },
        })
      )
    ).toThrow("notice.send: its input names people or places it reaches");
    expect(named("notice.submitDraft", addressed)).toThrow(
      "notice.submitDraft: its input names people or places it reaches"
    );
    expect(named("notice.createDraft", addressed)).not.toThrow();
  });

  it("refuses a draft that can send, and a message written where people talk, declared as its author's own", () => {
    const write = { readOnly: false, reach: "own" } as const;
    expect(
      named(
        "notice.createDraft",
        declared({
          ...write,
          routes: ["POST /v1/notices"],
          args: { to: v.string(), send: v.boolean() },
        })
      )
    ).toThrow(
      "notice.createDraft: its input names people or places it reaches"
    );
    expect(
      named(
        "chat.createMessage",
        declared({
          ...write,
          routes: ["POST /v1/notices"],
          args: { chatId: v.string(), content: v.string() },
        })
      )
    ).toThrow(
      "chat.createMessage: its input names people or places it reaches, or it writes where people talk"
    );
    expect(
      named(
        "mail.label",
        declared({ ...write, routes: ["POST /v1/notices"], args: {} })
      )
    ).not.toThrow();
  });

  it("refuses a benign name for a route whose path names what Grasp never does, but not for a parameter's name", () => {
    const write = { readOnly: false, reach: "own", args: {} } as const;
    expect(
      named(
        "mail.tidy",
        declared({
          ...write,
          routes: ["POST /gmail/v1/users/{u}/messages/{id}/trash"],
        })
      )
    ).toThrow("mail.tidy: a route's path names what Grasp never does");
    expect(
      named(
        "mail.pass",
        declared({
          ...write,
          routes: ["POST /v1.0/users/{u}/messages/{id}/forward"],
        })
      )
    ).toThrow("mail.pass: a route's path names what Grasp never does");
    expect(
      named(
        "items.tidy",
        declared({ ...write, routes: ["POST /v1/items/{id}:batchDelete"] })
      )
    ).toThrow("items.tidy: a route's path names what Grasp never does");
    expect(
      named(
        "mail.store",
        declared({
          ...write,
          routes: ["POST /gmail/v1/users/{send}/messages/{trash}"],
        })
      )
    ).not.toThrow();
  });

  it("lets a read export a file, as Drive answers one in another format", () => {
    expect(
      named(
        "drive.files.get",
        declared({
          readOnly: true,
          reach: "own",
          routes: [
            "GET /drive/v3/files/{fileId}",
            "GET /drive/v3/files/{fileId}/export",
          ],
          args: {},
        })
      )
    ).not.toThrow();
  });

  it("reads a delivery word inside a path's joined word only to make a write reach others, never to refuse a read", () => {
    expect(
      named(
        "orders.read",
        declared({
          readOnly: true,
          reach: "company",
          routes: [
            "GET /v1/submissions",
            "GET /v1/deliveries",
            "GET /v1/senders",
            "GET /v1/publications",
            "GET /v1.0/me/mailFolders/sentitems/messages",
            "GET /api/chat.scheduledMessages.list",
          ],
          args: {},
        })
      )
    ).not.toThrow();
    expect(
      named(
        "mail.store",
        declared({
          readOnly: false,
          reach: "own",
          routes: ["POST /v1.0/me/sendmail"],
          args: {},
        })
      )
    ).toThrow("mail.store: a route's path delivers to people");
    expect(
      named(
        "mail.store",
        declared({
          readOnly: false,
          reach: "own",
          routes: ["POST /v1/messages/{id}/replyall"],
          args: {},
        })
      )
    ).toThrow("mail.store: a route's path delivers to people");
  });

  it("makes a write whose path delivers, by any method, reach others", () => {
    const write = { readOnly: false, reach: "own", args: {} } as const;
    expect(
      named(
        "mail.store",
        declared({
          ...write,
          routes: ["POST /gmail/v1/users/{u}/messages/send"],
        })
      )
    ).toThrow("mail.store: a route's path delivers to people");
    expect(
      named(
        "mail.store",
        declared({ ...write, routes: ["POST /v1.0/me/sendMail"] })
      )
    ).toThrow("mail.store: a route's path delivers to people");
    expect(
      named(
        "chat.note",
        declared({ ...write, routes: ["GET /api/chat.postMessage"] })
      )
    ).toThrow("chat.note: a route's path delivers to people");
    expect(
      named(
        "mail.store",
        declared({ ...write, routes: ["POST /v1.0/me/sendmail"] })
      )
    ).toThrow("mail.store: a route's path delivers to people");
    expect(
      named(
        "chat.note",
        declared({ ...write, routes: ["POST /api/chat.scheduleMessage"] })
      )
    ).toThrow("chat.note: a route's path delivers to people");
  });

  it("refuses a read whose path changes or delivers", () => {
    const read = { readOnly: true, reach: "own", args: {} } as const;
    expect(
      named(
        "channel.history",
        declared({ ...read, routes: ["GET /api/chat.postMessage"] })
      )
    ).toThrow(
      "channel.history: it is read-only, but a route's path says it changes or delivers something"
    );
    for (const route of [
      "GET /api/conversations.archive",
      "GET /api/conversations.aRchive",
    ] as const) {
      expect(
        named("channel.info", declared({ ...read, routes: [route] }))
      ).toThrow(
        "channel.info: it is read-only, but a route's path says it changes or delivers something"
      );
    }
    expect(
      named(
        "channel.history",
        declared({ ...read, routes: ["GET /api/chat.postmessage"] })
      )
    ).toThrow(
      "channel.history: it is read-only, but a route's path says it changes or delivers something"
    );
    expect(
      named(
        "channel.history",
        declared({ ...read, routes: ["GET /api/chat.pOstMessage"] })
      )
    ).toThrow(
      "channel.history: it is read-only, but a route's path says it changes or delivers something"
    );
    expect(
      named(
        "channel.history",
        declared({ ...read, routes: ["GET /api/chat.scheduleMessage"] })
      )
    ).toThrow(
      "channel.history: it is read-only, but a route's path says it changes or delivers something"
    );
  });

  it("lets a draft write its reply on the vendor's draft route, never on the route that sends it", () => {
    const write = { readOnly: false, reach: "own", args: {} } as const;
    expect(
      named(
        "mail.createReplyDraft",
        declared({
          ...write,
          routes: ["POST /v1.0/me/messages/{id}/createReply"],
        })
      )
    ).not.toThrow();
    expect(
      named(
        "mail.createReplyDraft",
        declared({ ...write, routes: ["POST /v1.0/me/messages/{id}/reply"] })
      )
    ).toThrow("mail.createReplyDraft: a route's path delivers to people");
    expect(
      named(
        "mail.createDraft",
        declared({
          ...write,
          routes: ["POST /gmail/v1/users/{u}/drafts/send"],
        })
      )
    ).toThrow("mail.createDraft: a route's path delivers to people");
    expect(
      named(
        "mail.tidy",
        declared({
          ...write,
          routes: ["POST /v1.0/me/messages/{id}/createReply"],
        })
      )
    ).toThrow("mail.tidy: a route's path delivers to people");
    expect(
      named(
        "mail.createReplyDraft",
        declared({
          ...write,
          routes: ["POST /v1/messages/{id}/addReply"],
        })
      )
    ).toThrow("mail.createReplyDraft: a route's path delivers to people");
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

  it("refuses an event or a sync whose path delivers to people, as it would on every run, in its definition and its manifest", () => {
    const withReaders = (route: `GET ${string}`) => [
      () =>
        defineConnector({
          name: "stock",
          title: "Stock",
          hosts: [host],
          auth: keyAuth,
          tools: { "stock.get": getStock },
          events: {
            restocked: event({
              description: "A product is back in stock",
              filter: {},
              payload: Stock,
              id: ({ sku }) => sku,
              poll: {
                routes: [route],
                handler: async (_filter, cursor) =>
                  await Promise.resolve({ events: [], cursor }),
              },
            }),
          },
        }),
      () =>
        defineConnector({
          name: "stock",
          title: "Stock",
          hosts: [host],
          auth: keyAuth,
          tools: { "stock.get": getStock },
          syncs: {
            products: sync({
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
            }),
          },
        }),
    ];
    for (const define of withReaders("GET /api/chat.postMessage")) {
      expect(define).toThrow("its path may not deliver to people");
    }
    for (const define of withReaders("GET /v1/stock/{sku}/export")) {
      expect(define).not.toThrow();
    }
    expect(
      connectorManifestSchema
        .safeParse({
          ...stock.manifest,
          syncs: {
            products: {
              kind: "file",
              routes: [{ method: "GET", host, path: "/api/chat.postMessage" }],
            },
          },
        })
        .error?.issues.map(({ message }) => message)
    ).toStrictEqual([
      "A sync runs on its own, so its paths may not deliver to people",
    ]);
  });

  it("makes the manifest connect decides by: its sign-in, routes, recovery and resource, and what each tool says it does", () => {
    expect({
      provider: stock.manifest.provider,
      signIn: stock.manifest.signIn,
      update: stock.manifest.actions["stock.update"],
    }).toMatchObject({
      provider: "stock",
      signIn: { kind: "api_key", name: "Stock", header: "x-api-key" },
      update: {
        description: "Sets the stock of one product",
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
    const suite = defineConnector({
      name: "stock-suite",
      provider: "stock",
      title: "Stock",
      hosts: [host],
      auth: keyAuth,
      tools: { "stock.get": getStock },
    });
    expect([suite.manifest.provider, stock.manifest.provider]).toStrictEqual([
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

  it("refuses a path parameter that would be no segment of its own, sending nothing", async () => {
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
      refusals: results.map(({ isError, _meta }) => [isError, _meta]),
      asked,
    }).toStrictEqual({
      refusals: values.map(() => [true, { [notPerformedMetaKey]: true }]),
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
    vendorAnswers(new Response("Zeroed", { status: 200 }));
    const result = await call(
      "stock.zero",
      { sku: "a" },
      { [effectKeyMetaKey]: key }
    );
    expect(result.structuredContent).toStrictEqual({ answer: "Zeroed" });
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

describe("its MCP server", () => {
  it("refuses what isn't a JSON-RPC request, or a call of one of its tools", async () => {
    const answer = async (body: unknown): Promise<unknown> => {
      const response = await stock.fetch(
        new Request("https://connector.internal/mcp", {
          method: "POST",
          body: JSON.stringify(body),
        })
      );
      return await response.json();
    };
    const requests = [
      [],
      { jsonrpc: "1.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: 1, method: 1 },
      { jsonrpc: "2.0", id: 1, method: "ping", params: [] },
    ];
    await expect(Promise.all(requests.map(answer))).resolves.toStrictEqual(
      requests.map(() => ({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "Not a JSON-RPC request" },
      }))
    );
    const calls = [
      { name: "stock.nothing" },
      { name: "stock.get", arguments: null },
      { name: "stock.get", arguments: [] },
      { name: "stock.get", arguments: { sku: "a" }, _meta: "find" },
    ];
    await expect(
      Promise.all(
        calls.map(
          async (params) =>
            await answer({
              jsonrpc: "2.0",
              id: 7,
              method: "tools/call",
              params,
            })
        )
      )
    ).resolves.toStrictEqual(
      calls.map(() => ({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32_602, message: "No such tool" },
      }))
    );
  });
});
