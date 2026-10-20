import { z } from "zod";

import { connectorContractIdSchema } from "./connect.ts";
import { defineErrorFamily } from "./errors.ts";
import { chatIdSchema, identifierSchema, workspaceIdSchema } from "./ids.ts";
import {
  storeOperationPathMaxLength,
  storeOperationPathPattern,
} from "./operation-limits.ts";
import type { WorkflowDiagram, WorkflowRunTrace } from "./workflow-diagrams.ts";
import { workflowModulesError } from "./workflow-modules.ts";
import type { ActionUse } from "./workflow-modules.ts";

// Independent workflows (platform specification 3, 13.2 and 24): a
// workflow is a resource of its own, with its own owner, members and
// versions, never part of an App. An App, an agent, a trigger or the
// system may later start one; none of them owns it, and grouping it with
// an App in the product gives nothing. Each version is one validated
// workflow.json (grasp-open-workflow/1), published once and never
// changed.

/**
 * The namespace of every workflow in a deployment's registry. The host
 * selects it: a definition must name it, and naming it grants nothing.
 */
export const workflowNamespace = "workspace";

/**
 * A workflow resource's name: lowercase kebab-case, as the profile allows
 * a definition's `document.name`. Fixed when the resource is created and
 * never given to another resource, deleted ones included.
 */
export const workflowNameSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    "Lowercase letters, digits and dashes, starting and ending with a letter or digit"
  );

/** Whom a workflow is shared with, and in which role. */
export const workflowMemberSchema = z.strictObject({
  type: z.enum(["person", "team"]),
  id: identifierSchema,
});

/**
 * A role in a workflow: `user` follows it and, once starts land, starts
 * it; `builder` also publishes versions, shares and deletes it. The
 * organization role caps it, as for Apps.
 */
const workflowRoleSchema = z.enum(["user", "builder"]);
export type WorkflowRole = z.infer<typeof workflowRoleSchema>;

export const workflowShareSchema = workflowMemberSchema.extend({
  role: workflowRoleSchema,
});

/**
 * A version to publish: the definition's text, and the current version
 * the publisher built on (null for the first), so two publications don't
 * silently move the current version past each other.
 */
/**
 * The workflow's own modules, by path (`code/<file>.ts`): calculations its
 * `grasp.compute` tasks call (workflow-modules.ts), within what a version
 * carries.
 */
const workflowModulesSchema = z
  .record(z.string(), z.string())
  .superRefine((modules, context) => {
    const error = workflowModulesError(modules);
    if (error !== undefined) {
      context.addIssue({ code: "custom", message: error });
    }
  });

export const workflowPublishSchema = z.strictObject({
  definition: z.string(),
  basedOn: z.number().int().positive().nullable(),
  modules: workflowModulesSchema.optional(),
  /**
   * The approved npm packages its modules may import: the graph, by its
   * hash, approved for this workflow's `computation`, whose built entries
   * the version seals (GRA-665). Its modules import exactly those entries,
   * by name, and nothing else of npm.
   */
  packages: z
    .strictObject({ graphHash: z.string().regex(/^[0-9a-f]{64}$/u) })
    .optional(),
});

export const workflowResourceErrors = defineErrorFamily({
  "workflow.packages_invalid":
    "These packages can't be sealed into a version of this workflow: they need what a calculation's sandbox doesn't have, or are more than a version holds.",
  "workflow.packages_revoked":
    "The packages this version of the workflow uses aren't approved any more. Someone with the permission to approve dependencies can approve them again, or publish a version without them.",
  "workflow.resource_invalid": "That isn't a valid request for a workflow.",
  "workflow.resource_unavailable":
    "This workflow doesn't exist or was deleted.",
  "workflow.name_taken":
    "A workflow already has this name, or had it: names aren't reused.",
  "workflow.definition_invalid":
    "The workflow definition doesn't pass the grasp-open-workflow/1 profile.",
  "workflow.identity_mismatch":
    "The definition names another workflow than this one: its namespace and name must be the workflow's own.",
  "workflow.version_exists":
    "This workflow already has a version with this semantic version and different content: give the new one a version of its own.",
  "workflow.version_conflict":
    "Someone published another version since you started from this one. Start again from the current version.",
  "workflow.version_not_found": "This workflow has no such version.",
  "workflow.resource_bound":
    "The current version of another workflow calls this one, or a trigger starts it, so it can't be deleted.",
  "workflow.resource_busy":
    "Something changed this workflow while it was being deleted. Try again.",
  "workflow.resource_limit":
    "You have created as many workflows as one person may, deleted ones included.",
  "workflow.version_corrupt":
    "This version's stored record doesn't match what was published, so it isn't used. Report it to Grasp.",
  "workflow.evaluator_changed":
    "This version was published for an expression evaluator the platform no longer runs, so its runs can't evaluate as it was published. Publish it again as a new version.",
  "workflow.build_failed":
    "The code generated from this definition didn't build, so it wasn't published. Report it to Grasp.",
  "workflow.build_slow":
    "Building the code generated from this definition took longer than a publication waits, so nothing was published. Publish it again in a moment.",
  "workflow.output_invalid":
    "The workflow's result doesn't match its output schema, so the run failed.",
  "workflow.task_data_invalid":
    "A task's input, output or exported context doesn't match the task's schema, so the run failed.",
  "workflow.run_unavailable": "This workflow has no such run.",
  "workflow.decision_unavailable":
    "This workflow has no such decision for you to see.",
  "workflow.run_limit":
    "The person this start acts for already has as many runs of this workflow under way as one person may. Wait for one to end, or stop one.",
  "workflow.run_ended": "This run has already ended.",
  "workflow.start_unconfirmed":
    "The run never started: the workflow engine didn't confirm its start in time, so nothing of it ran. Start the workflow again.",
  "workflow.protocol_unsupported":
    "This version was built for a protocol between the platform and workflow code that this platform doesn't run. Publish it again as a new version.",
  "workflow.start_invalid":
    "That isn't a valid start: name an exact published version, and input the workflow accepts.",
  "workflow.start_denied":
    "You, or what starts it for you, may not start this workflow, or that changed as it started. Check again, then retry.",
  "workflow.start_conflict":
    "This idempotency key already started this workflow with another version or input.",
  "workflow.trigger_unavailable":
    "This trigger doesn't exist, was disabled or was deleted.",
  "workflow.trigger_limit":
    "You have as many live triggers as one person may: delete one first.",
  "workflow.contract_invalid":
    "That isn't a contract the host catalog can hold.",
  "workflow.contract_exists":
    "The catalog already has this contract key: a contract never changes, so publish another key.",
  "workflow.binding_invalid":
    "That target can't serve this binding: check its kind, its contract and that the workflow holds the permission it needs.",
  "workflow.binding_unapproved":
    "A binding of this version has no approval that serves its exact contract, so it can't start.",
  "workflow.binding_conflict":
    "Someone changed this binding as you did. Read it again, then retry.",
  "workflow.params_invalid":
    "Those parameter values aren't ones the workflow's current version accepts.",
  "workflow.params_conflict":
    "Someone changed the parameters since you read them. Read them again, then retry.",
  "workflow.app_binding_invalid":
    "That isn't a workflow version this App can bind.",
  "workflow.app_binding_unavailable": "This App has no such workflow binding.",
  "workflow.call_denied":
    "This run may no longer make that call: the person it acts for, the approval or permission behind the binding, or the trigger, App or agent that started it lost what it needed since the run started.",
  "workflow.call_invalid":
    "A task's call, or what it answered, doesn't match the binding's contract, so the run failed.",
  "workflow.call_release_not_current":
    "The App release this call's approval pins is no longer the App's current version, so the call can't run. Approve the binding for the App's current release, then start the workflow again.",
  "workflow.model_call_limit":
    "The run made as many model calls as its workflow allows, so it failed.",
  "workflow.modules_invalid":
    "The workflow's code modules don't build: fix what the diagnostics name, then publish again.",
  "workflow.compute_failed":
    "A task's calculation threw, or the sandbox stopped it, so the run failed.",
  "workflow.draft_conflict":
    "Someone changed this draft since you read it. Read it again, then make your change.",
  "workflow.draft_unchecked":
    "Only the latest draft can be published, and only once it passes the profile.",
  "workflow.action_failed":
    "A task's action threw, or the sandbox stopped it, so the run failed.",
  "workflow.action_restricted":
    "This run is restricted, so its actions can't make connector calls: connect holds those for a decision, which an action can't wait for.",
  "workflow.action_call_limit":
    "A task's action made as many calls as one attempt of it may, so the run failed.",
});

/**
 * The binding kinds the host catalog serves, beside other workflows. A
 * `knowledge` or `template` binding is reached only by the workflow's own
 * actions (GRA-700): no JSON task calls one.
 */
export const catalogBindingKinds = [
  "operation",
  "connector",
  "model",
  "decision",
  "event",
  "knowledge",
  "template",
] as const;
export type CatalogBindingKind = (typeof catalogBindingKinds)[number];

/**
 * A host catalog contract key: lowercase segments, never one of this
 * deployment's workflows (`workspace/...`) nor a workflow's own module
 * (`local:`).
 */
export const catalogKeySchema = z
  .string()
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9.-]*){0,2}$/u,
    "Lowercase segments of letters, digits, dots and dashes, separated by /"
  )
  .refine((key) => !key.startsWith(`${workflowNamespace}/`), {
    message: "Workflow contract keys are this deployment's workflows",
  });

/**
 * A catalog contract as an admin publishes it: its key, kind, and the SDK
 * value descriptors (as JSON text) of what a call passes and returns, as
 * `@grasp-os/open-workflow`'s catalog reads them.
 */
/** The most a catalog contract holds, as JSON. */
const catalogContractMaxBytes = 512 * 1024;

export const catalogContractSchema = z
  .strictObject({
    key: catalogKeySchema,
    kind: z.enum(catalogBindingKinds),
    input: z
      .string()
      .max(256 * 1024)
      .optional(),
    output: z
      .string()
      .max(256 * 1024)
      .optional(),
    response: z
      .string()
      .max(256 * 1024)
      .optional(),
    operations: z
      .record(
        z.string().regex(/^[A-Za-z][\w.-]{0,63}$/u),
        z.strictObject({
          input: z.string().max(256 * 1024),
          output: z.string().max(256 * 1024),
          /**
           * That the operation only reads, as the admin who publishes the
           * contract states it (GRA-718): what a version's review relies
           * on to leave it out of the writes a model may steer. Missing,
           * it is taken for a write.
           */
          readOnly: z.boolean().optional(),
        })
      )
      .optional(),
    /**
     * An event contract's admitted CloudEvents types, each with the
     * descriptor of its data (required: no type is admitted untyped) and
     * whether a person's screen may send it, which is what makes it an
     * App's event reference.
     */
    events: z
      .record(
        z.string().min(1).max(256),
        z.strictObject({
          data: z.string().max(256 * 1024),
          browser: z.boolean(),
        })
      )
      .optional(),
  })
  .refine(
    // A screen sends an event through its binding's alias, which names one
    // type: an event contract admits at most one type a screen sends.
    (contract) =>
      Object.values(contract.events ?? {}).filter(({ browser }) => browser)
        .length <= 1,
    { message: "An event contract admits at most one type a screen sends." }
  )
  .refine(
    // One row of the catalog: well under what a database row may hold.
    (contract) =>
      new TextEncoder().encode(JSON.stringify(contract)).byteLength <=
      catalogContractMaxBytes,
    { message: "A contract is at most 512 KiB, its operations included." }
  );
export type CatalogContractInput = z.input<typeof catalogContractSchema>;

/** A catalog contract as the catalog lists it. */
export interface CatalogContractEntry {
  key: string;
  kind: CatalogBindingKind;
  fingerprint: string;
  publishedBy: string;
  publishedAt: string;
}

/** Who answers a decision binding: people, teams or an organization role. */
const deciderSchema = z.string().regex(/^(?:person|team|role):[\w.-]{1,128}$/u);

/**
 * What an admin binds a workflow's alias to, by its kind:
 *
 * - `model`: one model the deployment allows, through the model gateway;
 * - `connector`: one of the workflow's own connection permissions, and the
 *   contract connect generates for that connection (`<connector>.<family>@1`
 *   or `composio.<toolkit>@1`) whose actions serve the catalog contract;
 * - `operation`: an exact version of an App's export, through one of the
 *   workflow's own permissions on that App's exports;
 * - `storeOperation`: a business store's public operation, by its path,
 *   through one of the workflow's own store permissions, run by the App
 *   that owns the store as its current version serves it (core's
 *   store-operations.ts). It serves an `operation` binding, as an export
 *   does;
 * - `decision`: who answers it;
 * - `event`: that the workflow may listen for and emit the contract's
 *   types. Who may send each is the contract's (`browser`) and the
 *   host's checks on every send, never this approval's.
 */
export const workflowBindingTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("model"),
    model: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[a-z0-9-]+\/\S+$/u),
  }),
  z.strictObject({
    kind: z.literal("connector"),
    permissionId: identifierSchema,
    contract: connectorContractIdSchema,
  }),
  z.strictObject({
    kind: z.literal("operation"),
    permissionId: identifierSchema,
    appVersion: z.int().min(1),
    export: z.string().regex(/^[A-Za-z][\w]{0,63}$/u),
  }),
  z.strictObject({
    kind: z.literal("storeOperation"),
    permissionId: identifierSchema,
    operation: z
      .string()
      .max(storeOperationPathMaxLength)
      .regex(storeOperationPathPattern),
    /**
     * The operation's kind, as the admin approves it: a query only reads,
     * a mutation writes. One that becomes the other serves nothing.
     */
    operationKind: z.enum(["query", "mutation"]),
  }),
  z.strictObject({
    kind: z.literal("decision"),
    deciders: z.array(deciderSchema).min(1).max(16),
  }),
  z.strictObject({ kind: z.literal("event") }),
  // One Knowledge collection, through a permission the workflow itself
  // holds to read it (GRA-700): its runs' actions read only that, and
  // only what the person a run acts for may read too.
  z.strictObject({
    kind: z.literal("knowledge"),
    permissionId: identifierSchema,
  }),
  // One published template version, pinned by its content's hash as the
  // admin approves it (GRA-700): content that no longer hashes to it
  // serves nothing.
  z.strictObject({
    kind: z.literal("template"),
    templateId: identifierSchema,
    version: z.int().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);
export type WorkflowBindingTarget = z.infer<typeof workflowBindingTargetSchema>;

/** The catalog binding kind a target serves: a store operation an `operation`. */
export const servedKindOf = (
  target: WorkflowBindingTarget
): CatalogBindingKind =>
  target.kind === "storeOperation" ? "operation" : target.kind;

/**
 * An admin's approval of a workflow's binding: the alias, its target, and
 * the version of the workflow they reviewed, whose declaration of the
 * alias (kind, contract key, fingerprint) is what they approve, for that
 * version alone.
 */
export const workflowBindingApprovalSchema = z.strictObject({
  alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  target: workflowBindingTargetSchema,
  reviewed: z.strictObject({ version: z.int().min(1) }),
});

/** An approved binding of a workflow's alias. */
export interface WorkflowBindingApproval {
  id: string;
  alias: string;
  kind: CatalogBindingKind;
  contractId: string;
  fingerprint: string;
  target: WorkflowBindingTarget;
  /** The one version of the workflow it serves: the version reviewed. */
  reviewedVersion: number;
  status: "active" | "revoked";
  approvedBy: string;
  approvedAt: string;
}

const paramNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

/**
 * New values for a workflow's parameters: the revision they were read at,
 * each parameter's new value (null is a value, for a parameter that takes
 * it), and the parameters to put back to their defaults. A parameter in
 * neither keeps its value; one in both is refused.
 */
export const workflowParamsEditSchema = z
  .strictObject({
    expectedRevision: z.int().min(0),
    values: z.record(paramNameSchema, z.json()).default({}),
    reset: z.array(paramNameSchema).max(64).default([]),
  })
  .refine(
    ({ values, reset }) => reset.every((name) => !Object.hasOwn(values, name)),
    { message: "A parameter is either set or reset, not both." }
  );

/**
 * A parameter's configuration, as its members read it: its label, whether
 * it is sensitive, and its value, never a sensitive one's (`set` says
 * whether one is set).
 */
export interface WorkflowParamSetting {
  name: string;
  label: string;
  sensitive: boolean;
  /** Whether a value is set; otherwise its default applies. */
  set: boolean;
  /** The value set, for a parameter that isn't sensitive; null otherwise. */
  value: unknown;
  /** Its JSON Schema, as the current version seals it; null if unknown. */
  schema: unknown;
}

/** A workflow's parameter configuration at a revision. */
export interface WorkflowParams {
  revision: number;
  params: WorkflowParamSetting[];
}

/** An App's binding of an exact version of a workflow, by an alias of the App's. */
export const appWorkflowBindingSchema = z.strictObject({
  app: identifierSchema,
  alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
  version: z.int().min(1),
});

/** An App's binding of a workflow version. */
export interface AppWorkflowBinding {
  id: string;
  app: string;
  alias: string;
  workflowId: string;
  version: number;
  boundBy: string;
  boundAt: string;
}

/**
 * A start of an independent workflow: the exact version (a publication
 * number, never an alias such as "latest"), its input, and a key of the
 * invoker's own, so the same start sent again is the same start.
 */
export const workflowStartSchema = z.strictObject({
  version: z.number().int().positive(),
  input: z.json(),
  key: identifierSchema,
});

/** A start the host admitted: its receipt. */
export interface WorkflowStart {
  id: string;
  workflowId: string;
  version: number;
  manifestHash: string;
  invoker: { type: "person" | "app" | "agent" | "trigger"; id: string };
  principal: string;
  authorityGeneration: number;
  inputHash: string;
  /** The parameter revision its values were frozen at. */
  paramsRevision: number;
  /** The SHA-256 of the frozen bindings. */
  bindingsHash: string;
  /**
   * The run executing it, under its own ID, pinned to the version's sealed
   * build; null for a version that has no executable build
   * (`WorkflowVersionBuild`), which is admitted and never runs.
   */
  runId: string | null;
  createdAt: string;
}

/**
 * The start keys core derives itself begin with this: an App action's
 * starts, and a committed mutation's. A key a caller chooses (a person's,
 * an agent's, and a screen's when screens start workflows) may not, so no
 * caller can take one of core's keys before core does.
 */
export const coreStartKeyPrefix = "grasp:";

/**
 * A start a committed mutation staged in its store's outbox
 * (`ctx.afterCommit.start`), which its dispatch admits after the commit:
 * who starts it, as core resolved them as the mutation ran (the App, the
 * version of it whose code staged it, the person its call acted for),
 * the alias the App binds the workflow under, its input as checked
 * against the App's declaration, and the agent whose call staged it, if
 * one did. Its key is its outbox entry's ID, which names the commit, so
 * every dispatch of it is the same start and no later commit's start is.
 * Never anything App code chose but the alias and the input.
 */
export const workflowStartIntentSchema = z.strictObject({
  app: identifierSchema,
  appVersion: z.int().min(1),
  principal: identifierSchema,
  alias: appWorkflowBindingSchema.shape.alias,
  input: z.json(),
  /**
   * The agent whose call of the App staged it (a chat's code), whose
   * permission on the App its dispatch requires again; null for a
   * person's own call.
   */
  agent: z
    .strictObject({
      agentId: identifierSchema,
      workspaceId: workspaceIdSchema,
      chatId: chatIdSchema,
    })
    .nullable(),
});
export type WorkflowStartIntent = z.infer<typeof workflowStartIntentSchema>;

/**
 * The most runs of one workflow that haven't ended a person may have
 * started (or had started for them) at once: a start past it is refused
 * (`workflow.run_limit`). An interim bound on what one person's starts
 * make core spend, until lineage quotas hold these runs (GRA-567).
 */
export const maxLiveRunsPerPrincipal = 20;

/** Where a run of a workflow is: the engine's say, as core follows it. */
export type WorkflowRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * A run of a workflow's exact version and build, admitted by its start's
 * receipt (`WorkflowStart.id`, which it shares). What it returned or why it
 * failed only for the person it acts for and the organization's admins:
 * it can hold what the run read for them.
 */
export interface WorkflowResourceRun {
  id: string;
  workflowId: string;
  version: number;
  manifestHash: string;
  /** The executable identity it runs (`WorkflowVersionBuild.hash`). */
  buildHash: string;
  principal: string;
  status: WorkflowRunStatus;
  createdAt: string;
  endedAt: string | null;
  /** What it returned, once completed, for those who see its details. */
  output?: unknown;
  /** Why it failed, for those who see its details. */
  error?: { code: string | null; message: string };
}

/** A workflow resource, as its members see it. */
export interface WorkflowResource {
  id: string;
  namespace: string;
  name: string;
  owner: string;
  /** The version published last; null before the first. */
  currentVersion: number | null;
  /** The caller's role in it. */
  role: WorkflowRole;
  createdAt: string;
}

/**
 * A binding a version resolved, by the host: exact IDs and fingerprints.
 * Which workflow resource it binds (its ID and internal version) only for
 * a builder of that workflow, and its contract key for them and for the
 * binding workflow's builders, whose definition text names it: anyone else
 * gets null there, and only the alias and the contract's fingerprint. A
 * catalog binding
 * (an operation, connector, model or decision contract) names its
 * contract key and fingerprint; what serves it is an approval's.
 */
export interface WorkflowVersionBinding {
  alias: string;
  kind: "workflow" | CatalogBindingKind;
  resourceId: string | null;
  resourceVersion: number | null;
  /** The contract key the definition named. */
  contractId: string | null;
  /** The target version's contract hash. */
  fingerprint: string;
}

/**
 * One of a version's own actions a task can call (GRA-709): its binding,
 * the module and export it is, and what its sealed contract lets it
 * reach, each use the workflow's own binding by alias, a connector's with
 * the exact operations it calls. The host refuses anything else (GRA-704).
 * It names nothing outside the workflow, so every role sees it alike.
 */
export interface WorkflowVersionAction {
  binding: string;
  module: string;
  export: string;
  uses: ActionUse[];
}

/**
 * A use whose writes a model's answers may steer, by its binding's alias:
 * a connector's, with each of its operations that may write; or an
 * operation binding's (an App's export), which may always write, as its
 * contract states nothing about reading only.
 */
export type SteeredWrite =
  | { alias: string; kind: "connector"; operations: string[] }
  | { alias: string; kind: "operation" };

/**
 * One of a version's own actions as its review shows it (GRA-718): as
 * sealed, and, when it asks a model, each of its uses that may write, which
 * the model's answers may steer. Empty when it asks no model, or only
 * reads. It covers the action's own uses only, never a workflow's own
 * model task whose answer feeds a later task's call.
 */
export interface WorkflowActionReview extends WorkflowVersionAction {
  modelSteeredWrites: SteeredWrite[];
}

/**
 * Why a deletion was refused with `workflow.resource_bound`, in its
 * details: the workflows whose current version binds it that the caller
 * may see, and how many more there are that they may not.
 */
export interface WorkflowBinders {
  binders: { id: string; name: string }[];
  hidden: number;
  /**
   * Enabled triggers holding an active `start` grant whose current version
   * starts it: those the caller may see, and how many more.
   */
  triggers: { ids: string[]; hidden: number };
  /**
   * Active App bindings of one of its versions whose App holds an active
   * `start` grant on it: each binding and its App. Its builders may remove
   * any of them, so they see them all.
   */
  appBindings: { id: string; app: string }[];
  /**
   * Its runs that haven't ended. Its builders may terminate any of them
   * (`terminateRun`), so they see how many.
   */
  liveRuns: number;
}

/**
 * The version of the protocol between the host and the code generated
 * from a JSON workflow: what core's run module calls of the sealed SDK
 * (`openWorkflow`'s definition and engine, `@grasp-os/sdk/open-workflow`).
 * A version built for another one doesn't run
 * (`workflow.protocol_unsupported`): its sealed SDK speaks something else.
 */
export const openWorkflowProtocol = 6;

/**
 * Something of a definition the code generator doesn't lower yet: its
 * place, the task it is in, and what it is (a task kind such as
 * `call:grasp.model`, or a property such as `then`).
 */
export interface UnsupportedConstruct {
  pointer: string;
  taskId: string | null;
  feature: string;
}

/**
 * What a version runs: code generated from its definition, compiled and
 * sealed with it, named by `hash`, its executable identity (the same
 * definition, generator, compiler and SDK always make the same hash); or,
 * for a definition that uses what the generator doesn't lower yet,
 * nothing, and what those constructs are. Such a version is published and
 * can be started, but no run executes it.
 */
export type WorkflowVersionBuild =
  | { executable: true; hash: string }
  | { executable: false; unsupported: UnsupportedConstruct[] };

/** One published version of a workflow. */
export interface WorkflowResourceVersion {
  resourceId: string;
  version: number;
  /** The definition's own semantic version (`document.version`). */
  definitionVersion: string;
  profile: string;
  definitionHash: string;
  contractHash: string;
  manifestHash: string;
  bindings: WorkflowVersionBinding[];
  /** What its own actions may do, as sealed with it, by binding. */
  actions: WorkflowActionReview[];
  /**
   * What the workflow's own model tasks may steer (GRA-727): when its build
   * holds any model task, every write its call tasks may make, a called
   * action's writing uses among them; empty otherwise. Conservative: a
   * model task is taken to reach every call, whatever their order.
   */
  modelSteeredWrites: SteeredWrite[];
  build: WorkflowVersionBuild;
  author: string;
  createdAt: string;
}

/**
 * A version's portable source, for its builders: the definition exactly as
 * published and the SDK TypeScript generated from it, by path (nothing
 * generated for a version that isn't executable). Edited generated code
 * can't come back: a version is only ever published from a definition.
 */
export interface WorkflowVersionSource {
  files: Record<string, string>;
}

/** Someone a workflow is shared with. */
export interface WorkflowMember {
  type: "person" | "team";
  id: string;
  role: WorkflowRole;
  addedBy: string;
  addedAt: string;
}

/**
 * An edit of a workflow's draft: its whole new text, and the revision it
 * read (0 before the first edit), which must still be the latest.
 */
export const workflowDraftEditSchema = z.strictObject({
  expectedRevision: z.int().min(0),
  // The profile's own bound on a definition: 1 MiB of UTF-8, as stored.
  source: z
    .string()
    .max(1024 * 1024)
    .refine(
      (text) => new TextEncoder().encode(text).byteLength <= 1024 * 1024,
      "A draft is at most 1 MiB of UTF-8."
    ),
  /**
   * Its modules, all of them: an edit says what the draft carries, so one
   * that leaves them out drops none by mistake. Empty for none.
   */
  modules: workflowModulesSchema,
});

/**
 * Publishing a draft: its revision, which must be the latest and pass the
 * profile, and the current version it built on (`workflowPublishSchema`).
 */
export const workflowDraftPublishSchema = z.strictObject({
  revision: z.int().min(1),
  basedOn: z.number().int().positive().nullable(),
});

/**
 * A workflow's draft, for its builders: its latest text and revision (0
 * while nobody has edited it: then the current version's definition, or
 * a starting one), what the profile said of it, and its latest checkpoint,
 * the latest text that passed (the current version's definition at
 * revision 0), which is what may be published and what its diagram shows.
 */
export interface WorkflowDraft {
  revision: number;
  source: string;
  /** Its own modules, by path, as this revision carries them. */
  modules: Record<string, string>;
  problems: WorkflowDefinitionProblem[];
  checkpoint: {
    revision: number;
    source: string;
    /** Drawn from the checkpoint's own JSON, as it passed. */
    diagram: WorkflowDiagram;
  } | null;
  editedBy: string | null;
  editedAt: string | null;
}

/** A refused publication's diagnostics, as the profile reports them. */
export interface WorkflowDefinitionProblem {
  code: string;
  message: string;
  pointer: string;
  taskId?: string;
  remedy: string;
}

/** Independent workflows over `/rpc`. */
export interface WorkflowResourcesApi {
  /** Creates a workflow the caller owns, named `name`; for builders. */
  create: (name: string) => Promise<WorkflowResource>;
  /** The workflows the caller has a role in, by name. */
  list: () => Promise<WorkflowResource[]>;
  get: (id: string) => Promise<WorkflowResource>;
  /** Publishes a version from a workflow.json; for its builders. */
  publish: (id: string, input: unknown) => Promise<WorkflowResourceVersion>;
  /** Its draft, for its builders (`WorkflowDraft`). */
  draft: (id: string) => Promise<WorkflowDraft>;
  /** Saves an edit of its draft (`workflowDraftEditSchema`), checked. */
  editDraft: (id: string, input: unknown) => Promise<WorkflowDraft>;
  /** Publishes its draft's checkpoint (`workflowDraftPublishSchema`). */
  publishDraft: (
    id: string,
    input: unknown
  ) => Promise<WorkflowResourceVersion>;
  versions: (id: string) => Promise<WorkflowResourceVersion[]>;
  /** One version's definition text, exactly as published; for builders. */
  definition: (id: string, version: number) => Promise<string>;
  /**
   * One version's portable source: its definition and the code generated
   * from it, read back from what was sealed; for builders.
   */
  source: (id: string, version: number) => Promise<WorkflowVersionSource>;
  share: (id: string, input: unknown) => Promise<void>;
  unshare: (id: string, input: unknown) => Promise<void>;
  members: (id: string) => Promise<WorkflowMember[]>;
  delete: (id: string) => Promise<void>;
  /**
   * Starts an exact version of a workflow the caller has a role in, acting
   * for them (`workflowStartSchema`): its admitted receipt.
   */
  start: (id: string, input: unknown) => Promise<WorkflowStart>;
  /** One of its runs, for anyone with a role (`WorkflowResourceRun`). */
  run: (id: string, runId: string) => Promise<WorkflowResourceRun>;
  /**
   * Its runs, newest first, the latest page: every run for its builders,
   * a user's own for a user; never what one returned or why it failed.
   */
  runs: (id: string) => Promise<WorkflowResourceRun[]>;
  /** Stops a run that hasn't ended; for the workflow's builders and admins. */
  terminateRun: (id: string, runId: string) => Promise<WorkflowResourceRun>;
  /** What run `runId` did, over its version's diagram, for builders. */
  runTrace: (id: string, runId: string) => Promise<WorkflowRunTrace>;
  /** Its parameters' configuration, for anyone with a role. */
  params: (id: string) => Promise<WorkflowParams>;
  /** Sets parameter values, revision-checked; for builders. */
  setParams: (id: string, input: unknown) => Promise<WorkflowParams>;
  /** Its approved bindings, for anyone with a role. */
  bindings: (id: string) => Promise<WorkflowBindingApproval[]>;
  /** Approves a binding; for the organization's admins. */
  approveBinding: (
    id: string,
    input: unknown
  ) => Promise<WorkflowBindingApproval>;
  /** Revokes a binding approval; for the organization's admins. */
  revokeBinding: (id: string, approval: string) => Promise<void>;
  /** Binds an exact version to an App; for the App's builders. */
  bindToApp: (id: string, input: unknown) => Promise<AppWorkflowBinding>;
  /** Removes an App's binding; for the App's builders. */
  unbindFromApp: (binding: string) => Promise<void>;
  /** The host catalog's contracts, for builders. */
  catalog: () => Promise<CatalogContractEntry[]>;
  /** Publishes a catalog contract; for the organization's admins. */
  publishContract: (input: unknown) => Promise<CatalogContractEntry>;
}
