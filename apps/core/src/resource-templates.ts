import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { jsonOf, operationErrors } from "@grasp-os/shared/operations";
import {
  resourceBindingErrors,
  templateContentMaxBytes,
  templatePublicationSchema,
} from "@grasp-os/shared/resource-bindings";
import type { PublishedTemplate } from "@grasp-os/shared/resource-bindings";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { resourceTemplates } from "./db/core/schema.ts";
import {
  requireMemberAdmin,
  requireStillAdmin,
  stillAdminSql,
} from "./permissions.ts";
import type { ResourceAdapter } from "./resource-adapter.ts";

// Published templates (spec 32.3): content an admin publishes for Apps to
// read through a template resource, one immutable version at a time. A
// version is written once, by an insert that numbers it, and nothing ever
// updates it, so a binding pinned to a version reads exactly what was
// approved, and its fingerprint is the content's own hash: content that no
// longer hashes to it (a row changed behind the platform's back) serves
// nothing. A template is data, never code: reading one runs nothing.

type Row = typeof resourceTemplates.$inferSelect;

const toPublished = (row: Row): PublishedTemplate => ({
  templateId: row.id,
  version: row.version,
  contract: row.contract,
  contentHash: row.contentHash,
  publishedBy: row.publishedBy,
  publishedAt: row.publishedAt.toISOString(),
});

const encoder = new TextEncoder();

type Admin = Identity & Pick<Acting, "actor">;

/**
 * Publishes a template version, as an admin of the organization: a new
 * template, or the next version of `templateId`, which keeps the contract
 * of its first version. Audited.
 */
export const publishTemplate = async (
  env: Env,
  by: Admin,
  input: unknown
): Promise<PublishedTemplate> => {
  requireMemberAdmin(by);
  const parsed = templatePublicationSchema.safeParse(input);
  const content = parsed.success ? canonicalJson(parsed.data.content) : "";
  if (
    !parsed.success ||
    encoder.encode(content).byteLength > templateContentMaxBytes
  ) {
    throw resourceBindingErrors.create("resource.template_invalid");
  }
  const { contract } = parsed.data;
  const db = drizzle(env.DB);
  const templateId = parsed.data.templateId ?? crypto.randomUUID();
  if (parsed.data.templateId !== undefined) {
    const first = await db
      .select({ contract: resourceTemplates.contract })
      .from(resourceTemplates)
      .where(eq(resourceTemplates.id, templateId))
      .orderBy(asc(resourceTemplates.version))
      .get();
    if (first === undefined) {
      throw resourceBindingErrors.create("resource.template_not_found");
    }
    if (first.contract !== contract) {
      throw resourceBindingErrors.create("resource.template_contract_changed");
    }
  }
  const contentHash = await sha256Hex(content);
  const now = new Date();
  // Numbered by the insert itself, and only while `by` is still an admin
  // and the template's first version still has this contract (none yet
  // for a new one). Two at once: one takes the number, the other fails.
  const sameContract = sql`NOT EXISTS (SELECT 1 FROM ${resourceTemplates} WHERE ${resourceTemplates.id} = ${templateId} AND ${resourceTemplates.contract} <> ${contract})`;
  let inserted: Row[];
  try {
    [inserted] = await auditedBatch(env, db, [
      db
        .insert(resourceTemplates)
        .select(
          sql`SELECT ${templateId}, COALESCE((SELECT MAX(${resourceTemplates.version}) FROM ${resourceTemplates} WHERE ${resourceTemplates.id} = ${templateId}), 0) + 1, ${contract}, ${content}, ${contentHash}, ${by.userId}, ${now.getTime()} WHERE ${stillAdminSql(by)} AND ${sameContract}`
        )
        .returning(),
      outboxedIfChanged(db, {
        actor: by.actor ?? actorOf(by),
        action: "resource.template.published",
        target: { type: "template", id: templateId },
        detail: { contract, contentHash },
      }),
    ]);
  } catch (error) {
    if (
      error instanceof Error &&
      `${error.message} ${String(error.cause)}`.includes("UNIQUE constraint")
    ) {
      throw appErrors.create("app.conflict");
    }
    throw error;
  }
  const [row] = inserted;
  if (row === undefined) {
    await requireStillAdmin(env, by);
    throw resourceBindingErrors.create("resource.template_contract_changed");
  }
  return toPublished(row);
};

/** Every template version, newest first: for admins and builders. */
export const listTemplates = async (
  env: Env,
  by: Identity
): Promise<PublishedTemplate[]> => {
  if (by.staff || (!isAdmin(by.role) && by.role !== "builder")) {
    throw roleErrors.create("role.forbidden");
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(resourceTemplates)
    .orderBy(desc(resourceTemplates.publishedAt))
    .limit(200);
  return rows.map(toPublished);
};

/** Version `version` of template `templateId`, if it is published. */
const versionOf = async (
  env: Env,
  templateId: string,
  version: number
): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(resourceTemplates)
    .where(
      and(
        eq(resourceTemplates.id, templateId),
        eq(resourceTemplates.version, version)
      )
    )
    .get();

/**
 * The content of `row` as a template binding answers it, if the row is a
 * version of `contract` whose content still hashes to what it was
 * published with; undefined otherwise.
 */
const intactContent = async (
  row: Row | undefined,
  contract: string
): Promise<TemplateContent | undefined> => {
  const content =
    row === undefined ? undefined : jsonOf(JSON.parse(row.content));
  const intact =
    row !== undefined &&
    content !== undefined &&
    row.contract === contract &&
    (await sha256Hex(row.content)) === row.contentHash;
  return intact
    ? { contract: row.contract, version: row.version, content }
    : undefined;
};

/** What a template binding answers: the pinned version, as published. */
interface TemplateContent {
  readonly contract: string;
  readonly version: number;
  readonly content: Json;
}

/**
 * A template resource: the one version its binding pins, of the declared
 * contract, read as it was published, each time it is read.
 */
export const templateAdapter: ResourceAdapter<"template"> = {
  bind: async (env, _app, declaration, target) => {
    const row = await versionOf(env, target.templateId, target.version);
    const content = await intactContent(row, declaration.contract);
    return row === undefined || content === undefined
      ? undefined
      : {
          contractId: declaration.contract,
          fingerprint: row.contentHash,
          call: async () => {
            const read = await intactContent(
              await versionOf(env, target.templateId, target.version),
              declaration.contract
            );
            if (read === undefined) {
              throw operationErrors.create("resource.unavailable");
            }
            return read;
          },
        };
  },
};
