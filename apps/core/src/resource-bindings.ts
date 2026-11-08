import { collections } from "@grasp-os/brain/schema";
import type { AnyPermission } from "@grasp-os/sdk";
import { actionPermission, actionPermissions } from "@grasp-os/sdk/host";
import { appErrors } from "@grasp-os/shared/apps";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import type { HeldBinding } from "@grasp-os/shared/capability";
import { identifierMaxLength } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { bindingSpendListed } from "@grasp-os/shared/models";
import type { ModelSettings } from "@grasp-os/shared/models";
import { operationErrors } from "@grasp-os/shared/operations";
import {
  bindingApprovalSchema,
  bindingTargetSchema,
  resourceBindingErrors,
} from "@grasp-os/shared/resource-bindings";
import type {
  BindingChoices,
  BindingLabel,
  BindingState,
  BindingTarget,
  DeclaredResource,
  ResourceBinding,
  ResourceBindingsReview,
} from "@grasp-os/shared/resource-bindings";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import { appFor, findApp } from "./apps.ts";
import { auditedBatch, outboxedIfChanged } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { personOf } from "./connections.ts";
import { appResourceBindings, apps, permissions } from "./db/core/schema.ts";
// Each list bound as one parameter: a review may name more permissions or
// collections than D1's 100 bound parameters.
import { inList } from "./db/d1.ts";
import { bindingKey, bindingSpendOf } from "./model-spend.ts";
import { modelSettings, usableAnswerTokens } from "./models.ts";
import type { BoundResource, ResourceBindings } from "./operations.ts";
import {
  requireMemberAdmin,
  requireStillAdmin,
  stillAdminSql,
} from "./permissions.ts";
import { targetKindOf, unchecked } from "./resource-adapter.ts";
import type {
  BindingCaller,
  ContractAsks,
  DeclarationOf,
  ResourceAdapter,
  ServedBinding,
} from "./resource-adapter.ts";
import { connectorAdapter, contractReader } from "./resource-connector.ts";
import type {
  ConnectionGrantRow,
  ContractReader,
} from "./resource-connector.ts";
import { declarationHash } from "./resource-declarations.ts";
import { graspAdapter } from "./resource-grasp.ts";
import { guestsAdapter } from "./resource-guests.ts";
import { knowledgeAdapter } from "./resource-knowledge.ts";
import { modelAdapter, modelAnswers } from "./resource-model.ts";
import { platformGrantsOf } from "./resource-platform.ts";
import type { PlatformAction } from "./resource-platform.ts";

// Approved resource bindings (spec 12, 16.1, 32.3): what lets an action of
// an App of spec 8's layout reach what its permissions declare: a model
// (`ctx.ai`), a connection (`ctx.connections.<alias>`), the Brain
// (`ctx.brain`), the platform's own functions (`ctx.grasp`) and
// guest chats (`ctx.guests`). Threat model, and
// how each is closed:
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
// - A binding the review misses: a request resolves only an alias the
//   release's manifest declares as a permission an action reaches, of the
//   kind its row was approved for, which the operation host checks first
//   (operations.ts). The review lists exactly the manifest's
//   declarations, and every active row of an alias it doesn't declare as
//   `undeclared`, which serves nothing: no binding reaches a version
//   without being listed with it.
// - An approval races a version change: the admin names the version they
//   reviewed; the batch writes only while it is still current, as a
//   permission grant does (`app.conflict` otherwise).
//
// A binding is the host's record, never part of a sealed manifest: it is
// approved after the release is sealed and can be revoked at any time, so
// `manifest.bindings` stays empty and the pins above do its work.

/** Each kind's adapter. */
const adapters: {
  readonly [Kind in BindingTarget["kind"]]: ResourceAdapter<Kind>;
} = {
  model: modelAdapter,
  knowledge: knowledgeAdapter,
  connector: connectorAdapter,
  grasp: graspAdapter,
  guests: guestsAdapter,
};

/**
 * `target` bound for `declaration`, by its kind's adapter: with a review's
 * `asks`, sharing and bounding what it asks connect.
 */
const bindWith = async (
  env: Env,
  app: AppId,
  declaration: AnyPermission,
  target: BindingTarget,
  asks?: ContractAsks
): Promise<ServedBinding | undefined | typeof unchecked> => {
  if (targetKindOf(declaration) !== target.kind) {
    return undefined;
  }
  const adapter = adapters[target.kind];
  // SAFETY: the declaration's kind is the target's, checked above, and
  // `adapters` holds each kind's own adapter.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const loose = adapter as ResourceAdapter<BindingTarget["kind"]> | undefined;
  return await loose?.bind(env, app, declaration, target, asks);
};

/** `target` bound for `declaration` now, asking every provider live. */
const boundBy = async (
  env: Env,
  app: AppId,
  declaration: AnyPermission,
  target: BindingTarget
): Promise<ServedBinding | undefined> => {
  const served = await bindWith(env, app, declaration, target);
  // Only a review's limit leaves a target unchecked; this one has none.
  return served === unchecked ? undefined : served;
};

type Row = typeof appResourceBindings.$inferSelect;

/**
 * Drops the held actions App `app` made through binding `bindingId`, now
 * revoked or replaced: none of them could be confirmed anyway
 * (`requireHeldBinding`), so the person isn't asked about them. Best
 * effort: the check on confirming is what holds.
 */
const dropHeldFor = async (
  env: Env,
  app: string,
  bindingId: string
): Promise<void> => {
  try {
    await env.CONNECT.dropForBinding({ appId: app, bindingId });
  } catch (error) {
    log.warn("resource_binding.drop_failed", {
      binding: bindingId,
      ...errorFields(error),
    });
  }
};

/** `text` as JSON; undefined when it isn't. */
const jsonOrUndefined = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** What the API returns of a row, but its target. */
const rowFields = (row: Row): Omit<ResourceBinding, "target"> => ({
  id: row.id,
  appId: row.appId,
  alias: row.alias,
  kind: row.kind,
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

/**
 * A row as the API returns it; undefined when its target no longer parses
 * (a kind there is no more, such as a binding to another App written by
 * an older version while this one deployed), so a list leaves it out, as
 * the other readers of a row's target do.
 */
const bindingOf = (row: Row): ResourceBinding | undefined => {
  const target = bindingTargetSchema.safeParse(jsonOrUndefined(row.target));
  return target.success
    ? { ...rowFields(row), target: target.data }
    : undefined;
};

/** `row` as the API returns it, or `resource.binding_not_found` when it can't be read. */
const toBinding = (row: Row): ResourceBinding => {
  const binding = bindingOf(row);
  if (binding === undefined) {
    throw resourceBindingErrors.create("resource.binding_not_found");
  }
  return binding;
};

/** What the audit log records of a binding's target: IDs only. */
const targetDetail = (target: BindingTarget): Record<string, Json> => {
  if (target.kind === "model") {
    return { model: target.model };
  }
  if (target.kind === "connector") {
    return { permissionId: target.permissionId };
  }
  if (target.kind === "knowledge") {
    // A detail is one identifier-sized value: the permissions, joined,
    // when they fit; their number otherwise (the row keeps them all).
    const ids = [...new Set(Object.values(target.collections))].toSorted();
    const joined = ids.join(" ");
    return joined.length <= identifierMaxLength
      ? { permissionIds: joined }
      : { permissionCount: ids.length };
  }
  return { permissionId: target.permissionId };
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
 * The longest single request an `ai` permission asks for: its whole bound,
 * as a request for text spends it (`tokensOfBound`), whoever uses it. A
 * request that asks for a value, and a workflow's AI step, ask for half.
 */
const longestAsk = ({ maxOutputTokens }: DeclarationOf<"model">): number =>
  maxOutputTokens;

/**
 * Refuses binding model resource `declaration` to `model` unless the model
 * can give its longest request (`longestAsk`), by the gateway's measure:
 * otherwise every such request would be refused at run time (models.ts).
 */
const requireModelAnswers = (
  declaration: DeclarationOf<"model">,
  model: string
): void => {
  const maxTokens = longestAsk(declaration);
  if (!modelAnswers(model, maxTokens)) {
    throw resourceBindingErrors.create("resource.model_too_small", {
      maxTokens,
      usableTokens: usableAnswerTokens(model) ?? 0,
    });
  }
};

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
  const declaration = actionPermission(release.app, alias);
  if (declaration === undefined || targetKindOf(declaration) !== target.kind) {
    throw resourceBindingErrors.create("resource.undeclared");
  }
  const served = await boundBy(env, found.id, declaration, target);
  if (served === undefined) {
    throw resourceBindingErrors.create("resource.target_invalid");
  }
  // A model the deployment allows, which can serve the declaration only
  // when it can give the answers it asks for.
  if (declaration["~permission"] === "ai" && target.kind === "model") {
    requireModelAnswers(declaration, target.model);
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
  if (previous !== undefined) {
    await dropHeldFor(env, found.id, previous.id);
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
  // One whose target no longer parses is no binding the API shows.
  if (found === undefined || bindingOf(found) === undefined) {
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
    // Answered as it stands now: another revoke, or a replacing approval,
    // may have revoked it since it was read.
    await requireStillAdmin(env, by);
    const now = await drizzle(env.DB)
      .select()
      .from(appResourceBindings)
      .where(eq(appResourceBindings.id, found.id))
      .get();
    return toBinding(now ?? found);
  }
  await dropHeldFor(env, row.appId, row.id);
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
  const found = isMemberAdmin(by)
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
  return rows.flatMap((row) => bindingOf(row) ?? []);
};

/** Why an active binding doesn't serve its declaration now. */
type NotServed =
  /** The current declaration is of another kind. */
  | "kind"
  /** The stored target doesn't read. */
  | "unreadable"
  /** The current declaration isn't the approved one. */
  | "declaration"
  /** The target can't be bound any more. */
  | "unbindable"
  /** The target serves another contract, or a changed one. */
  | "drift"
  /** A review's limit on asking connect left it unchecked. */
  | "unchecked";

/** How an active binding resolves for a declaration now. */
type Resolution =
  | {
      readonly state: "served";
      readonly served: ServedBinding;
      /** What it binds, as its row names it. */
      readonly target: BindingTarget;
    }
  | {
      readonly state: Exclude<BindingState, "served" | "unbound">;
      readonly why: NotServed;
    };

/**
 * Whether `row`, the active binding of `declaration`'s alias of `app`,
 * serves it now: approved for exactly this declaration, and its target
 * still serving exactly the contract it served then. Both a request's
 * resolution and an admin's review read it here, so the review says
 * exactly what the next request will find. It logs nothing: a request
 * does, a review doesn't.
 */
const resolved = async (
  env: Env,
  app: AppId,
  declaration: AnyPermission,
  row: Row,
  asks?: ContractAsks
): Promise<Resolution> => {
  if (row.kind !== targetKindOf(declaration)) {
    return { state: "declaration_changed", why: "kind" };
  }
  const target = bindingTargetSchema.safeParse(JSON.parse(row.target));
  if (!target.success) {
    return { state: "grant_lost", why: "unreadable" };
  }
  if ((await declarationHash(declaration)) !== row.declarationHash) {
    return { state: "declaration_changed", why: "declaration" };
  }
  const served = await bindWith(env, app, declaration, target.data, asks);
  // Never served unless checked: a review that ran out of asks says so.
  if (served === unchecked) {
    return { state: "unchecked", why: "unchecked" };
  }
  if (served === undefined) {
    return { state: "grant_lost", why: "unbindable" };
  }
  return served.contractId === row.contractId &&
    served.fingerprint === row.fingerprint
    ? { state: "served", served, target: target.data }
    : { state: "contract_changed", why: "drift" };
};

/** The most choices of one kind a review offers. */
const choicesMax = 100;

/**
 * The most times one review asks connect what a connection serves, across
 * all its connector resources: each (connection, contract) is asked once,
 * and what is left past this is left out, marked truncated.
 */
const reviewContractAsksMax = 50;

const actionListSchema = z.array(z.string());

/**
 * The App's own active permissions on objects of `objectType`, newest
 * first: at most `choicesMax`, and whether there were more.
 */
const appGrants = async (
  env: Env,
  app: AppId,
  objectType: "connection" | "collection"
): Promise<{ rows: ConnectionGrantRow[]; truncated: boolean }> => {
  const rows = await drizzle(env.DB)
    .select({
      id: permissions.id,
      objectId: permissions.objectId,
      resource: permissions.resource,
      actions: permissions.actions,
    })
    .from(permissions)
    .where(
      and(
        eq(permissions.subjectType, "app"),
        eq(permissions.subjectId, app),
        eq(permissions.objectType, objectType),
        eq(permissions.status, "active"),
        isNull(permissions.chatId)
      )
    )
    .orderBy(desc(permissions.grantedAt))
    .limit(choicesMax + 1);
  return {
    rows: rows.slice(0, choicesMax),
    truncated: rows.length > choicesMax,
  };
};

/** What one review reads once, for every declared resource's choices. */
interface ReviewGrants {
  readonly connections: Awaited<ReturnType<typeof appGrants>>;
  readonly collections: Awaited<ReturnType<typeof appGrants>>;
  /** The collections' names, by ID. */
  readonly names: ReadonlyMap<string, string>;
  readonly contracts: ContractReader;
  /**
   * The App's own active `{ type: "platform" }` permissions of `action`,
   * newest first, at most `choicesMax`: read once for each action, when
   * the platform's functions (`grasp`) or a guests permission asks.
   */
  readonly platform: (
    action: PlatformAction
  ) => Promise<{ ids: string[]; truncated: boolean }>;
}

/** The App's grants and their collections' names, read once for a review. */
const reviewGrants = async (
  env: Env,
  app: AppId,
  contracts: ContractReader
): Promise<ReviewGrants> => {
  const [connections, collectionGrants] = await Promise.all([
    appGrants(env, app, "connection"),
    appGrants(env, app, "collection"),
  ]);
  const readable = collectionGrants.rows.filter(
    ({ actions }) =>
      actionListSchema.safeParse(JSON.parse(actions)).data?.includes("read") ===
      true
  );
  const ids = [...new Set(readable.map(({ objectId }) => objectId))];
  const named =
    ids.length === 0
      ? []
      : await drizzle(env.KNOWLEDGE)
          .select({ id: collections.id, name: collections.name })
          .from(collections)
          .where(inList(collections.id, ids));
  const platform = new Map<PlatformAction, Promise<string[]>>();
  return {
    platform: async (action) => {
      const reading =
        platform.get(action) ??
        platformGrantsOf(env, app, action, choicesMax + 1);
      platform.set(action, reading);
      const granted = await reading;
      return {
        ids: granted.slice(0, choicesMax),
        truncated: granted.length > choicesMax,
      };
    },
    connections,
    collections: { rows: readable, truncated: collectionGrants.truncated },
    names: new Map(named.map(({ id, name }) => [id, name])),
    contracts,
  };
};

/**
 * What `declaration` may be bound to now, from the grants the review read.
 * A connector's choices are those its adapter binds, so each is one
 * approving accepts; the other kinds' are checked as they are approved.
 */
const choicesFor = async (
  env: Env,
  declaration: AnyPermission,
  grants: ReviewGrants
): Promise<BindingChoices> => {
  const kind = targetKindOf(declaration);
  if (declaration["~permission"] === "ai") {
    const { models: allowed } = await modelSettings(env);
    return {
      kind: "model",
      // Only those approving accepts: each can give its longest request.
      models: allowed.filter((model) =>
        modelAnswers(model, longestAsk(declaration))
      ),
      truncated: false,
    };
  }
  if (declaration["~permission"] === "connections") {
    const { rows, truncated } = grants.connections;
    const serving = await Promise.all(
      rows.map(
        async (row) =>
          [row, await grants.contracts.serves(row, declaration)] as const
      )
    );
    return {
      kind: "connector",
      permissions: serving
        .filter(([, serves]) => serves === true)
        .map(([row]) => ({
          permissionId: row.id,
          connectionId: row.objectId,
          resource: row.resource,
        })),
      truncated:
        truncated || serving.some(([, serves]) => serves === undefined),
    };
  }
  if (kind === "grasp" || kind === "guests") {
    const granted = await grants.platform(
      kind === "grasp" ? "statistics" : "guests"
    );
    return {
      kind,
      permissions: granted.ids.map((permissionId) => ({ permissionId })),
      truncated: granted.truncated,
    };
  }
  return {
    kind: "knowledge",
    permissions: grants.collections.rows.map((row) => ({
      permissionId: row.id,
      collectionId: row.objectId,
      name: grants.names.get(row.objectId) ?? null,
    })),
    truncated: grants.collections.truncated,
  };
};

/**
 * How a review names each of `rows`' own bound target, for anyone who may
 * read the review, builders included: a connector binding's connection,
 * as `by` can see it in their own connections (connect lists them a
 * person's personal ones and the shared ones), and a knowledge binding's
 * collections by name. Only the targets bound, never what else the App
 * holds: that is an admin's choices.
 */
const targetLabels = async (
  env: Env,
  by: Identity,
  rows: readonly Row[]
): Promise<(row: Row) => BindingLabel> => {
  const targets = new Map<string, BindingTarget>();
  for (const row of rows) {
    const target = bindingTargetSchema.safeParse(jsonOrUndefined(row.target));
    if (target.success) {
      targets.set(row.id, target.data);
    }
  }
  const permissionIds = [
    ...new Set(
      [...targets.values()].flatMap((target) => {
        if (target.kind === "connector") {
          return [target.permissionId];
        }
        return target.kind === "knowledge"
          ? Object.values(target.collections)
          : [];
      })
    ),
  ];
  const objects =
    permissionIds.length === 0
      ? []
      : await drizzle(env.DB)
          .select({ id: permissions.id, objectId: permissions.objectId })
          .from(permissions)
          .where(inList(permissions.id, permissionIds));
  const objectOf = new Map(objects.map(({ id, objectId }) => [id, objectId]));
  const connectorBound = [...targets.values()].some(
    ({ kind }) => kind === "connector"
  );
  const visible = connectorBound
    ? await env.CONNECT.listConnections(await personOf(env, by))
    : [];
  const collectionIds = [...targets.values()].flatMap((target) =>
    target.kind === "knowledge"
      ? Object.values(target.collections).flatMap(
          (id) => objectOf.get(id) ?? []
        )
      : []
  );
  const named =
    collectionIds.length === 0
      ? []
      : await drizzle(env.KNOWLEDGE)
          .select({ id: collections.id, name: collections.name })
          .from(collections)
          .where(inList(collections.id, [...new Set(collectionIds)]));
  const nameOf = new Map(named.map(({ id, name }) => [id, name]));
  return (row) => {
    const target = targets.get(row.id);
    if (target?.kind === "connector") {
      const connectionId = objectOf.get(target.permissionId);
      const connection = visible.find(({ id }) => id === connectionId);
      return {
        connection:
          connection === undefined
            ? null
            : {
                account: connection.accountName,
                provider: connection.provider,
              },
        collections: {},
      };
    }
    if (target?.kind === "knowledge") {
      return {
        connection: null,
        collections: Object.fromEntries(
          Object.entries(target.collections).map(([name, permission]) => {
            const collection = objectOf.get(permission);
            return [
              name,
              collection === undefined
                ? null
                : (nameOf.get(collection) ?? null),
            ];
          })
        ),
      };
    }
    return { connection: null, collections: {} };
  };
};

/**
 * The Brain's or guests' declared operations, or the platform's functions,
 * by path; none for other kinds.
 */
const operationsOf = (declaration: AnyPermission): string[] => {
  if (
    declaration["~permission"] === "brain" ||
    declaration["~permission"] === "guests"
  ) {
    return [...declaration.operations];
  }
  return declaration["~permission"] === "grasp"
    ? Object.keys(declaration.functions).toSorted()
    : [];
};

/** What a review says of `declaration`, apart from how it is bound. */
const declaredOf = (declaration: AnyPermission) => ({
  alias: declaration.alias,
  kind: targetKindOf(declaration),
  contract:
    declaration["~permission"] === "connections" ? declaration.contract : null,
  actions:
    declaration["~permission"] === "connections"
      ? [...declaration.actions]
      : [],
  operations: operationsOf(declaration),
  collections:
    declaration["~permission"] === "brain" ? [...declaration.collections] : [],
  maxOutputTokens:
    declaration["~permission"] === "ai" ? declaration.maxOutputTokens : null,
});

/**
 * What the App's current version declares for its actions, each with its
 * active binding and whether that serves it now (as the next request
 * would find it), and for admins of the organization what it may be
 * bound to: for them and the App's builders. Reads only.
 */
export const reviewResourceBindings = async (
  env: Env,
  by: Identity,
  app: unknown,
  /** How many times it may ask connect; only a test sets it lower. */
  contractAsksMax = reviewContractAsksMax
): Promise<ResourceBindingsReview> => {
  const decides = isMemberAdmin(by);
  const found = decides
    ? await findApp(env, app)
    : await appFor(env, by, app, "builder");
  const rows = await drizzle(env.DB)
    .select()
    .from(appResourceBindings)
    .where(
      and(
        eq(appResourceBindings.appId, found.id),
        eq(appResourceBindings.status, "active")
      )
    );
  const byAlias = new Map(rows.map((row) => [row.alias, row]));
  const version = found.currentVersion;
  const release =
    version === null ? undefined : await loadRelease(env, found.id, version);
  const declared = (
    release === undefined ? [] : actionPermissions(release.app)
  ).map((declaration): [string, AnyPermission] => [
    declaration.alias,
    declaration,
  ]);
  // Read once for every resource's choices, and only for who gets them.
  // One reader for the whole review: the bindings it checks and the
  // choices it offers ask connect each (connection, contract) once, and no
  // more than the limit in all.
  const contracts = contractReader(env, contractAsksMax);
  const grants = decides
    ? await reviewGrants(env, found.id, contracts)
    : undefined;
  const declaredRows = declared.flatMap(([alias]) => byAlias.get(alias) ?? []);
  const labelOf = await targetLabels(env, by, declaredRows);
  const resources = await Promise.all(
    declared.map(async ([alias, declaration]): Promise<DeclaredResource> => {
      const row = byAlias.get(alias);
      const resolution =
        row === undefined
          ? undefined
          : await resolved(env, found.id, declaration, row, contracts.asks);
      const binding = row === undefined ? undefined : bindingOf(row);
      return {
        ...declaredOf(declaration),
        state: resolution?.state ?? "unbound",
        binding:
          row === undefined || binding === undefined
            ? null
            : { ...binding, label: labelOf(row) },
        choices:
          grants === undefined
            ? null
            : await choicesFor(env, declaration, grants),
      };
    })
  );
  const aliases = new Set(declared.map(([alias]) => alias));
  return {
    app: found.id,
    version,
    resources,
    undeclared: rows
      .filter(({ alias }) => !aliases.has(alias))
      .toSorted((one, other) => one.alias.localeCompare(other.alias))
      .flatMap((row) => bindingOf(row) ?? []),
    truncated: contracts.truncated(),
  };
};

/**
 * How core binds `app`'s declared resources for one invocation, for
 * `caller` (see the header): on every request, the alias's active binding,
 * if it was approved for exactly this declaration and its target still
 * serves exactly the contract it served then; undefined otherwise, which
 * the operation host answers as `resource.unavailable`.
 */
export const resourceBindingsFor = (
  env: Env,
  given: BindingCaller
): ResourceBindings => {
  // One count of what the invocation used, across all its requests.
  const caller: BindingCaller = {
    ...given,
    counts: given.counts ?? new Map<string, number>(),
  };
  return async (
    declaration: AnyPermission
  ): Promise<BoundResource | undefined> => {
    const row = await activeRow(env, caller.app, declaration.alias);
    if (row === undefined) {
      return undefined;
    }
    const resolution = await resolved(env, caller.app, declaration, row);
    if (resolution.state !== "served") {
      if (resolution.why === "unreadable") {
        log.error("resource_binding.unreadable", { binding: row.id });
      } else if (
        resolution.why === "unbindable" ||
        resolution.why === "drift"
      ) {
        log.warn("resource_binding.not_served", {
          binding: row.id,
          contractId: row.contractId,
          state: resolution.state,
        });
      }
      return undefined;
    }
    const { served } = resolution;
    return {
      kind: declaration["~permission"],
      contract:
        declaration["~permission"] === "connections"
          ? declaration.contract
          : null,
      call: async (method, args, context) =>
        await served.call(
          caller,
          { method, args },
          context,
          {
            id: row.id,
            declarationHash: row.declarationHash,
            fingerprint: row.fingerprint,
          },
          { alias: row.alias }
        ),
    };
  };
};

/** A held call its binding no longer serves. */
const notServed = () => operationErrors.create("resource.unavailable");

/**
 * Refuses a held call of App `app` through binding `pin` unless the
 * binding would still serve it now, exactly as a live request of the App's
 * current version would resolve it (`resourceBindingsFor`): the binding is
 * the same one and still active, the current release declares exactly
 * what was approved, the binding
 * resolves as a live request's would (its target serving exactly the
 * contract pinned), and that contract still names the call's tool. A
 * binding revoked or replaced since, a version that widened the
 * declaration, a drifted contract or a lost grant: `resource.unavailable`, and nothing runs.
 */
export const requireHeldBinding = async (
  env: Env,
  app: AppId,
  pin: HeldBinding,
  tool: string
): Promise<void> => {
  const row = await drizzle(env.DB)
    .select()
    .from(appResourceBindings)
    .where(
      and(
        eq(appResourceBindings.id, pin.id),
        eq(appResourceBindings.appId, app),
        eq(appResourceBindings.status, "active")
      )
    )
    .get();
  const found = row === undefined ? undefined : await findApp(env, app);
  if (
    row === undefined ||
    found?.currentVersion === null ||
    found === undefined ||
    row.declarationHash !== pin.declarationHash ||
    row.fingerprint !== pin.fingerprint
  ) {
    throw notServed();
  }
  const release = await loadRelease(env, found.id, found.currentVersion);
  // As a live request needs: the current release declares it.
  const declaration = actionPermission(release.app, row.alias);
  if (declaration === undefined) {
    throw notServed();
  }
  // Resolved as a live request resolves it (`resolved`): its kind, target,
  // declaration and contract, all as now. Then what only a held
  // call needs: its contract still names the call's tool.
  const resolution = await resolved(env, found.id, declaration, row);
  if (
    resolution.state !== "served" ||
    resolution.served.tools?.includes(tool) !== true
  ) {
    throw notServed();
  }
};

/**
 * The Apps' active model bindings, by App name and alias (at most
 * `bindingSpendListed`, and whether more are bound), each with what its
 * requests spent in `month`: for admins to read (models-rpc.ts), who core
 * checks. Spend is read by App and alias (`bindingKey`), never the
 * binding's row, so approving the alias again keeps it. One whose
 * target can't be read is listed with a null `model`, as it serves
 * nothing.
 */
export const modelBindingSpend = async (
  env: Pick<Env, "DB">,
  month: string
): Promise<ModelSettings["bindings"]> => {
  // One more than are listed, to tell whether any are left out.
  const rows = await drizzle(env.DB)
    .select({ row: appResourceBindings, appName: apps.name })
    .from(appResourceBindings)
    .innerJoin(apps, eq(apps.id, appResourceBindings.appId))
    .where(
      and(
        eq(appResourceBindings.status, "active"),
        eq(appResourceBindings.kind, "model")
      )
    )
    .orderBy(
      asc(apps.name),
      asc(appResourceBindings.alias),
      asc(appResourceBindings.appId)
    )
    .limit(bindingSpendListed + 1);
  const listed = rows.slice(0, bindingSpendListed).map(({ row, appName }) => ({
    row,
    appName,
    key: bindingKey({ app: row.appId, alias: row.alias }),
  }));
  const spentByKey = await bindingSpendOf(
    env,
    month,
    listed.map(({ row }) => ({ app: row.appId, alias: row.alias }))
  );
  return {
    listed: listed.map(({ row, appName, key }) => {
      // Each target read without throwing, so one stored damaged never
      // hides the others.
      const target = bindingTargetSchema.safeParse(jsonOrUndefined(row.target));
      return {
        appId: row.appId,
        appName,
        alias: row.alias,
        model:
          target.success && target.data.kind === "model"
            ? target.data.model
            : null,
        thisMonth: spentByKey.get(key) ?? 0,
      };
    }),
    more: rows.length > bindingSpendListed,
  };
};
