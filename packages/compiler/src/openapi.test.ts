import { v } from "@grasp-os/runtime/app";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vite-plus/test";

import { generateConnector } from "./openapi-source.ts";
import { readSpec, SpecError } from "./openapi.ts";

// The OpenAPI generator, as pure logic: a spec in, tools and source out.
// The specs are small stand-ins written as Pipedrive's v2 spec is (its
// envelopes, its cursor), plus the hostile ones a vendor, or someone
// posing as one, could hand the generator.

const url = "https://developers.example.test/openapi.json";

const Deal = {
  type: "object",
  properties: {
    id: { type: "integer" },
    title: { type: "string" },
    pipeline_id: { type: "integer" },
    status: { type: "string", enum: ["open", "won", "lost", "deleted"] },
    update_time: { type: "string", nullable: true },
  },
};

const ok = (schema: unknown) => ({
  "200": { description: "ok", content: { "application/json": { schema } } },
});

const envelope = (data: unknown) =>
  ok({
    allOf: [
      { type: "object", properties: { success: { type: "boolean" } } },
      {
        type: "object",
        properties: {
          data,
          additional_data: {
            type: "object",
            properties: { next_cursor: { type: "string", nullable: true } },
          },
        },
      },
    ],
  });

const idParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "integer" },
};

const pipedrivePaths = {
  "/deals": {
    get: {
      operationId: "getDeals",
      summary: "Get all deals",
      security: [{ api_key: [] }, { oauth2: ["deals:read"] }],
      parameters: [
        { name: "pipeline_id", in: "query", schema: { type: "integer" } },
        {
          name: "ids",
          in: "query",
          style: "form",
          explode: false,
          schema: { type: "array", items: { type: "integer" } },
        },
        { name: "cursor", in: "query", schema: { type: "string" } },
      ],
      responses: envelope({ type: "array", items: Deal }),
    },
    post: {
      operationId: "addDeal",
      security: [{ oauth2: ["deals:full"] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string" },
                value: { type: "number" },
              },
            },
          },
        },
      },
      responses: ok({ type: "object", properties: { data: Deal } }),
    },
  },
  "/deals/{id}": {
    parameters: [idParameter],
    get: {
      operationId: "getDeal",
      responses: ok({ type: "object", properties: { data: Deal } }),
    },
    patch: {
      operationId: "updateDeal",
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                stage_id: { type: "integer" },
              },
            },
          },
        },
      },
      responses: ok({ type: "object", properties: { data: Deal } }),
    },
    delete: {
      operationId: "deleteDeal",
      responses: { "204": { description: "gone" } },
    },
  },
  "/deals/{id}/followers": {
    parameters: [idParameter],
    get: {
      operationId: "getDealFollowers",
      responses: envelope({
        type: "array",
        items: { type: "object", properties: { user_id: { type: "integer" } } },
      }),
    },
  },
  "/deals/{id}/products": {
    parameters: [idParameter],
    delete: {
      operationId: "deleteManyDealProducts",
      responses: { "200": { description: "ok" } },
    },
  },
};

const specText = (
  paths: unknown,
  extra: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    openapi: "3.0.1",
    info: { title: "Deals", version: "2.0.0" },
    servers: [{ url: "https://api.example.test/api/v2" }],
    components: {
      securitySchemes: {
        api_key: { type: "apiKey", name: "x-api-token", in: "header" },
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://oauth.example.test/oauth/authorize",
              tokenUrl: "https://oauth.example.test/oauth/token",
              scopes: {
                "deals:read": "Read deals",
                "deals:full": "Change deals",
              },
            },
          },
        },
      },
    },
    security: [{ oauth2: [] }],
    paths,
    ...extra,
  });

const operation = (
  summary: unknown,
  path: string,
  extra: Record<string, unknown> = {}
) => ({
  [path]: {
    get: {
      operationId: "listThings",
      summary,
      responses: ok({ type: "array", items: { type: "string" } }),
      ...extra,
    },
  },
});

/** The module's top-level statements, as oxc parses the generated source. */
const statements = (source: string) => {
  const parsed = parseSync("tools.gen.ts", source);
  expect(parsed.errors).toStrictEqual([]);
  return parsed.program.body.map((statement) => statement.type);
};

/** What generated source holds: imports, the spec's exports, schemas, tools. */
const sourceStatements = [
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportNamedDeclaration",
  "ExportNamedDeclaration",
  "ExportNamedDeclaration",
  "VariableDeclaration",
  "VariableDeclaration",
  "ExportNamedDeclaration",
];

/** The same, for a spec that names no sign-in. */
const sourceWithoutSignIn = sourceStatements.toSpliced(4, 1);

describe("a spec as tools", () => {
  it("makes one tool per operation, named from its route", async () => {
    const spec = await readSpec(specText(pipedrivePaths), url);
    expect(spec.operations.map((tool) => tool.name)).toStrictEqual([
      "deals.list",
      "deals.create",
      "deals.get",
      "deals.delete",
      "deals.update",
      "deals.followers.list",
      "deals.products.deleteManyDealProducts",
    ]);
    expect(spec.skipped).toStrictEqual([]);
    expect(spec.base).toBe("/api/v2");
    expect(spec.host).toBe("api.example.test");
  });

  it("keeps the vendor's names and pages a list as { items, next }", async () => {
    const spec = await readSpec(specText(pipedrivePaths), url);
    const list = spec.operations.find((tool) => tool.name === "deals.list");
    expect({
      path: list?.path,
      args: list?.args.kind === "object" && Object.keys(list.args.fields),
      ids: list?.parameters.find((parameter) => parameter.name === "ids"),
      items: list?.page?.items,
      next: list?.page?.next,
      item:
        list?.page?.item.kind === "object" &&
        Object.keys(list.page.item.fields),
      returns:
        list?.returns.kind === "object" && Object.keys(list.returns.fields),
    }).toStrictEqual({
      path: "/deals",
      args: ["pipeline_id", "ids", "cursor"],
      ids: { name: "ids", in: "query", separator: "," },
      items: ["data"],
      next: ["additional_data", "next_cursor"],
      item: ["id", "title", "pipeline_id", "status", "update_time"],
      returns: ["items", "next"],
    });
  });

  it("takes a body's fields as arguments beside the path's, and its scopes from the chosen sign-in", async () => {
    const spec = await readSpec(specText(pipedrivePaths), url);
    const create = spec.operations.find((tool) => tool.name === "deals.create");
    const update = spec.operations.find((tool) => tool.name === "deals.update");
    const deleted = spec.operations.find(
      (tool) => tool.name === "deals.delete"
    );
    expect({
      title:
        create?.args.kind === "object" && create.args.fields.title?.presence,
      args: update?.args.kind === "object" && Object.keys(update.args.fields),
      body: update?.body,
      auth: spec.auth?.kind,
      scopes: spec.operations.find((tool) => tool.name === "deals.list")
        ?.scopes,
      deleted: [deleted?.answer, deleted?.returns],
    }).toStrictEqual({
      title: "required",
      args: ["id", "title", "stage_id"],
      body: ["title", "stage_id"],
      auth: "oauth2",
      scopes: ["deals:read"],
      deleted: [undefined, v.object({}).descriptor],
    });
  });

  it("signs in with the scheme the connector picks, and refuses one it can't", async () => {
    const text = specText(pipedrivePaths, {
      security: [{ oauth2: [] }, { api_key: [] }],
    });
    const spec = await readSpec(text, url, "api_key");
    expect({
      auth: spec.auth,
      scopes: [...new Set(spec.operations.flatMap((tool) => tool.scopes))],
    }).toStrictEqual({
      auth: { kind: "apiKey", header: "x-api-token" },
      scopes: [],
    });
    await expect(readSpec(text, url, "basic")).rejects.toThrow(SpecError);
  });

  it("makes no tool of an operation whose arguments take keys no one names", async () => {
    const free = (schema: unknown) => ({
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { meta: schema } },
            },
          },
        },
        responses: ok({ type: "object", properties: {} }),
      },
    });
    const spec = await readSpec(
      specText({
        "/labels": free({
          type: "object",
          additionalProperties: { type: "string" },
        }),
        "/notes": free({
          type: "array",
          items: { type: "object", additionalProperties: { type: "integer" } },
        }),
      }),
      url
    );
    expect(spec.skipped.map((skipped) => skipped.operation)).toStrictEqual([
      "POST /labels",
      "POST /notes",
    ]);
  });

  it("makes no tool of an operation a connector can't call or send as the spec has it", async () => {
    const answered = { responses: ok({ type: "object", properties: {} }) };
    const body = (schema: unknown) => ({
      requestBody: {
        required: true,
        content: { "application/json": { schema } },
      },
      ...answered,
    });
    const spec = await readSpec(
      specText({
        "/deals": { options: answered, trace: answered },
        "/deals/{deal-id}": {
          get: {
            parameters: [{ ...idParameter, name: "deal-id" }],
            ...answered,
          },
        },
        "/notes": { post: body({ type: "array", items: { type: "string" } }) },
        "/labels": { post: body({ type: "object" }) },
        "/stages": {
          get: {
            responses: ok({
              type: "object",
              nullable: true,
              properties: { data: { type: "array", items: Deal } },
            }),
          },
        },
      }),
      url
    );
    expect(spec.operations).toStrictEqual([]);
    expect(spec.skipped).toStrictEqual([
      {
        operation: "OPTIONS /deals",
        reason: "Its method isn't one a connector may call.",
      },
      {
        operation: "TRACE /deals",
        reason: "Its method isn't one a connector may call.",
      },
      {
        operation: "GET /deals/{deal-id}",
        reason: "Its path isn't one a route may take.",
      },
      {
        operation: "POST /notes",
        reason: "Its body can't be typed as an object.",
      },
      {
        operation: "POST /labels",
        reason: "Its body can't be typed as an object.",
      },
      { operation: "GET /stages", reason: "Its answer isn't an object." },
    ]);
  });

  it("keeps a body's required fields required where the body itself is optional", async () => {
    const spec = await readSpec(
      specText({
        "/deals": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["title"],
                    properties: {
                      title: { type: "string" },
                      value: { type: "number" },
                    },
                  },
                },
              },
            },
            responses: ok({ type: "object", properties: {} }),
          },
        },
      }),
      url
    );
    const [create] = spec.operations;
    expect(
      create?.args.kind === "object" &&
        Object.entries(create.args.fields).map(([name, field]) => [
          name,
          field.presence,
        ])
    ).toStrictEqual([
      ["title", "required"],
      ["value", "optional"],
    ]);
  });

  it("reads an allOf of one schema as that schema, and an answer's enum as any value of its type", async () => {
    const spec = await readSpec(
      specText({
        "/deals/{id}": {
          parameters: [idParameter],
          get: {
            parameters: [
              {
                name: "status",
                in: "query",
                schema: { type: "string", enum: ["open", "won"] },
              },
            ],
            responses: ok({
              type: "object",
              properties: {
                visible_to: { allOf: [{ type: "integer", enum: [1, 3] }] },
                status: { type: "string", enum: ["open", "won"] },
              },
            }),
          },
        },
      }),
      url
    );
    const [get] = spec.operations;
    expect({
      status: get?.args.kind === "object" && get.args.fields.status?.kind,
      answer:
        get?.returns.kind === "object" &&
        Object.entries(get.returns.fields).map(([name, field]) => [
          name,
          field.kind,
        ]),
    }).toStrictEqual({
      status: "enum",
      answer: [
        ["visible_to", "number"],
        ["status", "string"],
      ],
    });
  });

  it("names no tool by a vendor's name that is a standard action", async () => {
    const spec = await readSpec(
      specText({
        "/deals/{id}/merge": {
          parameters: [idParameter],
          put: {
            operationId: "delete",
            responses: ok({ type: "object", properties: {} }),
          },
        },
      }),
      url
    );
    expect({
      tools: spec.operations,
      skipped: spec.skipped.map((each) => each.operation),
    }).toStrictEqual({ tools: [], skipped: ["PUT /deals/{id}/merge"] });
  });

  it("names two operations that would share a name by the vendor's operation names", async () => {
    const spec = await readSpec(
      specText({
        "/deals/{id}": {
          parameters: [idParameter],
          put: {
            operationId: "replaceDeal",
            responses: ok({
              type: "object",
              properties: { id: { type: "integer" } },
            }),
          },
          patch: {
            operationId: "updateDeal",
            responses: ok({
              type: "object",
              properties: { id: { type: "integer" } },
            }),
          },
        },
      }),
      url
    );
    expect(spec.operations.map((tool) => tool.name)).toStrictEqual([
      "deals.replaceDeal",
      "deals.updateDeal",
    ]);
    expect(spec.skipped).toStrictEqual([]);
  });

  it("writes source that records the spec's URL, its hash and the scheme it was read for", async () => {
    const text = specText(pipedrivePaths);
    const { source, spec } = await generateConnector(text, url);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(text)
    );
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(spec.sha256).toBe(hash);
    expect(source).toContain(
      `export const openapi = { url: ${JSON.stringify(url)}, sha256: "${hash}" } as const;`
    );
    expect(statements(source)).toStrictEqual(sourceStatements);
    const withKey = await generateConnector(text, url, { scheme: "api_key" });
    expect(withKey.source).toContain(
      `export const openapi = { url: ${JSON.stringify(url)}, sha256: "${hash}", scheme: "api_key" } as const;`
    );
  });

  it("reads Swagger 2.0 as OpenAPI 3.1", async () => {
    const spec = await readSpec(
      JSON.stringify({
        swagger: "2.0",
        info: { title: "Old", version: "1" },
        host: "api.example.test",
        basePath: "/v1",
        schemes: ["https"],
        paths: {
          "/deals/{id}": {
            get: {
              operationId: "getDeal",
              parameters: [
                { name: "id", in: "path", required: true, type: "integer" },
              ],
              responses: {
                "200": {
                  description: "ok",
                  schema: {
                    type: "object",
                    properties: { id: { type: "integer" } },
                  },
                },
              },
            },
          },
        },
      }),
      url
    );
    expect(
      spec.operations.map((tool) => `${tool.name} ${tool.path}`)
    ).toStrictEqual(["deals.get /deals/{id}"]);
    expect(spec.base).toBe("/v1");
  });
});

describe("a hostile spec", () => {
  it("can't write code through an operation name", async () => {
    const hostile = [
      'x"); globalThis.pwned = 1; ("',
      "constructor",
      "__proto__",
      "a.b",
      "x".repeat(200),
    ];
    const paths = Object.fromEntries(
      hostile.map((operationId, index) => [
        `/deals/{id}/thing${index}`,
        {
          parameters: [idParameter],
          delete: {
            operationId,
            responses: { "204": { description: "gone" } },
          },
        },
      ])
    );
    const { source, spec } = await generateConnector(specText(paths), url);
    expect(spec.operations).toStrictEqual([]);
    expect(spec.skipped).toHaveLength(hostile.length);
    expect(source).not.toContain("pwned");
    expect(statements(source)).toStrictEqual(sourceStatements);
  });

  it("can't write code through a description, a field or a scope", async () => {
    const quote = '"}); globalThis.pwned = 1; /*';
    const text = specText(
      {
        "/deals": {
          get: {
            summary: `*/ ${quote}\n</script>\u2028`,
            security: [{ oauth2: [quote] }],
            responses: ok({
              type: "array",
              items: {
                type: "object",
                properties: {
                  [quote]: { type: "string" },
                  ["__proto__"]: { type: "string" },
                  constructor: { type: "string" },
                  ["x".repeat(65)]: { type: "string" },
                  ok: { type: "string" },
                },
              },
            }),
          },
        },
      },
      {
        components: {
          securitySchemes: {
            oauth2: {
              type: "oauth2",
              flows: {
                authorizationCode: {
                  authorizationUrl: "https://oauth.example.test/authorize",
                  tokenUrl: "https://oauth.example.test/token",
                  scopes: { [quote]: quote },
                },
              },
            },
          },
        },
      }
    );
    const { source, spec } = await generateConnector(text, url);
    const [list] = spec.operations;
    expect(
      list?.page?.item.kind === "object" && Object.keys(list.page.item.fields)
    ).toStrictEqual([quote, "ok"]);
    expect(statements(source)).toStrictEqual(sourceStatements);
  });

  it("can't name a route outside the API or with what a path may not hold", async () => {
    const paths = [
      "/deals/../admin",
      "/deals/%2e%2e",
      "/deals?admin=1",
      "/deals#x",
      "/deals/{id}x",
      "/déals",
      "/deals//x",
      'deals"',
      "/deals/{id}/{id}",
      "/",
    ];
    for (const path of paths) {
      const text = specText({
        [path]: {
          delete: {
            operationId: "removeThing",
            responses: ok({ type: "string" }),
          },
        },
      });
      // oxlint-disable-next-line no-await-in-loop -- one spec at a time, each its own case
      const refused = await readSpec(text, url).then(
        (spec) => spec.operations.length === 0,
        (error: unknown) => error instanceof SpecError
      );
      expect({ path, refused }).toStrictEqual({ path, refused: true });
    }
  });

  it("stops at a recursive schema, one too deep and one that doubles at each level", async () => {
    const levels = 40;
    const schemas: Record<string, unknown> = {
      Node: {
        type: "object",
        properties: {
          id: { type: "integer" },
          child: { $ref: "#/components/schemas/Node" },
        },
      },
      Deep: { type: "object", properties: { id: { type: "integer" } } },
    };
    let deep: unknown = {
      type: "object",
      properties: { id: { type: "integer" } },
    };
    for (let level = 0; level < 100; level += 1) {
      deep = { type: "object", properties: { next: deep } };
    }
    schemas.Deep = deep;
    for (let level = 0; level < levels; level += 1) {
      const next =
        level === 0
          ? { type: "string" }
          : { $ref: `#/components/schemas/Wide${level - 1}` };
      schemas[`Wide${level}`] = {
        type: "object",
        properties: { left: next, right: next },
      };
    }
    const text = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Hostile", version: "1" },
      servers: [{ url: "https://api.example.test" }],
      components: { schemas },
      paths: {
        "/nodes/{id}": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          get: { responses: ok({ $ref: "#/components/schemas/Node" }) },
        },
        "/deep/{id}": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          get: { responses: ok({ $ref: "#/components/schemas/Deep" }) },
        },
        "/wide/{id}": {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          get: {
            responses: ok({ $ref: `#/components/schemas/Wide${levels - 1}` }),
          },
        },
      },
    });
    const started = performance.now();
    const { spec, source } = await generateConnector(text, url);
    expect(performance.now() - started).toBeLessThan(5000);
    const node = spec.operations.find((tool) => tool.name === "nodes.get");
    const child =
      node?.returns.kind === "object" ? node.returns.fields.child : undefined;
    expect(
      child?.kind === "object" &&
        Object.entries(child.fields).map(([name, field]) => [name, field.kind])
    ).toStrictEqual([
      ["id", "number"],
      ["child", "json"],
    ]);
    expect(spec.operations.map((tool) => tool.name)).toContain("deep.get");
    expect(spec.skipped).toStrictEqual([
      { operation: "GET /wide/{id}", reason: "Its schemas are too large." },
    ]);
    expect(statements(source)).toStrictEqual(sourceWithoutSignIn);
  });

  it("fetches nothing a reference points at", async () => {
    const fetched: unknown[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (input) => {
      fetched.push(input);
      throw new TypeError("no network");
    };
    try {
      const text = specText(
        operation("x", "/deals", {
          responses: ok({
            $ref: "https://169.254.169.254/latest/meta-data#/x",
          }),
        })
      );
      await expect(readSpec(text, url)).rejects.toBeInstanceOf(SpecError);
    } finally {
      globalThis.fetch = real;
    }
    expect(fetched).toStrictEqual([]);
  });

  it("refuses YAML that expands without end", async () => {
    const lines = [
      "openapi: 3.1.0",
      "info: { title: t, version: '1' }",
      "a0: &a0 [x, x, x, x, x, x, x, x, x, x]",
    ];
    for (let level = 1; level < 12; level += 1) {
      lines.push(
        `a${level}: &a${level} [${Array.from({ length: 10 }, () => `*a${level - 1}`).join(", ")}]`
      );
    }
    lines.push("paths: {}");
    const started = performance.now();
    await expect(readSpec(lines.join("\n"), url)).rejects.toBeInstanceOf(Error);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("refuses a server that isn't plain HTTPS, and a spec too large", async () => {
    const serving = async (server: string) =>
      await readSpec(
        specText(pipedrivePaths, { servers: [{ url: server }] }),
        url
      );
    await expect(serving("http://api.example.test")).rejects.toThrow(
      "plain HTTPS"
    );
    await expect(
      serving(["https://user", "secret@api.example.test"].join(":"))
    ).rejects.toThrow("plain HTTPS");
    await expect(serving("https://api.example.test/v1?key=1")).rejects.toThrow(
      "plain HTTPS"
    );
    await expect(serving("https://api.example.test/v1/%20x")).rejects.toThrow(
      "path no route may take"
    );
    await expect(
      readSpec(" ".repeat(16 * 1024 * 1024 + 1), url)
    ).rejects.toThrow("larger than 16 MiB");
  });

  it("signs in only through HTTPS addresses", async () => {
    const text = specText(pipedrivePaths, {
      components: {
        securitySchemes: {
          oauth2: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "data:text/html,x",
                tokenUrl: "http://oauth.example.test/token",
                scopes: {},
              },
            },
          },
        },
      },
      security: [{ oauth2: [] }],
    });
    const spec = await readSpec(text, url);
    expect(spec.auth).toBeUndefined();
  });
});
