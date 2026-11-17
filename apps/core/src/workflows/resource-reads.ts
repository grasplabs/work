import { brainSourceErrors } from "@grasp-os/shared/brain-sources";
import { isExpectedError } from "@grasp-os/shared/errors";
import {
  chatIdSchema,
  permissionIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { drizzle } from "drizzle-orm/d1";

import { readableMemoriesAs, readableVersionsAs } from "../brain-next.ts";
import type { PinnedVersionRef } from "../brain-next.ts";
import { runChatSources } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { readableSources } from "../history-access.ts";
import { authorize } from "../permissions.ts";
import { runAuthority, runContext } from "./resource-authority.ts";
import type { CallingRun } from "./resource-authority.ts";
import { evidenceOfRuns, memoryEvidenceOfRuns } from "./run-evidence.ts";

// What a run read, checked before anything of the run leaves it: the
// Brain's versions its recalls pinned (run-evidence.ts) and what the chat
// that started it had read (GRA-1093).

/**
 * `brain.revoked` for a refusal (any expected error: a grant, a member or
 * a read refused), or `error` as it is. A stored row the Brain refuses as
 * no request it takes (`brain.request_invalid`) stops the run as itself:
 * nothing was revoked.
 */
const revokedOr = (error: unknown): unknown =>
  isExpectedError(error) &&
  brainSourceErrors.codeOf(error) !== "brain.request_invalid"
    ? workflowResourceErrors.create("brain.revoked")
    : error;

/** A run whose evidence is checked: its ID, its workflow and its person. */
type EvidenceRun = Pick<CallingRun, "runId" | "workflowId" | "principal">;

/**
 * What a check of runs found: those refused, and those whose check failed
 * otherwise, each with why.
 */
interface Checked {
  readonly refused: Set<string>;
  readonly failed: Map<string, unknown>;
}

/**
 * Records `error`, thrown checking runs `runIds` together, against each of
 * them: a refusal (`revokedOr`) refuses them; anything else fails their
 * check, as `revokedOr` has it, and theirs alone.
 */
const settled = (
  checked: Checked,
  runIds: readonly string[],
  error: unknown
): void => {
  const mapped = revokedOr(error);
  for (const runId of runIds) {
    if (workflowResourceErrors.codeOf(mapped) === "brain.revoked") {
      checked.refused.add(runId);
    } else if (!checked.failed.has(runId)) {
      checked.failed.set(runId, mapped);
    }
  }
};

/** `items` grouped by `key`, each group in the order its items came. */
const groupedBy = <T>(
  items: readonly T[],
  key: (item: T) => string
): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  }
  return groups;
};

/**
 * What runs read, as their evidence keeps it: the pins of the chats that
 * started them (`runChatSources`), the versions their recalls were handed
 * and the memories their entity reads rested on (run-evidence.ts).
 */
export interface EvidenceRead {
  readonly pins: readonly (typeof runChatSources.$inferSelect)[];
  readonly versions: Awaited<ReturnType<typeof evidenceOfRuns>>;
  readonly memories: Awaited<ReturnType<typeof memoryEvidenceOfRuns>>;
}

/** What runs `runIds` read, as their evidence keeps it: a read of each kind. */
const evidenceReadOf = async (
  env: Env,
  runIds: readonly string[]
): Promise<EvidenceRead> => {
  const [pins, versions, memories] = await Promise.all([
    drizzle(env.DB)
      .select()
      .from(runChatSources)
      .where(inList(runChatSources.runId, runIds)),
    evidenceOfRuns(env, runIds),
    memoryEvidenceOfRuns(env, runIds),
  ]);
  return { pins, versions, memories };
};

/** Of `read`, what runs `runIds` read alone. */
const readOf = (
  read: EvidenceRead,
  runIds: readonly string[]
): EvidenceRead => {
  const ids = new Set(runIds);
  return {
    pins: read.pins.filter(({ runId }) => ids.has(runId)),
    versions: read.versions.filter(({ runId }) => ids.has(runId)),
    memories: read.memories.filter(({ runId }) => ids.has(runId)),
  };
};

/**
 * Of `runs`, those the chat whose agent had one started may no longer
 * read, for its person, something it had read then (GRA-1093,
 * workflow-starts.ts): as the chat's own history check decides it
 * (`readableSources`), under the chat's agent and person as they are
 * now: one check per chat, however many runs it started.
 */
const chatPinsChecked = async (
  env: Env,
  rows: EvidenceRead["pins"],
  checked: Checked
): Promise<void> => {
  // Each run's pins are its one chat's: its first row names it.
  const chatOf = new Map<string, string>();
  for (const row of rows) {
    if (!chatOf.has(row.runId)) {
      chatOf.set(
        row.runId,
        JSON.stringify([row.workspaceId, row.chatId, row.agentId, row.personId])
      );
    }
  }
  const byChat = groupedBy(rows, (row) => chatOf.get(row.runId) ?? "");
  await Promise.all(
    [...byChat.values()].map(async (pins) => {
      const [first] = pins;
      if (first === undefined) {
        return;
      }
      try {
        const { readable } = await readableSources(
          env,
          {
            workspaceId: workspaceIdSchema.parse(first.workspaceId),
            chatId: chatIdSchema.parse(first.chatId),
            agentId: first.agentId,
            personId: first.personId,
          },
          [...new Set(pins.map(({ sourceId }) => sourceId))]
        );
        for (const { runId, sourceId } of pins) {
          if (!readable.has(sourceId)) {
            checked.refused.add(runId);
          }
        }
      } catch (error) {
        settled(
          checked,
          pins.map(({ runId }) => runId),
          error
        );
      }
    })
  );
};

/** A version of a source, as one key. */
const versionKey = (
  producer: string,
  sourceId: string,
  version: number
): string => JSON.stringify([producer, sourceId, version]);

/**
 * Of `runs`, those that may no longer read what they read (the header),
 * and those whose check failed otherwise: checked together, so a list of
 * them costs one read of each kind of evidence, a check per chat, one per
 * permission of a workflow and person, and two of the Brain per person,
 * however many runs and decisions it holds. A failure counts against the
 * runs of the check it came from alone. A read of the evidence that fails
 * throws. Without `grants`, what they read alone, not the grants it came
 * through (`copiesEvidence`). Given `read`, what they read as a caller
 * read it, never read again (`EvidenceRead`).
 */
const evidenceChecked = async (
  env: Env,
  runs: readonly EvidenceRun[],
  grants: boolean,
  read?: EvidenceRead
): Promise<Checked> => {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const ids = [...byId.keys()];
  const checked: Checked = { refused: new Set(), failed: new Map() };
  if (ids.length === 0) {
    return checked;
  }
  const evidence =
    read === undefined ? await evidenceReadOf(env, ids) : readOf(read, ids);
  const { versions: rows, memories: memoryRows } = evidence;
  await chatPinsChecked(env, evidence.pins, checked);
  // Each permission its recalls came through still the run's, active, now
  // (`authorize`): decided by the run's workflow and person, once each.
  const granted = groupedBy(
    (grants ? [...rows, ...memoryRows] : []).flatMap(
      ({ runId, permissionId }) => {
        const run = byId.get(runId);
        return run === undefined ? [] : [{ run, permissionId }];
      }
    ),
    ({ run, permissionId }) =>
      JSON.stringify([run.workflowId, run.principal, permissionId])
  );
  await Promise.all(
    [...granted.values()].map(async (holders) => {
      const [first] = holders;
      if (first === undefined) {
        return;
      }
      try {
        await authorize(
          env,
          runAuthority(first.run),
          { type: "platform" },
          "brain",
          permissionIdSchema.parse(first.permissionId),
          runContext(first.run)
        );
      } catch (error) {
        settled(
          checked,
          holders.map(({ run }) => run.runId),
          error
        );
      }
    })
  );
  // What they read, as their recalls and entity reads read it: the company
  // alone (`company`), as each run's person reads as the company. A
  // version erased or narrowed away from the company is no longer
  // readable; nor is a memory a person's erasure took, its writer retired
  // or took back (a share), or resting on a source erased or narrowed, as
  // a chat's history decides it (history-access.ts): someone who takes a
  // memory back wants others to stop getting it (GRA-1985). One a newer
  // memory ended stays. Paged by the Brain's check, 500 a call.
  const principalOf = (runId: string): string =>
    byId.get(runId)?.principal ?? "";
  const versionsBy = groupedBy(rows, ({ runId }) => principalOf(runId));
  const memoriesBy = groupedBy(memoryRows, ({ runId }) => principalOf(runId));
  await Promise.all(
    [...new Set([...versionsBy.keys(), ...memoriesBy.keys()])].map(
      async (principal) => {
        const versionRows = versionsBy.get(principal) ?? [];
        const memoryRowsOf = memoriesBy.get(principal) ?? [];
        // SAFETY: core wrote each row from a pack's own item or a skill it
        // handed the run (`skillVersionRefOf`); checked again, strictly, by
        // `readableVersionsAs`, which refuses a producer it doesn't know,
        // and the runs with it.
        const versions = [
          ...new Map(
            versionRows.map(({ producer, sourceId, version }) => [
              versionKey(producer, sourceId, version),
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
              {
                source: { producer, id: sourceId },
                version,
              } as PinnedVersionRef,
            ])
          ).values(),
        ];
        const memories = [
          ...new Set(memoryRowsOf.map(({ memoryId }) => memoryId)),
        ];
        try {
          const [readableMemories, readable] = await Promise.all([
            readableMemoriesAs(
              env,
              principal,
              memories.map((memory) => ({ store: "shared" as const, memory })),
              { reach: "company" }
            ),
            readableVersionsAs(env, principal, versions, { reach: "company" }),
          ]);
          const keptMemories = new Set(
            readableMemories.map(({ memory }) => memory)
          );
          const kept = new Set(
            readable.map(({ source, version }) =>
              versionKey(source.producer, source.id, version)
            )
          );
          for (const { runId, memoryId } of memoryRowsOf) {
            if (!keptMemories.has(memoryId)) {
              checked.refused.add(runId);
            }
          }
          for (const { runId, producer, sourceId, version } of versionRows) {
            if (!kept.has(versionKey(producer, sourceId, version))) {
              checked.refused.add(runId);
            }
          }
        } catch (error) {
          settled(
            checked,
            [...versionRows, ...memoryRowsOf].map(({ runId }) => runId),
            error
          );
        }
      }
    )
  );
  return checked;
};

/**
 * `requireResourceRunEvidenceReadable` for `run`'s own evidence alone: a
 * refusal as `brain.revoked`, before any other failure, which throws as
 * it is.
 */
const requireOwnEvidenceReadable = async (
  env: Env,
  run: EvidenceRun
): Promise<void> => {
  const { refused, failed } = await evidenceChecked(env, [run], true);
  if (refused.has(run.runId)) {
    throw workflowResourceErrors.create("brain.revoked");
  }
  if (failed.has(run.runId)) {
    throw failed.get(run.runId);
  }
};

/**
 * Refuses anything leaving a run of a JSON workflow (GRA-299) that recalled
 * what it may no longer read, as `brain.revoked`: each permission its
 * recalls came through still the run's, active, now (`authorize`), and
 * each version they handed it still one the whole company may read
 * (`readableVersionsAs`, as `company`, as its recalls read): not erased,
 * nor its readers narrowed away from the company; and each memory its
 * entity reads rested on still one the company may read
 * (`readableMemoriesAs`): not taken by a person's erasure, retired, or
 * resting on a source erased or narrowed (GRA-1985). A test run recalls
 * nothing, so has nothing to check. Asked before a model, connection,
 * App or files-write call, a decision, its output, and before a step's
 * state is written (sealed-run.ts `stepRecording`); its files are listed
 * and downloaded only while it holds (run-file-downloads.ts), and what its
 * decisions ask is shown only while it holds (decisions.ts, GRA-1988).
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

/**
 * Whether run `run` may still read what it read
 * (`requireEndedRunEvidenceReadable`): false once refused as
 * `brain.revoked`, for a reader that leaves what it holds out (its files,
 * listed or downloaded). Any other failure throws.
 */
export const runEvidenceHolds = async (
  env: Env,
  run: Pick<CallingRun, "runId" | "workflowId" | "principal">
): Promise<boolean> => {
  try {
    await requireEndedRunEvidenceReadable(env, run);
    return true;
  } catch (error) {
    if (workflowResourceErrors.codeOf(error) !== "brain.revoked") {
      throw error;
    }
    return false;
  }
};

/**
 * What checking a run's evidence came to for a reader: it holds; it was
 * refused (`brain.revoked`: the run may no longer read what it read); or
 * it couldn't be checked (the check failed otherwise: a database or the
 * Brain away, a stored row it can't read), which a later check may
 * settle.
 */
export type EvidenceState = "holds" | "refused" | "unchecked";

/** Logs that run `runId`'s evidence couldn't be checked, and says so. */
const unchecked = (runId: string, error: unknown): EvidenceState => {
  log.error("workflow.run_evidence_unchecked", {
    runId,
    ...errorFields(error),
  });
  return "unchecked";
};

/**
 * How the evidence of each of `runs` stands (`EvidenceState`), by run ID,
 * checked together (`evidenceChecked`), for a reader that shows what each
 * holds only while it holds (what a run's decisions ask: decisions.ts). A
 * run whose check failed otherwise is checked again alone, so another
 * run's failure in the same check never counts against it; one whose own
 * check fails is unchecked, logged, and so is every run when the evidence
 * can't be read at all. Without `grants`, what they read alone, not the
 * grants it came through (`copiesEvidence`). Given `read`, every check,
 * a run's check alone included, holds to what it read (`EvidenceRead`).
 */
export const runsEvidence = async (
  env: Env,
  runs: readonly EvidenceRun[],
  { grants = true, read }: { grants?: boolean; read?: EvidenceRead } = {}
): Promise<Map<string, EvidenceState>> => {
  const unique = [...new Map(runs.map((run) => [run.runId, run])).values()];
  /** How `some` stand, each failed one checked again alone if `again`. */
  const states = async (
    some: readonly EvidenceRun[],
    again: boolean
  ): Promise<[string, EvidenceState][]> => {
    let checked: Checked;
    try {
      checked = await evidenceChecked(env, some, grants, read);
    } catch (error) {
      return some.map(({ runId }) => [runId, unchecked(runId, error)]);
    }
    const each = await Promise.all(
      some.map(async (run): Promise<[string, EvidenceState][]> => {
        const failure = checked.failed.get(run.runId);
        if (checked.refused.has(run.runId)) {
          return [[run.runId, "refused"]];
        }
        if (failure === undefined) {
          return [[run.runId, "holds"]];
        }
        return again
          ? await states([run], false)
          : [[run.runId, unchecked(run.runId, failure)]];
      })
    );
    return each.flat();
  };
  return new Map(await states(unique, unique.length > 1));
};

/**
 * How what each of runs `writers` read stands for a copy of it they wrote
 * (`EvidenceState`), by run ID: what a workflow keeps between its runs
 * (workflow-state.ts, GRA-1996). A copy follows what happens to what was
 * read: each version still one the company may read, each memory still
 * one a person's erasure didn't take nor its writer retire, and what the
 * chat behind a run had read still the chat's, as `runsEvidence` checks
 * them, all read by `reader` at company reach. Never the grants it came
 * through, nor whether the writer's person is still a member: a copy is
 * the company's, and pulling a workflow's grant or someone leaving
 * protects no one by hiding it (GRA-1996, decision Q4). Their evidence
 * as `read` holds it, read in one snapshot with the copies that name
 * them: read after, a release in between would leave none to refuse.
 */
export const copiesEvidence = async (
  env: Env,
  writers: readonly Pick<EvidenceRun, "runId" | "workflowId">[],
  reader: string,
  read: EvidenceRead
): Promise<Map<string, EvidenceState>> =>
  await runsEvidence(
    env,
    writers.map(({ runId, workflowId }) => ({
      runId,
      workflowId,
      principal: reader,
    })),
    { grants: false, read }
  );
