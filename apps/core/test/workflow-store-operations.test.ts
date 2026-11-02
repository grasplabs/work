/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { declaredStoresOf } from "@grasp-os/open-workflow/stores";
import type { Json } from "@grasp-os/shared/json";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { documentMaxBytes } from "@grasp-os/shared/stores";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { appFor } from "../src/apps.ts";
import { openStore } from "../src/data-stores.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import {
  grantPermission,
  listPermissions,
  requestPermission,
  revokePermission,
} from "../src/permissions.ts";
import {
  approveWorkflowBinding,
  callApprovedStoreOperation,
} from "../src/workflow-bindings.ts";
import { publishCatalogContract } from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { commit } from "./pending-stores.ts";
import { person } from "./sealed-apps.ts";
import { outcome, unique } from "./sign-in.ts";
import { newRecordId } from "./store-schemas.ts";

// A standalone workflow's store, its generated operations called by
// another workflow (GRA-682 slice 4, workflow-store-operations.ts), from
// its threat model: served only through the consumer's own permission and
// approval, and only while the store holds its owner's current schema in
// force; never to the owner itself or to a restricted run; as the
// consumer's person, every record of the table reached; and a mutation
// replayed under its step's key written once.

type Person = Awaited<ReturnType<typeof person>>;

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** The owner's `orders` table, with `extra` fields beside its own. */
const orders = (extra: Record<string, unknown> = {}) => ({
  schema: {
    type: "object",
    properties: {
      customer: { type: "string" },
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
  ordersOf: { kind: "list", table: "orders", index: "byCustomer" },
  addOrder: { kind: "insert", table: "orders" },
  settle: { kind: "patch", table: "orders" },
};

/** A definition of workflow `name` at `version`: stores, bindings, tasks. */
const definitionOf = (
  name: string,
  version: string,
  grasp: { stores?: unknown; bindings?: unknown },
  tasks: unknown[] = [],
  input: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: grasp.bindings ?? {},
          ...(grasp.stores === undefined ? {} : { stores: grasp.stores }),
        },
      },
    },
    input: { schema: objectSchema(input) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [...tasks, { finish: { set: { status: "done" } } }],
  });

/** The owner workflow, its `intake` store published at 1.0.0. */
const ownerOf = async (ada: Person, table = orders()) => {
  const name = `intake-${unique()}`;
  const workflow = await createWorkflowResource(env, ada, name);
  const stores = { intake: { tables: { orders: table }, operations } };
  const definition = definitionOf(name, "1.0.0", { stores });
  await publishWorkflowVersion(env, ada, workflow.id, {
    definition,
    basedOn: null,
  });
  const { results } = await env.DB.prepare(
    "SELECT store_id AS storeId FROM workflow_stores WHERE workflow_id = ?"
  )
    .bind(workflow.id)
    .all<{ storeId: string }>();
  const declared = await declaredStoresOf(definition);
  const store = declared.get("intake");
  if (store === undefined || results[0] === undefined) {
    throw new Error("No store");
  }
  return { id: workflow.id, name, storeId: results[0].storeId, store };
};

type Owner = Awaited<ReturnType<typeof ownerOf>>;

/** A record ID the consumer's run is given, as its input. */
const idInput = {
  id: { type: "string", "x-grasp-value": { kind: "id", table: "orders" } },
};
const byInput = "${ $workflow.input.id }";

/** What each consumer's definition calls its operation with. */
const callsOf: Record<
  string,
  { arguments: unknown; input: Record<string, unknown> }
> = {
  addOrder: { arguments: { customer: "acme", total: 1 }, input: {} },
  getOrder: { arguments: { id: byInput }, input: idInput },
  ordersOf: {
    arguments: { where: { customer: "acme" }, pageSize: 10, cursor: null },
    input: {},
  },
  settle: { arguments: { id: byInput, set: { total: 1 } }, input: idInput },
};

const rolesOf = (by: Person) => ({
  app: async (named: string, role: "user" | "builder") =>
    await appFor(env, by, named, role),
  resource: async (
    ref: Parameters<typeof requireResourceRole>[2],
    needed: Parameters<typeof requireResourceRole>[3]
  ) => {
    await requireResourceRole(env, by, ref, needed);
  },
});

/** A store permission `admin` asks for and grants. */
const granted = async (
  admin: Person,
  request: Omit<PermissionRequest, "binding">
): Promise<string> => {
  const asked = await requestPermission(
    env,
    admin,
    {
      ...request,
      binding: `STORE_${unique().toUpperCase().replaceAll("-", "_")}`,
    },
    rolesOf(admin)
  );
  await grantPermission(env, admin, asked.id, { version: null });
  return asked.id;
};

/**
 * A consumer workflow with one operation binding, `orders`, of a catalog
 * contract of `path`'s exact shapes on `owner`'s store, its permission
 * granted and its binding approved: what its runs call through.
 */
const consumerOf = async (
  admin: Person,
  ada: Person,
  owner: Owner,
  path: string
) => {
  const operation = owner.store.operations.get(path)?.manifest;
  const key = `orders-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "operation",
    input: JSON.stringify(operation?.args),
    output: JSON.stringify(operation?.returns),
  });
  const name = `desk-${unique()}`;
  const workflow = await createWorkflowResource(env, ada, name);
  await publishWorkflowVersion(env, ada, workflow.id, {
    definition: definitionOf(
      name,
      "1.0.0",
      { bindings: { orders: { kind: "operation", contract: key } } },
      [
        {
          call: {
            call: "grasp.operation",
            with: { binding: "orders", arguments: callsOf[path]?.arguments },
          },
        },
      ],
      callsOf[path]?.input
    ),
    basedOn: null,
  });
  const permissionId = await granted(admin, {
    subject: { type: "workflow", workflowId: workflow.id },
    object: { type: "store", storeId: owner.storeId },
    actions: Object.keys(operations),
  });
  const approval = await approveWorkflowBinding(env, admin, workflow.id, {
    alias: "orders",
    target: {
      kind: "storeOperation",
      permissionId,
      operation: path,
      operationKind: operation?.kind === "query" ? "query" : "mutation",
    },
    reviewed: { version: 1 },
  });
  return { id: workflow.id, permissionId, approval };
};

type Consumer = Awaited<ReturnType<typeof consumerOf>>;

/** Calls `consumer`'s approved operation with `args`, as `by`'s run would. */
const called = async (
  consumer: Consumer,
  by: Person,
  args: Json,
  { key = `step-${unique()}`, restricted = false } = {}
) =>
  await callApprovedStoreOperation(
    env,
    {
      id: consumer.id,
      version: 1,
      approval: consumer.approval,
      restrictedRun: restricted ? crypto.randomUUID() : null,
    },
    args,
    {
      actor: { type: "person", userId: by.userId },
      principal: by.userId,
      requestId: crypto.randomUUID(),
      deadline: Date.now() + 30_000,
      idempotencyKey: key,
      runId: null,
    }
  );

const recordSchema = z.object({
  customer: z.string(),
  total: z.number(),
  _ownerId: z.string(),
});
const pageSchema = z.object({ items: z.array(z.unknown()) });

/** A record's own fields and its owner, as an operation answers it. */
const fieldsOf = (value: unknown) => {
  const { customer, total, _ownerId } = recordSchema.parse(value);
  return { customer, total, owner: _ownerId };
};

describe("a workflow's store, called by another workflow", () => {
  it("serves its generated operations through the consumer's own grant, over every record of the table, as the consumer's person", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const bob = await person("builder");
    const owner = await ownerOf(ada);
    const add = await consumerOf(admin, ada, owner, "addOrder");
    const get = await consumerOf(admin, ada, owner, "getOrder");
    const list = await consumerOf(admin, ada, owner, "ordersOf");
    const settle = await consumerOf(admin, ada, owner, "settle");
    const first = await called(add, ada, { customer: "acme", total: 10 });
    // Another person's record, which every operation reaches as well.
    await called(add, bob, { customer: "acme", total: 5 });
    await called(add, ada, { customer: "zeta", total: 7 });
    await called(settle, bob, { id: first, set: { total: 12 } });
    const read = await called(get, ada, { id: first });
    const page = await called(list, ada, {
      where: { customer: "acme" },
      pageSize: 10,
      cursor: null,
    });
    const events = await allEvents();

    expect({
      read: fieldsOf(read),
      listed: pageSchema.parse(page).items.map((item) => fieldsOf(item)),
      mutationsCalled: events.filter(
        ({ action, target }) =>
          action === "store.operation.called" && target?.id === owner.storeId
      ).length,
    }).toStrictEqual({
      // Inserted by Ada, settled by Bob: patched, still hers.
      read: { customer: "acme", total: 12, owner: ada.userId },
      listed: [
        { customer: "acme", total: 12, owner: ada.userId },
        { customer: "acme", total: 5, owner: bob.userId },
      ],
      mutationsCalled: 4,
    });
  });

  it("tells the admin reviewing its permission that each operation reaches every record of its table", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const owner = await ownerOf(ada);
    const add = await consumerOf(admin, ada, owner, "addOrder");
    const listed = await listPermissions(env, admin);
    const permission = listed.find(({ id }) => id === add.permissionId);

    expect(permission?.reach).toStrictEqual([
      { operation: "getOrder", table: "orders", changes: false },
      { operation: "ordersOf", table: "orders", changes: false },
      { operation: "addOrder", table: "orders", changes: true },
      { operation: "settle", table: "orders", changes: true },
    ]);
  });

  it("writes a mutation replayed under its step's key once, after a commit whose answer was lost", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const owner = await ownerOf(ada);
    const add = await consumerOf(admin, ada, owner, "addOrder");
    const list = await consumerOf(admin, ada, owner, "ordersOf");
    const key = `step-${unique()}`;
    // The commit landed; the step never heard, and runs again.
    const first = await called(
      add,
      ada,
      { customer: "acme", total: 1 },
      { key }
    );
    const replayed = await called(
      add,
      ada,
      { customer: "acme", total: 1 },
      { key }
    );
    const page = await called(list, ada, {
      where: { customer: "acme" },
      pageSize: 10,
      cursor: null,
    });

    expect({
      same: replayed === first,
      records: pageSchema.parse(page).items.length,
    }).toStrictEqual({ same: true, records: 1 });
  });

  it("serves nothing without the grant, to a restricted run, or to the owner itself", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const owner = await ownerOf(ada);
    const add = await consumerOf(admin, ada, owner, "addOrder");
    const restricted = await outcome(
      called(add, ada, { customer: "acme", total: 1 }, { restricted: true })
    );
    const ownSelf = await outcome(
      requestPermission(
        env,
        admin,
        {
          subject: { type: "workflow", workflowId: owner.id },
          object: { type: "store", storeId: owner.storeId },
          actions: ["addOrder"],
          binding: `STORE_${unique().toUpperCase().replaceAll("-", "_")}`,
        },
        rolesOf(admin)
      )
    );
    await revokePermission(env, admin, add.permissionId);
    const revoked = await outcome(
      called(add, ada, { customer: "acme", total: 1 })
    );
    const events = await allEvents();
    const refusals = events.filter(
      ({ action, target }) =>
        action === "store.operation.refused" && target?.id === owner.storeId
    );

    expect({
      restricted,
      ownSelf,
      revoked,
      restrictedRecorded: refusals.some(
        ({ detail }) => detail?.reason === "store.restricted_caller"
      ),
    }).toStrictEqual({
      restricted: "resource.unavailable",
      ownSelf: "permission.invalid",
      revoked: "resource.unavailable",
      restrictedRecorded: true,
    });
  });

  it("serves nothing while the store doesn't hold its owner's current schema in force, and nothing under a contract it no longer serves", async () => {
    const admin = await person("admin");
    const ada = await person("builder");
    const owner = await ownerOf(ada);
    const add = await consumerOf(admin, ada, owner, "addOrder");
    // A record whose document fits only without a default added later.
    const store = await openStore(env, owner.storeId);
    await commit(store, owner.store.schemaHash, [
      {
        op: "insert",
        table: "orders",
        id: newRecordId(),
        fields: { customer: "x".repeat(documentMaxBytes - 60), total: 1 },
      },
    ]);
    // Version 2 adds a defaulted field the store can't fill in for it.
    const definition = definitionOf(owner.name, "2.0.0", {
      stores: {
        intake: {
          tables: {
            orders: orders({ state: { type: "string", default: "open" } }),
          },
          operations,
        },
      },
    });
    await publishWorkflowVersion(env, ada, owner.id, {
      definition,
      basedOn: 1,
    });
    const declared = await declaredStoresOf(definition);
    const second = declared.get("intake");
    if (second === undefined) {
      throw new Error("No store");
    }
    // A consumer approved for version 2's contract, while its schema waits.
    const addSecond = await consumerOf(
      admin,
      ada,
      { ...owner, store: second },
      "addOrder"
    );

    expect({
      // Version 1's contract: no longer what the store serves.
      drifted: await outcome(called(add, ada, { customer: "acme", total: 1 })),
      pending: await outcome(
        called(addSecond, ada, { customer: "acme", total: 1 })
      ),
    }).toStrictEqual({
      drifted: "resource.unavailable",
      pending: "migration.pending",
    });
  });
});
