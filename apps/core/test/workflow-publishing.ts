import type { LiveVersion } from "@grasp-os/shared/drafts";
import type { SessionApi } from "@grasp-os/shared/rpc";

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
