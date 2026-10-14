import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { identifierSchema } from "./ids.ts";

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
export const workflowRoleSchema = z.enum(["user", "builder"]);
export type WorkflowRole = z.infer<typeof workflowRoleSchema>;

export const workflowShareSchema = workflowMemberSchema.extend({
  role: workflowRoleSchema,
});

/**
 * A version to publish: the definition's text, and the current version
 * the publisher built on (null for the first), so two publications don't
 * silently move the current version past each other.
 */
export const workflowPublishSchema = z.strictObject({
  definition: z.string(),
  basedOn: z.number().int().positive().nullable(),
});

export const workflowResourceErrors = defineErrorFamily({
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
    "The current version of another workflow calls this one, so it can't be deleted.",
  "workflow.resource_limit":
    "You have created as many workflows as one person may, deleted ones included.",
  "workflow.version_corrupt":
    "This version's stored record doesn't match what was published, so it isn't used. Report it to Grasp.",
});

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
 * Which workflow it binds (its ID, version and contract key, which names
 * it) only for a builder of that workflow: anyone else gets null there,
 * and only the alias and the contract's fingerprint.
 */
export interface WorkflowVersionBinding {
  alias: string;
  kind: "workflow";
  resourceId: string | null;
  resourceVersion: number | null;
  /** The contract key the definition named. */
  contractId: string | null;
  /** The target version's contract hash. */
  fingerprint: string;
}

/**
 * Why a deletion was refused with `workflow.resource_bound`, in its
 * details: the workflows whose current version binds it that the caller
 * may see, and how many more there are that they may not.
 */
export interface WorkflowBinders {
  binders: { id: string; name: string }[];
  hidden: number;
}

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
  author: string;
  createdAt: string;
}

/** Someone a workflow is shared with. */
export interface WorkflowMember {
  type: "person" | "team";
  id: string;
  role: WorkflowRole;
  addedBy: string;
  addedAt: string;
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
  versions: (id: string) => Promise<WorkflowResourceVersion[]>;
  /** One version's definition text, exactly as published; for builders. */
  definition: (id: string, version: number) => Promise<string>;
  share: (id: string, input: unknown) => Promise<void>;
  unshare: (id: string, input: unknown) => Promise<void>;
  members: (id: string) => Promise<WorkflowMember[]>;
  delete: (id: string) => Promise<void>;
}
