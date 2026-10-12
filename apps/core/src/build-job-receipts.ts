import type { ChatId, WorkspaceId } from "@grasp-os/shared/ids";

import { proposedByJob } from "./apps.ts";
import { workspace } from "./durable-objects.ts";

// A build job's receipt (build-jobs.ts): the version it committed. The job
// records the tree it is about to commit before it commits; a version over
// that parent with that tree, proposed by this very job, is found here and
// recorded as its receipt, however the job went on: cut off, refused or
// ended behind its record's back.

/**
 * The version the chat's job `jobId` committed, recorded as its receipt
 * once found: the one its record names, or the one it recorded it was
 * about to commit and did. None when it committed nothing.
 */
export const reconcileReceipt = async (
  env: Env,
  workspaceId: WorkspaceId,
  chatId: ChatId,
  jobId: string
): Promise<number | undefined> => {
  const chats = workspace(env, workspaceId);
  const job = await chats.buildJob(chatId, jobId);
  if (job === undefined) {
    return undefined;
  }
  if (job.version !== null) {
    return job.version;
  }
  if (job.intendedTree === null) {
    return undefined;
  }
  const version = await proposedByJob(
    env,
    job.appId,
    { parent: job.intendedParent, tree: job.intendedTree },
    { chatId: job.chatId, jobId: job.id }
  );
  if (version !== undefined) {
    await chats.recordBuildReceipt(job.chatId, job.id, version);
  }
  return version;
};
