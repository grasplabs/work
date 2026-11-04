import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { resetStorage } from "./reset-storage.ts";
import { testBinding } from "./test-env.ts";

// Migration 0214 (GRA-1552), on a database as workflow stores left it:
// what a workflow's store was reached by goes with it, so nothing names a
// store nobody owns (an operation binding or its approval, a permission
// nobody can revoke), the store itself is deleted rather than handed to
// whoever published the workflow, and an App's store and the guard that
// keeps removed Apps out stay as they were.

const migrations = z
  .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
  .parse(testBinding("CORE_MIGRATIONS"));

/** Whether migration `name` comes before 0214. */
const before = ({ name }: { name: string }): boolean =>
  name < "0214_workflow_stores_removed";

/** Runs each of `statements`, with values bound in order. */
const run = async (...statements: [string, ...unknown[]][]): Promise<void> => {
  await env.DB.batch(
    statements.map(([query, ...values]) =>
      env.DB.prepare(query).bind(...values)
    )
  );
};

/** One value of `query`'s first row, or undefined. */
const one = async (query: string, ...values: unknown[]): Promise<unknown> =>
  await env.DB.prepare(query)
    .bind(...values)
    .first("v");

describe("migration 0214, removing workflow stores", () => {
  it("deletes a workflow's store and whatever reached it, and leaves an App's store and its guard", async () => {
    await resetStorage();
    await applyD1Migrations(env.DB, migrations.filter(before));
    const now = Date.now();
    await run(
      [
        "INSERT INTO workflow_resources (id, name, owner_id, current_version, created_at) VALUES ('owner', 'owner', 'ada', 1, ?), ('consumer', 'consumer', 'ada', 1, ?)",
        now,
        now,
      ],
      [
        "INSERT INTO business_stores (id, owner_id, physical_namespace_role, created_at) VALUES ('wf-store', 'ada', 'data_store', ?), ('app-store', 'ada', 'data_store', ?)",
        now,
        now,
      ],
      [
        "INSERT INTO sdk_store_owners (store_id, app_id, workflow_id, claimed_at) VALUES ('wf-store', NULL, 'owner', ?), ('app-store', 'app', NULL, ?)",
        now,
        now,
      ],
      [
        "INSERT INTO workflow_stores (workflow_id, name, store_id, created_at) VALUES ('owner', 'orders', 'wf-store', ?)",
        now,
      ],
      [
        "INSERT INTO sdk_resource_bindings (resource_id, resource_version, alias, kind, target_id, schema_hash, manifest_hash) VALUES ('owner', 1, 'store:orders', 'store', 'wf-store', 'schema', 'manifest')",
      ],
      [
        "INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id, actions, binding, status, requested_by, requested_at) VALUES ('grant', 'workflow', 'consumer', 'store', 'wf-store', '[\"orders:list\"]', 'orders', 'active', 'ada', ?), ('app-grant', 'workflow', 'consumer', 'store', 'app-store', '[\"notes:list\"]', 'notes', 'active', 'ada', ?)",
        now,
        now,
      ],
      [
        "INSERT INTO workflow_binding_approvals (id, workflow_resource_id, alias, kind, contract_id, fingerprint, target, reviewed_version, status, approved_by, approved_at) VALUES ('approval', 'consumer', 'orders', 'operation', 'acme.orders@1', 'print', '{}', 1, 'active', 'ada', ?)",
        now,
      ],
      [
        "INSERT INTO sdk_resource_bindings (resource_id, resource_version, alias, kind, target_id, target_version, target_path, approval_id, contract_id, schema_hash, manifest_hash) VALUES ('consumer', 1, 'orders', 'operation', 'wf-store', 1, 'orders:list', 'approval', 'acme.orders@1', 'print', 'manifest')",
      ]
    );

    await applyD1Migrations(env.DB, migrations);

    expect({
      storeDeleted:
        (await one(
          "SELECT deleted_at IS NOT NULL AS v FROM business_stores WHERE id = 'wf-store'"
        )) === 1,
      appStoreLive:
        (await one(
          "SELECT deleted_at IS NULL AS v FROM business_stores WHERE id = 'app-store'"
        )) === 1,
      owners: await one(
        "SELECT group_concat(store_id || '=' || app_id) AS v FROM sdk_store_owners"
      ),
      storeBindings: await one(
        "SELECT count(*) AS v FROM sdk_resource_bindings WHERE kind = 'store'"
      ),
      // The consumer's binding is unresolved again, as a revocation leaves it.
      operation: await env.DB.prepare(
        "SELECT target_id, target_version, target_path, approval_id FROM sdk_resource_bindings WHERE kind = 'operation'"
      ).first(),
      approval: await one(
        "SELECT status AS v FROM workflow_binding_approvals WHERE id = 'approval'"
      ),
      permissions: await one(
        "SELECT group_concat(id) AS v FROM permissions ORDER BY id"
      ),
      guard: await one(
        "SELECT count(*) AS v FROM sqlite_master WHERE type = 'trigger' AND name = 'sdk_store_owners_removed_app_insert'"
      ),
    }).toStrictEqual({
      storeDeleted: true,
      appStoreLive: true,
      owners: "app-store=app",
      storeBindings: 0,
      operation: {
        target_id: "acme.orders@1",
        target_version: null,
        target_path: null,
        approval_id: null,
      },
      approval: "revoked",
      permissions: "app-grant",
      guard: 1,
    });
  });
});
