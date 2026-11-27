import type { ChatRef, WorkspaceId } from "@grasp-os/shared/ids";
import { sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

import {
  personalWorkspaceId,
  personalWorkspacePrefix,
} from "./personal-workspace.ts";

// A chat outside its Workspace object is its `ChatRef` (workspace and chat
// ID), never its ID alone: every table of core's that names a chat keys it
// by both (`chatColumns`, db/core/schema.ts), and these are how a row is
// written and found by it.
//
// Until the contract migration, the release before still runs while a
// release rolls out (its migrations land before its Workers, and a failed
// probe rolls an organisation back), and it writes a chat's permissions,
// draft checkpoints and wake-ups with no workspace. Such a row is its
// owner's (`requested_by`, `person_id`): every chat of a person's is in
// their own Workspace object (`personalWorkspaceId`), so it is found by
// that workspace, and never by another's. The contract migration fills
// them all and drops this.

/** A table that names a chat by its ref (`chatColumns`). */
interface ChatTable {
  workspaceId: AnyColumn;
  chatId: AnyColumn;
}

/**
 * `personalWorkspacePrefix` as an SQL literal, not a bound value: a check
 * of a start's grants inlines `ofChat` once per guard, in one statement
 * that D1 allows 100 bound values in all (workflow-starts.ts).
 */
const personalPrefixSql = sql.raw(`'${personalWorkspacePrefix}'`);

/** As SQL, the workspace of a row of `table` with owner `owner` (`ofChat`). */
export const workspaceOf = (table: ChatTable, owner: AnyColumn): SQL =>
  sql`COALESCE(${table.workspaceId}, ${personalPrefixSql} || ${owner})`;

/** As SQL, the workspace of a row whose columns `own` names (`ofChat`). */
export const workspaceOfColumns = (workspace: SQL, owner: SQL): SQL =>
  sql`COALESCE(${workspace}, ${personalPrefixSql} || ${owner})`;

/**
 * The rows of `table` that are of chat `ref`; with `owner`, the column
 * naming whose a row the release before wrote with no workspace is.
 */
export const ofChat = (
  table: ChatTable,
  { workspaceId, chatId }: ChatRef,
  owner?: AnyColumn
): SQL =>
  owner === undefined
    ? sql`(${table.workspaceId} = ${workspaceId} AND ${table.chatId} = ${chatId})`
    : sql`(${table.chatId} = ${chatId} AND ${workspaceOf(table, owner)} = ${workspaceId})`;

/**
 * The workspace of a row's chat: its own, or, for a row the release before
 * wrote with none, its owner `owner`'s (`ofChat`).
 */
export const workspaceOfRow = (
  workspaceId: WorkspaceId | null,
  owner: string
): WorkspaceId => workspaceId ?? personalWorkspaceId(owner);

/** Just the ref of `chat` (a scope or context names more), as a row keeps it. */
export const chatRefOf = ({ workspaceId, chatId }: ChatRef): ChatRef => ({
  workspaceId,
  chatId,
});
