import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { appIdSchema, permissionIdSchema } from "./ids.ts";

// Approved resource bindings (spec 12, 16.1, 32.3): which provider serves
// each permission an App of spec 8's layout declares for its actions. A
// declaration in App code is a requirement and grants nothing; an admin's
// binding, together with the live grant it names, is what lets an action
// reach a model (`ai`), a connection, the Brain, another
// App, the platform's own functions (`grasp`) or guest chats.
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
 * What a binding binds an alias to, by the permission's kind:
 *
 * - `model` (`ai`): one model the deployment allows, called through the
 *   model gateway (its rules and accounting apply on every call);
 * - `connector` (`connections`): one of the App's connection permissions,
 *   checked on every call, through connect;
 * - `brain` (`brain`): one of the App's `{ type: "platform" }`
 *   permissions to read the Brain (`brain`), checked on every call, which
 *   recalls only what everyone in the company may read;
 * - `grasp` (`grasp`): the platform's own read-only
 *   functions, under one of the App's `{ type: "platform" }` permissions
 *   to read the platform's statistics (`statistics`), checked on every
 *   call;
 * - `guests` (`guests`): one of the App's `{ type: "platform" }`
 *   permissions to invite guests (`guests`), checked on every call, and by
 *   every guest's link of a chat invited through it, which the binding's
 *   revocation stops too.
 */
export const bindingTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("model"), model: modelNameSchema }),
  z.strictObject({
    kind: z.literal("connector"),
    permissionId: permissionIdSchema,
  }),
  z.strictObject({
    kind: z.literal("brain"),
    permissionId: permissionIdSchema,
  }),
  z.strictObject({
    kind: z.literal("grasp"),
    permissionId: permissionIdSchema,
  }),
  z.strictObject({
    kind: z.literal("guests"),
    permissionId: permissionIdSchema,
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
   * decided. Its sealed declaration of the alias is what they approve,
   * and the approval is refused with `app.conflict` once another is
   * current.
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
 * Whether a declared resource is served now, as a request of the App's
 * current version would resolve it:
 *
 * - `served`: its active binding serves it;
 * - `unbound`: it has no active binding;
 * - `declaration_changed`: the current version declares it differently
 *   from the version its binding was approved for;
 * - `contract_changed`: its binding's target serves another contract, or
 *   the same one changed, since it was approved;
 * - `grant_lost`: its binding's target can't be bound any more: the
 *   permission it names was revoked, or the deployment no longer allows
 *   its model;
 * - `unchecked`: the review couldn't ask connect about its binding within
 *   its limit, so it is never reported served; the next request checks it
 *   live.
 */
export type BindingState =
  | "served"
  | "unbound"
  | "declaration_changed"
  | "contract_changed"
  | "grant_lost"
  | "unchecked";

/** One of the App's connection permissions, as a connector's choice. */
export interface ConnectorChoice {
  permissionId: string;
  connectionId: string;
  /** The one resource of the connection it is limited to, if any. */
  resource: string | null;
}

/**
 * One of the App's `{ type: "platform" }` permissions, as the platform's
 * functions' (`grasp`), a guests or a brain permission's choice: to read
 * the platform's statistics, to invite guests, or to read the Brain.
 */
export interface PlatformChoice {
  permissionId: string;
}

/**
 * What an admin may bind a declared permission to now, by its kind:
 *
 * - `model`: the models the deployment allows;
 * - `connector`: the App's own active connection permissions that serve
 *   the declared contract and allow the tool of every declared action;
 * - `brain`: the App's own active permissions to read the Brain;
 * - `grasp`: the App's own active permissions to read the platform's
 *   statistics;
 * - `guests`: the App's own active permissions to invite guests.
 *
 * Approving checks the choice again: one that stopped serving since is
 * refused (`permission.target_invalid`). `truncated` says some were left
 * out: a review reads a bounded number of grants and versions, and asks
 * connect a bounded number of times.
 */
export type BindingChoices = { truncated: boolean } & (
  | { kind: "model"; models: string[] }
  | { kind: "connector"; permissions: ConnectorChoice[] }
  | { kind: "brain"; permissions: PlatformChoice[] }
  | { kind: "grasp"; permissions: PlatformChoice[] }
  | { kind: "guests"; permissions: PlatformChoice[] }
);

/**
 * How a review names a binding's own target, for everyone who may read the
 * review: only the target bound, never the App's other grants.
 */
export interface BindingLabel {
  /**
   * A connector binding's connection, while the reviewer can see it among
   * their own connections; null otherwise, and for other kinds.
   */
  connection: { account: string | null; provider: string } | null;
}

/**
 * A permission the App's current version declares for its actions, by
 * what it binds to (`kind`).
 */
export interface DeclaredResource {
  alias: string;
  kind: BindingTarget["kind"];
  /** A connection's contract; null for the other kinds. */
  contract: string | null;
  /** A connection's declared actions; empty for the other kinds. */
  actions: string[];
  /**
   * The Brain's declared operations, another App's or the platform's
   * functions, by path, or guests'; empty for the other kinds.
   */
  operations: string[];
  /** AI's output token ceiling; null for the other kinds. */
  maxOutputTokens: number | null;
  state: BindingState;
  /**
   * Its active binding, serving or not, with how its own target is named;
   * null when `unbound`.
   */
  binding: (ResourceBinding & { label: BindingLabel }) | null;
  /** What it may be bound to: for admins of the organization only. */
  choices: BindingChoices | null;
}

/** An App's declared resources and how each is bound, for its settings. */
export interface ResourceBindingsReview {
  app: string;
  /** The App's current version, null before it has one. */
  version: number | null;
  /** What the current version declares for its actions, by alias. */
  resources: DeclaredResource[];
  /**
   * Active bindings of aliases the current version doesn't declare: they
   * serve nothing until a version declares the alias again, and can be
   * revoked.
   */
  undeclared: ResourceBinding[];
  /**
   * The review reached its limit on asking connect: some bindings are
   * `unchecked`, or some connector choices left out (`truncated` there).
   */
  truncated: boolean;
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
   * the deployment allows, another App that serves what it declares).
   *
   * What is approved is the declaration as the reviewed version seals it,
   * and it carries over to later versions that declare it identically,
   * approved or not: a binding grants reads as a permission to read does.
   * For
   * a model, the declaration's `maxOutputTokens` is a hard ceiling on each
   * request of the App as a whole: an answer that must fit a structured
   * output may be asked for twice, and then each attempt gets half.
   */
  approve: (approval: BindingApproval) => Promise<ResourceBinding>;
  /** Revokes a binding: the next request through it is refused. */
  revoke: (id: string) => Promise<ResourceBinding>;
  /** The App's bindings, active first, then newest first. */
  list: (app: string) => Promise<ResourceBinding[]>;
  /**
   * What the App's current version declares for its actions, each with
   * whether a binding serves it now, and why not, and for admins what it
   * may be bound to. For admins and the App's builders.
   */
  review: (app: string) => Promise<ResourceBindingsReview>;
}

/** Why a binding couldn't be approved, revoked or found. */
export const resourceBindingErrors = defineErrorFamily({
  "permission.binding_invalid": "That isn't a valid binding of a permission.",
  "permission.binding_not_found": "There's no such binding of a permission.",
  "permission.undeclared":
    "The reviewed version doesn't declare that permission for its actions, or declares it of another kind.",
  "permission.model_too_small":
    "That model can't give an answer as long as this permission declares within its window. Choose a model with a larger window, or ask the App's builder for a smaller bound.",
  "permission.target_invalid":
    "That can't serve this permission: it isn't the App's own active grant, a model this deployment allows, or an App that serves what it declares.",
});
