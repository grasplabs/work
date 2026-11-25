import { v } from "@grasp-os/runtime/app";
import type { ValueDescriptor } from "@grasp-os/runtime/app";
import { describe, expect, it } from "vite-plus/test";

import { checkMirror } from "./mirror.ts";
import type { MirrorTool } from "./mirror.ts";
import { readSpec } from "./openapi.ts";

// The mirror rule: every tool named from its route, and, where the
// vendor's spec is known, held to it field by field. The tools are built
// with `v`, as a connector's definition declares them.

const spec = await readSpec(
  JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Deals", version: "2" },
    servers: [{ url: "https://api.example.test/api/v2" }],
    paths: {
      "/deals": {
        get: {
          operationId: "getDeals",
          parameters: [
            { name: "pipeline_id", in: "query", schema: { type: "integer" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["id"],
                          properties: {
                            id: { type: "integer" },
                            title: { type: "string" },
                            stage_id: { type: ["integer", "null"] },
                          },
                        },
                      },
                      additional_data: {
                        type: "object",
                        properties: {
                          next_cursor: { type: ["string", "null"] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/deals/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
        ],
        patch: {
          operationId: "updateDeal",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    value: { type: "number" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { success: { type: "boolean" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  }),
  "https://developers.example.test/openapi.json"
);

const shape = (fields: Record<string, { descriptor: ValueDescriptor }>) =>
  Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, field.descriptor])
  );

const page = (item: Parameters<typeof v.array>[0]) =>
  v.object({ items: v.array(item), next: v.string().nullable() }).descriptor;

const dealsList = (changes: Partial<MirrorTool> = {}): MirrorTool => ({
  name: "deals.list",
  routes: ["GET /deals"],
  args: shape({
    pipeline_id: v.number().integer().optional(),
    cursor: v.string().optional(),
  }),
  returns: page(
    v.object({
      id: v.number().integer(),
      stage_id: v.number().integer().nullable().optional(),
    })
  ),
  ...changes,
});

const messages = (tools: MirrorTool[], withSpec = true) =>
  checkMirror(tools, withSpec ? spec : undefined).map(
    (problem) => `${problem.tool}: ${problem.message}`
  );

describe("a tool held to the vendor's spec", () => {
  it("passes as the generator made it", () => {
    const generated = spec.operations.map((operation) => ({
      name: operation.name,
      routes: [`${operation.method} ${operation.path}`],
      args: operation.args.kind === "object" ? operation.args.fields : {},
      returns: operation.returns,
    }));
    expect(generated.map((tool) => tool.name)).toStrictEqual([
      "deals.list",
      "deals.update",
    ]);
    expect(messages(generated)).toStrictEqual([]);
  });

  it("may be narrowed: fewer arguments, a fixed set of values, fewer fields", () => {
    expect(
      messages([
        dealsList({
          args: shape({ status: v.enum(["open", "won"]).optional() }),
          returns: page(v.object({ id: v.number().integer() })),
        }),
      ])
    ).toStrictEqual([]);
  });

  it("is refused a renamed argument or field", () => {
    expect(
      messages([
        dealsList({
          args: shape({ pipelineId: v.number().integer().optional() }),
        }),
        dealsList({
          returns: page(
            v.object({
              id: v.number().integer(),
              stageId: v.number().integer().nullable().optional(),
            })
          ),
        }),
      ])
    ).toStrictEqual([
      "deals.list: args.pipelineId isn't a field of the vendor's: keep the vendor's names and shapes.",
      "deals.list: returns.items[].stageId isn't a field of the vendor's: keep the vendor's names and shapes.",
    ]);
  });

  it("is refused a reshaped argument or answer", () => {
    expect(
      messages([
        dealsList({ args: shape({ pipeline_id: v.string().optional() }) }),
        dealsList({
          returns: page(
            v.object({
              id: v.number().integer(),
              stage_id: v.number().integer().optional(),
            })
          ),
        }),
        dealsList({
          returns: page(
            v.object({ id: v.number().integer(), title: v.string() })
          ),
        }),
        dealsList({
          returns: v.object({
            data: v.array(v.object({ id: v.number().integer() })),
          }).descriptor,
        }),
        {
          name: "deals.update",
          routes: ["PATCH /deals/{id}"],
          args: shape({
            id: v.number().integer(),
            deal: v.object({ title: v.string() }),
          }),
          returns: v.object({ success: v.boolean().optional() }).descriptor,
        },
      ])
    ).toStrictEqual([
      "deals.list: args.pipeline_id doesn't keep the vendor's type.",
      "deals.list: returns.items[].stage_id isn't nullable, but the vendor's answer may be null.",
      "deals.list: returns.items[].title is required, but the vendor's answer may leave it out.",
      "deals.list: A list answers page(item): { items, next }.",
      "deals.update: args.deal isn't a field of the vendor's: keep the vendor's names and shapes.",
    ]);
  });

  it("is refused a name or a path parameter that doesn't follow from its route", () => {
    expect(
      messages([
        dealsList({ name: "deals.fetch" }),
        {
          name: "deals.update",
          routes: ["PATCH /deals/{deal_id}"],
          args: shape({ deal_id: v.number().integer() }),
          returns: v.object({}).descriptor,
        },
      ])
    ).toStrictEqual([
      "deals.fetch: GET /deals is named deals.list.",
      "deals.update: Its route renames the vendor's path parameters: /deals/{id}.",
      "deals.update: args.deal_id isn't a field of the vendor's: keep the vendor's names and shapes.",
    ]);
  });
});

const tool = (
  name: string,
  route: string,
  returns = v.object({ id: v.number() }).descriptor
): MirrorTool => ({
  name,
  routes: [route],
  args: {},
  returns,
});

describe("a tool with no spec to hold it to", () => {
  it("is named from its route", () => {
    const listed = page(v.object({ id: v.number() }));
    expect(
      messages(
        [
          tool("deals.list", "GET /deals", listed),
          tool("deals.get", "GET /deals/{id}"),
          tool("deals.create", "POST /deals"),
          tool("deals.update", "PUT /deals/{id}"),
          tool("deals.delete", "DELETE /deals/{id}"),
          tool("deals.followers.list", "GET /deals/{id}/followers", listed),
          tool(
            "deals.products.deleteManyDealProducts",
            "DELETE /deals/{id}/products"
          ),
          tool("deals.search.searchDeals", "GET /deals/search"),
        ],
        false
      )
    ).toStrictEqual([]);
  });

  it("is refused any other name", () => {
    expect(
      messages(
        [
          tool("deals.fetch", "GET /deals/{id}"),
          tool("pipedrive.deals.get", "GET /deals/{id}"),
          tool("deals.list", "GET /deals/{id}"),
          tool("deals.list", "GET /deals"),
          tool("deals.products.delete", "DELETE /deals/{id}/products"),
          tool("deals.change", "PATCH /deals/{id}"),
          tool("deals.get", "GET /v1/deals/{id}"),
          {
            name: "deals.get",
            routes: [],
            args: {},
            returns: v.null().descriptor,
          },
        ],
        false
      )
    ).toStrictEqual([
      "deals.fetch: GET /deals/{id} is named deals.get.",
      "pipedrive.deals.get: GET /deals/{id} is named deals.get.",
      "deals.list: GET /deals/{id} is named deals.get.",
      "deals.list: A list answers page(item): { items, next }.",
      "deals.list: GET /deals is named deals.<the vendor's operation name>.",
      "deals.list: A list answers page(item): { items, next }.",
      "deals.products.delete: DELETE /deals/{id}/products is named deals.products.<the vendor's operation name>.",
      "deals.change: PATCH /deals/{id} is named deals.update.",
      "deals.get: GET /v1/deals/{id} is named v1.deals.get.",
      "deals.get: It declares no route it is named from.",
    ]);
  });
});
