import type { ValueDescriptor } from "@grasp-os/sdk";
import { descriptorFromText, jsonSchemaOf } from "@grasp-os/sdk/host";
import type { JsonSchema } from "@grasp-os/sdk/host";
import type { WorkflowStartForm } from "@grasp-os/shared/workflow-resources";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "./auth/identity.ts";
import { workflowResourceLifecycles } from "./db/core/schema.ts";
import { requireWorkflowRole, versionContract } from "./workflow-resources.ts";
import { organizationPeopleAndTeams } from "./workflow-share-candidates.ts";

// What a person needs to start an independent workflow by hand from its
// page (GRA-1305): the version a start would run, and the JSON Schema its
// input must match, as that version's contract says. Anyone with a role
// in the workflow may start it (workflow-starts.ts decides, again, on the
// start), so anyone with a role may read this; nobody else learns the
// workflow exists. The version is the one approved to go live, and before
// any is, the one published last, as a builder's run takes it. The schema
// is the exact form a start is checked against: a field with a default
// must be given, as nothing fills it in. A field that takes a person is
// marked so (`startSchemaOf`), and the form then carries whom it may
// name: the organization's people and teams, by name and ID alone, as a
// workflow's share offers them (workflow-share-candidates.ts). Whoever may
// start it may name anyone in such a field (the start checks only that it
// is a person, team or role, and the run's decision that its binding
// covers them), so they learn names they need to pick, and no more: no
// address, role, or a team's members. A form with no such field carries
// none.

/**
 * `descriptor` as the start form's exact JSON Schema, each field of the
 * input that takes a person, team or role (`person:`, `team:` or `role:`)
 * marked as a workflow's JSON writes it (`"x-grasp-value": { "kind": "person" }`), so
 * the form offers people to pick, never an ID to type. The mark only
 * annotates: what a start takes stays the descriptor's to check.
 */
const startSchemaOf = (descriptor: ValueDescriptor): JsonSchema => {
  const schema = jsonSchemaOf(descriptor, { exact: true });
  if (descriptor.kind !== "object") {
    return schema;
  }
  const properties: JsonSchema = {};
  for (const [name, field] of Object.entries(descriptor.fields)) {
    const property = jsonSchemaOf(field, { exact: true });
    properties[name] =
      field.kind === "person" && !field.nullable
        ? { ...property, "x-grasp-value": { kind: "person" } }
        : property;
  }
  return { ...schema, properties };
};

/** Whether input `descriptor` has a field the start form marks as a person. */
const takesPerson = (descriptor: ValueDescriptor): boolean =>
  descriptor.kind === "object" &&
  Object.values(descriptor.fields).some(
    (field) => field.kind === "person" && !field.nullable
  );

/** How workflow `id` is started by hand, for `by`, who has a role in it. */
export const workflowStartForm = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowStartForm> => {
  const workflow = await requireWorkflowRole(env, by, id, "user");
  const lifecycle = await drizzle(env.DB)
    .select({ live: workflowResourceLifecycles.liveVersion })
    .from(workflowResourceLifecycles)
    .where(eq(workflowResourceLifecycles.workflowResourceId, workflow.id))
    .get();
  const version = lifecycle?.live ?? workflow.currentVersion;
  if (version === null) {
    return { version: null, input: null, people: null };
  }
  const contract = await versionContract(env, workflow.id, version);
  if (contract === undefined) {
    return { version, input: null, people: null };
  }
  const descriptor = descriptorFromText(JSON.stringify(contract.input));
  return {
    version,
    input: startSchemaOf(descriptor),
    people: takesPerson(descriptor)
      ? await organizationPeopleAndTeams(env)
      : null,
  };
};
