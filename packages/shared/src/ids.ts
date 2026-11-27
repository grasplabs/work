import { z } from "zod";

import { identifierMaxLength } from "./identifier.ts";

export { identifierMaxLength } from "./identifier.ts";

/** An identifier: non-empty, and at most {@link identifierMaxLength}. */
export const identifierSchema = z.string().min(1).max(identifierMaxLength);

/**
 * Creates the schema for one kind of ID. The brand exists only in the type
 * system: an `AppId` can't be passed where a `RunId` is expected, and a plain
 * string becomes an ID only by parsing it.
 *
 * IDs are opaque: nothing may read meaning into their contents, and each store
 * picks how it mints them, so the only rules are those of an identifier: never
 * empty, and short enough for the audit log.
 *
 * Marked free of side effects so bundlers drop the ID schemas a consumer
 * doesn't import.
 */
/* @__NO_SIDE_EFFECTS__ */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the brand is type-only by design
const idSchema = <Brand extends string>() => identifierSchema.brand<Brand>();

/** A memory record in the Brain. */
export const memoryIdSchema = idSchema<"MemoryId">();
export type MemoryId = z.infer<typeof memoryIdSchema>;

/**
 * A business store: its logical tables and records, independent of any
 * App, workflow or run that uses it.
 */
export const storeIdSchema = idSchema<"StoreId">();
export type StoreId = z.infer<typeof storeIdSchema>;

/** An App: its pages, workflows and permissions, installed as one unit. */
export const appIdSchema = idSchema<"AppId">();
export type AppId = z.infer<typeof appIdSchema>;

/** A blueprint to create Apps from: random, or a built-in's folder name. */
export const blueprintIdSchema = idSchema<"BlueprintId">();
export type BlueprintId = z.infer<typeof blueprintIdSchema>;

/** A workflow inside an App. */
export const workflowIdSchema = idSchema<"WorkflowId">();
export type WorkflowId = z.infer<typeof workflowIdSchema>;

/**
 * An independent workflow resource (workflow-resources.ts): owned and
 * versioned on its own, never part of an App.
 */
export const workflowResourceIdSchema = idSchema<"WorkflowResourceId">();
export type WorkflowResourceId = z.infer<typeof workflowResourceIdSchema>;

/** An independent trigger: what starts one exact workflow version. */
export const triggerIdSchema = idSchema<"TriggerId">();
export type TriggerId = z.infer<typeof triggerIdSchema>;

/** One run of a workflow. */
export const runIdSchema = idSchema<"RunId">();
export type RunId = z.infer<typeof runIdSchema>;

/** A workspace. */
export const workspaceIdSchema = idSchema<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

/**
 * A chat in a workspace: unique only within it, as each person's own
 * Workspace object names its chats (a page may name a new one). Outside
 * that object a chat is always its {@link ChatRef}.
 */
export const chatIdSchema = idSchema<"ChatId">();
export type ChatId = z.infer<typeof chatIdSchema>;

/**
 * A chat as everything outside its Workspace object names it: the
 * workspace and the chat's ID there, never the ID alone. Whatever is kept
 * or found of a chat elsewhere (core's D1, another object, connect) is
 * keyed by both, so one person's chat can never be taken for another's
 * that has the same ID.
 */
export const chatRefSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  chatId: chatIdSchema,
});
export type ChatRef = z.infer<typeof chatRefSchema>;

/**
 * The one string a chat's {@link ChatRef} makes, for a name or key built
 * from a chat (its ChatSession object's name, an idempotency key): `/`
 * never occurs in a workspace's ID, so two refs never make one string.
 */
export const chatKeyOf = ({ workspaceId, chatId }: ChatRef): string =>
  `${workspaceId}/${chatId}`;

/** Whether `a` and `b` are one chat: the same workspace and ID there. */
export const sameChat = (a: ChatRef, b: ChatRef): boolean =>
  a.workspaceId === b.workspaceId && a.chatId === b.chatId;

/** A connection to an outside system, held by connect. */
export const connectionIdSchema = idSchema<"ConnectionId">();
export type ConnectionId = z.infer<typeof connectionIdSchema>;

/** An agent that works for people, such as the chat agent of a workspace. */
export const agentIdSchema = idSchema<"AgentId">();
export type AgentId = z.infer<typeof agentIdSchema>;

/**
 * A team of the organization, by its stable ID: a rename changes only its
 * name, never what names it.
 */
export const teamIdSchema = idSchema<"TeamId">();
export type TeamId = z.infer<typeof teamIdSchema>;

/** One permission granted to an agent or App. */
export const permissionIdSchema = idSchema<"PermissionId">();
export type PermissionId = z.infer<typeof permissionIdSchema>;
