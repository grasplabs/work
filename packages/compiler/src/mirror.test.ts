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
      "/me": {
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/files/{id}:download": {
        servers: [{ url: "https://files.example.test" }],
        get: {
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/lookup": {
        servers: [{ url: "https://files.example.test" }],
        get: {
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
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

  it("is named from its one write, read before or after it, on the spec's server", () => {
    const operation = spec.operations.find(
      ({ name }) => name === "deals.update"
    );
    const update = (routes: string[]): MirrorTool => ({
      name: "deals.update",
      routes,
      args: operation?.args.kind === "object" ? operation.args.fields : {},
      returns: operation?.returns ?? v.null().descriptor,
    });
    expect(
      messages([
        update(["GET /deals", "PATCH /deals/{id}"]),
        update(["PATCH /deals/{id}", "GET /deals"]),
        update(["GET /me", "PATCH /deals/{id}"]),
        update(["PATCH /deals/{id}", "GET elsewhere.example.test/deals"]),
        update(["GET /lookup", "PATCH /deals/{id}"]),
        update(["GET /files/{id}:download", "PATCH /deals/{id}"]),
      ])
    ).toStrictEqual([
      "deals.update: GET elsewhere.example.test/deals isn't on the spec's host api.example.test.",
      "deals.update: GET /lookup isn't an operation of the vendor's spec.",
      "deals.update: GET /files/{id}:download isn't an operation of the vendor's spec.",
    ]);
  });

  it("is refused a route the spec doesn't have, or one on another host", () => {
    expect(
      messages([
        dealsList({
          name: "deals.archived.list",
          routes: ["GET /deals/archived"],
        }),
        dealsList({ routes: ["GET /deals", "GET /persons"] }),
        dealsList({ routes: ["GET elsewhere.example.test/deals"] }),
      ])
    ).toStrictEqual([
      "deals.archived.list: GET /deals/archived isn't an operation of the vendor's spec.",
      "deals.list: GET /persons isn't an operation of the vendor's spec.",
      "deals.list: GET elsewhere.example.test/deals isn't on the spec's host api.example.test.",
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
          tool("deals.get", "GET /v1users/deals/{id}"),
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
      "deals.get: GET /v1users/deals/{id} is named v1users.deals.get.",
      "deals.get: It declares no route it is named from.",
    ]);
  });

  it("is never named by a version in its path", () => {
    const listed = page(v.object({ id: v.number() }));
    expect(
      messages(
        [
          tool(
            "gmail.users.messages.list",
            "GET /gmail/v1/users/{mailbox}/messages",
            listed
          ),
          tool(
            "calendar.calendars.events.get",
            "GET /calendar/v3/calendars/{calendar}/events/{event}"
          ),
          tool("spreadsheets.get", "GET /v4/spreadsheets/{spreadsheet}"),
          tool("deals.get", "GET /v1.0/deals/{id}"),
          tool("deals.create", "POST /v2beta1/deals"),
          tool("views.get", "GET /views/{id}"),
          tool("vbeta.get", "GET /vbeta/{id}"),
          tool("v2alpha.get", "GET /v2alpha/{id}"),
          tool("drive.getContent", "GET /drive/v3/root:/{name}:/content"),
        ],
        false
      )
    ).toStrictEqual([]);
  });

  it("is named from its one write, read before it of any family on the connector's hosts", () => {
    const writing = (name: string, routes: string[]): MirrorTool => ({
      ...tool(name, routes[0] ?? ""),
      routes,
    });
    expect(
      messages(
        [
          writing("deals.update", [
            "GET /me",
            "GET /pipelines/{pipeline}",
            "PATCH /deals/{id}",
          ]),
          writing("deals.delete", ["DELETE /deals/{id}", "PATCH /deals/{id}"]),
          writing("deals.get", ["GET /deals/{id}", "HEAD /deals"]),
        ],
        false
      )
    ).toStrictEqual([
      "deals.delete: It declares 2 writes, and a tool sends one.",
      "deals.get: HEAD /deals isn't a GET, as a tool's other routes are.",
    ]);
  });

  it("takes the vendor's operation name only where the rule can't read its path", () => {
    expect(
      messages(
        [
          tool("drive.getContent", "GET /drive/root:/{name}:/content"),
          tool(
            "drives.root.search",
            "GET /drives/{drive}/root/search(q='{q}')"
          ),
          tool(
            "drives.items.workbook.tables.rows.itemAt.range.update",
            "PATCH /drives/{drive}/items/{workbook}/workbook/tables/{table}/rows/itemAt(index={index})/range"
          ),
          tool(
            "me.chats.messages.list",
            "GET /me/chats/19:{chat}/messages",
            page(v.object({ id: v.string() }))
          ),
          {
            ...tool("me.drive.root.content.upload", ""),
            routes: [
              "GET /me",
              "GET /me/drive/root:/{folder}/{name}",
              "GET /me/chats/19:{chat}",
              "PUT /me/drive/root:/{folder}/{name}:/content",
            ],
          },
          tool("deals.getDeal", "GET /deals/{id}"),
          tool("deals.get", "GET /2.0/deals/{id}"),
          tool("deals.delete", "DELETE /{collection}/{id}"),
          tool("drive.get", "DELETE /drive/root:/{name}:"),
          tool("content", "GET /drive/root:/{name}:/content"),
          tool(
            "drives.list",
            "GET /drives/{drive}/root/search(q='{q}')",
            page(v.object({ id: v.string() }))
          ),
          tool("me.drive.get", "GET /me/drive/root:/{folder}/{name}"),
          tool("drive.children.list", "GET /drive/root:/{name}:/children"),
          tool(
            "me.chats.listMessages",
            "GET /me/chats/19:{chat}/messages",
            page(v.object({ id: v.string() }))
          ),
        ],
        false
      )
    ).toStrictEqual([
      "deals.getDeal: GET /deals/{id} is named deals.get.",
      "deals.get: The segment \"2.0\" of /2.0/deals/{id} can't be part of a tool's name.",
      "deals.delete: /{collection}/{id} names no collection.",
      "drive.get: DELETE /drive/root:/{name}: is named drive.<the vendor's operation name>.",
      "content: GET /drive/root:/{name}:/content is named drive.<the vendor's operation name>.",
      "drives.list: GET /drives/{drive}/root/search(q='{q}') is named drives.<the vendor's operation name>.",
      "me.drive.get: GET /me/drive/root:/{folder}/{name} is named me.drive.<the vendor's operation name>.",
      "drive.children.list: A list answers page(item): { items, next }.",
      "me.chats.listMessages: GET /me/chats/19:{chat}/messages is named me.chats.messages.list.",
    ]);
  });
});
