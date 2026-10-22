import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { defineConnector, defineTool, ToolError } from "../src/connector.ts";
import {
  connectorManifestSchema,
  effectAbsentMetaKey,
  effectKeyMetaKey,
  findMetaKey,
  generatedContracts,
  outcomeUnknownMetaKey,
  pathMatches,
  redirectHostMatches,
} from "../src/manifest.ts";
import type { Route } from "../src/manifest.ts";

// The connector contract, as a connector is defined: input parsed strictly
// all the way down, one declared resource property, and only requests to
// the connector's own hosts. A connector that breaks it doesn't build.

const route: Route = {
  method: "GET",
  host: "api.example.test",
  path: "/v1/items",
};

const toolWith = (input: z.ZodObject, resource?: string) =>
  defineTool({
    name: "items.list",
    description: "Lists items",
    input,
    output: z.strictObject({}),
    readOnly: true,
    resource,
    routes: [route],
    run: async () => await Promise.resolve({ output: {} }),
  });

const connectorWith = (
  fields: Partial<Parameters<typeof defineConnector>[0]>
) =>
  defineConnector({
    name: "example",
    version: "1.0.0",
    provider: "microsoft",
    scopes: [],
    hosts: ["api.example.test"],
    tools: [],
    ...fields,
  });

describe("a tool", () => {
  it("answers a file only when read-only, taking `as` and answering a file's fields, as the manifest then says", () => {
    const fileTool = (readOnly: boolean, output: z.ZodObject) =>
      defineTool({
        name: "files.read",
        description: "Reads a file",
        input: z.strictObject({
          id: z.string(),
          as: z.enum(["text", "base64"]),
        }),
        output,
        readOnly,
        answersFile: true,
        routes: [route],
        run: async () => await Promise.reject(new Error("Not run")),
      });
    const fileOutput = z.strictObject({
      name: z.string().nullable(),
      contentType: z.string().nullable(),
      encoding: z.enum(["text", "base64"]),
      content: z.string().nullable(),
    });
    expect(fileTool(true, fileOutput).action.answersFile).toBeTruthy();
    expect(() => fileTool(false, fileOutput)).toThrow(/answers a file/u);
    expect(() => fileTool(true, z.strictObject({ id: z.string() }))).toThrow(
      /answers a file/u
    );
  });

  it("takes strict input with a string resource property", () => {
    expect(() =>
      toolWith(
        z.strictObject({
          mailbox: z.string(),
          filter: z.strictObject({ from: z.string() }).optional(),
          ids: z.array(z.strictObject({ id: z.string() })).optional(),
        }),
        "mailbox"
      )
    ).not.toThrow();
  });

  it("can't take input that drops or passes through unknown keys, at any depth", () => {
    const loose = [
      z.object({ mailbox: z.string() }),
      z.looseObject({ mailbox: z.string() }),
      z.strictObject({
        mailbox: z.string(),
        options: z.object({ a: z.string() }),
      }),
      z.strictObject({
        mailbox: z.string(),
        extra: z.record(z.string(), z.string()),
      }),
      z.strictObject({
        mailbox: z.string(),
        items: z.array(z.looseObject({ id: z.string() })),
      }),
      z.strictObject({
        mailbox: z.string(),
        target: z.union([z.string(), z.object({ mailbox: z.string() })]),
      }),
      z.strictObject({ mailbox: z.string() }).catchall(z.string()),
      // Anything at all, where a second selector could hide.
      z.strictObject({ mailbox: z.string(), opts: z.unknown() }),
      z.strictObject({ mailbox: z.string(), opts: z.any() }),
      z.strictObject({ mailbox: z.string(), opts: z.array(z.any()) }),
      z.strictObject({
        mailbox: z.string(),
        opts: z.tuple([z.string()]).rest(z.any()),
      }),
      z.strictObject({
        mailbox: z.string(),
        opts: z.union([z.string(), z.unknown()]),
      }),
    ];
    for (const input of loose) {
      expect(() => toolWith(input)).toThrow("strict");
    }
  });

  it("takes closed tuples, literals, enums and nullable values", () => {
    expect(() =>
      toolWith(
        z.strictObject({
          pair: z.tuple([z.string(), z.number()]),
          kind: z.enum(["a", "b"]),
          one: z.literal(1),
          maybe: z.string().nullable(),
        })
      )
    ).not.toThrow();
  });

  it("names as its resource only one of its own string properties", () => {
    const input = z.strictObject({
      mailbox: z.string(),
      top: z.number(),
      target: z.strictObject({ mailbox: z.string() }),
    });
    for (const resource of [
      "top",
      "target",
      "target.mailbox",
      "sharedMailbox",
    ]) {
      expect(() => toolWith(input, resource)).toThrow("resource");
    }
  });

  it("reports an error with a code callers can act on, when it has one", async () => {
    const failing = (error: Error) =>
      defineTool({
        name: "items.list",
        description: "Lists items",
        input: z.strictObject({}),
        output: z.strictObject({}),
        readOnly: true,
        routes: [route],
        run: () => {
          throw error;
        },
      });
    await expect(
      failing(
        new ToolError("Throttled", { code: "throttled", retryAfterSeconds: 7 })
      ).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "Throttled" }],
      structuredContent: {
        error: {
          message: "Throttled",
          code: "throttled",
          retryAfterSeconds: 7,
        },
      },
      isError: true,
    });
    await expect(
      failing(new ToolError("No such item")).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "No such item" }],
      isError: true,
    });
    // Any other error says nothing of itself.
    await expect(
      failing(new Error("token=abc")).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "The action failed" }],
      isError: true,
    });
  });

  it("says a write whose outcome it can't tell is of unknown outcome, never that it failed", async () => {
    const writing = (error: Error) =>
      defineTool({
        name: "items.create",
        description: "Creates an item",
        input: z.strictObject({}),
        output: z.strictObject({}),
        readOnly: false,
        routes: [{ ...route, method: "POST" }],
        run: () => {
          throw error;
        },
      });
    await expect(
      writing(
        new ToolError("Example answered 502", {
          code: "failed",
          outcomeUnknown: true,
        })
      ).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "Example answered 502" }],
      structuredContent: {
        error: { message: "Example answered 502", code: "failed" },
      },
      isError: true,
      _meta: { [outcomeUnknownMetaKey]: true },
    });
    // An error the tool didn't foresee may have come after its write.
    await expect(
      writing(new Error("token=abc")).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "The action's outcome is unknown" }],
      isError: true,
      _meta: { [outcomeUnknownMetaKey]: true },
    });
    // What it refused itself, before sending anything, failed.
    await expect(
      writing(new ToolError("Name a label", { code: "invalid" })).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "Name a label" }],
      structuredContent: {
        error: { message: "Name a label", code: "invalid" },
      },
      isError: true,
    });
  });

  it("can't say both that it did nothing and that its outcome is unknown", () => {
    expect(
      () =>
        new ToolError("Throttled", { notPerformed: true, outcomeUnknown: true })
    ).toThrow(Error);
  });
});

describe("a tool's recovery", () => {
  const key = "a".repeat(64);
  const writeRoute: Route = { ...route, method: "POST" };

  /** A writing tool, recording the effect keys its run and find were given. */
  const writer = (
    recovery: { repeatable?: true; find?: "found" | "absent" | "throttled" },
    seen: (string | null)[] = []
  ) =>
    defineTool({
      name: "items.create",
      description: "Creates an item",
      input: z.strictObject({}),
      output: z.strictObject({ id: z.string() }),
      readOnly: false,
      routes: [route, writeRoute],
      run: async (_input, effect) => {
        seen.push(effect.key);
        return await Promise.resolve({ output: { id: "made" } });
      },
      ...(recovery.repeatable === true ? { repeatable: true } : {}),
      ...(recovery.find === undefined
        ? {}
        : {
            find: async (_input: object, effect: { key: string }) => {
              seen.push(`find:${effect.key}`);
              if (recovery.find === "throttled") {
                // As `providerFetch` reports a 429 to the lookup's GET.
                throw new ToolError("Rate limited", {
                  code: "throttled",
                  notPerformed: true,
                });
              }
              return await Promise.resolve(
                recovery.find === "found" ? { output: { id: "found" } } : null
              );
            },
          }),
    });

  it("is declared in the manifest: none, repeat or find, and nothing for a read", () => {
    expect(
      [writer({}), writer({ repeatable: true }), writer({ find: "found" })].map(
        ({ action }) => action.recovery
      )
    ).toStrictEqual(["none", "repeat", "find"]);
    expect(toolWith(z.strictObject({})).action.recovery).toBe("none");
    expect(() =>
      defineTool({
        name: "items.list",
        description: "Lists items",
        input: z.strictObject({}),
        output: z.strictObject({}),
        readOnly: true,
        repeatable: true,
        routes: [route],
        run: async () => await Promise.resolve({ output: {} }),
      })
    ).toThrow(Error);
  });

  it("finds its effect only by a GET of its own", () => {
    const finder = writer({ find: "found" });
    expect(() =>
      connectorWith({
        tools: [
          { ...finder, action: { ...finder.action, routes: [writeRoute] } },
        ],
      })
    ).toThrow(Error);
  });

  it("gives run the call's effect key, and nothing that isn't one", async () => {
    const seen: (string | null)[] = [];
    const tool = writer({}, seen);
    await tool.call({}, { [effectKeyMetaKey]: key });
    await tool.call({}, { [effectKeyMetaKey]: "not-a-key" });
    await tool.call({});
    expect(seen).toStrictEqual([key, null, null]);
  });

  it("looks the effect up instead of running when asked: found, or certainly absent", async () => {
    const seen: (string | null)[] = [];
    const asked = { [effectKeyMetaKey]: key, [findMetaKey]: true };
    const found = await writer({ find: "found" }, seen).call({}, asked);
    const absent = await writer({ find: "absent" }, seen).call({}, asked);
    // A tool that can't find, or a lookup without a key: it can't tell.
    const cannot = await writer({}, seen).call({}, asked);
    const keyless = await writer({ find: "found" }, seen).call(
      {},
      {
        [findMetaKey]: true,
      }
    );
    // A lookup that failed says nothing of the effect, even when the GET
    // did nothing: never "absent", nor "did nothing" for the call.
    const throttled = await writer({ find: "throttled" }, seen).call({}, asked);
    expect({ found, absent, cannot, keyless, throttled, seen }).toMatchObject({
      found: { structuredContent: { id: "found" } },
      absent: { isError: true, _meta: { [effectAbsentMetaKey]: true } },
      cannot: { isError: true },
      keyless: { isError: true },
      throttled: { isError: true },
      seen: [`find:${key}`, `find:${key}`, `find:${key}`],
    });
    expect([cannot._meta, keyless._meta, throttled._meta]).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("a connector", () => {
  it("sends requests only to its own hosts", () => {
    expect(() =>
      connectorWith({
        tools: [
          defineTool({
            name: "items.list",
            description: "Lists items",
            input: z.strictObject({}),
            output: z.strictObject({}),
            readOnly: true,
            routes: [{ ...route, host: "evil.test" }],
            run: async () => await Promise.resolve({ output: {} }),
          }),
        ],
      })
    ).toThrow("Every route's host must be one of the connector's hosts");
  });

  it("lists only exact DNS names as hosts", () => {
    for (const host of [
      "API.example.test",
      "api.example.test:443",
      "127.0.0.1",
      "localhost",
      "*.example.test",
      "user@api.example.test",
    ]) {
      expect(() => connectorWith({ hosts: [host] })).toThrow("pattern");
    }
  });

  it("declares no batch endpoint", () => {
    for (const path of [
      "/v1.0/$batch",
      "/batch/gmail/v1",
      "/v1/$BATCH",
      "/v1/Batch",
      "/v1/$batch{id}",
      "/v1/batch{id}",
    ]) {
      expect(() =>
        connectorWith({
          tools: [
            defineTool({
              name: "items.list",
              description: "Lists items",
              input: z.strictObject({}),
              output: z.strictObject({}),
              readOnly: true,
              routes: [{ ...route, path }],
              run: async () => await Promise.resolve({ output: {} }),
            }),
          ],
        })
      ).toThrow("Not a path template");
    }
  });

  it("declares each route by its method, host, path and redirects alone", () => {
    const withRoute = (extra: Record<string, unknown>) =>
      connectorManifestSchema.parse({
        name: "example",
        version: "1.0.0",
        provider: "microsoft",
        scopes: [],
        hosts: ["api.example.test"],
        actions: {
          "items.list": {
            routes: [{ ...route, ...extra }],
            readOnly: true,
            recovery: "none",
            resource: null,
            input: [],
            contract: { input: { type: "object" }, output: { type: "object" } },
          },
        },
      });
    expect(() => withRoute({})).not.toThrow();
    // Nothing a route declares is silently dropped: the egress holds a
    // request to its method and path, nothing more.
    for (const extra of [
      { query: { driveId: "{drive}" } },
      { check: { path: "/v1/items/{item}" } },
    ]) {
      expect(() => withRoute(extra)).toThrow("Unrecognized key");
    }
  });

  it("writes at most once", () => {
    const withWrites = (methods: Route["method"][], readOnly: boolean) =>
      connectorWith({
        tools: [
          defineTool({
            name: "items.move",
            description: "Moves an item",
            input: z.strictObject({}),
            output: z.strictObject({}),
            readOnly,
            routes: methods.map((method, index) => ({
              ...route,
              method,
              path: `/v1/items/${index}`,
            })),
            run: async () => await Promise.resolve({ output: {} }),
          }),
        ],
      });
    expect(() => withWrites(["GET", "HEAD", "POST"], false)).not.toThrow();
    expect(() => withWrites(["GET", "POST", "DELETE"], false)).toThrow(
      "at most one write"
    );
  });

  it("follows a redirect only from a GET, to hosts one label under a named one", () => {
    const withRoute = (extra: Partial<Route>) =>
      connectorWith({
        tools: [
          defineTool({
            name: "items.read",
            description: "Reads an item",
            input: z.strictObject({}),
            output: z.strictObject({}),
            readOnly: true,
            routes: [{ ...route, ...extra }],
            run: async () => await Promise.resolve({ output: {} }),
          }),
        ],
      });
    expect(() => withRoute({ redirects: ["*.sharepoint.com"] })).not.toThrow();
    expect(() =>
      withRoute({ method: "POST", redirects: ["*.sharepoint.com"] })
    ).toThrow("Only a GET");
    for (const pattern of [
      "sharepoint.com",
      "*.com",
      "*.*.sharepoint.com",
      "*.SharePoint.com",
      "*sharepoint.com",
      "*.sharepoint.com:443",
    ]) {
      expect(() => withRoute({ redirects: [pattern] })).toThrow(
        "Not a redirect host"
      );
    }
  });

  it("describes a call by its tools' own input properties, each once", () => {
    // Typed loosely, as `toolWith` takes it: a described property is
    // otherwise held to the input's own by its type.
    const input: z.ZodObject = z.strictObject({
      to: z.string(),
      body: z.string(),
    });
    const described = (fields: { label: string; input: string }[]) =>
      connectorWith({
        tools: [
          defineTool({
            name: "items.send",
            description: "Sends an item",
            input,
            output: z.strictObject({}),
            readOnly: false,
            routes: [{ ...route, method: "POST" }],
            describe: { title: "Send an item", fields },
            run: async () => await Promise.resolve({ output: {} }),
          }),
        ],
      });
    const fields = [
      { label: "To", input: "to" },
      { label: "Body", input: "body" },
    ];
    expect(
      described(fields).manifest.actions["items.send"]?.describe
    ).toStrictEqual({
      title: "Send an item",
      fields,
    });
    for (const broken of [
      [{ label: "To", input: "recipient" }],
      [...fields, { label: "Again", input: "to" }],
      [],
    ]) {
      expect(() => described(broken)).toThrow(z.ZodError);
    }
  });

  it("has one tool per name", () => {
    const tool = toolWith(z.strictObject({}));
    expect(() => connectorWith({ tools: [tool, tool] })).toThrow("Two tools");
  });
});

describe("a redirect host", () => {
  it("stands for exactly one DNS label under its host", () => {
    for (const host of [
      "example.sharepoint.com",
      "example-my.sharepoint.com",
    ]) {
      expect(redirectHostMatches("*.sharepoint.com", host)).toBeTruthy();
    }
    for (const host of [
      "sharepoint.com",
      ".sharepoint.com",
      "evilsharepoint.com",
      "a.b.sharepoint.com",
      "example.sharepoint.com.evil.test",
      "-example.sharepoint.com",
    ]) {
      expect(redirectHostMatches("*.sharepoint.com", host)).toBeFalsy();
    }
  });
});

describe("a route's path", () => {
  const template = "/v1/users/{mailbox}/messages";

  it("matches only its own segments, with one segment for each parameter", () => {
    expect(
      pathMatches(template, "/v1/users/a%40acme.test/messages")
    ).toBeTruthy();
    for (const path of [
      "/v1/users/messages",
      "/v1/users/a/b/messages",
      "/v1/users//messages",
      "/v1/users/a/messages/",
      "/v1/Users/a/messages",
      "/v1/users/a/messages/x",
    ]) {
      expect(pathMatches(template, path)).toBeFalsy();
    }
  });

  it("takes no parameter that decodes to more than plain text", () => {
    for (const segment of [
      "..",
      "%2e%2e",
      "a%2Fb",
      "a%5Cb",
      "%",
      ".",
      "%252e%252e%252f",
      "a%00b",
      "a%0D%0Ab",
      "a%7Fb",
      "..;",
      "a;x=y",
      "a%3Fb",
      "a%23b",
      "a:b",
      "a%3Ab",
      "batch",
      "%24batch",
      "$BATCH",
    ]) {
      expect(
        pathMatches(template, `/v1/users/${segment}/messages`)
      ).toBeFalsy();
    }
  });

  it("binds a parameter to a value, where it is given one", () => {
    const values = { mailbox: "a@acme.test" };
    expect(
      pathMatches(template, "/v1/users/a%40acme.test/messages", values)
    ).toBeTruthy();
    expect(
      pathMatches(template, "/v1/users/b%40acme.test/messages", values)
    ).toBeFalsy();
  });

  it("takes a parameter inside literal text only as declared", () => {
    const search = "/v1/drives/{drive}/root/search(q='{query}')";
    // Inside literal text, a value is neither a dot segment nor a batch
    // endpoint, so those words may be searched for.
    for (const query of ["invoice", "invoice%202026", "it''s", "batch", ".."]) {
      expect(
        pathMatches(search, `/v1/drives/d-1/root/search(q='${query}')`)
      ).toBeTruthy();
    }
    for (const segment of [
      "search(q='')",
      "search(q='a%2Fb')",
      "search(q='a:b')",
      "search(q='a%25')",
      // A quote only comes doubled, as OData escapes it.
      "search(q='a'')",
      "search(q='a'%20or%20'b')",
      "search(q='%27')",
      "search(q=a)",
      "search(q='a')x",
      "find(q='a')",
      "search(q=')",
    ]) {
      expect(pathMatches(search, `/v1/drives/d-1/root/${segment}`)).toBeFalsy();
    }
  });

  it("takes a literal suffix only as declared", () => {
    const custom = "/v1/files/{id}:batchUpdate";
    expect(pathMatches(custom, "/v1/files/f-1:batchUpdate")).toBeTruthy();
    for (const path of [
      "/v1/files/f-1",
      "/v1/files/f-1:delete",
      "/v1/files/f-1%3AbatchUpdate",
      "/v1/files/:batchUpdate",
      "/v1/files/a:b:batchUpdate",
    ]) {
      expect(pathMatches(custom, path)).toBeFalsy();
    }
  });
});

describe("generated contracts", () => {
  const toolNamed = (name: string) =>
    defineTool({
      name,
      description: "A tool",
      input: z.strictObject({}),
      output: z.strictObject({}),
      readOnly: true,
      routes: [route],
      run: async () => await Promise.resolve({ output: {} }),
    });

  it("group a connector's tools by family, each action named after it", () => {
    const { manifest } = connectorWith({
      tools: [
        toolNamed("items.list"),
        toolNamed("items.get"),
        toolNamed("people.find"),
        // No family, or an action name a declaration can't list: in no
        // contract, so neither served by connect nor in the SDK's catalog.
        toolNamed("ping"),
        toolNamed("items.archive.all"),
      ],
    });
    expect(
      Object.fromEntries(
        [...generatedContracts(manifest)].map(([contract, actions]) => [
          contract,
          Object.fromEntries(
            [...actions].map(([action, { tool }]) => [action, tool])
          ),
        ])
      )
    ).toStrictEqual({
      "example.items@1": { list: "items.list", get: "items.get" },
      "example.people@1": { find: "people.find" },
    });
  });
});
