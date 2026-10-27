import type { Role } from "@grasp-os/shared/roles";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { Acting } from "../src/auth/identity.ts";
import { deleteStore, shareStore } from "../src/data-stores.ts";
import {
  candidateBuildOf,
  createWorkflowResource,
  getWorkflowResource,
  liveWorkflow,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { allEvents } from "./audit-events.ts";
import { outcome, unique } from "./sign-in.ts";

// The stores a standalone workflow declares (GRA-682 slice 3,
// workflow-stores.ts), from its threat model: a store is created only by
// a publication, by a builder who isn't staff; a publication run again or
// raced never mints a second store for one name; a schema its records
// don't fit never lands; and nobody manages the store around its
// workflow.

/** A member of the organization in `role`, as their session has them. */
const person = async (role: Role, staff = false): Promise<Acting> => {
  const userId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('organization', 'Acme', 'acme', ?)"
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Person", `${userId}@acme.test`, Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, ?, ?)"
    ).bind(crypto.randomUUID(), userId, role, Date.now()),
  ]);
  return { userId, role, teams: [], staff };
};

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

const wholeTotal = { type: "integer", minimum: 0 };

/** The `orders` table, with `extra` fields beside its own. */
const orders = (
  extra: Record<string, unknown> = {},
  total: unknown = wholeTotal
) => ({
  schema: {
    type: "object",
    properties: { customer: { type: "string" }, total, ...extra },
    required: ["customer", "total"],
    additionalProperties: false,
  },
  indexes: { byCustomer: ["customer"] },
});

/** A definition of workflow `name` at `version` declaring `stores`. */
const definitionOf = (
  name: string,
  version: string,
  stores: Record<string, unknown>
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
          bindings: {},
          stores,
        },
      },
    },
    input: { schema: objectSchema({}) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [{ finish: { set: { status: "done" } } }],
  });

/** One store, `intake`, of `table`, with a get and an insert. */
const intake = (table: unknown) => ({
  intake: {
    tables: { orders: table },
    operations: {
      getOrder: { kind: "get", table: "orders" },
      addOrder: { kind: "insert", table: "orders" },
    },
  },
});

/** The stores workflow `id` has, by name, and each one's owner claim. */
const storesOf = async (id: string) => {
  const { results } = await env.DB.prepare(
    `SELECT named.name, named.store_id AS storeId, owner.workflow_id AS owner,
       owner.app_id AS app, live.deleted_at AS deletedAt
     FROM workflow_stores AS named
     LEFT JOIN sdk_store_owners AS owner ON owner.store_id = named.store_id
     LEFT JOIN business_stores AS live ON live.id = named.store_id
     WHERE named.workflow_id = ? ORDER BY named.name`
  )
    .bind(id)
    .all<{
      name: string;
      storeId: string;
      owner: string | null;
      app: string | null;
      deletedAt: number | null;
    }>();
  return results;
};

/** The store bindings of version `version` of workflow `id`. */
const bindingsOf = async (id: string, version: number) => {
  const { results } = await env.DB.prepare(
    `SELECT alias, target_id AS storeId, target_version AS storeVersion
     FROM sdk_resource_bindings
     WHERE resource_id = ? AND resource_version = ? AND kind = 'store'`
  )
    .bind(id, version)
    .all<{ alias: string; storeId: string; storeVersion: number }>();
  return results;
};

/** When the first store of workflow `id` was deleted, or null. */
const deletedAtOf = async (id: string): Promise<number | null> => {
  const [first] = await storesOf(id);
  return first?.deletedAt ?? null;
};

const newWorkflow = async (by: Acting) => {
  const name = `intake-${unique()}`;
  const workflow = await createWorkflowResource(env, by, name);
  return { id: workflow.id, name };
};

describe("stores a workflow declares", () => {
  it("are created by the publication that first declares them, owned by the workflow, and kept for the next version", async () => {
    const ada = await person("builder");
    const { id, name } = await newWorkflow(ada);
    const first = await publishWorkflowVersion(env, ada, id, {
      definition: definitionOf(name, "1.0.0", intake(orders())),
      basedOn: null,
    });
    const created = await storesOf(id);
    // A safe expansion: an optional field more.
    const second = await publishWorkflowVersion(env, ada, id, {
      definition: definitionOf(
        name,
        "1.1.0",
        intake(orders({ note: { type: "string" } }))
      ),
      basedOn: first.version,
    });
    const events = await allEvents();
    const kept = await storesOf(id);
    const current = await getWorkflowResource(env, ada, id);
    const storeId = created[0]?.storeId ?? "";

    expect({
      created: created.map(({ name: store, owner, app }) => ({
        store,
        owner,
        app,
      })),
      kept: kept.map(({ storeId: same }) => same),
      firstBinds: await bindingsOf(id, first.version),
      secondBinds: await bindingsOf(id, second.version),
      current: current.currentVersion,
      createdEvents: events.filter(
        ({ action, target }) =>
          action === "store.created" && target?.id === storeId
      ).length,
    }).toStrictEqual({
      created: [{ store: "intake", owner: id, app: null }],
      kept: [storeId],
      firstBinds: [{ alias: "store:intake", storeId, storeVersion: 1 }],
      secondBinds: [{ alias: "store:intake", storeId, storeVersion: 2 }],
      current: second.version,
      createdEvents: 1,
    });
  });

  it("mint one store for a name however often or concurrently the publication runs, and none for a test run", async () => {
    const ada = await person("builder");
    const { id, name } = await newWorkflow(ada);
    const definition = definitionOf(name, "1.0.0", intake(orders()));
    const workflow = await liveWorkflow(env, id);
    if (workflow === undefined) {
      throw new Error("No workflow");
    }
    // A test run builds the definition as a publication would, and
    // creates nothing.
    await candidateBuildOf(env, ada, workflow, definition, {});
    const afterTestRun = await storesOf(id);
    const raced = await Promise.all([
      outcome(
        publishWorkflowVersion(env, ada, id, { definition, basedOn: null })
      ),
      outcome(
        publishWorkflowVersion(env, ada, id, { definition, basedOn: null })
      ),
    ]);
    // Run again after it landed: the same version, and the same store.
    const again = await publishWorkflowVersion(env, ada, id, {
      definition,
      basedOn: null,
    });

    const stores = await storesOf(id);

    expect({
      afterTestRun,
      raced,
      again: again.version,
      stores: stores.length,
    }).toStrictEqual({
      afterTestRun: [],
      raced: ["ok", "ok"],
      again: 1,
      stores: 1,
    });
  });

  it("are never created for Grasp staff, and a schema the records don't fit never lands", async () => {
    const ada = await person("builder");
    const staff = await person("admin", true);
    const { id, name } = await newWorkflow(staff);
    const byStaff = await outcome(
      publishWorkflowVersion(env, staff, id, {
        definition: definitionOf(name, "1.0.0", intake(orders())),
        basedOn: null,
      })
    );
    const other = await newWorkflow(ada);
    const first = await publishWorkflowVersion(env, ada, other.id, {
      definition: definitionOf(other.name, "1.0.0", intake(orders())),
      basedOn: null,
    });
    // `total` becomes text: the records it has may not fit.
    const narrowed = await outcome(
      publishWorkflowVersion(env, ada, other.id, {
        definition: definitionOf(
          other.name,
          "2.0.0",
          intake(orders({}, { type: "string" }))
        ),
        basedOn: first.version,
      })
    );

    const staffStores = await storesOf(id);
    const kept = await getWorkflowResource(env, ada, other.id);

    expect({
      byStaff,
      staffStores,
      narrowed,
      current: kept.currentVersion,
    }).toStrictEqual({
      byStaff: "role.forbidden",
      staffStores: [],
      narrowed: "migration.required",
      current: first.version,
    });
  });

  it("can't be managed as a store around the workflow: not by its creator, never shared, and not deleted while a version binds it", async () => {
    const ada = await person("builder");
    const admin = await person("admin");
    const { id, name } = await newWorkflow(ada);
    await publishWorkflowVersion(env, ada, id, {
      definition: definitionOf(name, "1.0.0", intake(orders())),
      basedOn: null,
    });
    const [store] = await storesOf(id);
    const storeId = store?.storeId ?? "";
    const share = { type: "person", id: admin.userId };

    expect({
      creatorDeletes: await outcome(deleteStore(env, ada, storeId)),
      creatorShares: await outcome(shareStore(env, ada, storeId, share)),
      adminShares: await outcome(shareStore(env, admin, storeId, share)),
      adminDeletes: await outcome(deleteStore(env, admin, storeId)),
      stillThere: await deletedAtOf(id),
    }).toStrictEqual({
      creatorDeletes: "data.store_unavailable",
      creatorShares: "data.store_unavailable",
      adminShares: "data.store_managed_by_workflow",
      adminDeletes: "data.store_bound",
      stillThere: null,
    });
  });
});
