import { z } from "zod";

import type { BusinessProcess } from "./business-processes.ts";
import { connectorContractIdSchema } from "./connect.ts";
import { defineErrorFamily } from "./errors.ts";
import type { EventSourcesApi } from "./event-sources.ts";
import { chatIdSchema, identifierSchema, workspaceIdSchema } from "./ids.ts";
import type { Json } from "./json.ts";
import type { RunFileListing } from "./run-files.ts";
import { isEventType, sealedBuildLimits } from "./sealed-builds.ts";
import type {
  WorkflowCandidateTrace,
  WorkflowDiagram,
  WorkflowRunTrace,
} from "./workflow-diagrams.ts";
import type { WorkflowPauseApi } from "./workflow-pause.ts";
import type { WorkflowTriggersApi } from "./workflow-triggers.ts";
import type { RunAiProviderWait } from "./workflows.ts";

// Independent workflows (platform specification 3, 13.2 and 24): a
// workflow is a resource of its own, with its own owner, members and
// versions, never part of an App. An App, an agent, a trigger or the
// system may later start one; none of them owns it, and grouping it with
// an App in the product gives nothing. Each version is one validated
// workflow.json (grasp-workflow/2), published once and never
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

/**
 * Whom a workflow is shared with, and in which role: a person, a team, or
 * everyone in a project (@grasp-os/shared/projects).
 */
export const workflowMemberSchema = z.strictObject({
  type: z.enum(["person", "team", "project"]),
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

export const workflowResourceErrors = defineErrorFamily({
  "workflow.resource_invalid": "That isn't a valid request for a workflow.",
  "workflow.resource_unavailable":
    "This workflow doesn't exist or was deleted.",
  "workflow.name_taken":
    "A workflow already has this name, or had it and an admin hasn't released it.",
  "workflow.name_unreleasable":
    "Only the name of a deleted workflow can be released.",
  "workflow.name_pinned":
    "Something still names a version of the deleted workflow: another workflow, a trigger, an App binding or a run that hasn't ended. Its name can be released once nothing does.",
  "workflow.name_busy":
    "What names the deleted workflow kept changing while its name was released. Try again in a moment.",
  "workflow.definition_invalid":
    "The workflow definition isn't a valid grasp-workflow/2 document.",
  "workflow.version_not_found": "This workflow has no such version.",
  "workflow.version_not_live":
    "Only the workflow's live version starts: this one isn't live.",
  "workflow.resource_bound":
    "The current version of another workflow calls this one, or a trigger starts it, so it can't be deleted.",
  "workflow.resource_busy":
    "Something changed this workflow while it was being deleted. Try again.",
  "workflow.resource_limit":
    "You have created as many workflows as one person may, deleted ones included.",
  "workflow.version_corrupt":
    "This version's stored record doesn't match what was published, so it isn't used. Report it to Grasp.",
  "workflow.build_failed":
    "The code generated from this definition didn't build, so it wasn't published. Report it to Grasp.",
  "workflow.build_slow":
    "Building the code generated from this definition took longer than a publication waits, so nothing was published. Publish it again in a moment.",
  "workflow.output_invalid":
    "The workflow's result doesn't match what it returns (`returns`), so the run failed.",
  "workflow.task_data_invalid":
    "A task's input, output or exported context doesn't match the task's schema, so the run failed.",
  "workflow.arguments_too_deep": `This step's arguments are nested deeper than ${sealedBuildLimits.callDepth} levels, so its call wasn't made.`,
  "workflow.branch_cancelled":
    "Another branch settled this branch's scope (a race's winner, or an end), so this branch's next step didn't run.",
  "workflow.collection_invalid":
    "A for task's collection isn't a list of at most 1,000 items, so the run failed.",
  "workflow.run_unavailable": "This workflow has no such run.",
  "workflow.run_details_removed":
    "This run ended long enough ago that what it returned is no longer kept.",
  "workflow.decision_unavailable":
    "This workflow has no such decision for you to see.",
  "workflow.run_limit":
    "The person this start acts for already has as many runs of this workflow under way as one person may. Wait for one to end, or stop one.",
  "workflow.run_ended": "This run has already ended.",
  "workflow.event_invalid":
    "That event isn't one this run takes: its binding doesn't admit its type, or its data doesn't match the type's contract.",
  "workflow.event_denied":
    "This run may no longer take events through that binding: its approval, or the run's own access, was revoked.",
  "workflow.event_refused":
    "This run can't take that event now: its inbox is full, the event is too large, the run is too old, or it hasn't started yet. Nothing was accepted.",
  "workflow.event_conflict":
    "That delivery key was used for another event to this run. Send a new event under a new key.",
  "workflow.event_timeout":
    "A listen task's events didn't all arrive before its timeout.",
  "workflow.run_paused":
    "This run is paused. Resume it, then confirm what it holds.",
  "workflow.format_unsupported":
    "This version was published by an earlier release of the platform that this one doesn't read. Publish it again as a new version.",
  "workflow.start_unconfirmed":
    "The run never started: the workflow engine didn't confirm its start in time, so nothing of it ran. Start the workflow again.",
  "workflow.start_invalid":
    "That isn't a valid start: name an exact published version, and input the workflow accepts.",
  "workflow.start_held_gone":
    "That start no longer waits for you: it was confirmed, declined or let lapse, or isn't yours.",
  "workflow.start_held_changed":
    "What that start would send changed since you saw it. Look at it again, then confirm.",
  "workflow.start_offer_only":
    "In a chat app, offer the start on a card instead: the person presses Start there.",
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
    "An admin hasn't approved what this version reaches yet, so it can't start. Ask an admin to approve it on the workflow's Files and apps tab.",
  "workflow.binding_conflict":
    "Someone changed this binding as you did. Read it again, then retry.",
  "workflow.params_invalid":
    "Those parameter values aren't ones the workflow's current version accepts.",
  "workflow.params_conflict":
    "Someone changed the parameters since you read them. Read them again, then retry.",
  "workflow.state_invalid":
    "That isn't state a step may keep: name each value with letters, digits and underscores, starting with a letter, and keep each value JSON.",
  // A run's recall evidence (core's workflows/run-evidence.ts): the codes
  // and words the old Brain's contract has for them, which runs keep
  // until the cutover (GRA-1735) drops that contract.
  "brain.revoked":
    "Evidence this run recalled can no longer be read. Recall again before using it.",
  "brain.budget_exceeded": "This request is over the Brain's limits for it.",
  "workflow.state_restricted":
    "A run in restricted mode keeps no state for later runs: what it read stays with it, so the step that set it failed.",
  "workflow.state_too_large":
    "The workflow's state would pass 64 KB, so the step that set it failed. Keep less in it, or reset it from the workflow's page.",
  "workflow.app_binding_invalid":
    "That isn't a workflow version this App can bind.",
  "workflow.app_binding_unavailable": "This App has no such workflow binding.",
  "workflow.app_binding_contract_changed":
    "This workflow version's events, decisions or listen tasks aren't the ones the App declares. Bind it in the App's draft instead, which declares them, then publish the App.",
  "workflow.app_version_binding_unavailable":
    "This App version binds a workflow version that can't be bound now: the workflow was deleted, or whoever bound it in the draft, or whoever makes the App version current, has no role in it. Bind one in the App's draft again, then publish.",
  "workflow.call_denied":
    "This run may no longer make that call: the person it acts for, the approval or permission behind the binding, or the trigger, App or agent that started it lost what it needed since the run started.",
  "workflow.call_invalid":
    "A task's call, or what it answered, doesn't match the binding's contract, so the run failed.",
  "workflow.app_function_unavailable":
    "The App function this run calls can't be reached: the App has no current version, that version gives no function this ID, or the person the run acts for has no role in the App.",
  "workflow.app_call_failed":
    "The App function this run called failed, so the run failed. These details name the App's error code.",
  "workflow.decision_timed_out":
    "Nobody answered the run's decision before its deadline, so the run failed.",
  "workflow.model_call_limit":
    "The run made as many model calls as its workflow allows, so it failed.",
  "workflow.paused":
    "This workflow is paused, so it starts no runs. Someone who builds it can resume it.",
  "workflow.step_not_found":
    "There's no step there in this draft: read the draft again and pick the step, or the list to insert into, from its diagram.",
  "workflow.draft_not_json":
    "This draft isn't JSON, so a step can't be edited on the canvas. Fix its text first.",
  "workflow.candidate_unfixtured":
    "This test run made a call its start gave no answer for. A test run never calls anything: give each binding it calls an answer, then start it again.",
  "workflow.test_unfixtured":
    "This test's run made a model call its fixture gives nothing for. A test's run never calls a real model: in the fixture's workflows, give each model binding it calls an answer.",
  "workflow.candidate_unavailable":
    "This test run doesn't exist, or isn't one you can see.",
  "workflow.candidate_limit":
    "You already have as many test runs of this workflow going as one person may. Wait for one to end, or stop one.",
  "workflow.candidate_kept_limit":
    "You have as many test runs of this workflow kept as one person may. Older ones are removed after a week.",
  "workflow.candidate_time_limit":
    "This test run went on longer than a test run may, so it failed. Shorten what it waits for to test it.",
  "workflow.candidate_wait_limit":
    "This test run would wait longer than a test run may, so it failed. Shorten the wait to test it.",
  "workflow.item_test_empty":
    "None of your recent runs of this workflow can be tested again: a test takes runs you can see the details of, whose input is still kept.",
  "workflow.item_test_unavailable":
    "This test doesn't exist, or isn't one you can see.",
  "workflow.failed_after_effect":
    "The task's call took effect, then the task failed. What the call did stands.",
  "workflow.raised":
    "The workflow raised an error of its own, and nothing in it caught that error.",
});

/**
 * The binding kinds the host catalog serves, beside other workflows. A
 * `brain` or `files` binding is for the Brain and files steps
 * (GRA-1662); until they land, no JSON task calls one.
 */
export const catalogBindingKinds = [
  "connector",
  "model",
  "decision",
  "event",
  "brain",
  "files",
] as const;
export type CatalogBindingKind = (typeof catalogBindingKinds)[number];

/**
 * A host catalog contract key: lowercase segments, never one of this
 * deployment's workflows (`workspace/...`).
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

/** The most a catalog contract holds, as JSON. */
const catalogContractMaxBytes = 512 * 1024;

/**
 * Where outsiders send an event contract's type from: a reply to mail the
 * run sent (`email`), to the run's own reply address (core's
 * run-inboxes.ts), the workflow's `inbox.<alias>`; or an event source an
 * admin made (`webhook`, core's event-sources.ts), the one the binding's
 * approval names, matched to a waiting run by a field of its data (core's
 * workflows/event-waits.ts).
 */
export const eventIngressKinds = ["email", "webhook"] as const;
export type EventIngressKind = (typeof eventIngressKinds)[number];

/**
 * A workflow event's CloudEvents type, wherever one is read: as an event
 * contract admits it, a sealed build names it, and a run's inbox takes it.
 */
export const workflowEventTypeSchema = z
  .string()
  .refine(
    isEventType,
    "1 to 256 characters on one line, with no control character and no space at either end"
  );

/**
 * A catalog contract as an admin publishes it: its key, kind, and the SDK
 * value descriptors (as JSON text) of what a call passes and returns, as
 * `@grasp-os/workflow-schema`'s catalog reads them.
 */
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
          /**
           * That the operation answers a file a call may keep as a file of
           * its run (GRA-886): only on an operation described by its
           * native connector's JSON Schemas, as connect confirms it.
           */
          answersFile: z.literal(true).optional(),
          /**
           * That the operation attaches files a call names from its run
           * (GRA-887): only on an operation described by its native
           * connector's JSON Schemas, as connect confirms it.
           */
          takesFiles: z.literal(true).optional(),
        })
      )
      .optional(),
    /**
     * An event contract's admitted CloudEvents types, each with the
     * descriptor of its data (required: no type is admitted untyped),
     * whether a person's page may send it, which is what makes it an
     * App's event reference, and whether outsiders may (`ingress`): a
     * reply to the run's mail (`email`), through a reply address of the
     * run's own (core's run-inboxes.ts), or an event source's event
     * (`webhook`). An email type's data is the platform's received
     * message, as core checks it is.
     */
    events: z
      .record(
        workflowEventTypeSchema,
        z.strictObject({
          data: z.string().max(256 * 1024),
          browser: z.boolean(),
          ingress: z.enum(eventIngressKinds).optional(),
        })
      )
      .optional(),
  })
  .refine(
    // A page sends an event through its binding's alias, which names one
    // type: an event contract admits at most one type a page sends.
    (contract) =>
      Object.values(contract.events ?? {}).filter(({ browser }) => browser)
        .length <= 1,
    { message: "An event contract admits at most one type a page sends." }
  )
  .refine(
    // Who sends a type is a page or outsiders, never both.
    (contract) =>
      Object.values(contract.events ?? {}).every(
        ({ browser, ingress }) => !(browser && ingress !== undefined)
      ),
    { message: "An event type a page sends takes no ingress." }
  )
  .refine(
    // A binding's inbox (`inbox.<alias>`) is one address, and what arrives
    // there is of one type: an event contract admits at most one type
    // of replies to the run's mail. A source sends many types.
    (contract) =>
      Object.values(contract.events ?? {}).filter(
        ({ ingress }) => ingress === "email"
      ).length <= 1,
    { message: "An event contract admits at most one type of email replies." }
  )
  .refine(
    // One row of the catalog: well under what a database row may hold.
    (contract) =>
      new TextEncoder().encode(JSON.stringify(contract)).byteLength <=
      catalogContractMaxBytes,
    { message: "A contract is at most 512 KiB, its operations included." }
  );
export type CatalogContractInput = z.input<typeof catalogContractSchema>;
/** A catalog contract, its key included, as published. */
export type CatalogContractDefinition = z.infer<typeof catalogContractSchema>;

/** A catalog contract as the catalog lists it. */
export interface CatalogContractEntry {
  key: string;
  kind: CatalogBindingKind;
  fingerprint: string;
  publishedBy: string;
  publishedAt: string;
}

/** Most people, teams and roles one decision binding names. */
export const decisionDecidersMax = 16;

/** Who answers a decision binding: people, teams or an organization role. */
const deciderSchema = z.string().regex(/^(?:person|team|role):[\w.-]{1,128}$/u);

/**
 * What an admin binds a workflow's alias to, by its kind:
 *
 * - `model`: one model the deployment allows, through the model gateway;
 * - `connector`: one of the workflow's own connection permissions, and the
 *   contract connect generates for that connection (`<connector>.<family>@1`
 *   or `composio.<toolkit>@1`) whose actions serve the catalog contract;
 * - `decision`: who answers it;
 * - `event`: that the workflow may listen for and emit the contract's
 *   types. Who may send each is the contract's (`browser`, `ingress`)
 *   and the host's checks on every send, never this approval's.
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
    kind: z.literal("decision"),
    deciders: z.array(deciderSchema).min(1).max(decisionDecidersMax),
  }),
  // An event binding, and for one whose contract takes types from a
  // webhook source, the event source whose events reach it (core's
  // event-sources.ts): only that one's, only as those types.
  z.strictObject({
    kind: z.literal("event"),
    source: identifierSchema.optional(),
  }),
  // The Brain, through the workflow's own `{ type: "platform" }`
  // permission to read it (`brain`): its runs recall what the person a
  // run acts for may read, never more.
  z.strictObject({
    kind: z.literal("brain"),
    permissionId: identifierSchema,
  }),
  // The run's own files (GRA-724): what its actions write and read back,
  // its own alone, gone with its details. Nothing outside the run serves
  // it, so there is nothing to name: the admin approves that the version
  // keeps run files at all.
  z.strictObject({ kind: z.literal("files") }),
]);
export type WorkflowBindingTarget = z.infer<typeof workflowBindingTargetSchema>;

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

/**
 * An active approval as a workflow's listing names it: with what its
 * target names, as an offer of the same target is named
 * (`PendingWorkflowBindings`): a connector's grant
 * by its binding name, a model by its ID;
 * empty where the target names nothing, or its grant is gone.
 */
export interface ListedWorkflowBindingApproval extends WorkflowBindingApproval {
  label: string;
}

/**
 * A version of a workflow whose catalog bindings an admin hasn't approved,
 * so its starts are refused (`workflow.binding_unapproved`): each binding,
 * with the targets core can offer now that would serve it, each checked as
 * an approval is. A decision is offered none: the admin names its
 * deciders. Across workflows (`pendingBindings`) only what is quick to
 * read is offered (models, events, files, the Brain); a connector is
 * offered on the workflow's own read
 * (`pendingBindingsOf`).
 */
export interface PendingWorkflowBindings {
  workflow: { id: string; name: string };
  version: number;
  bindings: {
    alias: string;
    kind: CatalogBindingKind;
    /** The catalog contract it calls. */
    contractId: string;
    /** Each target offered, with what it names (`ListedWorkflowBindingApproval`). */
    offered: { target: WorkflowBindingTarget; label: string }[];
  }[];
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

/** The most a workflow's state takes in all, in bytes: 64 KiB. */
export const workflowStateMaxBytes = 64 * 1024;

/** A key of a workflow's state, as an expression reads it (`state.<key>`). */
export const workflowStateKeySchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

/** One value a workflow keeps between its runs. */
export interface WorkflowStateEntry {
  key: string;
  value: Json;
  /** The run whose step set it last. */
  runId: string;
  updatedAt: string;
}

/** What a workflow keeps between its runs, by key. */
export interface WorkflowState {
  entries: WorkflowStateEntry[];
  /** What it takes now, of `workflowStateMaxBytes`. */
  bytes: number;
}

/**
 * An App's binding of a workflow, by an alias of the App's: its starts
 * run the workflow's live version.
 */
export const appWorkflowBindingSchema = z.strictObject({
  app: identifierSchema,
  alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u),
});

/** An App's binding of a workflow. */
export interface AppWorkflowBinding {
  id: string;
  app: string;
  alias: string;
  /** The workflow it binds: its starts run its live version. */
  workflowId: string;
  boundBy: string;
  boundAt: string;
}

/**
 * A start of an independent workflow: the exact version (a publication
 * number, never an alias such as "latest"), its args, and a key of the
 * invoker's own, so the same start sent again is the same start.
 */
export const workflowStartSchema = z.strictObject({
  version: z.number().int().positive(),
  args: z.json(),
  key: identifierSchema,
});

/** A start the host admitted: its receipt. */
export interface WorkflowStart {
  id: string;
  workflowId: string;
  version: number;
  manifestHash: string;
  invoker: {
    type: "person" | "app" | "agent" | "trigger";
    id: string;
  };
  principal: string;
  authorityGeneration: number;
  inputHash: string;
  /** The parameter revision its values were frozen at. */
  paramsRevision: number;
  /** The SHA-256 of the frozen bindings. */
  bindingsHash: string;
  /** The run executing it, pinned to the version's build. */
  runId: string;
  createdAt: string;
}

/**
 * The start keys core derives itself begin with this: an App action's
 * starts, and a committed mutation's. A key a caller chooses (a person's,
 * an agent's, and a page's when pages start workflows) may not, so no
 * caller can take one of core's keys before core does.
 */
export const coreStartKeyPrefix = "grasp:";

/**
 * A start a committed mutation staged in its store's outbox
 * (`ctx.workflows.<alias>.start`), which its dispatch admits after the commit:
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
  | "paused"
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
  /**
   * While it runs, a step of it waiting for its AI provider: which, what it
   * showed (refusing the key, not answering, limiting requests), and since
   * when. It goes on by itself once calls work.
   */
  aiProvider?: RunAiProviderWait;
  createdAt: string;
  endedAt: string | null;
  /** What it returned, once completed, for those who see its details. */
  result?: unknown;
  /** Why it failed, for those who see its details. */
  error?: { code: string | null; message: string };
}

/**
 * How a workflow is started by hand: the version a start runs, its live
 * one (null before any is published), and the JSON Schema its args must match exactly (null when
 * it can't be read). A field of the args that takes a person, team or
 * role (`person:<id>`, `team:<id>` or `role:<role>`) carries
 * `"x-grasp-value": { "kind": "person" }`, as a workflow's JSON writes it,
 * and `people` then says whom it may name: the organization's people,
 * members now, and its teams, by name; null for a form with no such field.
 */
export interface WorkflowStartForm {
  version: number | null;
  args: Record<string, unknown> | null;
  people: {
    people: { id: string; name: string }[];
    teams: { id: string; name: string }[];
  } | null;
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
  /**
   * The business process it serves, if a builder set one: what the UI
   * shows its icon for and groups it by. It grants nothing.
   */
  process: BusinessProcess | null;
  createdAt: string;
}

/**
 * A binding a version resolved, by the host: exact IDs and fingerprints.
 * Which workflow resource it binds (its ID and internal version) only for
 * a builder of that workflow, and its contract key for them and for the
 * binding workflow's builders, whose definition text names it: anyone else
 * gets null there, and only the alias and the contract's fingerprint. A
 * catalog binding
 * (a connector, model or decision contract) names its
 * contract key and fingerprint; what serves it is an approval's.
 */
export interface WorkflowVersionBinding {
  alias: string;
  kind: CatalogBindingKind;
  /** The contract key the definition named. */
  contractId: string;
  /** The target version's contract hash. */
  fingerprint: string;
}

/**
 * A write a model's answers may steer, by its permission's alias: a
 * connector's, with each of its operations that may write.
 */
export interface SteeredWrite {
  alias: string;
  kind: "connector";
  operations: string[];
}

/** Why a deletion was refused with `workflow.resource_bound`, in its details. */
export interface WorkflowBinders {
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
 * What a version runs: code generated from its definition, compiled and
 * sealed with it, named by `hash`, its executable identity (the same
 * definition, generator, compiler and SDK always make the same hash).
 * Every definition that passes generates, so every version has one.
 */
export interface WorkflowVersionBuild {
  hash: string;
}

/** One published version of a workflow. */
export interface WorkflowResourceVersion {
  resourceId: string;
  version: number;
  /**
   * The semantic version publication gives its contract (its catalog
   * key's), unique per workflow.
   */
  contractVersion: string;
  /**
   * What people call it, `YY.MM.N`: given the first time it goes live,
   * and kept; null for one never live.
   */
  label: string | null;
  profile: string;
  definitionHash: string;
  contractHash: string;
  manifestHash: string;
  bindings: WorkflowVersionBinding[];
  /**
   * What the workflow's own model tasks may steer (GRA-727): when its build
   * holds any model task, every write its call tasks may make; empty
   * otherwise. Conservative: a model task is taken to reach every call,
   * whatever their order.
   */
  modelSteeredWrites: SteeredWrite[];
  /** Its build; null for a version that is refused (`refused`). */
  build: WorkflowVersionBuild | null;
  /**
   * Why the version is refused, when it is: an earlier platform release
   * published it, in a format this one doesn't read
   * (`workflow.format_unsupported`), and it is to be published again. It
   * never runs, starts, is reviewed or exported, so nothing of its build
   * is shown.
   */
  refused?: { code: "workflow.format_unsupported"; message: string };
  author: string;
  createdAt: string;
}

/**
 * A version's portable source, for its builders: the SDK TypeScript
 * generated from its definition, by path. The
 * definition itself stays with the version, for review: what leaves is
 * the code. Edited generated code can't come back: a version is only ever
 * published from a definition.
 */
export interface WorkflowVersionSource {
  files: Record<string, string>;
}

/**
 * The organization's people and teams, by name, to share a workflow with,
 * and the projects the person builds, whose everyone it may be shared with.
 */
export interface WorkflowShareCandidates {
  people: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

/** Someone a workflow is shared with, as an App's (`AppMember`). */
export interface WorkflowMember {
  type: "person" | "team" | "project";
  id: string;
  /**
   * The person's, team's or project's name; null once they are gone, and
   * for a project the person isn't in, whose name is its members' alone.
   */
  name: string | null;
  role: WorkflowRole;
  /** Who shared it with them, or last changed their role. */
  addedBy: string;
  addedAt: string;
}

/**
 * Whom a workflow is shared with (`workflowResources.members`), as an
 * App's members (`apps.members`): anyone with a role in it lists them;
 * its builders change them, never Grasp staff.
 */
export interface WorkflowMembersApi {
  list: (id: string) => Promise<WorkflowMember[]>;
  /** Shares it (`workflowShareSchema`), or changes the role of someone it is shared with. */
  add: (id: string, member: unknown) => Promise<WorkflowMember>;
  /** Stops sharing it with them (`workflowMemberSchema`). */
  remove: (id: string, member: unknown) => Promise<void>;
  /**
   * Whom its builders may share it with: the organization's people and
   * teams, by name and ID alone (no address, no role, no team's members).
   */
  candidates: (id: string) => Promise<WorkflowShareCandidates>;
}

/**
 * A JSON Pointer to a step in a draft, as the diagram names it
 * (`DiagramTask.pointer`, `/steps/0/then/1`), or to a list of steps: the
 * workflow's own (`/steps`) or one a step holds (`/steps/0/else`).
 */
const stepPointerSchema = z.string().startsWith("/").max(4096);

/**
 * A step's fields besides its `id`, as grasp-workflow/2 has them: `type`,
 * `title` and the rest. Checked with the draft, as any edit.
 */
const stepFieldsSchema = z.record(z.string(), z.json());

/**
 * One step of a draft edited on the canvas or by the agent (`editStep`),
 * as the next revision over `revision`, the one read: `change` replaces the
 * fields of the step at `pointer`, keeping its ID (a rename is a new
 * `title`); `insert` puts step `id` with `step`'s fields at `index` of the
 * list of steps at `list`. The draft is saved checked, as any edit,
 * problems and all.
 */
export const workflowStepEditSchema = z.strictObject({
  revision: z.int().min(0),
  edit: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("change"),
      pointer: stepPointerSchema,
      step: stepFieldsSchema,
    }),
    z.strictObject({
      kind: z.literal("insert"),
      list: stepPointerSchema,
      index: z.int().min(0),
      id: z.string().min(1).max(128),
      step: stepFieldsSchema,
    }),
  ]),
});

/**
 * An edit of a workflow's draft (`workflow.json`): its whole new text, and
 * the draft's revision it read (0 before the first edit), which must
 * still be the draft's (`draft.conflict` otherwise).
 */
export const workflowDraftEditSchema = z.strictObject({
  revision: z.int().min(0),
  // The profile's own bound on a definition: 1 MiB of UTF-8, as stored.
  source: z
    .string()
    .max(1024 * 1024)
    .refine(
      (text) => new TextEncoder().encode(text).byteLength <= 1024 * 1024,
      "A draft is at most 1 MiB of UTF-8."
    ),
});

/** Most bindings a test run's start answers for. */
export const maxCandidateFixtures = 64;

/** Most bytes of a test run's fixtures, as JSON text, all answers together. */
export const maxCandidateFixtureBytes = 256 * 1024;

/**
 * Most test runs of one workflow that haven't ended a person may have at
 * once: a start past it is refused (`workflow.candidate_limit`).
 */
export const maxLiveCandidateRuns = 5;

/**
 * Most test runs of one workflow a person may have kept, ended or not,
 * until the sweep removes them: a start past it is refused
 * (`workflow.candidate_kept_limit`).
 */
export const maxKeptCandidateRuns = 100;

/**
 * The most runs a workflow's list of runs answers: the newest. A page
 * that counts them says "50+" when it has this many.
 */
export const workflowRunsListed = 50;

/**
 * The most files, or activity entries, a read of a workflow's answers:
 * the newest. A page that counts them says "100+" when it has this many.
 */
export const workflowOwnListed = 100;

/**
 * The longest a test run may wait or sleep, from its start: a wait past it
 * fails the run (`workflow.candidate_wait_limit`).
 */
export const maxCandidateWaitMs = 15 * 60 * 1000;

/**
 * The longest a test run may go on, from its start: its first activation
 * past it fails the run (`workflow.candidate_time_limit`), however its
 * waits are chained.
 */
export const maxCandidateLifetimeMs = 60 * 60 * 1000;

/**
 * A test run of a workflow's draft (GRA-815): the draft's exact revision,
 * which must still be the draft's and pass the profile, the run's args, the parameter values it runs with (each
 * left out takes its default; the workflow's own values never count),
 * and the result each binding it calls answers, by alias, and each App
 * function by `<alias>/<function ID>`. A test run never calls anything:
 * a call with no answer here fails (`workflow.candidate_unfixtured`).
 */
export const workflowCandidateStartSchema = z.strictObject({
  revision: z.int().min(0),
  args: z.json(),
  params: z.record(z.string().max(64), z.json()).optional(),
  fixtures: z
    .record(
      // An alias, or an App permission's alias and a function's ID.
      z.string().min(1).max(129),
      z.strictObject({ result: z.json() })
    )
    .refine(
      (fixtures) => Object.keys(fixtures).length <= maxCandidateFixtures,
      { message: `At most ${maxCandidateFixtures} bindings.` }
    )
    .refine(
      (fixtures) =>
        new TextEncoder().encode(JSON.stringify(fixtures)).byteLength <=
        maxCandidateFixtureBytes,
      { message: `At most ${maxCandidateFixtureBytes} bytes of answers.` }
    ),
});

/** A test run of a workflow's draft, for its builders. */
export interface WorkflowCandidateRun {
  id: string;
  workflowId: string;
  /** The draft revision it runs. */
  draftRevision: number;
  /** The executable identity it runs, compiled as it started. */
  buildHash: string;
  principal: string;
  status: WorkflowRunStatus;
  createdAt: string;
  endedAt: string | null;
  /** What it returned, once completed. */
  result?: unknown;
  /** Why it failed. */
  error?: { code: string | null; message: string };
}

/**
 * Most recent runs one test over real items takes: one test run each, all
 * going at once, so no more than a person may have going.
 */
export const maxItemTestItems = maxLiveCandidateRuns;

/**
 * A test of a workflow's draft over recent real items (GRA-513): the
 * draft's exact revision runs once on the args of each of the
 * tester's most recent runs whose details they may see and whose input is
 * still kept (`items` of them, at most `maxItemTestItems`), each as a test
 * run (`workflowCandidateStartSchema`): with the parameters given here or
 * their defaults, and every call answered from `fixtures`, never made.
 */
export const workflowItemTestStartSchema = workflowCandidateStartSchema
  .omit({ args: true })
  .extend({ items: z.int().min(1).max(maxItemTestItems).optional() });

/** One real item of a test, and how the draft did on it. */
export interface WorkflowItemTestItem {
  /** The run whose input it is. */
  sourceRunId: string;
  /** The version that run ran, and how it stands now. */
  sourceVersion: number;
  sourceStatus: WorkflowRunStatus;
  sourceCreatedAt: string;
  /**
   * The test run of the item, as `candidateRun` reads it; null when it
   * never started (`refusal`), or once it was removed after a week.
   */
  run: WorkflowCandidateRun | null;
  /** Why the item's test run never started (its input refused, a limit). */
  refusal: string | null;
}

/** A test of a workflow's draft over recent real items, item by item. */
export interface WorkflowItemTest {
  id: string;
  workflowId: string;
  draftRevision: number;
  principal: string;
  createdAt: string;
  /** Newest item first, as the runs were started. */
  items: WorkflowItemTestItem[];
}

/**
 * A workflow's draft as its editor shows it (`workflow.json` of its
 * draft, @grasp-os/shared/drafts): its text at `revision` (0 while nobody
 * has written it: the live version's definition, or a starting one with
 * no steps), what the profile says of it, and its diagram, drawn from
 * that very text while it has no problems.
 */
export interface WorkflowDraft {
  revision: number;
  source: string;
  problems: WorkflowDefinitionProblem[];
  /** Null while the text has problems: there is nothing sound to draw. */
  diagram: WorkflowDiagram | null;
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
/**
 * A file a run of a workflow wrote: what it is and which run wrote it,
 * never its bytes. Seen as a run's results are: by the person the run
 * acted for, and the organization's admins. Kept with its run, and gone
 * when the run's details are.
 */
export interface WorkflowFile {
  id: string;
  runId: string;
  name: string;
  /** Its media type, as the run gave it. */
  type: string;
  /** In bytes. */
  size: number;
  /** When its run finished writing it (ISO 8601). */
  writtenAt: string;
}

/** One thing that happened to a workflow, newest first in its activity. */
export type WorkflowActivity =
  /** A version was published, by its author. */
  | { kind: "version"; at: string; by: string; version: number }
  /** A binding of a version was approved or revoked, by whom. */
  | {
      kind: "binding";
      at: string;
      by: string;
      alias: string;
      bindingKind: string;
      version: number;
      change: "approved" | "revoked";
    }
  /**
   * A run started, or ended with its status, for the person it acted for
   * (`principal`): every run for its builders, a user's own for a user.
   */
  | {
      kind: "run";
      at: string;
      runId: string;
      principal: string;
      version: number;
      status: WorkflowRunStatus;
      change: "started" | "ended";
    };

export interface WorkflowResourcesApi {
  /**
   * Creates a workflow the caller owns, named `name`; for builders. With
   * `project`, it is made in that project, shared with everyone in it:
   * only for a builder of the project, checked before anything is made.
   */
  create: (name: string, project?: string) => Promise<WorkflowResource>;
  /** The workflows the caller has a role in, by name. */
  list: () => Promise<WorkflowResource[]>;
  get: (id: string) => Promise<WorkflowResource>;
  /**
   * Sets the business process it serves (`businessProcessSchema`), or
   * clears it with null; for its builders, audited.
   */
  setProcess: (id: string, process: unknown) => Promise<WorkflowResource>;
  /** Its draft, for its builders (`WorkflowDraft`). */
  draft: (id: string) => Promise<WorkflowDraft>;
  /**
   * Saves an edit of its draft (`workflowDraftEditSchema`), checked, as
   * the person's own checkpoint; `draft.conflict` once the draft moved
   * past the revision read. Publishing it is `drafts.publish`.
   */
  editDraft: (id: string, input: unknown) => Promise<WorkflowDraft>;
  /**
   * Inserts or changes one step of its draft (`workflowStepEditSchema`),
   * saved as the draft's next revision, checked; for builders.
   */
  editStep: (id: string, input: unknown) => Promise<WorkflowDraft>;
  /**
   * One version's portable source: its definition and the code generated
   * from it, read back from what was sealed; for builders.
   */
  source: (id: string, version: number) => Promise<WorkflowVersionSource>;
  /**
   * Whether its owner lets people ask Stephen to start it in a chat app;
   * for anyone with a role in it.
   */
  askable: (id: string) => Promise<boolean>;
  /**
   * The live workflows, of those the person sees, that people may ask
   * Stephen to start, in one read: for Settings › Stephen.
   */
  askableWorkflows: () => Promise<{ id: string; name: string }[]>;
  /**
   * Lets people ask Stephen to start it in a chat app, as themselves, or
   * stops that; for its owner.
   */
  setAskable: (id: string, askable: unknown) => Promise<void>;
  delete: (id: string) => Promise<void>;
  /**
   * Releases the name of a deleted workflow, so a new workflow may take
   * it; for the organization's admins. Refused while anything still names
   * a version of it (`workflow.name_pinned`). Its old contract keys stay
   * unanswered: no workflow publishes a version it published.
   */
  releaseName: (name: string) => Promise<void>;
  /**
   * Starts an exact version of a workflow the caller has a role in, acting
   * for them (`workflowStartSchema`): its admitted receipt.
   */
  /**
   * How to start it by hand (`WorkflowStartForm`): the version a start
   * from its page runs and the input it takes; for anyone with a role.
   */
  startForm: (id: string) => Promise<WorkflowStartForm>;
  start: (id: string, input: unknown) => Promise<WorkflowStart>;
  /** One of its runs, for anyone with a role (`WorkflowResourceRun`). */
  run: (id: string, runId: string) => Promise<WorkflowResourceRun>;
  /**
   * Its runs, newest first, the latest page: every run for its builders,
   * a user's own for a user; never what one returned or why it failed.
   */
  runs: (id: string) => Promise<WorkflowResourceRun[]>;
  /**
   * The files its runs wrote, newest first, the latest page: what they are,
   * never their bytes. For anyone with a role, of the runs that acted for
   * them; every run's for the organization's admins, as a run's results are.
   */
  files: (id: string) => Promise<WorkflowFile[]>;
  /**
   * What happened to it, newest first, the latest page: versions,
   * bindings approved and revoked, and runs, as `runs` shows them to the
   * reader.
   */
  activity: (id: string) => Promise<WorkflowActivity[]>;
  /** Stops a run that hasn't ended; for the workflow's builders and admins. */
  terminateRun: (id: string, runId: string) => Promise<WorkflowResourceRun>;
  /**
   * Run `runId`'s finished files, oldest first, to download: for the run's
   * person and, unless the run is restricted, the organization's admins;
   * null for anyone else who may see the run, and once its details are
   * gone.
   */
  runFiles: (id: string, runId: string) => Promise<RunFileListing[] | null>;
  /** What run `runId` did, over its version's diagram, for builders. */
  runTrace: (id: string, runId: string) => Promise<WorkflowRunTrace>;
  /**
   * Starts a test run of the draft at an exact revision,
   * never published, its calls answered from the start's fixtures; for
   * builders (`workflowCandidateStartSchema`).
   */
  startCandidateRun: (id: string, input: unknown) => Promise<{ runId: string }>;
  /** One of its test runs, for builders. */
  candidateRun: (id: string, runId: string) => Promise<WorkflowCandidateRun>;
  /** Stops one of its test runs that hasn't ended; for builders. */
  terminateCandidateRun: (
    id: string,
    runId: string
  ) => Promise<WorkflowCandidateRun>;
  /** What one of its test runs did, step by step, for builders. */
  candidateRunTrace: (
    id: string,
    runId: string
  ) => Promise<WorkflowCandidateTrace>;
  /**
   * Tests the draft at an exact revision over the caller's
   * recent real runs, one test run each, every call answered from the
   * start's fixtures; for builders (`workflowItemTestStartSchema`).
   */
  startItemTest: (id: string, input: unknown) => Promise<WorkflowItemTest>;
  /** One of its tests over real items, item by item; for its tester. */
  itemTest: (id: string, testId: string) => Promise<WorkflowItemTest>;
  /** Its parameters' configuration, for anyone with a role. */
  params: (id: string) => Promise<WorkflowParams>;
  /** Sets parameter values, revision-checked; for builders. */
  setParams: (id: string, input: unknown) => Promise<WorkflowParams>;
  /** What it keeps between its runs, for its builders and admins. */
  state: (id: string) => Promise<WorkflowState>;
  /** Empties what it keeps between its runs; for builders and admins, audited. */
  resetState: (id: string) => Promise<WorkflowState>;
  /** Its active approvals, each named, for anyone with a role. */
  bindings: (id: string) => Promise<ListedWorkflowBindingApproval[]>;
  /** Approves a binding; for the organization's admins. */
  approveBinding: (
    id: string,
    input: unknown
  ) => Promise<WorkflowBindingApproval>;
  /** Revokes a binding approval; for the organization's admins. */
  revokeBinding: (id: string, approval: string) => Promise<void>;
  /**
   * The live versions of workflows whose bindings
   * no admin approved, at most 50, each with the targets core can offer;
   * for the organization's own admins, never Grasp staff.
   */
  pendingBindings: () => Promise<PendingWorkflowBindings[]>;
  /**
   * Its live version, when its bindings no admin approved, with the
   * targets core can offer, of every kind; for the organization's own
   * admins, never Grasp staff.
   */
  pendingBindingsOf: (id: string) => Promise<PendingWorkflowBindings[]>;
  /** Binds an exact version to an App; for the App's builders. */
  bindToApp: (id: string, input: unknown) => Promise<AppWorkflowBinding>;
  /** Removes an App's binding; for the App's builders. */
  unbindFromApp: (binding: string) => Promise<void>;
  /**
   * The workflows App `app` binds, by alias: for the App's builders,
   * archived or not, never Grasp staff.
   */
  appBindings: (app: string) => Promise<AppWorkflowBinding[]>;
  /** The host catalog's contracts, for builders. */
  catalog: () => Promise<CatalogContractEntry[]>;
  /** Publishes a catalog contract; for the organization's admins. */
  publishContract: (input: unknown) => Promise<CatalogContractEntry>;
  /** Whether it is paused, and pausing and resuming it. */
  readonly pause: WorkflowPauseApi;
  readonly members: WorkflowMembersApi;
  /** Its triggers: list, create, move to a version, enable and delete. */
  readonly triggers: WorkflowTriggersApi;
  /**
   * The deployment's event sources, which webhook triggers start on:
   * created and managed by admins, listed for builders too.
   */
  readonly sources: EventSourcesApi;
}
