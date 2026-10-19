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

import {
  auditedBatch,
  keepAuditEvent,
  outboxedIfChanged,
} from "./audit-outbox.ts";
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

const toPublished = (row: Omit<Row, "content">): PublishedTemplate => ({
  templateId: row.id,
  version: row.version,
  contract: row.contract,
  contentHash: row.contentHash,
  publishedBy: row.publishedBy,
  publishedAt: row.publishedAt.toISOString(),
});

const encoder = new TextEncoder();

/**
 * The level a template's content sits at in the answer a binding gives
 * (`{ contract, version, content }`), so content is held to the depth an
 * answer can carry from there, at publication and at every read.
 */
const contentLevel = 2;

/** `text` read as template content, or undefined when it can't be served. */
const servableContent = (text: string): Json | undefined => {
  try {
    return jsonOf(JSON.parse(text), contentLevel);
  } catch {
    return undefined;
  }
};

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
  // Content an answer couldn't carry would be published only to fail
  // every read: refused here instead.
  if (
    !parsed.success ||
    encoder.encode(content).byteLength > templateContentMaxBytes ||
    servableContent(content) === undefined
  ) {
    throw resourceBindingErrors.create("resource.template_invalid");
  }
  const { contract } = parsed.data;
  const db = drizzle(env.DB);
  const templateId = parsed.data.templateId ?? crypto.randomUUID();
  let version = 1;
  if (parsed.data.templateId !== undefined) {
    const [first, latest] = await Promise.all([
      db
        .select({ contract: resourceTemplates.contract })
        .from(resourceTemplates)
        .where(eq(resourceTemplates.id, templateId))
        .orderBy(asc(resourceTemplates.version))
        .get(),
      db
        .select({ version: resourceTemplates.version })
        .from(resourceTemplates)
        .where(eq(resourceTemplates.id, templateId))
        .orderBy(desc(resourceTemplates.version))
        .get(),
    ]);
    if (first === undefined || latest === undefined) {
      throw resourceBindingErrors.create("resource.template_not_found");
    }
    if (first.contract !== contract) {
      throw resourceBindingErrors.create("resource.template_contract_changed");
    }
    version = latest.version + 1;
  }
  const contentHash = await sha256Hex(content);
  const now = new Date();
  // The next number, read just above, so the event can record it; taken
  // only while `by` is still an admin and the template's first version
  // still has this contract (none yet for a new one). Two at once: the
  // key lets one take the number, and the other fails as a conflict.
  const sameContract = sql`NOT EXISTS (SELECT 1 FROM ${resourceTemplates} WHERE ${resourceTemplates.id} = ${templateId} AND ${resourceTemplates.contract} <> ${contract})`;
  let inserted: Row[];
  try {
    [inserted] = await auditedBatch(env, db, [
      db
        .insert(resourceTemplates)
        .select(
          sql`SELECT ${templateId}, ${version}, ${contract}, ${content}, ${contentHash}, ${by.userId}, ${now.getTime()} WHERE ${stillAdminSql(by)} AND ${sameContract}`
        )
        .returning(),
      outboxedIfChanged(db, {
        actor: by.actor ?? actorOf(by),
        action: "resource.template.published",
        target: { type: "template", id: templateId },
        detail: { contract, version, contentHash },
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

/**
 * The published versions of `contract` (every contract's when undefined),
 * newest first, at most `limit`, without their content: what a template
 * resource of that contract may be bound to. The caller checks who asks.
 */
export const templateVersionsOf = async (
  env: Env,
  contract: string | undefined,
  limit: number
): Promise<PublishedTemplate[]> => {
  // Everything but the content, which a listing never returns.
  const rows = await drizzle(env.DB)
    .select({
      id: resourceTemplates.id,
      version: resourceTemplates.version,
      contract: resourceTemplates.contract,
      contentHash: resourceTemplates.contentHash,
      publishedBy: resourceTemplates.publishedBy,
      publishedAt: resourceTemplates.publishedAt,
    })
    .from(resourceTemplates)
    .where(
      contract === undefined
        ? undefined
        : eq(resourceTemplates.contract, contract)
    )
    .orderBy(desc(resourceTemplates.publishedAt))
    .limit(limit);
  return rows.map(toPublished);
};

/** Every template version, newest first: for admins and builders. */
export const listTemplates = async (
  env: Env,
  by: Identity
): Promise<PublishedTemplate[]> => {
  if (by.staff || (!isAdmin(by.role) && by.role !== "builder")) {
    throw roleErrors.create("role.forbidden");
  }
  return await templateVersionsOf(env, undefined, 200);
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
 * version of `contract` whose content, and the hash stored with it, are
 * still `contentHash` (what was approved; the row's own hash when there's
 * nothing approved to hold it to yet); undefined otherwise, as for content
 * that isn't JSON an answer can carry.
 */
const intactContent = async (
  row: Row | undefined,
  contract: string,
  contentHash = row?.contentHash
): Promise<TemplateContent | undefined> => {
  const intact =
    row !== undefined &&
    row.contract === contract &&
    row.contentHash === contentHash &&
    (await sha256Hex(row.content)) === contentHash;
  const content = intact ? servableContent(row.content) : undefined;
  return row === undefined || content === undefined
    ? undefined
    : { contract: row.contract, version: row.version, content };
};

/**
 * Version `version` of template `templateId` as a workflow's binding pins
 * it (GRA-700): its content, if the version is published and its content,
 * and the hash stored with it, are still `contentHash`; undefined
 * otherwise. Any contract: a workflow's binding pins the version itself.
 */
export const pinnedTemplate = async (
  env: Env,
  templateId: string,
  version: number,
  contentHash: string
): Promise<TemplateContent | undefined> => {
  const row = await versionOf(env, templateId, version);
  return row === undefined
    ? undefined
    : await intactContent(row, row.contract, contentHash);
};

/** What a template binding answers: the pinned version, as published. */
export interface TemplateContent {
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
          call: async (caller, _request, context, pin) => {
            // Held to the approved hash, not the row's own: a row changed
            // with its hash after the binding resolved serves nothing.
            const read = await intactContent(
              await versionOf(env, target.templateId, target.version),
              declaration.contract,
              pin.fingerprint
            );
            if (read === undefined) {
              throw operationErrors.create("resource.unavailable");
            }
            // Recorded as Knowledge records an App's reads, through the
            // outbox, which never fails the read.
            await keepAuditEvent(env, drizzle(env.DB), {
              actor: caller.actor,
              action: "resource.template.read",
              target: { type: "template", id: target.templateId },
              requestId: context.requestId,
              detail: {
                version: target.version,
                binding: pin.id,
                contentHash: pin.fingerprint,
              },
            });
            return read;
          },
        };
  },
};
