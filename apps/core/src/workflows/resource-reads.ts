import { brainErrors } from "@grasp-os/brain/contract";
import { d1BrainStore } from "@grasp-os/brain/recall-store";
import { isExpectedError } from "@grasp-os/shared/errors";
import {
  chatIdSchema,
  collectionIdSchema,
  permissionIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type { CollectionId, PermissionId } from "@grasp-os/shared/ids";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { permissions, runChatSources } from "../db/core/schema.ts";
import { readableSources } from "../history-access.ts";
import { readAsDelegate } from "../knowledge/binding.ts";
import { brainOf } from "../knowledge/ports.ts";
import { runAuthority, runContext } from "./resource-authority.ts";
import type { CallingRun } from "./resource-authority.ts";
import { evidenceOf, isAccessRefusal } from "./run-evidence.ts";

// What a run read from today's Brain, checked before anything of the run
// leaves it: the evidence a run pinned (run-evidence.ts) and what the chat
// that started it had read (GRA-1093). A run's steps recall from the new
// Brain (brain-calls.ts), which pins nothing here; this stays for what
// today's Brain recorded until the cutover (GRA-1735) removes it.

/**
 * The collection a knowledge binding reads through its permission, read
 * now: the workflow's own, active, allowing `read`, or the call is denied.
 */
const boundCollection = async (
  env: Env,
  run: CallingRun,
  permissionId: string
): Promise<{ permissionId: PermissionId; collectionId: CollectionId }> => {
  const row = await drizzle(env.DB)
    .select({ collectionId: permissions.objectId })
    .from(permissions)
    .where(
      and(
        eq(permissions.id, permissionId),
        eq(permissions.subjectType, "workflow"),
        eq(permissions.subjectId, run.workflowId),
        eq(permissions.objectType, "collection"),
        eq(permissions.status, "active")
      )
    )
    .get();
  if (row === undefined) {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  return {
    permissionId: permissionIdSchema.parse(permissionId),
    collectionId: collectionIdSchema.parse(row.collectionId),
  };
};

/**
 * Refuses, as `brain.revoked`, run `runId` once the chat whose agent had
 * it started may no longer read, for its person, something it had read
 * then (GRA-1093, workflow-starts.ts): as the chat's own history check
 * decides it (`readableSources`), under the chat's agent and person as
 * they are now.
 */
const requireChatPinsReadable = async (
  env: Env,
  runId: string
): Promise<void> => {
  const rows = await drizzle(env.DB)
    .select()
    .from(runChatSources)
    .where(eq(runChatSources.runId, runId));
  const [first] = rows;
  if (first === undefined) {
    return;
  }
  const readable = await readableSources(
    env,
    {
      workspaceId: workspaceIdSchema.parse(first.workspaceId),
      chatId: chatIdSchema.parse(first.chatId),
      agentId: first.agentId,
      personId: first.personId,
    },
    rows.map(({ sourceId }) => sourceId)
  ).catch((error: unknown) => {
    if (isAccessRefusal(error) || isExpectedError(error)) {
      throw brainErrors.create("brain.revoked");
    }
    throw error;
  });
  if (rows.some(({ sourceId }) => !readable.has(sourceId))) {
    throw brainErrors.create("brain.revoked");
  }
};

/** `requireResourceRunEvidenceReadable` for `run`'s own evidence alone. */
const requireOwnEvidenceReadable = async (
  env: Env,
  run: CallingRun
): Promise<void> => {
  await requireChatPinsReadable(env, run.runId);
  const rows = await evidenceOf(env, run.runId);
  if (rows.length === 0) {
    return;
  }
  const store = d1BrainStore(brainOf(env));
  try {
    for (const permissionId of new Set(rows.map((row) => row.permissionId))) {
      // oxlint-disable-next-line no-await-in-loop -- one per binding, few
      const bound = await boundCollection(env, run, permissionId);
      // oxlint-disable-next-line no-await-in-loop -- one per binding, few
      await readAsDelegate(
        env,
        runAuthority(run),
        runContext(run),
        bound.permissionId,
        async (reader) => {
          const pinned = rows.filter(
            (row) => row.permissionId === permissionId
          );
          // A recall's evidence needs the Brain too; a search's or a
          // read's only the collection.
          if (pinned.some((row) => row.recalled)) {
            await store.requireBrainGrant(reader);
          }
          await store.requireDocumentsReadable(reader, pinned);
        }
      );
    }
  } catch (error) {
    if (isAccessRefusal(error)) {
      throw brainErrors.create("brain.revoked");
    }
    throw error;
  }
};

/**
 * Refuses anything leaving a run of a JSON workflow (GRA-299) that recalled
 * what it may no longer read, as `brain.revoked`: its
 * recalls are each through a knowledge binding, one collection under one
 * permission of the workflow's, so each binding's documents are checked
 * under that permission, as the run reads now: the permission still the
 * workflow's and active (`boundCollection`), the Brain still admitting
 * the run, each document still in its collection, readable there and
 * unpurged. A test run recalls nothing, so has nothing to check.
 *
 * What a running run shows needs no check: its details (`resourceRunFor`)
 * hold its output or failure only once it ended, which this checks first,
 * and an App's workflow queries answer run metadata alone
 * (workflow-reference-queries.ts), a failure as a platform code.
 *
 * It checks, then the caller acts: a revoke, erase or purge landing in
 * between lets that one call through. Every later one is refused, and the
 * run with it.
 */
export const requireResourceRunEvidenceReadable = async (
  env: Env,
  run: CallingRun
): Promise<void> => {
  await requireOwnEvidenceReadable(env, run);
};
