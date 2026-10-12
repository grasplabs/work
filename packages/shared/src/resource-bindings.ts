import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { appIdSchema, identifierSchema, permissionIdSchema } from "./ids.ts";

// Approved resource bindings (spec 12, 16.1, 32.3): which provider serves
// each resource an App of spec 8's layout declares for its actions. A
// declaration in App code is a requirement and grants nothing; an admin's
// binding, together with the live grant it names, is what lets an action
// reach a model, a connection, knowledge collections or a template.
//
// A binding is the host's record, never part of a sealed manifest: it is
// approved after a release is sealed and can be revoked at any time. It pins
// the exact declaration it was approved for (by hash), the contract it
// serves and that contract's fingerprint at approval, so it serves no
// widened declaration and no drifted contract.

/** A resource alias, as the SDK checks it. */
const aliasSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

/** A model, as the deployment's allowlist names it: `<provider>/<model>`. */
const modelNameSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z0-9-]+\/\S+$/u);

/**
 * What a binding binds an alias to, by the declaration's kind:
 *
 * - `model`: one model the deployment allows, called through the model
 *   gateway (its rules, budgets and accounting apply on every call);
 * - `connector`: one of the App's connection permissions, checked on every
 *   call, through connect;
 * - `knowledge`: one of the App's collection permissions for each
 *   collection the declaration names, read as a delegate on every call;
 * - `template`: one immutable version of a published template.
 */
export const bindingTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("model"), model: modelNameSchema }),
  z.strictObject({
    kind: z.literal("connector"),
    permissionId: permissionIdSchema,
  }),
  z.strictObject({
    kind: z.literal("knowledge"),
    /** The permission for each collection name the declaration lists. */
    collections: z
      .record(
        z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
        permissionIdSchema
      )
      .refine((map) => Object.keys(map).length <= 32, {
        message: "At most 32 collections",
      }),
  }),
  z.strictObject({
    kind: z.literal("template"),
    templateId: identifierSchema,
    version: z.int().min(1),
  }),
]);
export type BindingTarget = z.infer<typeof bindingTargetSchema>;
export type BindingTargetInput = z.input<typeof bindingTargetSchema>;

/** An admin's approval of a binding, as a client sends it. */
export const bindingApprovalSchema = z.strictObject({
  app: appIdSchema,
  alias: aliasSchema,
  target: bindingTargetSchema,
  /**
   * The version of the App the admin reviewed: the one current as they
   * decided. Its sealed declaration of the alias is what they approve, and
   * the approval is refused with `app.conflict` once another is current.
   */
  reviewed: z.strictObject({ version: z.int().min(1) }),
});
export type BindingApproval = z.input<typeof bindingApprovalSchema>;

/** A binding, as the API returns it. */
export interface ResourceBinding {
  id: string;
  appId: string;
  alias: string;
  kind: BindingTarget["kind"];
  target: BindingTarget;
  /** The contract it serves, and that contract's fingerprint at approval. */
  contractId: string;
  fingerprint: string;
  /** The SHA-256 of the declaration it was approved for. */
  declarationHash: string;
  /** The version whose declaration was reviewed. */
  reviewedVersion: number;
  status: "active" | "revoked";
  approvedBy: string;
  approvedAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}

/**
 * An App's resource bindings, over `/rpc`. Approving and revoking are for
 * admins of the organization only, never Grasp staff or builders, and
 * audited; listing is for admins and the App's builders.
 */
export interface ResourceBindingsApi {
  /**
   * Binds `alias` of the App to `target`, replacing the binding it had:
   * the alias must be declared, as an action resource of the target's
   * kind, by the reviewed version, which must still be current, and the
   * target must be one the App may use (its own active permission, a model
   * the deployment allows, a published template version of the declared
   * contract).
   *
   * What is approved is the declaration as the reviewed version seals it,
   * and it carries over to later versions that declare it identically,
   * approved or not: a binding grants reads as a permission to read does.
   * A connector's side effects still need a version an admin approved. For
   * a model, the declaration's `maxOutputTokens` is a hard ceiling on each
   * request of the App as a whole: an answer that must fit a structured
   * output may be asked for twice, and then each attempt gets half.
   */
  approve: (approval: BindingApproval) => Promise<ResourceBinding>;
  /** Revokes a binding: the next request through it is refused. */
  revoke: (id: string) => Promise<ResourceBinding>;
  /** The App's bindings, active first, then newest first. */
  list: (app: string) => Promise<ResourceBinding[]>;
}

/** Why a binding couldn't be approved, revoked or found. */
export const resourceBindingErrors = defineErrorFamily({
  "resource.binding_invalid": "That isn't a valid resource binding.",
  "resource.binding_not_found": "There's no such resource binding.",
  "resource.undeclared":
    "The reviewed version doesn't declare that resource for its actions, or declares it of another kind.",
  "resource.target_invalid":
    "That can't serve this resource: it isn't the App's own active grant, a model this deployment allows, or a published version of the declared template.",
});
