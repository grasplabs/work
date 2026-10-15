import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { actorOf } from "@grasp-os/shared/audit";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  workflowParamsEditSchema,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowParams,
  WorkflowParamSetting,
} from "@grasp-os/shared/workflow-resources";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import type { Acting } from "./auth/identity.ts";
import { workflowResourceParams, workflowResources } from "./db/core/schema.ts";
import { isUniqueViolation, notNullFailed } from "./db/d1.ts";
import { requireNotStaff } from "./sharing.ts";
import { requireWorkflowRole, versionContract } from "./workflow-resources.ts";
import type { VersionContract } from "./workflow-resources.ts";

// The parameter configuration of independent workflows (platform
// specification 13.2): the values people set for the parameters a version
// declares, revision by revision, which a start freezes. Threat model, and
// how each is closed:
//
// - An edit racing another, or a start: every edit names the revision it
//   read, and lands only while it is still the one in force, moving it on
//   in the same statement (`workflow.params_conflict` otherwise). A start
//   freezes the values of the revision it read and is admitted only while
//   that revision is still in force (workflow-starts.ts), so it never runs
//   on values half of one edit and half of another, nor on values changed
//   after it was decided.
// - A value the workflow doesn't accept: every value is checked by the
//   SDK's validator against the descriptor of the current version, at the
//   edit, and the edit lands only while that version is still current (a
//   version published meanwhile refuses it, `workflow.params_conflict`); a
//   start checks the frozen values again against its own version.
//   Refusals name the parameter, never the value.
// - A sensitive value leaking: a parameter any version of the workflow
//   ever marked `sensitive` is never listed (only whether it is set),
//   never audited (an edit's event names the parameters changed and the
//   revision, never a value), and never in an error. It is stored to be
//   frozen into a start, which nothing lists either. Sensitivity sticks:
//   a builder publishing a version that declares the parameter not
//   sensitive reveals nothing set before, or after.
// - What `sensitive` doesn't do: keep a value from the workflow's own
//   builders, whose code reads its parameters when it runs, and who can
//   narrow a version's constraints until a start refuses the value. It
//   keeps a value from the workflow's users and from the audit log.
// - A revision changing after the fact: each revision is a row written
//   once; the database refuses updates and deletions of it, but retention
//   removing a replaced revision's values (workflows/retention.ts).
// - Who edits: the workflow's builders, as their roles decide on each
//   call, never Grasp staff: parameters decide whom a run reaches.

/** At most this many parameters are named in an edit's audit event. */
const maxNamedParams = 20;

/**
 * The most a workflow's parameter values take, as canonical JSON in UTF-8,
 * saved or frozen into a start (512 KiB). A start's receipt is one D1 row,
 * which holds at most 2,000,000 bytes, and carries these values beside:
 * its input, at most `operationInputBytes` (128 KiB); its frozen bindings,
 * at most 64 (the profile's `maxBindings`) of about 3 KiB each at their
 * largest (a decision's 16 deciders of 134 characters, a 256-character
 * contract key, the alias, fingerprint and IDs), under 256 KiB; and its
 * IDs and hashes, under 4 KiB. That is under 900 KiB in all, well within a
 * row, whatever a start is given.
 */
export const paramsMaxBytes = 512 * 1024;

/** `values` as canonical JSON, or `workflow.params_invalid` when too large. */
const boundedJson = (values: Record<string, unknown>): string => {
  const text = canonicalJson(z.json().parse(values));
  if (new TextEncoder().encode(text).byteLength > paramsMaxBytes) {
    throw workflowResourceErrors.create("workflow.params_invalid", {
      issues: ["values: The parameters' values together are too large."],
    });
  }
  return text;
};

const valuesSchema = z.record(z.string(), z.json());

/** The values set at `revision` of workflow `id`: none at revision 0. */
const valuesAt = async (
  env: Env,
  id: string,
  revision: number
): Promise<Record<string, unknown>> => {
  if (revision === 0) {
    return {};
  }
  const row = await drizzle(env.DB)
    .select({ values: workflowResourceParams.values })
    .from(workflowResourceParams)
    .where(
      and(
        eq(workflowResourceParams.workflowResourceId, id),
        eq(workflowResourceParams.revision, revision)
      )
    )
    .get();
  return row?.values === undefined || row.values === null
    ? {}
    : valuesSchema.parse(JSON.parse(row.values));
};

/**
 * The parameters any published version of workflow `id` marks sensitive:
 * once one did, its value is withheld whatever the current version says.
 */
const everSensitive = async (env: Env, id: string): Promise<Set<string>> => {
  const rows = await drizzle(env.DB).all<{ name: string }>(
    sql`SELECT DISTINCT param.key AS name
      FROM workflow_resource_versions AS version,
        json_each(version.contract, '$.params') AS param
      WHERE version.workflow_resource_id = ${id}
        AND json_extract(param.value, '$.sensitive') = 1`
  );
  return new Set(rows.map(({ name }) => name));
};

/**
 * `value` for parameter `name` of `contract`, normalized; or, with no
 * value, its default. `workflow.params_invalid` naming the parameter when
 * it doesn't fit, or it has neither.
 */
const acceptedValue = (
  contract: VersionContract,
  name: string,
  value?: unknown
): unknown => {
  const declared = contract.params[name];
  if (declared === undefined) {
    throw workflowResourceErrors.create("workflow.params_invalid", {
      issues: [`${name}: The workflow has no such parameter.`],
    });
  }
  const schema = schemaFromDescriptor(JSON.stringify(declared.descriptor));
  const checked = schema["~standard"].validate(value);
  if ("then" in checked || checked.issues !== undefined) {
    throw workflowResourceErrors.create("workflow.params_invalid", {
      issues: [`${name}: That isn't a value this parameter accepts.`],
    });
  }
  return checked.value;
};

/**
 * Every parameter's value at `revision` for version `version` of workflow
 * `id`, as a start freezes it: set, or its default, each checked against
 * that version's declaration, as canonical JSON.
 */
export const frozenParams = async (
  env: Env,
  id: string,
  version: number,
  revision: number
): Promise<string> => {
  const contract = await versionContract(env, id, version);
  if (contract === undefined) {
    throw workflowResourceErrors.create("workflow.version_not_found");
  }
  const set = await valuesAt(env, id, revision);
  const frozen: Record<string, unknown> = {};
  for (const name of Object.keys(contract.params).toSorted()) {
    frozen[name] = acceptedValue(contract, name, set[name]);
  }
  return boundedJson(frozen);
};

/** Workflow `id`'s current version's contract, which edits are checked against. */
const currentContract = async (
  env: Env,
  id: string,
  version: number | null
): Promise<VersionContract> => {
  const contract =
    version === null ? undefined : await versionContract(env, id, version);
  if (contract === undefined) {
    throw workflowResourceErrors.create("workflow.params_invalid", {
      issues: ["version: Publish a version before setting its parameters."],
    });
  }
  return contract;
};

/**
 * The settings `values` make of `contract`, the values of parameters
 * `sensitive` names, or the contract marks, withheld.
 */
const settingsOf = (
  contract: VersionContract,
  values: Record<string, unknown>,
  sensitive: ReadonlySet<string>
): WorkflowParamSetting[] =>
  Object.entries(contract.params)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, declared]) => {
      const set = Object.hasOwn(values, name);
      const withheld = declared.sensitive || sensitive.has(name);
      return {
        name,
        label: declared.label,
        sensitive: withheld,
        set,
        value: set && !withheld ? values[name] : null,
      };
    });

/**
 * Workflow `id`'s parameters for its current version and the values set,
 * for anyone with a role in it: a sensitive one's value never.
 */
export const workflowParams = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowParams> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const row = await drizzle(env.DB)
    .select({ revision: workflowResources.configRevision })
    .from(workflowResources)
    .where(eq(workflowResources.id, workflow.id))
    .get();
  const revision = row?.revision ?? 0;
  const contract =
    workflow.currentVersion === null
      ? undefined
      : await versionContract(env, workflow.id, workflow.currentVersion);
  const values = await valuesAt(env, workflow.id, revision);
  return {
    revision,
    params:
      contract === undefined
        ? []
        : settingsOf(contract, values, await everSensitive(env, workflow.id)),
  };
};

/**
 * Sets parameter values of workflow `id` for `by`, who must build it, from
 * `input`: the revision they read, the values to change (null among them,
 * for a parameter that takes it), each checked against the current
 * version, and the parameters to put back to their defaults. A new
 * revision, written only while the one read is still in force, and
 * audited by the parameters' names alone.
 */
export const setWorkflowParams = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown
): Promise<WorkflowParams> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const { expectedRevision, values, reset } = workflowResourceErrors.parse(
    "workflow.params_invalid",
    workflowParamsEditSchema,
    input
  );
  const contract = await currentContract(
    env,
    workflow.id,
    workflow.currentVersion
  );
  const next: Record<string, unknown> = {
    ...(await valuesAt(env, workflow.id, expectedRevision)),
  };
  // Null is a value like any other, for a parameter that takes it; going
  // back to the default is `reset`, so the two never mean the same.
  for (const [name, value] of Object.entries(values)) {
    next[name] = acceptedValue(contract, name, value);
  }
  // Back to the default only where there is one: a required parameter
  // with none can't be left unset.
  for (const name of reset) {
    acceptedValue(contract, name);
    Reflect.deleteProperty(next, name);
  }
  const changed = [...Object.keys(values), ...reset].toSorted();
  // Refused before anything is saved, as any value that doesn't fit is.
  const saved = boundedJson(next);
  const revision = expectedRevision + 1;
  const db = drizzle(env.DB);
  try {
    await auditedBatch(env, db, [
      db.insert(workflowResourceParams).values({
        // Only while the revision read is still in force, and the version
        // the values were checked against still the current one, the
        // workflow live: otherwise NULL, which fails the batch.
        workflowResourceId: sql`(SELECT id FROM workflow_resources
          WHERE id = ${workflow.id} AND deleted_at IS NULL
            AND config_revision = ${expectedRevision}
            AND current_version IS ${workflow.currentVersion})`,
        revision,
        values: saved,
        setBy: by.userId,
        setAt: new Date(),
      }),
      db
        .update(workflowResources)
        .set({ configRevision: revision })
        .where(eq(workflowResources.id, workflow.id)),
      outboxed(db, {
        actor: by.actor ?? actorOf(by),
        action: "workflow.params.set",
        target: { type: "workflow_resource", id: workflow.id },
        // The parameters' names, never their values.
        detail: {
          revision,
          changed: changed.length,
          ...Object.fromEntries(
            changed
              .slice(0, maxNamedParams)
              .map((name, index) => [`param${index + 1}`, name])
          ),
        },
      }),
    ]);
  } catch (error) {
    if (
      notNullFailed(error, "workflow_resource_params.workflow_resource_id") ||
      isUniqueViolation(error)
    ) {
      throw workflowResourceErrors.create("workflow.params_conflict");
    }
    throw error;
  }
  return {
    revision,
    params: settingsOf(contract, next, await everSensitive(env, workflow.id)),
  };
};
