import {
  createCatalogBudget,
  resolveContract,
} from "@grasp-os/open-workflow/catalog";
import type { CatalogContract } from "@grasp-os/open-workflow/catalog";
import { actorOf } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  catalogBindingKinds,
  catalogContractSchema,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  CatalogBindingKind,
  CatalogContractEntry,
} from "@grasp-os/shared/workflow-resources";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { workflowCatalogContracts } from "./db/core/schema.ts";
import { inList, isUniqueViolation } from "./db/d1.ts";
import { requireMemberAdmin, stillAdminSql } from "./permissions.ts";

// The host catalog of contracts independent workflows bind besides each
// other (platform specification 13.2): operation, connector, model,
// decision and event contracts, each a key and the SDK descriptors of
// what a call passes and returns, or of each event type's data. A workflow's validation resolves its bindings'
// contract keys here; an admin's approval (workflow-bindings.ts) then names
// what serves each. Threat model, and how each is closed:
//
// - A contract changing under the versions that pinned it: a key is
//   published once and never changed (the database refuses updates and
//   deletions); a new shape is a new key. A version pins a key and its
//   fingerprint, the SHA-256 of the canonical contract.
// - A contract the validator can't hold: published contracts are read by
//   the profile's own catalog reader (`resolveContract`), with its limits,
//   before they are stored; one it refuses is never stored.
// - Who publishes: only the organization's own admins, never Grasp staff,
//   re-checked in the statement that stores it, and audited.

/** A stored contract, as a validation resolves it. */
const storedSchema = z.strictObject({
  kind: z.enum(catalogBindingKinds),
  input: z.string().optional(),
  output: z.string().optional(),
  response: z.string().optional(),
  operations: z
    .record(
      z.string(),
      z.strictObject({ input: z.string(), output: z.string() })
    )
    .optional(),
  events: z
    .record(
      z.string(),
      z.strictObject({ data: z.string(), browser: z.boolean() })
    )
    .optional(),
});

/** A catalog contract as `@grasp-os/open-workflow` reads it. */
export interface ResolvedCatalogContract {
  key: string;
  kind: CatalogBindingKind;
  fingerprint: string;
  contract: CatalogContract;
}

const entryOf = (row: typeof workflowCatalogContracts.$inferSelect) => ({
  key: row.key,
  kind: row.kind,
  fingerprint: row.fingerprint,
  publishedBy: row.publishedBy,
  publishedAt: row.publishedAt.toISOString(),
});

/**
 * Publishes a contract to the catalog for `by`, one of the organization's
 * own admins: refused unless the profile's catalog reader accepts it
 * (`workflow.contract_invalid`), and once its key is taken
 * (`workflow.contract_exists`).
 */
export const publishCatalogContract = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<CatalogContractEntry> => {
  requireMemberAdmin(by);
  const { key, ...contract } = workflowResourceErrors.parse(
    "workflow.contract_invalid",
    catalogContractSchema,
    input
  );
  const read = resolveContract(() => contract, key, createCatalogBudget());
  if (!read.found) {
    throw workflowResourceErrors.create("workflow.contract_invalid", {
      issues: [read.reason],
    });
  }
  const text = canonicalJson(contract);
  const fingerprint = await sha256Hex(text);
  const publishedAt = new Date();
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(workflowCatalogContracts).select(
        sql`SELECT ${key}, ${contract.kind}, ${text}, ${fingerprint}, ${by.userId}, ${publishedAt.getTime()}
          WHERE ${stillAdminSql(by)}`
      ),
      outboxedIfChanged(db, {
        actor: actorOf(by),
        action: "workflow.contract.published",
        target: { type: "workflow_contract", id: key },
        detail: { kind: contract.kind, fingerprint },
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw workflowResourceErrors.create("workflow.contract_exists");
    }
    throw error;
  }
  const stored = await drizzle(env.DB)
    .select({ key: workflowCatalogContracts.key })
    .from(workflowCatalogContracts)
    .where(eq(workflowCatalogContracts.key, key))
    .get();
  if (stored === undefined) {
    // No longer an admin as the statement ran.
    throw roleErrors.create("role.forbidden");
  }
  return {
    key,
    kind: contract.kind,
    fingerprint,
    publishedBy: by.userId,
    publishedAt: publishedAt.toISOString(),
  };
};

/** The catalog's contracts, by key, for builders. */
export const catalogContracts = async (
  env: Env,
  by: Pick<Identity, "role">
): Promise<CatalogContractEntry[]> => {
  requireBuilder(by);
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowCatalogContracts)
    .orderBy(asc(workflowCatalogContracts.key));
  return rows.map(entryOf);
};

/**
 * The catalog contracts `keys` name, those there are, each checked against
 * its fingerprint: a stored contract that no longer hashes to it is left
 * out, so nothing validates against it.
 */
export const resolveCatalogKeys = async (
  env: Env,
  keys: readonly string[]
): Promise<Map<string, ResolvedCatalogContract>> => {
  const found = new Map<string, ResolvedCatalogContract>();
  if (keys.length === 0) {
    return found;
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(workflowCatalogContracts)
    // As one bound parameter: a version names at most 64, but an App's
    // bound workflows together may name more than D1's 100.
    .where(inList(workflowCatalogContracts.key, keys));
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one hash per named contract
    if ((await sha256Hex(row.contract)) === row.fingerprint) {
      const contract = storedSchema.parse(JSON.parse(row.contract));
      found.set(row.key, {
        key: row.key,
        kind: row.kind,
        fingerprint: row.fingerprint,
        contract,
      });
    }
  }
  return found;
};
