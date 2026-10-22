import {
  createCatalogBudget,
  resolveContract,
} from "@grasp-os/open-workflow/catalog";
import type { CatalogContract } from "@grasp-os/open-workflow/catalog";
import { actorOf } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
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
import {
  envelopedSchema,
  envelopedSchemaText,
  forValidation,
  readEnvelope,
} from "./workflows/connector-schemas.ts";

// The host catalog of contracts independent workflows bind besides each
// other (platform specification 13.2): operation, connector, model,
// decision and event contracts, each a key and the SDK descriptors of
// what a call passes and returns, or of each event type's data; a
// connector's operation may instead carry a native connector's own JSON
// Schemas, as connect confirms them (connector-schemas.ts). A workflow's validation resolves its bindings'
// contract keys here; an admin's approval (workflow-bindings.ts) then names
// what serves each. Threat model, and how each is closed:
//
// - A contract changing under the versions that pinned it: a key is
//   published once and never changed (the database refuses updates,
//   deletions and any insert over a row it holds, by its key or its rowid,
//   whatever the conflict clause: migrations 0080 and 0101); a new shape
//   is a new key. A version pins a key and its fingerprint, the SHA-256 of
//   the canonical contract.
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
      z.strictObject({
        input: z.string(),
        output: z.string(),
        readOnly: z.boolean().optional(),
        answersFile: z.literal(true).optional(),
        takesFiles: z.literal(true).optional(),
      })
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

const contractInvalid = (issue: string) =>
  workflowResourceErrors.create("workflow.contract_invalid", {
    issues: [issue],
  });

/** What a native operation's contract records of it, besides its schemas. */
interface Declared {
  readOnly?: boolean;
  answersFile?: true;
  takesFiles?: true;
}

/**
 * Refuses (`workflow.contract_invalid`) an operation whose record of what
 * it is differs from what its connector declares (`confirmed`, as connect
 * confirmed it). Whether it only reads is the connector's to say, not the
 * admin's: a write published as a read would leave the writes a model may
 * steer out of a version's review (GRA-718). A file answer (GRA-886) and
 * attached files (GRA-887) are sealed into the contract the same way, so
 * a call reads them from what was approved, never from connect as it is
 * then.
 */
const requireDeclared = (
  operation: string,
  { readOnly, answersFile, takesFiles }: Declared,
  confirmed: Declared & { readOnly: boolean }
): void => {
  if ((readOnly ?? false) !== confirmed.readOnly) {
    throw contractInvalid(
      `operations.${operation}: readOnly must be what its connector declares (${String(confirmed.readOnly)}).`
    );
  }
  if ((answersFile ?? false) !== (confirmed.answersFile ?? false)) {
    throw contractInvalid(
      `operations.${operation}: answersFile must be what its connector declares.`
    );
  }
  if ((takesFiles ?? false) !== (confirmed.takesFiles ?? false)) {
    throw contractInvalid(
      `operations.${operation}: takesFiles must be what its connector declares.`
    );
  }
};

/**
 * Refuses (`workflow.contract_invalid`) an operation described by JSON
 * Schema (connector-schemas.ts) unless it is a connector contract's, both
 * its input and output are, each is one the allow-list admits, and connect
 * confirms they are exactly a native action of this release by that tool,
 * its `readOnly`, whether it answers a file and whether it attaches files,
 * as the connector declares them.
 * Nothing else may put a pattern where core runs it (GRA-982).
 */
const requireNativeOperations = async (
  env: Env,
  contract: {
    kind: CatalogBindingKind;
    operations?: Record<
      string,
      {
        input: string;
        output: string;
        readOnly?: boolean;
        answersFile?: true;
        takesFiles?: true;
      }
    >;
  }
): Promise<void> => {
  for (const [
    operation,
    { input, output, readOnly, answersFile, takesFiles },
  ] of Object.entries(contract.operations ?? {})) {
    const enveloped = [input, output].filter(
      (text) => envelopedSchema(text) !== undefined
    ).length;
    if (enveloped === 0) {
      // A file answer is a native connector's to declare, confirmed below.
      if (answersFile === true) {
        throw contractInvalid(
          `operations.${operation}: Only an operation described by its native connector's JSON Schemas answers a file.`
        );
      }
      // So is attaching files (GRA-887).
      if (takesFiles === true) {
        throw contractInvalid(
          `operations.${operation}: Only an operation described by its native connector's JSON Schemas attaches files.`
        );
      }
      continue;
    }
    if (contract.kind !== "connector" || enveloped !== 2) {
      throw contractInvalid(
        `operations.${operation}: Only a connector's operation is described by JSON Schema, its input and output both.`
      );
    }
    const inputSchema = envelopedSchemaText(input);
    const outputSchema = envelopedSchemaText(output);
    if (
      readEnvelope(input) === undefined ||
      readEnvelope(output) === undefined ||
      inputSchema === undefined ||
      outputSchema === undefined
    ) {
      throw contractInvalid(
        `operations.${operation}: Its JSON Schema uses something a connector call's check doesn't enforce.`
      );
    }
    let confirmed: Declared & { readOnly: boolean };
    try {
      // oxlint-disable-next-line no-await-in-loop -- one confirmation per operation, each bounded
      confirmed = await env.CONNECT.nativeOperation({
        tool: operation,
        input: inputSchema,
        output: outputSchema,
      });
    } catch (error) {
      if (isExpectedError(error)) {
        throw contractInvalid(
          `operations.${operation}: Its JSON Schemas aren't exactly a native connector action's of this release.`
        );
      }
      throw error;
    }
    requireDeclared(
      operation,
      { readOnly, answersFile, takesFiles },
      confirmed
    );
  }
};

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
  await requireNativeOperations(env, contract);
  const read = resolveContract(
    () => forValidation(contract),
    key,
    createCatalogBudget()
  );
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
