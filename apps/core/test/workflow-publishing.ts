import type { LiveVersion } from "@grasp-os/shared/drafts";
import type { Identity, SessionApi } from "@grasp-os/shared/rpc";
import type { WorkflowResourceVersion } from "@grasp-os/shared/workflow-resources";

import type { Acting } from "../src/auth/identity.ts";
import { draftOf } from "../src/drafts.ts";
import { publish } from "../src/publish.ts";
import { editWorkflowDraft } from "../src/workflow-editor.ts";
import { workflowKind, workflowVersion } from "../src/workflow-resources.ts";

/**
 * Publishes `definition` as workflow `id`'s next version over `/rpc`, as
 * a person does in Grasp: written into the workflow's draft over the
 * revision read, then the draft published (`drafts.publish`).
 */
export const publishOverRpc = async (
  api: Pick<SessionApi, "drafts" | "workflowResources">,
  id: string,
  definition: string
): Promise<LiveVersion> => {
  const subject = { kind: "workflow", id } as const;
  const { revision } = await api.drafts.get(subject);
  await api.workflowResources.editDraft(id, { revision, source: definition });
  return await api.drafts.publish(subject, revision + 1);
};

/**
 * Publishes `definition` as workflow `id`'s next version for `by`, as a
 * person does in Grasp, in core: written into its draft over the
 * revision read, then the draft published (publish.ts). Answers the
 * version made live.
 */
export const publishDefinition = async (
  env: Env,
  by: Acting,
  id: string,
  definition: string
): Promise<WorkflowResourceVersion> => {
  // A person as a session names them: what publishing records.
  const person: Acting & Identity = {
    email: `${by.userId}@example.test`,
    name: by.userId,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...by,
  };
  const { revision } = await draftOf(env, workflowKind, id);
  await editWorkflowDraft(env, person, id, { revision, source: definition });
  const live = await publish(env, workflowKind, person, id, revision + 1);
  return await workflowVersion(env, person, id, live.version);
};
