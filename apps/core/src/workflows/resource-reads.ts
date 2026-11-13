import { isExpectedError } from "@grasp-os/shared/errors";
import {
  chatIdSchema,
  permissionIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { readableVersionsAs } from "../brain-next.ts";
import type { SourceVersionRef } from "../brain-next.ts";
import { runChatSources } from "../db/core/schema.ts";
import { readableSources } from "../history-access.ts";
import { authorize } from "../permissions.ts";
import { runAuthority, runContext } from "./resource-authority.ts";
import type { CallingRun } from "./resource-authority.ts";
import { evidenceOf } from "./run-evidence.ts";

// What a run read, checked before anything of the run leaves it: the
// Brain's versions its recalls pinned (run-evidence.ts) and what the chat
// that started it had read (GRA-1093).

/**
 * `brain.revoked` for a refusal (any expected error: a grant, a member or
 * a read refused), or `error` as it is.
 */
const revokedOr = (error: unknown): unknown =>
  isExpectedError(error)
    ? workflowResourceErrors.create("brain.revoked")
    : error;

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
    throw revokedOr(error);
  });
  if (rows.some(({ sourceId }) => !readable.has(sourceId))) {
    throw workflowResourceErrors.create("brain.revoked");
  }
};

/** `requireResourceRunEvidenceReadable` for `run`'s own evidence alone. */
const requireOwnEvidenceReadable = async (
  env: Env,
  run: Pick<CallingRun, "runId" | "workflowId" | "principal">
): Promise<void> => {
  await requireChatPinsReadable(env, run.runId);
  const rows = await evidenceOf(env, run.runId);
  if (rows.length === 0) {
    return;
  }
  // SAFETY: core wrote each row from a pack's own item; checked again,
  // strictly, by `readableVersionsAs`, which refuses a producer it
  // doesn't know, and the run with it.
  const versions = rows.map(
    ({ producer, sourceId, version }) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      ({ source: { producer, id: sourceId }, version }) as SourceVersionRef
  );
  try {
    for (const permissionId of new Set(rows.map((row) => row.permissionId))) {
      // oxlint-disable-next-line no-await-in-loop -- one per grant, few
      await authorize(
        env,
        runAuthority(run),
        { type: "platform" },
        "brain",
        permissionIdSchema.parse(permissionId),
        runContext(run)
      );
    }
    // As the run's recalls read them: the company alone.
    const readable = await readableVersionsAs(env, run.principal, versions, {
      reach: "company",
    });
    const kept = new Set(
      readable.map(({ source, version }) =>
        JSON.stringify([source.producer, source.id, version])
      )
    );
    if (
      versions.some(
        ({ source, version }) =>
          !kept.has(JSON.stringify([source.producer, source.id, version]))
      )
    ) {
      throw workflowResourceErrors.create("brain.revoked");
    }
  } catch (error) {
    throw revokedOr(error);
  }
};

/**
 * Refuses anything leaving a run of a JSON workflow (GRA-299) that recalled
 * what it may no longer read, as `brain.revoked`: each permission its
 * recalls came through still the run's, active, now (`authorize`), and
 * each version they handed it still one the whole company may read
 * (`readableVersionsAs`, as `company`, as its recalls read): not erased,
 * nor its readers narrowed away from the company. A test run recalls nothing, so has nothing to check.
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

/**
 * The same check for a run that ended, before what it returned or why it
 * failed is shown to anyone (resource-runs.ts `resultOf`): its record
 * holds what it recalled, so once the company may no longer read that,
 * the record is withheld as `brain.revoked`, its status and times shown.
 */
export const requireEndedRunEvidenceReadable = async (
  env: Env,
  run: Pick<CallingRun, "runId" | "workflowId" | "principal">
): Promise<void> => {
  await requireOwnEvidenceReadable(env, run);
};
