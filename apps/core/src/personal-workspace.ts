import { workspaceIdSchema } from "@grasp-os/shared/ids";
import type { WorkspaceId } from "@grasp-os/shared/ids";

/**
 * The Workspace object that holds `userId`'s chats: each person's own, so
 * one person's chats, watches and turns never load, cap or restart
 * another's. A chat's context names it (`workspaceId`), and its agent is
 * still `chatAgentId` (chats-rpc.ts). Their dashboard is kept there too.
 */
export const personalWorkspaceId = (userId: string): WorkspaceId =>
  workspaceIdSchema.parse(`person:${userId}`);
