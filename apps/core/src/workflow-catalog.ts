import {
  createCatalogBudget,
  resolveContract,
} from "@grasp-os/open-workflow/catalog";
import type { CatalogContract } from "@grasp-os/open-workflow/catalog";
import { actorOf } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { requireBuilder, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  catalogBindingKinds,
  catalogContractSchema,
  eventIngressKinds,
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
import { emailReplyContract, emailReplyData } from "./release-contracts.ts";
import {
  envelopedSchema,
  envelopedSchemaText,
  forValidation,
  readEnvelope,
} from "./workflows/connector-schemas.ts";
import { takesPageAnswers } from "./workflows/exact-values.ts";

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
//   re-checked in the statement that stores it, and audited; and the
//   release's install, the contracts a built-in blueprint's workflows bind
//   (`ensureReleaseContract`), only under a key nobody has taken.

/**
 * Who publishes a contract: one of the organization's admins, or the
 * release's install (`ensureReleaseContract`).
 */
type ContractSource = "admin" | "release";

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
      z.strictObject({
        data: z.string(),
        browser: z.boolean(),
        ingress: z.enum(eventIngressKinds).optional(),
      })
    )
    .optional(),
});

/**
 * A catalog contract as `@grasp-os/open-workflow` reads it, and what core
 * reads of it besides (an event type's `ingress`).
 */
export interface ResolvedCatalogContract {
  key: string;
  kind: CatalogBindingKind;
  fingerprint: string;
  contract: CatalogContract & z.infer<typeof storedSchema>;
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
 *
 * The release's own contracts (`ensureReleaseContract`, `from: "release"`)
 * are this release's code, not anyone's input: their schemas are the very
 * ones connect serves (`httpActionSchemas`, which connect's tests confirm
 * as native actions), so their envelopes are checked here but connect
 * isn't asked. Core installs them as it boots, where connect may not be
 * up yet, or, in core's on-prem smoke run, there at all.
 */
const requireNativeOperations = async (
  env: Env,
  from: ContractSource,
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
    if (from === "release") {
      continue;
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

/** The platform's reply data, canonical, as an `email` type's must be. */
const emailReplyText = canonicalJson(
  z.json().parse(JSON.parse(emailReplyData))
);

/**
 * Refuses (`workflow.contract_invalid`) an `email` type whose data isn't
 * exactly the platform's reply (`emailReplyData`), compared canonically:
 * a reply is admitted as core reads it off the message, never as an admin
 * might shape it, so a type taking anything else would refuse every one.
 */
const requireEmailReplies = (
  events: Readonly<Record<string, { data: string; ingress?: string }>> = {}
): void => {
  for (const [type, { data, ingress }] of Object.entries(events)) {
    if (ingress !== "email") {
      continue;
    }
    let text: string | undefined;
    try {
      text = canonicalJson(z.json().parse(JSON.parse(data)));
    } catch {
      text = undefined;
    }
    if (text !== emailReplyText) {
      throw contractInvalid(
        `events.${type}: An email type's data is the platform's reply (${emailReplyContract}'s).`
      );
    }
  }
};

/**
 * `input` as the catalog stores it: refused unless the profile's catalog
 * reader accepts it, and a decision contract's response schema takes what
 * a person can answer (`workflow.contract_invalid`). `from` is who
 * publishes it: an admin, or the release's install.
 */
const checkedContract = async (
  env: Env,
  from: ContractSource,
  input: unknown
) => {
  const { key, ...contract } = workflowResourceErrors.parse(
    "workflow.contract_invalid",
    catalogContractSchema,
    input
  );
  await requireNativeOperations(env, from, contract);
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
  // A decision is answered on its page, with no payload or a comment: a
  // response schema taking neither could never be answered.
  if (
    contract.kind === "decision" &&
    contract.response !== undefined &&
    !takesPageAnswers(contract.response)
  ) {
    throw workflowResourceErrors.create("workflow.contract_invalid", {
      issues: [
        "response: A person answers a decision with no payload or with { comment }: take one of them.",
      ],
    });
  }
  requireEmailReplies(contract.events);
  const text = canonicalJson(contract);
  return { key, kind: contract.kind, text, fingerprint: await sha256Hex(text) };
};

/**
 * Publishes a contract to the catalog for `by`, one of the organization's
 * own admins: refused unless it is a contract the catalog takes
 * (`checkedContract`), and once its key is taken
 * (`workflow.contract_exists`).
 */
export const publishCatalogContract = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<CatalogContractEntry> => {
  requireMemberAdmin(by);
  const { key, kind, text, fingerprint } = await checkedContract(
    env,
    "admin",
    input
  );
  const publishedAt = new Date();
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(workflowCatalogContracts).select(
        sql`SELECT ${key}, ${kind}, ${text}, ${fingerprint}, ${by.userId}, ${publishedAt.getTime()}
          WHERE ${stillAdminSql(by)}`
      ),
      outboxedIfChanged(db, {
        actor: actorOf(by),
        action: "workflow.contract.published",
        target: { type: "workflow_contract", id: key },
        detail: { kind, fingerprint },
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
    kind,
    fingerprint,
    publishedBy: by.userId,
    publishedAt: publishedAt.toISOString(),
  };
};

/** Who the catalog names as publishing what the release ships. */
const releasePublisher = "grasp";

/**
 * Publishes `input`, a contract a built-in blueprint ships, as the
 * release's install (app-blueprints.ts): checked as an admin's is, and
 * stored only while its key isn't taken, audited only then. A key is
 * never changed once published, so one taken already, by an earlier
 * install or by an admin, stays as it is: a different contract under it
 * is logged, and a definition binding the key is checked against the
 * contract stored, as any is. A contract grants nothing: what serves its
 * binding is still an admin's approval.
 */
export const ensureReleaseContract = async (
  env: Env,
  input: unknown,
  /** What the audit event names it shipped with: the built-in. */
  detail: Readonly<Record<string, string>>
): Promise<void> => {
  const { key, kind, text, fingerprint } = await checkedContract(
    env,
    "release",
    input
  );
  const db = drizzle(env.DB);
  // Not an insert over the key's row, which the database refuses whatever
  // the conflict clause (migrations 0080 and 0101): one only while there is
  // none.
  await auditedBatch(env, db, [
    db.insert(workflowCatalogContracts).select(
      sql`SELECT ${key}, ${kind}, ${text}, ${fingerprint}, ${releasePublisher}, ${Date.now()}
          WHERE NOT EXISTS (SELECT 1 FROM workflow_catalog_contracts WHERE key = ${key})`
    ),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "workflow.contract.published",
      target: { type: "workflow_contract", id: key },
      detail: { kind, fingerprint, ...detail },
    }),
  ]);
  const stored = await db
    .select({ fingerprint: workflowCatalogContracts.fingerprint })
    .from(workflowCatalogContracts)
    .where(eq(workflowCatalogContracts.key, key))
    .get();
  if (stored?.fingerprint !== fingerprint) {
    log.warn("builtins.contract_differs", { key, ...detail });
  }
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

/** A descriptor's JSON text, read back as JSON for whoever binds it. */
const descriptorOf = (text: string | undefined): unknown =>
  text === undefined ? undefined : JSON.parse(text);

/**
 * A catalog contract as someone writing a definition binds it: its key,
 * kind, and what a call passes and gets back, each descriptor as JSON.
 */
export interface CatalogContractTerms {
  key: string;
  kind: CatalogBindingKind;
  input?: unknown;
  output?: unknown;
  response?: unknown;
  operations?: Record<
    string,
    { input: unknown; output: unknown; readOnly: boolean }
  >;
  events?: Record<string, { data: unknown }>;
}

const termsOf = ({
  key,
  kind,
  contract,
}: ResolvedCatalogContract): CatalogContractTerms => {
  const { input, output, response, operations, events } = contract;
  const terms: CatalogContractTerms = { key, kind };
  if (input !== undefined) {
    terms.input = descriptorOf(input);
  }
  if (output !== undefined) {
    terms.output = descriptorOf(output);
  }
  if (response !== undefined) {
    terms.response = descriptorOf(response);
  }
  if (operations !== undefined) {
    terms.operations = Object.fromEntries(
      Object.entries(operations).map(([name, operation]) => [
        name,
        {
          input: descriptorOf(operation.input),
          output: descriptorOf(operation.output),
          readOnly: operation.readOnly ?? false,
        },
      ])
    );
  }
  if (events !== undefined) {
    terms.events = Object.fromEntries(
      Object.entries(events).map(([type, event]) => [
        type,
        { data: descriptorOf(event.data) },
      ])
    );
  }
  return terms;
};

/**
 * The catalog's contracts with their terms, for builders: what a
 * definition can bind besides its own code and other workflows. Only
 * those intact, as validation resolves them (`resolveCatalogKeys`).
 */
export const catalogContractTerms = async (
  env: Env,
  by: Pick<Identity, "role">
): Promise<CatalogContractTerms[]> => {
  const listed = await catalogContracts(env, by);
  const resolved = await resolveCatalogKeys(
    env,
    listed.map(({ key }) => key)
  );
  return listed.flatMap(({ key }) => {
    const contract = resolved.get(key);
    return contract === undefined ? [] : [termsOf(contract)];
  });
};
