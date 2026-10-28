import { actorOf } from "@grasp-os/shared/audit";
import { log } from "@grasp-os/shared/log";
import {
  exceptionInputSchema,
  policyErrors,
  policyUploadSchema,
  ruleInputSchema,
} from "@grasp-os/shared/policies";
import type {
  ExceptionInput,
  PoliciesApi,
  PolicyBook,
  PolicyDocument,
  PolicyException,
  PolicyFindings,
  PolicyRule,
  PolicyUpload,
  RuleInput,
} from "@grasp-os/shared/policies";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import { activeMember } from "./auth/auth.ts";
import {
  policyDocuments,
  policyExceptions,
  policyRules,
} from "./db/core/schema.ts";
import { policyFindings } from "./policy-findings.ts";
import { CoreRpcTarget } from "./rpc-target.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The company's policies for the apps its people use
// (@grasp-os/shared/policies): its policy documents, the rules drawn from
// them or made by hand, and the exceptions that let one app break one rule
// until a day. Everyone signed in reads them, as everyone sees the
// Landscape the rules act on. Only the organization's own admins change
// them, never Grasp staff: what the company allows is the company's to
// say. Each change writes only while its admin still is one, with its
// audit event in the same batch, recorded only when it wrote; an event
// names what changed by ID, never a policy's text or a reason. Grasp
// doesn't read policies yet: an upload waits for an admin to publish it,
// and proposes no rules.

const idSchema = z.string().min(1).max(200);

/** The organization's own admins change the policies; nobody else does. */
const requireOwnAdmin = (by: Identity, action: string): void => {
  if (by.staff || !isAdmin(by.role)) {
    log.warn("policy.refused", { actor: by.userId, action });
    throw roleErrors.create("role.forbidden");
  }
};

/** `input`, as `schema` takes it, or refused as no policy, rule or exception. */
const parsed = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw policyErrors.create("policy.invalid");
  }
  return result.data;
};

/** Whether `by` is still one of the organization's admins as a statement runs. */
const stillAdmin = (by: Identity): SQL => activeMember(by.userId, ["admin"]);

/** After a write that wrote nothing: refused when the admin stopped being one, else `orElse`. */
const unwritten = async (
  env: Env,
  by: Identity,
  orElse: () => never
): Promise<never> => {
  const row = await drizzle(env.DB).get<{ admin: number }>(
    sql`SELECT ${stillAdmin(by)} AS admin`
  );
  if (row.admin !== 1) {
    throw roleErrors.create("role.forbidden");
  }
  return orElse();
};

/** An ID as a caller sends it, checked: none that isn't one reaches a query. */
const idOf = (value: unknown): string => parsed(idSchema, value);

const notFound = (): never => {
  throw policyErrors.create("policy.not_found");
};

type DocumentRow = typeof policyDocuments.$inferSelect;
type RuleRow = typeof policyRules.$inferSelect;
type ExceptionRow = typeof policyExceptions.$inferSelect;

const documentOf = (row: DocumentRow): PolicyDocument => ({
  id: row.id,
  title: row.title,
  fileName: row.fileName,
  uploadedBy: row.uploadedBy,
  uploadedAt: row.uploadedAt.toISOString(),
  status: row.status,
  proposals: [],
  unchecked: [],
  ...(row.publishedAt === null
    ? {}
    : { publishedAt: row.publishedAt.toISOString() }),
});

const ruleOf = (row: RuleRow): PolicyRule => ({
  id: row.id,
  name: row.name,
  description: row.description,
  conditions: row.conditions,
  effect: row.effect,
  status: row.status,
  policyId: row.policyId,
  ...(row.excerpt === null ? {} : { excerpt: row.excerpt }),
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
});

const exceptionOf = (row: ExceptionRow): PolicyException => ({
  ruleId: row.ruleId,
  appId: row.appId,
  reason: row.reason,
  until: row.until,
  grantedBy: row.grantedBy,
  grantedAt: row.grantedAt.toISOString(),
});

/** Every policy, rule and exception, newest first. */
const readBook = async (env: Env): Promise<PolicyBook> => {
  const db = drizzle(env.DB);
  const [documents, rules, exceptions] = await db.batch([
    db.select().from(policyDocuments).orderBy(desc(policyDocuments.uploadedAt)),
    db.select().from(policyRules).orderBy(desc(policyRules.createdAt)),
    db
      .select()
      .from(policyExceptions)
      .orderBy(desc(policyExceptions.grantedAt)),
  ]);
  return {
    policies: documents.map(documentOf),
    rules: rules.map(ruleOf),
    exceptions: exceptions.map(exceptionOf),
  };
};

const readDocument = async (
  env: Env,
  id: string
): Promise<PolicyDocument | undefined> => {
  const [row] = await drizzle(env.DB)
    .select()
    .from(policyDocuments)
    .where(eq(policyDocuments.id, id));
  return row === undefined ? undefined : documentOf(row);
};

const readRule = async (
  env: Env,
  id: string
): Promise<PolicyRule | undefined> => {
  const [row] = await drizzle(env.DB)
    .select()
    .from(policyRules)
    .where(eq(policyRules.id, id));
  return row === undefined ? undefined : ruleOf(row);
};

const target = (type: string, id: string) => ({ type, id });

/** A one-row source that has its row only while `by` is still an admin. */
/** A value as an insert's one row selects it, named as its column. */
const as = <T>(value: unknown, column: string) => sql<T>`${value}`.as(column);

/** The one row an insert selects has its row only while `by` is still an admin and `also` holds. */
const onlyWhile = (by: Identity, also: SQL = sql`1`): SQL =>
  and(stillAdmin(by), also) ?? stillAdmin(by);

const upload = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<PolicyDocument> => {
  requireOwnAdmin(by, "upload");
  const { title, fileName, text } = parsed(policyUploadSchema, input);
  const id = crypto.randomUUID();
  const now = Date.now();
  const db = drizzle(env.DB);
  const [written] = await auditedBatch(env, db, [
    db.insert(policyDocuments).select(
      db
        .select({
          id: as<string>(id, "id"),
          title: as<string>(title, "title"),
          fileName: as<string>(fileName, "file_name"),
          text: as<string>(text, "text"),
          status: as<"review">("review", "status"),
          uploadedBy: as<string>(by.userId, "uploaded_by"),
          uploadedAt: as<Date>(now, "uploaded_at"),
          publishedAt: as<Date | null>(null, "published_at"),
        })
        .from(sql`(SELECT 1)`)
        .where(onlyWhile(by))
    ),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "policy.uploaded",
      target: target("policy", id),
    }),
  ]);
  if (written.meta.changes === 0) {
    return await unwritten(env, by, notFound);
  }
  return (await readDocument(env, id)) ?? notFound();
};

const publish = async (
  env: Env,
  by: Identity,
  id: string
): Promise<PolicyDocument> => {
  requireOwnAdmin(by, "publish");
  const db = drizzle(env.DB);
  const [written] = await auditedBatch(env, db, [
    db
      .update(policyDocuments)
      .set({ status: "published", publishedAt: new Date() })
      .where(
        and(
          eq(policyDocuments.id, id),
          sql`${policyDocuments.status} <> 'published'`,
          stillAdmin(by)
        )
      ),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "policy.published",
      target: target("policy", id),
    }),
  ]);
  const found = await readDocument(env, id);
  if (found === undefined) {
    return notFound();
  }
  if (written.meta.changes === 0 && found.status !== "published") {
    return await unwritten(env, by, notFound);
  }
  return found;
};

const removePolicy = async (
  env: Env,
  by: Identity,
  id: string
): Promise<void> => {
  requireOwnAdmin(by, "removePolicy");
  const db = drizzle(env.DB);
  const [removed] = await auditedBatch(env, db, [
    db
      .delete(policyDocuments)
      .where(and(eq(policyDocuments.id, id), stillAdmin(by))),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "policy.removed",
      target: target("policy", id),
    }),
    // Its rules stay, as rules made by hand, in the same batch.
    db
      .update(policyRules)
      .set({ policyId: null })
      .where(
        and(
          eq(policyRules.policyId, id),
          sql`NOT EXISTS (SELECT 1 FROM ${policyDocuments} WHERE ${policyDocuments.id} = ${id})`
        )
      ),
  ]);
  if (removed.meta.changes === 0) {
    await unwritten(env, by, notFound);
  }
};

/** The rule's row as `input` says it, checked: a rule from a policy names one that is there. */
const ruleRow = async (env: Env, input: unknown) => {
  const rule = parsed(ruleInputSchema, input);
  if (rule.policyId !== null) {
    const policy = await readDocument(env, rule.policyId);
    if (policy === undefined) {
      throw policyErrors.create("policy.conflict");
    }
  }
  return {
    name: rule.name,
    description: rule.description,
    conditions: rule.conditions,
    effect: rule.effect,
    status: rule.status,
    policyId: rule.policyId,
    excerpt: rule.excerpt ?? null,
  };
};

/** While the rule's policy, if it names one, is still there as the statement runs. */
const policyStillThere = (policyId: string | null): SQL =>
  policyId === null
    ? sql`1`
    : sql`EXISTS (SELECT 1 FROM ${policyDocuments} WHERE ${policyDocuments.id} = ${policyId})`;

const createRule = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<PolicyRule> => {
  requireOwnAdmin(by, "createRule");
  const row = await ruleRow(env, input);
  const id = crypto.randomUUID();
  const now = Date.now();
  const db = drizzle(env.DB);
  const [written] = await auditedBatch(env, db, [
    db.insert(policyRules).select(
      db
        .select({
          id: as<string>(id, "id"),
          name: as<string>(row.name, "name"),
          description: as<string>(row.description, "description"),
          conditions: as<RuleRow["conditions"]>(
            JSON.stringify(row.conditions),
            "conditions"
          ),
          effect: as<RuleRow["effect"]>(row.effect, "effect"),
          status: as<RuleRow["status"]>(row.status, "status"),
          policyId: as<string | null>(row.policyId, "policy_id"),
          excerpt: as<string | null>(row.excerpt, "excerpt"),
          createdBy: as<string>(by.userId, "created_by"),
          createdAt: as<Date>(now, "created_at"),
          updatedAt: as<Date>(now, "updated_at"),
        })
        .from(sql`(SELECT 1)`)
        .where(onlyWhile(by, policyStillThere(row.policyId)))
    ),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "policy.rule.created",
      target: target("policy_rule", id),
      detail: { effect: row.effect, status: row.status },
    }),
  ]);
  if (written.meta.changes === 0) {
    return await unwritten(env, by, () => {
      throw policyErrors.create("policy.conflict");
    });
  }
  return (await readRule(env, id)) ?? notFound();
};

/** What a rule says, as `updateRule` compares it. */
const sameFieldsOf = (
  rule: Omit<RuleInput, "excerpt"> & { excerpt?: string }
) => [
  rule.name,
  rule.description,
  rule.conditions,
  rule.effect,
  rule.status,
  rule.policyId,
  rule.excerpt ?? null,
];

const updateRule = async (
  env: Env,
  by: Identity,
  id: string,
  input: unknown
): Promise<PolicyRule> => {
  requireOwnAdmin(by, "updateRule");
  const row = await ruleRow(env, input);
  const db = drizzle(env.DB);
  const conditions = JSON.stringify(row.conditions);
  const [written] = await auditedBatch(env, db, [
    db
      .update(policyRules)
      .set({ ...row, updatedAt: new Date() })
      .where(
        and(
          eq(policyRules.id, id),
          // Only when something differs: the same save twice records one change.
          sql`(${policyRules.name}, ${policyRules.description}, ${policyRules.conditions},
            ${policyRules.effect}, ${policyRules.status}, coalesce(${policyRules.policyId}, ''),
            coalesce(${policyRules.excerpt}, ''))
            IS NOT (${row.name}, ${row.description}, ${conditions}, ${row.effect},
            ${row.status}, ${row.policyId ?? ""}, ${row.excerpt ?? ""})`,
          policyStillThere(row.policyId),
          stillAdmin(by)
        )
      ),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "policy.rule.updated",
      target: target("policy_rule", id),
      detail: { effect: row.effect, status: row.status },
    }),
  ]);
  const found = await readRule(env, id);
  if (found === undefined) {
    return notFound();
  }
  if (written.meta.changes === 0) {
    // Unchanged when it already said exactly this.
    const same =
      JSON.stringify(sameFieldsOf(found)) ===
      JSON.stringify(
        sameFieldsOf({ ...row, excerpt: row.excerpt ?? undefined })
      );
    if (!same) {
      return await unwritten(env, by, () => {
        throw policyErrors.create("policy.conflict");
      });
    }
  }
  return found;
};

const removeRule = async (
  env: Env,
  by: Identity,
  id: string
): Promise<void> => {
  requireOwnAdmin(by, "removeRule");
  const db = drizzle(env.DB);
  const [removed] = await auditedBatch(env, db, [
    db.delete(policyRules).where(and(eq(policyRules.id, id), stillAdmin(by))),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "policy.rule.removed",
      target: target("policy_rule", id),
    }),
    // Its exceptions go with it, in the same batch.
    db
      .delete(policyExceptions)
      .where(
        and(
          eq(policyExceptions.ruleId, id),
          sql`NOT EXISTS (SELECT 1 FROM ${policyRules} WHERE ${policyRules.id} = ${id})`
        )
      ),
  ]);
  if (removed.meta.changes === 0) {
    await unwritten(env, by, notFound);
  }
};

const grantException = async (
  env: Env,
  by: Identity,
  input: unknown
): Promise<PolicyException> => {
  requireOwnAdmin(by, "grantException");
  const { ruleId, appId, reason, until } = parsed(exceptionInputSchema, input);
  const now = Date.now();
  const db = drizzle(env.DB);
  const [written] = await auditedBatch(env, db, [
    db
      .insert(policyExceptions)
      .select(
        db
          .select({
            ruleId: as<string>(ruleId, "rule_id"),
            appId: as<string>(appId, "app_id"),
            reason: as<string>(reason, "reason"),
            until: as<string>(until, "until"),
            grantedBy: as<string>(by.userId, "granted_by"),
            grantedAt: as<Date>(now, "granted_at"),
          })
          .from(sql`(SELECT 1)`)
          .where(
            onlyWhile(
              by,
              sql`EXISTS (SELECT 1 FROM ${policyRules} WHERE ${policyRules.id} = ${ruleId})`
            )
          )
      )
      .onConflictDoUpdate({
        target: [policyExceptions.ruleId, policyExceptions.appId],
        set: {
          reason,
          until,
          grantedBy: by.userId,
          grantedAt: new Date(now),
        },
      }),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "policy.exception.granted",
      target: target("policy_rule", ruleId),
      detail: { appId, until },
    }),
  ]);
  if (written.meta.changes === 0) {
    return await unwritten(env, by, notFound);
  }
  const [row] = await db
    .select()
    .from(policyExceptions)
    .where(
      and(
        eq(policyExceptions.ruleId, ruleId),
        eq(policyExceptions.appId, appId)
      )
    );
  return row === undefined ? notFound() : exceptionOf(row);
};

const revokeException = async (
  env: Env,
  by: Identity,
  ruleId: string,
  appId: string
): Promise<void> => {
  requireOwnAdmin(by, "revokeException");
  const db = drizzle(env.DB);
  const [removed] = await auditedBatch(env, db, [
    db
      .delete(policyExceptions)
      .where(
        and(
          eq(policyExceptions.ruleId, ruleId),
          eq(policyExceptions.appId, appId),
          stillAdmin(by)
        )
      ),
    outboxedIfChanged(db, {
      actor: actorOf(by),
      action: "policy.exception.revoked",
      target: target("policy_rule", ruleId),
      detail: { appId },
    }),
  ]);
  if (removed.meta.changes === 0) {
    await unwritten(env, by, notFound);
  }
};

/** A signed-in person's `policies`. */
export class PoliciesRpc extends CoreRpcTarget implements PoliciesApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async book(): Promise<PolicyBook> {
    return await withPerson(this.#check, async () => await readBook(this.#env));
  }

  async findings(): Promise<PolicyFindings> {
    return await withPerson(
      this.#check,
      async (by) =>
        await policyFindings(this.#env, by, await readBook(this.#env))
    );
  }

  async upload(input: PolicyUpload): Promise<PolicyDocument> {
    return await withPerson(
      this.#check,
      async (by) => await upload(this.#env, by, input)
    );
  }

  async publish(policyId: string): Promise<PolicyDocument> {
    return await withPerson(
      this.#check,
      async (by) => await publish(this.#env, by, idOf(policyId))
    );
  }

  async removePolicy(policyId: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await removePolicy(this.#env, by, idOf(policyId));
    });
  }

  async createRule(rule: RuleInput): Promise<PolicyRule> {
    return await withPerson(
      this.#check,
      async (by) => await createRule(this.#env, by, rule)
    );
  }

  async updateRule(ruleId: string, rule: RuleInput): Promise<PolicyRule> {
    return await withPerson(
      this.#check,
      async (by) => await updateRule(this.#env, by, idOf(ruleId), rule)
    );
  }

  async removeRule(ruleId: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await removeRule(this.#env, by, idOf(ruleId));
    });
  }

  async grantException(exception: ExceptionInput): Promise<PolicyException> {
    return await withPerson(
      this.#check,
      async (by) => await grantException(this.#env, by, exception)
    );
  }

  async revokeException(ruleId: string, appId: string): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await revokeException(this.#env, by, idOf(ruleId), idOf(appId));
    });
  }
}
