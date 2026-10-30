import { descriptorFromText, jsonSchemaOf } from "@grasp-os/sdk/host";
import type { WorkflowStartForm } from "@grasp-os/shared/workflow-resources";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "./auth/identity.ts";
import { workflowResourceLifecycles } from "./db/core/schema.ts";
import { requireWorkflowRole, versionContract } from "./workflow-resources.ts";

// What a person needs to start an independent workflow by hand from its
// page (GRA-1305): the version a start would run, and the JSON Schema its
// input must match, as that version's contract says. Anyone with a role
// in the workflow may start it (workflow-starts.ts decides, again, on the
// start), so anyone with a role may read this; nobody else learns the
// workflow exists. The version is the one approved to go live, and before
// any is, the one published last, as a builder's run takes it. The schema
// is the exact form a start is checked against: a field with a default
// must be given, as nothing fills it in.

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
    return { version: null, input: null };
  }
  const contract = await versionContract(env, workflow.id, version);
  return {
    version,
    input:
      contract === undefined
        ? null
        : jsonSchemaOf(descriptorFromText(JSON.stringify(contract.input)), {
            exact: true,
          }),
  };
};
