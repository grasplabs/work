import { describe, expect, it } from "vite-plus/test";

import { declaredStoresOf } from "../src/stores.ts";
import { validateWorkflow } from "../src/validate.ts";
import { documentAround, options } from "./fixtures.ts";

// The stores a standalone workflow declares (GRA-682), through the
// profile's one entry point. How it can fail: a schema accepted here that
// a store's host would refuse (or the other way round), an operation that
// reaches past its table or isn't one of the generated kinds, a contract
// whose fingerprint doesn't follow its table, and a refusal that repeats
// the definition's text.

const orderTable = (extra: Record<string, unknown> = {}) => ({
  schema: {
    type: "object",
    properties: {
      customer: { type: "string", minLength: 1 },
      total: { type: "integer", minimum: 0 },
      ...extra,
    },
    required: ["customer", "total"],
    additionalProperties: false,
  },
  indexes: { byCustomer: ["customer"] },
});

const operations = {
  getOrder: { kind: "get", table: "orders" },
  ordersByCustomer: { kind: "list", table: "orders", index: "byCustomer" },
  allOrders: { kind: "list", table: "orders" },
  addOrder: { kind: "insert", table: "orders" },
  "orders.update": { kind: "patch", table: "orders" },
};

/** A workflow that declares `stores` and does nothing else. */
const declaring = (stores: unknown) => {
  const definition = documentAround(
    { name: "order-intake", input: {}, required: [] },
    [{ finish: { set: { status: "done" } } }]
  );
  return JSON.stringify({
    ...definition,
    document: {
      ...definition.document,
      metadata: {
        grasp: { ...definition.document.metadata.grasp, stores },
      },
    },
  });
};

const validated = async (stores: unknown) =>
  await validateWorkflow(declaring(stores), options);

/** Each refusal's code and pointer: what an editor or an agent acts on. */
const refusals = async (stores: unknown) => {
  const result = await validated(stores);
  return result.ok
    ? []
    : result.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ code, pointer }) => ({ code, pointer }));
};

/** A store of `orders` (and `extra` tables), with one operation. */
const storeOf = (orders: unknown, extra: Record<string, unknown> = {}) => ({
  intake: {
    tables: { orders, ...extra },
    operations: { getOrder: { kind: "get", table: "orders" } },
  },
});

const storesPointer = "/document/metadata/grasp/stores";

/**
 * A store of one table whose field is `arrays` arrays deep around a
 * string, with every generated kind over it.
 */
const nested = (arrays: number) => {
  let deep: Record<string, unknown> = { type: "string" };
  for (let level = 0; level < arrays; level += 1) {
    deep = { type: "array", items: deep };
  }
  return {
    intake: {
      tables: {
        orders: {
          schema: {
            type: "object",
            properties: { lines: deep },
            required: ["lines"],
            additionalProperties: false,
          },
          indexes: {},
        },
      },
      operations: {
        getOrder: { kind: "get", table: "orders" },
        addOrder: { kind: "insert", table: "orders" },
        allOrders: { kind: "list", table: "orders" },
        "orders.update": { kind: "patch", table: "orders" },
      },
    },
  };
};

describe("stores a workflow declares", () => {
  it("checks a store's tables as a store's host does, and derives each generated operation's contract from its table", async () => {
    const result = await validated({
      intake: { tables: { orders: orderTable() }, operations },
    });
    if (!result.ok) {
      throw new Error("The store was refused");
    }
    const store = result.workflow.stores.get("intake");
    const contract = (path: string) => {
      const manifest = store?.operations.get(path)?.manifest;
      return {
        kind: manifest?.kind,
        visibility: manifest?.visibility,
        args: Object.keys(
          manifest?.args.kind === "object" ? manifest.args.fields : {}
        ).toSorted(),
        orders: manifest?.tables.orders,
      };
    };

    expect({
      tables: Object.keys(store?.manifest.tables ?? {}),
      access: store?.manifest.tables.orders?.access,
      indexes: store?.manifest.tables.orders?.indexes,
      hash: /^[0-9a-f]{64}$/u.test(store?.schemaHash ?? ""),
      fingerprinted: Object.keys(store?.fingerprints ?? {}).toSorted(),
      get: contract("getOrder"),
      byCustomer: contract("ordersByCustomer"),
      all: contract("allOrders"),
      insert: contract("addOrder"),
      patch: contract("orders.update"),
    }).toStrictEqual({
      tables: ["orders"],
      // Its members are only the consumers its generated operations serve.
      access: { read: "appMembers", write: "appMembers" },
      indexes: { byCustomer: { fields: ["customer"] } },
      hash: true,
      fingerprinted: Object.keys(operations).toSorted(),
      get: {
        kind: "query",
        visibility: "public",
        args: ["id"],
        orders: { read: true, insert: false, update: false, delete: false },
      },
      byCustomer: {
        kind: "query",
        visibility: "public",
        args: ["cursor", "pageSize", "where"],
        orders: { read: true, insert: false, update: false, delete: false },
      },
      all: {
        kind: "query",
        visibility: "public",
        args: ["cursor", "pageSize"],
        orders: { read: true, insert: false, update: false, delete: false },
      },
      insert: {
        kind: "mutation",
        visibility: "public",
        args: ["customer", "total"],
        orders: { read: false, insert: true, update: false, delete: false },
      },
      patch: {
        kind: "mutation",
        visibility: "public",
        args: ["id", "set"],
        orders: { read: true, insert: false, update: true, delete: false },
      },
    });
  });

  it("changes an operation's fingerprint exactly when its table's fields change", async () => {
    const sealed = async (table: unknown) => {
      const result = await validated({
        intake: { tables: { orders: table }, operations },
      });
      return result.ok ? result.workflow.stores.get("intake") : undefined;
    };
    const base = await sealed(orderTable());
    const reordered = await sealed({
      indexes: { byCustomer: ["customer"] },
      schema: {
        additionalProperties: false,
        required: ["total", "customer"],
        properties: {
          total: { minimum: 0, type: "integer" },
          customer: { minLength: 1, type: "string" },
        },
        type: "object",
      },
    });
    const widened = await sealed(orderTable({ note: { type: "string" } }));

    expect({
      sameWhateverTheOrder: reordered?.fingerprints,
      sameHash: reordered?.schemaHash === base?.schemaHash,
      changed: Object.keys(operations).filter(
        (path) => widened?.fingerprints[path] !== base?.fingerprints[path]
      ),
      hashChanged: widened?.schemaHash !== base?.schemaHash,
    }).toStrictEqual({
      sameWhateverTheOrder: base?.fingerprints,
      sameHash: true,
      // A list's `where` is the index's fields alone, but its page holds
      // whole records: every operation shows the new field.
      changed: Object.keys(operations),
      hashChanged: true,
    });
  });

  it("refuses an operation that isn't a generated kind over a declared table and index, pointing at it", async () => {
    const intake = (ops: Record<string, unknown>) => ({
      intake: { tables: { orders: orderTable() }, operations: ops },
    });
    const at = (path: string, key?: string) =>
      `${storesPointer}/intake/operations/${path}${key === undefined ? "" : `/${key}`}`;

    expect({
      script: await refusals(
        intake({ run: { kind: "get", table: "orders", code: "x" } })
      ),
      kind: await refusals(
        intake({ drop: { kind: "delete", table: "orders" } })
      ),
      table: await refusals(intake({ get: { kind: "get", table: "users" } })),
      index: await refusals(
        intake({ list: { kind: "list", table: "orders", index: "byTotal" } })
      ),
      indexOnGet: await refusals(
        intake({ get: { kind: "get", table: "orders", index: "byCustomer" } })
      ),
      path: await refusals(intake({ "a/b": { kind: "get", table: "orders" } })),
      none: await refusals(intake({})),
    }).toStrictEqual({
      script: [
        { code: "profile.unknown_property", pointer: at("run", "code") },
      ],
      kind: [{ code: "profile.invalid_value", pointer: at("drop", "kind") }],
      table: [{ code: "profile.invalid_value", pointer: at("get", "table") }],
      index: [{ code: "profile.invalid_value", pointer: at("list", "index") }],
      indexOnGet: [
        { code: "profile.invalid_value", pointer: at("get", "index") },
      ],
      path: [{ code: "profile.invalid_value", pointer: at("a~1b") }],
      none: [
        {
          code: "profile.too_many",
          pointer: `${storesPointer}/intake/operations`,
        },
      ],
    });
  });

  it("refuses, pointing at it, an operation whose page or set would nest a deep table past the limits, never throwing", async () => {
    // A field `arrays` arrays deep around a string. At 30, the deepest
    // table the limits take, a list's page and a patch's arguments both
    // wrap it past them; one level less, only the page does.
    const at = (path: string) => ({
      code: "profile.invalid_value",
      pointer: `${storesPointer}/intake/operations/${path}`,
    });

    expect({
      deepest: await refusals(nested(30)),
      shallower: await refusals(nested(29)),
    }).toStrictEqual({
      deepest: [at("allOrders"), at("orders.update")],
      shallower: [at("allOrders")],
    });
  });

  it("refuses tables a store's host would refuse, without repeating their names", async () => {
    const managedName = await validated(
      storeOf(orderTable({ _rev: { type: "string" } }))
    );
    const tablesAt = `${storesPointer}/intake/tables`;

    expect({
      managed: await refusals(
        storeOf(orderTable({ _rev: { type: "string" } }))
      ),
      unindexable: await refusals(
        storeOf({ ...orderTable(), indexes: { byNothing: ["missing"] } })
      ),
      danglingId: await refusals(
        storeOf(
          orderTable({
            owner: {
              type: "string",
              "x-grasp-value": { kind: "id", table: "people" },
            },
          })
        )
      ),
      notAnObject: await refusals(storeOf({ schema: { type: "string" } })),
      openObject: await refusals(
        storeOf({ schema: { type: "object", properties: {} } })
      ),
      name: await refusals({
        Intake: {
          tables: { orders: orderTable() },
          operations: { getOrder: { kind: "get", table: "orders" } },
        },
      }),
      quiet: managedName.ok
        ? []
        : managedName.diagnostics.filter(({ message, remedy, reason }) =>
            `${message} ${remedy} ${reason ?? ""}`.includes("_rev")
          ),
    }).toStrictEqual({
      managed: [{ code: "schema.invalid", pointer: tablesAt }],
      unindexable: [{ code: "schema.invalid", pointer: tablesAt }],
      danglingId: [{ code: "schema.invalid", pointer: tablesAt }],
      notAnObject: [
        { code: "schema.invalid", pointer: `${tablesAt}/orders/schema` },
      ],
      openObject: [
        {
          code: "schema.open_object",
          pointer: `${tablesAt}/orders/schema/additionalProperties`,
        },
      ],
      name: [
        { code: "profile.invalid_value", pointer: `${storesPointer}/Intake` },
      ],
      quiet: [],
    });
  });

  it("reads a sealed definition's stores again exactly as validation sealed them", async () => {
    const definition = declaring({
      intake: { tables: { orders: orderTable() }, operations },
    });
    const result = await validateWorkflow(definition, options);
    const sealed = result.ok ? result.workflow.stores.get("intake") : undefined;
    const declared = await declaredStoresOf(definition);
    const reread = declared.get("intake");
    const changed = definition.replace('"get"', '"delete"');

    expect({
      schemaHash: reread?.schemaHash,
      fingerprints: reread?.fingerprints,
      changed: await declaredStoresOf(changed).then(
        () => "read",
        () => "refused"
      ),
    }).toStrictEqual({
      schemaHash: sealed?.schemaHash,
      fingerprints: sealed?.fingerprints,
      changed: "refused",
    });
  });

  it("declares no store when a definition has none", async () => {
    const definition = documentAround(
      { name: "order-intake", input: {}, required: [] },
      [{ finish: { set: { status: "done" } } }]
    );
    const result = await validateWorkflow(JSON.stringify(definition), options);

    expect(result.ok ? result.workflow.stores.size : -1).toBe(0);
  });
});
