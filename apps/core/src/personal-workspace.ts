import { workspaceIdSchema } from "@grasp-os/shared/ids";
import type { WorkspaceId } from "@grasp-os/shared/ids";

/** What every person's own Workspace object's ID starts with. */
export const personalWorkspacePrefix = "person:";

/**
 * The Workspace object that holds `userId`'s chats: each person's own, so
 * one person's chats, watches and turns never load, cap or restart
 * another's. A chat's context names it (`workspaceId`), and its agent is
 * still `chatAgentId` (chats-rpc.ts).
 */
export const personalWorkspaceId = (userId: string): WorkspaceId =>
  workspaceIdSchema.parse(`${personalWorkspacePrefix}${userId}`);

/** Whose personal Workspace object `name` is (`personalWorkspaceId`), if anyone's. */
export const personOfWorkspace = (
  name: string | undefined
): string | undefined =>
  name?.startsWith(personalWorkspacePrefix) === true
    ? name.slice(personalWorkspacePrefix.length)
    : undefined;
