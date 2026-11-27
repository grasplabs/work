import type { ChatRef } from "@grasp-os/shared/ids";
import { sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

import { personalWorkspacePrefix } from "./personal-workspace.ts";

// A chat outside its Workspace object is its `ChatRef` (workspace and chat
// ID), never its ID alone: every table of core's that names a chat keys it
// by both (`chatColumns`, db/core/schema.ts), and these are how a row is
// written and found by it.

/** A table that names a chat by its ref (`chatColumns`). */
interface ChatTable {
  workspaceId: AnyColumn;
  chatId: AnyColumn;
}

/**
 * `personalWorkspacePrefix` as an SQL literal, not a bound value: a check
 * of a start's grants inlines a chat's once per grant, in one statement
 * at D1's limit of bound values (permissions.ts, `holdsIn`).
 */
const personalPrefixSql = sql.raw(`'${personalWorkspacePrefix}'`);

/** As SQL, the own workspace of the person in column `person`. */
export const personalWorkspaceSql = (person: AnyColumn): SQL =>
  sql`${personalPrefixSql} || ${person}`;

/** The rows of `table` that are of chat `ref`. */
export const ofChat = (
  table: ChatTable,
  { workspaceId, chatId }: ChatRef
): SQL =>
  sql`(${table.workspaceId} = ${workspaceId} AND ${table.chatId} = ${chatId})`;

/** Just the ref of `chat` (a scope or context names more), as a row keeps it. */
export const chatRefOf = ({ workspaceId, chatId }: ChatRef): ChatRef => ({
  workspaceId,
  chatId,
});
