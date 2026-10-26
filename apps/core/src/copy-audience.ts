import { brainErrors } from "@grasp-os/brain/contract";
import type { AccessMode } from "@grasp-os/sdk/host";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { AppId } from "@grasp-os/shared/ids";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { auditedBatch, outboxed } from "./audit-outbox.ts";
import {
  appMembers,
  apps,
  runBrainEvidence,
  runChatSources,
  runInheritedEvidence,
  teamMembers,
  workflowResourceRuns,
} from "./db/core/schema.ts";
import { workspace } from "./durable-objects.ts";
import { brainCitesOf } from "./history-access.ts";
import { audienceMaxMembers } from "./knowledge/access.ts";
import { readableByAll } from "./knowledge/memory-publish.ts";
import type { StartingAgent } from "./workflow-starts.ts";
import { ancestorsMax } from "./workflows/resource-reads.ts";

// What a pinned writer may write into an App's store (GRA-1093, S4; the
// threat model and the decision are on the issue): a chat whose agent read
// the Brain, or a run that recalled or read it, holds Brain pins (the
// collections, and documents in them, it was handed). Rows it writes are
// read by everyone the table is open to, through the App's code, so a
// write is admitted only while every one of them may read every
// collection the writer's pins name: a copy never shows more than its
// sources' audience. Otherwise it is refused (`brain.would_widen`) before
// anything commits, and the refusal audited, naming IDs only. Connection
// and App reads are the host's, not Brain pins, and are not carried. A
// revocation after the write leaves the rows as they are (the residual on
// the issue; per-row cites are a follow-up).

/** Who writes, as the pins it holds are read. */
export type CopyWriter =
  | { readonly kind: "chat"; readonly agent: StartingAgent }
  | { readonly kind: "run"; readonly runId: string };

/**
 * The collections chat `agent`'s Brain reads name: each it read, and each
 * a document it was handed is in.
 */
const chatCollectionsOf = async (
  env: Env,
  agent: StartingAgent
): Promise<string[]> => {
  const sources = await workspace(env, agent.workspaceId).heldSourcesOf(
    agent.chatId
  );
  const cites = await brainCitesOf(env, sources);
  return cites.map(({ collectionId }) => collectionId);
};

/**
 * The collections run `runId` is held to: its own pins, what it inherited,
 * its chat's Brain reads, and its ancestors' (a JSON run's parents, by
 * their rows); none for an App's run but its own.
 */
const runCollectionsOf = async (env: Env, runId: string): Promise<string[]> => {
  const db = drizzle(env.DB);
  const lineage: string[] = [];
  let next: string | null = runId;
  while (next !== null) {
    if (lineage.length > ancestorsMax || lineage.includes(next)) {
      throw brainErrors.create("brain.would_widen");
    }
    lineage.push(next);
    // oxlint-disable-next-line no-await-in-loop -- one run after its parent
    const row = await db
      .select({ parent: workflowResourceRuns.parentRunId })
      .from(workflowResourceRuns)
      .where(eq(workflowResourceRuns.id, next))
      .get();
    next = row?.parent ?? null;
  }
  const [own, inherited, chats] = await Promise.all([
    db
      .selectDistinct({ id: runBrainEvidence.collectionId })
      .from(runBrainEvidence)
      .where(inArray(runBrainEvidence.runId, lineage)),
    db
      .selectDistinct({ id: runInheritedEvidence.collectionId })
      .from(runInheritedEvidence)
      .where(inArray(runInheritedEvidence.runId, lineage)),
    db
      .selectDistinct({ source: runChatSources.sourceId })
      .from(runChatSources)
      .where(inArray(runChatSources.runId, lineage)),
  ]);
  const chatCites = await brainCitesOf(
    env,
    chats.map(({ source }) => source)
  );
  return [
    ...own.map(({ id }) => id),
    ...inherited.map(({ id }) => id),
    ...chatCites.map(({ collectionId }) => collectionId),
  ];
};

/** The collections `writer`'s Brain pins name, each once. */
export const pinnedCollectionsOf = async (
  env: Env,
  writer: CopyWriter
): Promise<string[]> => [
  ...new Set(
    writer.kind === "chat"
      ? await chatCollectionsOf(env, writer.agent)
      : await runCollectionsOf(env, writer.runId)
  ),
];

/**
 * Everyone a table of App `app` open to `mode` is read by, as people:
 * the record's owner (`principal`) for an `owner` table; the App's owner
 * and members (teams' people too) for `appMembers`; its owner and
 * builders for `appBuilders`; nobody for `none`. Undefined past
 * `audienceMaxMembers`: too many to decide for.
 */
const readersOf = async (
  env: Env,
  app: AppId,
  principal: string,
  mode: AccessMode
): Promise<string[] | undefined> => {
  if (mode === "none") {
    return [];
  }
  if (mode === "owner") {
    return [principal];
  }
  const db = drizzle(env.DB);
  const owner = await db
    .select({ id: apps.ownerId })
    .from(apps)
    .where(eq(apps.id, app))
    .get();
  const members = await db
    .select({
      type: appMembers.memberType,
      id: appMembers.memberId,
    })
    .from(appMembers)
    .where(
      and(
        eq(appMembers.appId, app),
        mode === "appBuilders" ? eq(appMembers.role, "builder") : undefined
      )
    );
  const teams = members.flatMap(({ type, id }) =>
    type === "team" ? [id] : []
  );
  const ofTeams =
    teams.length === 0
      ? []
      : await db
          .selectDistinct({ id: teamMembers.userId })
          .from(teamMembers)
          .where(inArray(teamMembers.teamId, teams))
          .limit(audienceMaxMembers + 1);
  const people = new Set([
    ...(owner === undefined ? [] : [owner.id]),
    ...members.flatMap(({ type, id }) => (type === "person" ? [id] : [])),
    ...ofTeams.map(({ id }) => id),
  ]);
  return people.size > audienceMaxMembers ? undefined : [...people];
};

/** What a write's refusal names: IDs only, never what was read or written. */
export interface CopyRefusal {
  readonly actor: AuditActor;
  readonly app: AppId;
  readonly writer: CopyWriter;
}

/**
 * Refuses (`brain.would_widen`) a write by `writer` into tables of App
 * `app` read as `modes`, unless every reader of each may read every
 * collection the writer's Brain pins name (see the header), auditing the
 * refusal. A writer holding no pins writes as before.
 */
export const requireCopyWithinAudience = async (
  env: Env,
  refusal: CopyRefusal,
  principal: string,
  modes: readonly AccessMode[]
): Promise<void> => {
  const pinned = await pinnedCollectionsOf(env, refusal.writer);
  if (pinned.length === 0) {
    return;
  }
  for (const mode of new Set(modes)) {
    // oxlint-disable-next-line no-await-in-loop -- one per access mode, few
    const readers = await readersOf(env, refusal.app, principal, mode);
    if (readers?.length === 0) {
      continue;
    }
    const readable =
      readers === undefined
        ? new Set<string>()
        : // oxlint-disable-next-line no-await-in-loop -- one per access mode, few
          await readableByAll(env, readers, pinned);
    const widened = pinned.filter((id) => !readable.has(id));
    if (widened.length > 0) {
      const db = drizzle(env.DB);
      // oxlint-disable-next-line no-await-in-loop -- refused once, then thrown
      await auditedBatch(env, db, [
        outboxed(db, {
          actor: refusal.actor,
          action: "brain.copy_refused",
          target: { type: "app", id: refusal.app },
          detail: {
            ...(refusal.writer.kind === "chat"
              ? { chat: refusal.writer.agent.chatId }
              : { run: refusal.writer.runId }),
            mode,
          },
          provenance: widened.slice(0, 20),
        }),
      ]);
      throw brainErrors.create("brain.would_widen");
    }
  }
};
