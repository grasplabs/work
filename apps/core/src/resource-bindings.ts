import type { AnyResource } from "@grasp-os/sdk";
import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { jsonOf } from "@grasp-os/shared/operations";
import {
  bindingApprovalSchema,
  bindingTargetSchema,
  resourceBindingErrors,
} from "@grasp-os/shared/resource-bindings";
import type {
  BindingTarget,
  ResourceBinding,
} from "@grasp-os/shared/resource-bindings";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { loadRelease } from "./app-releases.ts";
import { appFor, findApp } from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { appResourceBindings, apps } from "./db/core/schema.ts";
import type { BoundResource, ResourceBindings } from "./operations.ts";
import {
  requireMemberAdmin,
  requireStillAdmin,
  stillAdminSql,
} from "./permissions.ts";
import type {
  BindingCaller,
  ResourceAdapter,
  ServedContract,
} from "./resource-adapter.ts";
import { modelAdapter } from "./resource-model.ts";

// Approved resource bindings (spec 12, 16.1, 32.3): what lets an action of
// an App of spec 8's layout reach a model, a connection, knowledge or a
// template through `ctx.resources.<alias>`. Threat model, and how each is
// closed:
//
// - A declaration self-grants: a declaration is App code's requirement and
//   nothing more. An alias resolves only through an active row here, which
//   only an admin of the organization writes (never Grasp staff or a
//   builder), re-checked in the writing statement (`stillAdminSql`), and
//   audited. No request, manifest or App code names a provider.
// - A binding serves more than was reviewed: a row pins the exact
//   declaration the admin approved, by its SHA-256 as the reviewed version
//   sealed it (`declarationHash`), and resolves only for a release whose
//   declaration hashes the same. A later version that widens it (another
//   contract, more actions or collections, another output) gets
//   `resource.unavailable` until an admin approves again.
// - A provider's contract drifts: a row pins the contract its target served
//   at approval (`contractId`, `fingerprint`), and each request asks the
//   adapter what the target serves now; any difference, or a target the
//   App may no longer bind (a permission revoked, a model the deployment
//   no longer allows), refuses the request (`resource.unavailable`).
// - Revocation between calls: nothing is resolved once per invocation.
//   Each resource request reads the row and asks its adapter again, and
//   each adapter goes through the live grant (the permission check, the
//   delegate read, the gateway's rules) on every call. So revoking the
//   binding or what it names stops the next request, even within one
//   action.
// - A binding of one App serves another: rows are found by the release's
//   own App, never by anything the caller sends; the adapter acts for the
//   invocation's authority, the App and the person core resolved.
// - An approval races a version change: the admin names the version they
//   reviewed; the batch writes only while it is still current, as a
//   permission grant does (`app.conflict` otherwise).
//
// A binding is the host's record, never part of a sealed manifest: it is
// approved after the release is sealed and can be revoked at any time, so
// `manifest.bindings` stays empty and the pins above do its work.

/** Each kind's adapter. */
const adapters: {
  readonly [Kind in BindingTarget["kind"]]?: ResourceAdapter<Kind>;
} = {
  model: modelAdapter,
};

/** The SHA-256 of `declaration`, canonical, as a release sealed it. */
export const declarationHash = async (
  declaration: AnyResource
): Promise<string> => {
  const json = jsonOf(declaration);
  if (json === undefined) {
    throw new Error("A resource declaration is JSON");
  }
  return await sha256Hex(canonicalJson(json));
};

/** What `target` serves for `declaration`, by its kind's adapter. */
const servedBy = async (
  env: Env,
  app: AppId,
  declaration: AnyResource,
  target: BindingTarget
): Promise<ServedContract | undefined> => {
  if (declaration["~resource"] !== target.kind) {
    return undefined;
  }
  const adapter = adapters[target.kind];
  // SAFETY: the declaration's kind is the target's, checked above, and
  // `adapters` holds each kind's own adapter.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const loose = adapter as ResourceAdapter<BindingTarget["kind"]> | undefined;
  return await loose?.served(env, app, declaration, target);
};

type Row = typeof appResourceBindings.$inferSelect;

/** A row as the API returns it. */
const toBinding = (row: Row): ResourceBinding => ({
  id: row.id,
  appId: row.appId,
  alias: row.alias,
  kind: row.kind,
  target: bindingTargetSchema.parse(JSON.parse(row.target)),
  contractId: row.contractId,
  fingerprint: row.fingerprint,
  declarationHash: row.declarationHash,
  reviewedVersion: row.reviewedVersion,
  status: row.status,
  approvedBy: row.approvedBy,
  approvedAt: row.approvedAt.toISOString(),
  revokedBy: row.revokedBy,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

/** What the audit log records of a binding's target: IDs only. */
const targetDetail = (target: BindingTarget): Record<string, Json> => {
  if (target.kind === "model") {
    return { model: target.model };
  }
  if (target.kind === "connector") {
    return { permissionId: target.permissionId };
  }
  if (target.kind === "knowledge") {
    return { permissionIds: Object.values(target.collections).toSorted() };
  }
  return { templateId: target.templateId, templateVersion: target.version };
};

type Admin = Identity & Pick<Acting, "actor">;

const bindingEntry = (
  by: Admin,
  action: string,
  row: Pick<Row, "id" | "appId" | "alias" | "kind">,
  detail: Record<string, Json>
): AuditEntry => ({
  actor: by.actor ?? actorOf(by),
  action,
  target: { type: "app", id: row.appId },
  detail: { binding: row.id, alias: row.alias, kind: row.kind, ...detail },
});

/** The active binding of `alias` of `app`, if any. */
const activeRow = async (
  env: Env,
  app: string,
  alias: string
): Promise<Row | undefined> =>
  await drizzle(env.DB)
    .select()
    .from(appResourceBindings)
    .where(
      and(
        eq(appResourceBindings.appId, app),
        eq(appResourceBindings.alias, alias),
        eq(appResourceBindings.status, "active")
      )
    )
    .get();

/**
 * Binds an alias of an App to a provider, as an admin of the organization
 * (`ResourceBindingsApi.approve`): for the alias as the reviewed version
 * declares it, while that version is still current, to a target its kind's
 * adapter says the App may bind. Replaces the active binding of the alias
 * in the same batch. Audited.
 */
export const approveResourceBinding = async (
  env: Env,
  by: Admin,
  input: unknown
): Promise<ResourceBinding> => {
  requireMemberAdmin(by);
  const { app, alias, target, reviewed } = resourceBindingErrors.parse(
    "resource.binding_invalid",
    bindingApprovalSchema,
    input
  );
  const found = await findApp(env, app);
  if (found.currentVersion !== reviewed.version) {
    throw appErrors.create("app.conflict");
  }
  const release = await loadRelease(env, found.id, reviewed.version);
  const declaration = Object.hasOwn(release.app.resources, alias)
    ? release.app.resources[alias]
    : undefined;
  if (declaration === undefined || declaration["~resource"] !== target.kind) {
    throw resourceBindingErrors.create("resource.undeclared");
  }
  const served = await servedBy(env, found.id, declaration, target);
  if (served === undefined) {
    throw resourceBindingErrors.create("resource.target_invalid");
  }
  const previous = await activeRow(env, found.id, alias);
  const now = new Date();
  const row: Row = {
    id: crypto.randomUUID(),
    appId: found.id,
    alias,
    kind: target.kind,
    target: canonicalJson(target),
    declarationHash: await declarationHash(declaration),
    contractId: served.contractId,
    fingerprint: served.fingerprint,
    reviewedVersion: reviewed.version,
    status: "active",
    approvedBy: by.userId,
    approvedAt: now,
    revokedBy: null,
    revokedAt: null,
  };
  // Written only while `by` is still an admin and the reviewed version
  // still current, both read by the statements themselves.
  const stillReviewed = sql`(SELECT ${apps.currentVersion} FROM ${apps} WHERE ${apps.id} = ${found.id}) IS ${reviewed.version}`;
  const allowed = and(stillAdminSql(by), stillReviewed);
  const db = drizzle(env.DB);
  // The alias's binding until now, if it had one, is revoked in the same
  // batch; without one, the update names no row and its event isn't kept.
  const replaced = previous ?? row;
  try {
    await auditedBatch(env, db, [
      db
        .update(appResourceBindings)
        .set({ status: "revoked", revokedBy: by.userId, revokedAt: now })
        .where(
          and(
            eq(appResourceBindings.id, previous?.id ?? ""),
            eq(appResourceBindings.status, "active"),
            allowed
          )
        ),
      outboxedIfChanged(
        db,
        bindingEntry(by, "app.resource_binding.revoked", replaced, {
          replacedBy: row.id,
        })
      ),
      db
        .insert(appResourceBindings)
        .select(
          sql`SELECT ${row.id}, ${row.appId}, ${row.alias}, ${row.kind}, ${row.target}, ${row.declarationHash}, ${row.contractId}, ${row.fingerprint}, ${row.reviewedVersion}, 'active', ${row.approvedBy}, ${now.getTime()}, NULL, NULL WHERE ${allowed}`
        ),
      outboxedIfChanged(
        db,
        bindingEntry(by, "app.resource_binding.approved", row, {
          version: reviewed.version,
          contractId: row.contractId,
          fingerprint: row.fingerprint,
          declarationHash: row.declarationHash,
          ...targetDetail(target),
        })
      ),
    ]);
  } catch (error) {
    // Another approval of the alias took its place first: the unique
    // active binding refused this one, and the batch changed nothing.
    if (
      error instanceof Error &&
      `${error.message} ${String(error.cause)}`.includes("UNIQUE constraint")
    ) {
      log.warn("resource_binding.approve_conflict", errorFields(error));
      throw appErrors.create("app.conflict");
    }
    throw error;
  }
  const written = await drizzle(env.DB)
    .select()
    .from(appResourceBindings)
    .where(eq(appResourceBindings.id, row.id))
    .get();
  if (written === undefined) {
    await requireStillAdmin(env, by);
    throw appErrors.create("app.conflict");
  }
  return toBinding(written);
};

/**
 * Revokes a binding, as an admin of the organization: the next request
 * through it is refused. Revoking one already revoked changes nothing.
 * Audited.
 */
export const revokeResourceBinding = async (
  env: Env,
  by: Admin,
  id: unknown
): Promise<ResourceBinding> => {
  requireMemberAdmin(by);
  const found =
    typeof id === "string" && id.length <= 64
      ? await drizzle(env.DB)
          .select()
          .from(appResourceBindings)
          .where(eq(appResourceBindings.id, id))
          .get()
      : undefined;
  if (found === undefined) {
    throw resourceBindingErrors.create("resource.binding_not_found");
  }
  const db = drizzle(env.DB);
  const [revoked] = await auditedBatch(env, db, [
    db
      .update(appResourceBindings)
      .set({ status: "revoked", revokedBy: by.userId, revokedAt: new Date() })
      .where(
        and(
          eq(appResourceBindings.id, found.id),
          eq(appResourceBindings.status, "active"),
          stillAdminSql(by)
        )
      )
      .returning(),
    outboxedIfChanged(
      db,
      bindingEntry(by, "app.resource_binding.revoked", found, {})
    ),
  ]);
  const [row] = revoked;
  if (row === undefined) {
    // Revoked already, or `by` is no longer an admin: only that refuses.
    await requireStillAdmin(env, by);
    return toBinding(found);
  }
  return toBinding(row);
};

/**
 * An App's bindings, active first, then newest first: for admins of the
 * organization and the App's builders.
 */
export const listResourceBindings = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<ResourceBinding[]> => {
  const found =
    isAdmin(by.role) && !by.staff
      ? await findApp(env, app)
      : await appFor(env, by, app, "builder");
  const rows = await drizzle(env.DB)
    .select()
    .from(appResourceBindings)
    .where(eq(appResourceBindings.appId, found.id))
    .orderBy(
      sql`${appResourceBindings.status} = 'active' DESC`,
      desc(appResourceBindings.approvedAt)
    )
    .limit(200);
  return rows.map(toBinding);
};

/**
 * How core binds `app`'s declared resources for one invocation, for
 * `caller` (see the header): on every request, the alias's active binding,
 * if it was approved for exactly this declaration and its target still
 * serves exactly the contract it served then; undefined otherwise, which
 * the operation host answers as `resource.unavailable`.
 */
export const resourceBindingsFor =
  (env: Env, caller: BindingCaller): ResourceBindings =>
  async (declaration: AnyResource): Promise<BoundResource | undefined> => {
    const row = await activeRow(env, caller.app, declaration.alias);
    if (row === undefined || row.kind !== declaration["~resource"]) {
      return undefined;
    }
    const target = bindingTargetSchema.safeParse(JSON.parse(row.target));
    if (!target.success) {
      log.error("resource_binding.unreadable", { binding: row.id });
      return undefined;
    }
    if ((await declarationHash(declaration)) !== row.declarationHash) {
      return undefined;
    }
    const served = await servedBy(env, caller.app, declaration, target.data);
    if (
      served?.contractId !== row.contractId ||
      served.fingerprint !== row.fingerprint
    ) {
      log.warn("resource_binding.not_served", {
        binding: row.id,
        contractId: row.contractId,
        served: served?.contractId ?? "none",
      });
      return undefined;
    }
    const adapter = adapters[target.data.kind];
    // SAFETY: as in `servedBy`: the row's kind is the declaration's and
    // the target's, and each kind has its own adapter.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const loose = adapter as ResourceAdapter<BindingTarget["kind"]> | undefined;
    if (loose === undefined) {
      return undefined;
    }
    const bound = target.data;
    return {
      kind: declaration["~resource"],
      contract:
        declaration["~resource"] === "connector" ||
        declaration["~resource"] === "template"
          ? declaration.contract
          : null,
      call: async (method, args, context) =>
        await loose.call(
          env,
          caller,
          declaration,
          bound,
          { method, args },
          context
        ),
    };
  };
