import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { skillErrors } from "@grasp-os/shared/skills";
import type { ListedSkill, SkillProposal } from "@grasp-os/shared/skills";
import { and, desc, eq, gt, inArray, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { runSource } from "./brain-next-origins.ts";
import {
  addOwnSkill,
  ownSkillProposalsAs,
  ownSkillTextOf,
  proposeOwnSkill,
  readCurrentSkillAs,
  settleOwnSkillProposal,
} from "./brain-next.ts";
import type { OwnSkillProposal, SourceRef } from "./brain-next.ts";
import { holdsWorkflowSql } from "./brain-run-sources.ts";
import {
  workflowResourceRuns,
  workflowResources,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { runRetentionDays } from "./workflows/engine.ts";

// Skills proposed to a person from their own runs that keep succeeding
// (GRA-1756; the design is on the issue). The Brain's model drafts each in
// the person's own store (@grasp-os/brain-next skill-proposals.ts); core
// decides when, from which runs, and what is shown. What could go wrong,
// and what stops it:
//
// - A proposal used before its person adds it: a proposal is no skill.
//   Nothing lists, selects or reads it as one until `acceptProposal`
//   writes it as their own skill (brain-next.ts `addOwnSkill`).
// - One built from, or shown to, anyone but the person whose runs they
//   were: only runs whose person they are, started by them or their agent,
//   are counted; the draft is asked of, kept in and listed from their own
//   store alone, by their own reader; every call here names them from
//   their session (`Identity`), never from what they send.
// - Content they can't read in it: the model sees only the current
//   versions of their own run sources (what core handed over to them:
//   redacted, and only how a run ended when it read the Brain) and the
//   workflow's name, which they read as a holder of the workflow. A
//   proposal is listed only while every run source it rests on is still
//   current and theirs (their store's statement), and only while they
//   hold the workflow and each run is theirs (`basisOf`'s statement): a
//   role lost or a run erased hides it; an erasure deletes it.
// - An erased run's id kept in queued work: a draft is queued naming no
//   run (its workflow at a version, in core's words: `subjectOf`); it asks
//   core which runs as it runs (`proposalRunsFor`), among those that still
//   have their details, so what retention erased is never among them.
// - A model asked for nothing new: only once a run's hand-over to them
//   landed (`proposeAfterRun`, from brain-sources.ts), and once per
//   workflow version, as the store drafts a key once, open or settled.
// - Which workflow a skill came from kept: a proposal's key is the SHA-256
//   of its workflow and version, its basis is dropped once settled, and
//   the skill's change key is the SHA-256 of its text.
// - Not audited, as writing an own skill isn't (skill-shares.ts): it
//   affects no one else. The model's call is metered and audited by the
//   gateway, as the Brain's upkeep.

/** How many of a person's latest runs of a workflow must have succeeded, all at one version. */
export const proposalStreak = 5;

const encoder = new TextEncoder();

/** The SHA-256 of `text`, as hex. */
const sha256Of = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const dayMs = 24 * 60 * 60 * 1000;

/** A run of a streak. */
interface StreakRun {
  id: string;
  workflow: string;
  name: string;
  version: number;
}

/**
 * `person`'s latest `proposalStreak` ended runs of `workflowId` that they
 * or their agent started and that still have their details (not past the
 * run retention, nor swept: what retention erased from the Brain is never
 * among them), while they hold the workflow, read in one statement, when
 * every one of them completed, at one version, none restricted: newest
 * first. Null when they don't, or there are fewer.
 */
const streakOf = async (
  env: Env,
  person: string,
  workflowId: string
): Promise<StreakRun[] | null> => {
  const kept = new Date(Date.now() - runRetentionDays * dayMs);
  const runs = await drizzle(env.DB)
    .select({
      id: workflowResourceRuns.id,
      workflow: workflowResourceRuns.workflowResourceId,
      name: workflowResources.name,
      version: workflowResourceRuns.version,
      status: workflowResourceRuns.status,
      restricted: workflowResourceRuns.restricted,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .innerJoin(
      workflowResources,
      eq(workflowResources.id, workflowResourceRuns.workflowResourceId)
    )
    .where(
      and(
        eq(workflowResourceRuns.workflowResourceId, workflowId),
        eq(workflowResourceRuns.principalId, person),
        gt(workflowResourceRuns.endedAt, kept),
        isNull(workflowStartReceipts.detailsRemovedAt),
        inArray(workflowStartReceipts.invokerType, ["person", "agent"]),
        holdsWorkflowSql(person, workflowId)
      )
    )
    .orderBy(desc(workflowResourceRuns.endedAt), desc(workflowResourceRuns.id))
    .limit(proposalStreak);
  const [newest] = runs;
  const holds =
    newest !== undefined &&
    runs.length === proposalStreak &&
    runs.every(
      ({ status, version, restricted }) =>
        status === "completed" && version === newest.version && !restricted
    );
  return holds
    ? runs.map(({ id, workflow, name, version }) => ({
        id,
        workflow,
        name,
        version,
      }))
    : null;
};

/** What a draft is queued for: a workflow at a version, in core's own words. */
const subjectOf = (workflow: string, version: number): string =>
  `${workflow}@${version}`;

/**
 * After run `runId` was handed over to its person's own store: when it is
 * one of their streak of its workflow (`streakOf`), asks their own store
 * to draft a skill (once per workflow version), naming no run: the draft
 * asks which as it runs (`proposalRunsFor`). A failure is logged and
 * left: the next run of theirs that ends asks again.
 */
export const proposeAfterRun = async (
  env: Env,
  runId: string
): Promise<void> => {
  try {
    const run = await drizzle(env.DB)
      .select({
        person: workflowResourceRuns.principalId,
        workflow: workflowResourceRuns.workflowResourceId,
      })
      .from(workflowResourceRuns)
      .where(eq(workflowResourceRuns.id, runId))
      .get();
    if (run === undefined) {
      return;
    }
    const streak = await streakOf(env, run.person, run.workflow);
    const [newest] = streak ?? [];
    if (
      streak === null ||
      newest === undefined ||
      !streak.some(({ id }) => id === runId)
    ) {
      return;
    }
    await proposeOwnSkill(env, run.person, {
      key: await sha256Of(`${newest.workflow}:${newest.version}`),
      about: `Workflow "${newest.name}"`,
      subject: subjectOf(newest.workflow, newest.version),
    });
  } catch (error) {
    log.warn("skills.proposal_unasked", errorFields(error));
  }
};

/**
 * The runs a draft queued for `subject` is drawn from, picked for `person`
 * as it runs (their own store's alarm, brain-store.ts): their streak of
 * that workflow now, when it is still at that version; none otherwise,
 * and the draft ends without a proposal.
 */
export const proposalRunsFor = async (
  env: Env,
  person: string,
  subject: string
): Promise<SourceRef[]> => {
  const at = subject.lastIndexOf("@");
  const workflow = subject.slice(0, at);
  const version = Number(subject.slice(at + 1));
  const streak = at > 0 ? await streakOf(env, person, workflow) : null;
  return streak !== null && streak[0]?.version === version
    ? streak.map(({ id }) => runSource(id))
    : [];
};

/**
 * What `proposal` rests on, for `person`: its runs, each theirs, of one
 * workflow they hold now, at one version, read in one statement; null
 * when any isn't, so it isn't shown.
 */
const basisOf = async (
  env: Env,
  person: string,
  proposal: OwnSkillProposal
): Promise<SkillProposal["basis"] | null> => {
  const ids = proposal.restsOn.flatMap(({ producer, id }) =>
    producer === "run" ? [id] : []
  );
  if (ids.length !== proposal.restsOn.length) {
    return null;
  }
  const rows = await drizzle(env.DB)
    .select({
      id: workflowResourceRuns.id,
      workflow: workflowResourceRuns.workflowResourceId,
      name: workflowResources.name,
      version: workflowResourceRuns.version,
      endedAt: workflowResourceRuns.endedAt,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowResources,
      eq(workflowResources.id, workflowResourceRuns.workflowResourceId)
    )
    .where(
      and(
        inArray(workflowResourceRuns.id, ids),
        eq(workflowResourceRuns.principalId, person),
        isNotNull(workflowResourceRuns.endedAt),
        holdsWorkflowSql(person, workflowResourceRuns.workflowResourceId)
      )
    )
    .orderBy(desc(workflowResourceRuns.endedAt), desc(workflowResourceRuns.id));
  const [first] = rows;
  if (
    first === undefined ||
    rows.length !== new Set(ids).size ||
    rows.some(
      ({ workflow, version }) =>
        workflow !== first.workflow || version !== first.version
    )
  ) {
    return null;
  }
  return {
    workflow: { id: first.workflow, name: first.name },
    version: first.version,
    runs: rows.flatMap(({ id, endedAt }) =>
      endedAt === null ? [] : [{ id, endedAt }]
    ),
  };
};

/**
 * Whether `text` is one the add takes as a person's own skill, by the
 * add's own check (`ownSkillTextOf`): a draft it would refuse is never
 * shown or accepted. The Brain keeps only drafts of a name and a
 * description, so this holds a drift between the two, never a person.
 */
const addableText = (text: string): boolean => {
  try {
    ownSkillTextOf(text);
    return true;
  } catch {
    return false;
  }
};

/** `by`'s open proposals that rest on runs of theirs they may still see, each with its basis. */
const proposalsOf = async (
  env: Env,
  by: Identity
): Promise<(SkillProposal & { own: OwnSkillProposal })[]> => {
  const listed = await ownSkillProposalsAs(env, by.userId);
  const shown = await Promise.all(
    listed
      .filter(({ text }) => addableText(text))
      .map(async (own) => {
        const basis = await basisOf(env, by.userId, own);
        return basis === null
          ? []
          : [
              {
                key: own.key,
                name: own.name,
                description: own.description,
                text: own.text,
                basis,
                own,
              },
            ];
      })
  );
  return shown.flat();
};

/**
 * The skills proposed to `by` from their own runs: those they may add now,
 * each with what it rests on. One whose name they already use for a skill
 * of their own isn't shown: adding it would replace theirs, so the add
 * refuses it too (`acceptProposal`).
 */
export const skillProposalsFor = async (
  env: Env,
  by: Identity
): Promise<SkillProposal[]> => {
  const proposals = await proposalsOf(env, by);
  const shown = await Promise.all(
    proposals.map(async ({ own: _own, ...proposal }) => {
      const current = await readCurrentSkillAs(env, by.userId, {
        scope: "person",
        name: proposal.name,
      });
      return current === null ? [proposal] : [];
    })
  );
  return shown.flat();
};

/** A proposal's key, as the Brain keys it: a SHA-256, as hex. */
const proposalKeySchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** `key`, refused (`skills.invalid`) unless a proposal's. */
const keyOf = (key: unknown): string =>
  skillErrors.parse("skills.invalid", proposalKeySchema, key);

/**
 * Adds `by`'s proposal `key` as their own skill, then settles it, so it
 * isn't proposed again: `skills.not_found` for one they aren't shown now
 * (none of theirs, settled, or resting on what they no longer see). Added
 * only while they have no skill of its name, checked in the very write
 * in their own store (`addOwnSkill`'s `onlyNew`): `skills.name_taken`
 * otherwise, theirs untouched, whatever they saved meanwhile. Its change
 * key is its text's SHA-256: a retry after the add landed answers what it
 * wrote, and settles.
 */
export const acceptProposal = async (
  env: Env,
  by: Identity,
  key: unknown
): Promise<ListedSkill> => {
  const wanted = keyOf(key);
  const shown = await proposalsOf(env, by);
  const proposal = shown.find((each) => each.key === wanted);
  if (proposal === undefined) {
    throw skillErrors.create("skills.not_found");
  }
  const added = await addOwnSkill(env, by.userId, {
    change: `proposal-${await sha256Of(proposal.text)}`,
    text: proposal.text,
    onlyNew: true,
  });
  await settleOwnSkillProposal(env, by.userId, wanted);
  return {
    name: proposal.name,
    version: added.version,
    description: proposal.description,
  };
};

/**
 * Dismisses `by`'s proposal `key`: it isn't proposed again for that
 * version of its workflow. `skills.not_found` for one they aren't shown.
 */
export const dismissProposal = async (
  env: Env,
  by: Identity,
  key: unknown
): Promise<void> => {
  const wanted = keyOf(key);
  const shown = await proposalsOf(env, by);
  if (!shown.some((each) => each.key === wanted)) {
    throw skillErrors.create("skills.not_found");
  }
  await settleOwnSkillProposal(env, by.userId, wanted);
};
