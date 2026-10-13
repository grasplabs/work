import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { identifierMaxLength } from "./identifier.ts";
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

/** US dollars a binding budget may cap: a cent at least, well within an integer. */
const budgetDollarsSchema = z.number().min(0.01).max(1_000_000_000);

/**
 * What a model binding may spend, in US dollars at the providers' list
 * prices, on top of every budget the gateway already counts its requests
 * against (the deployment's, the person's, a workflow's, a run lineage's):
 *
 * - `perRequest`: one request of the App as a whole, every provider request
 *   it sends included (a structured output's second attempt, a retry);
 * - `perDay`: all the binding's requests in a UTC day;
 * - `perMonth`: all the binding's requests in a UTC month.
 *
 * At least one is set. The day and month count the alias's binding across
 * approvals, so approving it again changes the cap and keeps what was
 * spent. Admins are alerted at `alertAt` percent of a day's or month's
 * cap, and when it is reached.
 *
 * The caps cover only requests made through the binding, from the App's
 * actions. A workflow's own model steps (`step.model`) don't go through a
 * binding: they count against the deployment's, the workflow's, the
 * person's and the run lineage's budgets only.
 */
export const modelBindingBudgetSchema = z
  .strictObject({
    perRequest: budgetDollarsSchema.optional(),
    perDay: budgetDollarsSchema.optional(),
    perMonth: budgetDollarsSchema.optional(),
    /** The percent of a day's or month's cap at which admins are alerted. */
    alertAt: z.int().min(1).max(99).default(80),
  })
  .refine(
    ({ perRequest, perDay, perMonth }) =>
      perRequest !== undefined ||
      perDay !== undefined ||
      perMonth !== undefined,
    { message: "At least one cap" }
  );
export type ModelBindingBudget = z.output<typeof modelBindingBudgetSchema>;
export type ModelBindingBudgetInput = z.input<typeof modelBindingBudgetSchema>;

/** An admin's approval of a binding, as a client sends it. */
export const bindingApprovalSchema = z
  .strictObject({
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
    /** A model binding's own caps; none for no cap of its own. */
    budget: modelBindingBudgetSchema.optional(),
  })
  .refine(
    ({ target, budget }) => budget === undefined || target.kind === "model",
    { message: "Only a model binding has a budget" }
  );
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
  /** A model binding's own caps; null for none, or when damaged. */
  budget: ModelBindingBudget | null;
  /**
   * Its caps are stored but can't be read: it serves nothing until an
   * admin approves it again.
   */
  budgetDamaged: boolean;
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
 *   permission it names was revoked, the deployment no longer allows its
 *   model, or its template version can't be served;
 * - `unchecked`: the review couldn't ask connect about its binding within
 *   its limit, so it is never reported served; the next request checks it
 *   live;
 * - `budget_damaged`: its stored budget doesn't read (`budgetDamaged` on
 *   the binding), so it serves nothing rather than run uncapped, until an
 *   admin binds it again.
 *
 * A model binding's caps are on the binding itself (`budget`).
 */
export type BindingState =
  | "served"
  | "unbound"
  | "declaration_changed"
  | "contract_changed"
  | "grant_lost"
  | "unchecked"
  | "budget_damaged";

/** One of the App's connection permissions, as a connector's choice. */
export interface ConnectorChoice {
  permissionId: string;
  connectionId: string;
  /** The one resource of the connection it is limited to, if any. */
  resource: string | null;
}

/** One of the App's collection permissions, as a collection's choice. */
export interface CollectionChoice {
  permissionId: string;
  collectionId: string;
  /** The collection's name; null once it is gone. */
  name: string | null;
}

/**
 * What an admin may bind a declared resource to now, by its kind:
 *
 * - `model`: the models the deployment allows;
 * - `connector`: the App's own active connection permissions that serve
 *   the declared contract and allow the tool of every declared action;
 * - `knowledge`: the App's own active permissions to read a collection,
 *   one for each declared collection;
 * - `template`: the published versions of the declared contract.
 *
 * Approving checks the choice again: one that stopped serving since is
 * refused (`resource.target_invalid`). `truncated` says some were left
 * out: a review reads a bounded number of grants and versions, and asks
 * connect a bounded number of times.
 */
export type BindingChoices = { truncated: boolean } & (
  | { kind: "model"; models: string[] }
  | { kind: "connector"; permissions: ConnectorChoice[] }
  | { kind: "knowledge"; permissions: CollectionChoice[] }
  | { kind: "template"; versions: PublishedTemplate[] }
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
  /**
   * A knowledge binding's collections, by the names App code uses: each
   * bound collection's name, null once it is gone. Empty for other kinds.
   */
  collections: Record<string, string | null>;
}

/** A resource the App's current version declares for its actions. */
export interface DeclaredResource {
  alias: string;
  kind: BindingTarget["kind"];
  /** A connector's or a template's contract; null for the other kinds. */
  contract: string | null;
  /** A connector's declared actions; empty for the other kinds. */
  actions: string[];
  /** Knowledge's declared operations; empty for the other kinds. */
  operations: string[];
  /** Knowledge's declared collections, by the names App code uses. */
  collections: string[];
  /** A model's output token ceiling; null for the other kinds. */
  maxOutputTokens: number | null;
  /** Whether a model answers in a structure the App declares. */
  structuredOutput: boolean;
  /** The paths of the App's actions that use it. */
  usedBy: string[];
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
   * the deployment allows, a published template version of the declared
   * contract).
   *
   * What is approved is the declaration as the reviewed version seals it,
   * and it carries over to later versions that declare it identically,
   * approved or not: a binding grants reads as a permission to read does.
   * A connector's side effects still need a version an admin approved. For
   * a model, the declaration's `maxOutputTokens` is a hard ceiling on each
   * request of the App as a whole: an answer that must fit a structured
   * output may be asked for twice, and then each attempt gets half. A
   * model binding's `budget` caps what it may spend per request, day or
   * month; a request it has no room for is refused, sending nothing.
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

/**
 * A template's contract and major version, as the SDK checks it: no longer
 * than an identifier, so its publication's audit event can name it.
 */
const templateContractSchema = z
  .string()
  .max(identifierMaxLength)
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*@[1-9]\d{0,5}$/u);

/** The most bytes of one template version's content, as JSON text. */
export const templateContentMaxBytes = 64 * 1024;

/**
 * A template version an admin publishes: its content, as data (never
 * code), for a template of its own (`templateId` left out: a new one) or
 * the next version of one, which keeps its first version's contract.
 */
export const templatePublicationSchema = z.strictObject({
  templateId: identifierSchema.optional(),
  contract: templateContractSchema,
  content: z.json(),
});
export type TemplatePublication = z.input<typeof templatePublicationSchema>;

/** A published template version, as the API returns it (content apart). */
export interface PublishedTemplate {
  templateId: string;
  version: number;
  contract: string;
  /** The SHA-256 of its canonical content. */
  contentHash: string;
  publishedBy: string;
  publishedAt: string;
}

/**
 * Published templates, over `/rpc`: what a template binding reads. Each
 * version is written once and never changed. Publishing is for admins of
 * the organization only, never Grasp staff, and audited; listing is for
 * admins and builders.
 */
export interface TemplatesApi {
  publish: (publication: TemplatePublication) => Promise<PublishedTemplate>;
  /** Every template version, newest first, at most 200. */
  list: () => Promise<PublishedTemplate[]>;
}

/** Why a binding couldn't be approved, revoked or found. */
export const resourceBindingErrors = defineErrorFamily({
  "resource.binding_invalid": "That isn't a valid resource binding.",
  "resource.binding_not_found": "There's no such resource binding.",
  "resource.undeclared":
    "The reviewed version doesn't declare that resource for its actions, or declares it of another kind.",
  "resource.template_invalid":
    "That isn't a valid template: a contract, and JSON content of at most 64 KiB.",
  "resource.template_not_found": "There's no such template.",
  "resource.template_contract_changed":
    "A template keeps the contract of its first version: publish a new template for another contract.",
  "resource.target_invalid":
    "That can't serve this resource: it isn't the App's own active grant, a model this deployment allows, or a published version of the declared template.",
});
