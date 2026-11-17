import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import { skillErrors } from "@grasp-os/shared/skills";
import type { ListedSkill, SkillProposal } from "@grasp-os/shared/skills";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { runSource } from "./brain-next-origins.ts";
import {
  addOwnSkill,
  ownSkillProposalsAs,
  proposeOwnSkill,
  readCurrentSkillAs,
  settleOwnSkillProposal,
} from "./brain-next.ts";
import type { OwnSkillProposal } from "./brain-next.ts";
import { holdsWorkflowSql } from "./brain-run-sources.ts";
import {
  workflowResourceRuns,
  workflowResources,
  workflowStartReceipts,
} from "./db/core/schema.ts";

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

/** The run a streak is read for. */
const thisRun = alias(workflowResourceRuns, "this_run");

/**
 * After run `runId` was handed over to its person's own store: when it is
 * one of their latest `proposalStreak` ended runs of its workflow that
 * they or their agent started, and every one of those completed, at one
 * version, none restricted, while they hold the workflow, asks their own
 * store to draft a skill from them (once per workflow version). Read in
 * one statement. A failure is logged and left: the next run of theirs
 * that ends asks again.
 */
export const proposeAfterRun = async (
  env: Env,
  runId: string
): Promise<void> => {
  try {
    const runs = await drizzle(env.DB)
      .select({
        id: workflowResourceRuns.id,
        workflow: workflowResourceRuns.workflowResourceId,
        name: workflowResources.name,
        principal: workflowResourceRuns.principalId,
        version: workflowResourceRuns.version,
        status: workflowResourceRuns.status,
        restricted: workflowResourceRuns.restricted,
      })
      .from(thisRun)
      .innerJoin(
        workflowResourceRuns,
        and(
          eq(
            workflowResourceRuns.workflowResourceId,
            thisRun.workflowResourceId
          ),
          eq(workflowResourceRuns.principalId, thisRun.principalId)
        )
      )
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
          eq(thisRun.id, runId),
          isNotNull(workflowResourceRuns.endedAt),
          inArray(workflowStartReceipts.invokerType, ["person", "agent"]),
          holdsWorkflowSql(thisRun.principalId, thisRun.workflowResourceId)
        )
      )
      .orderBy(
        desc(workflowResourceRuns.endedAt),
        desc(workflowResourceRuns.id)
      )
      .limit(proposalStreak);
    const [newest] = runs;
    const kept =
      newest !== undefined &&
      runs.length === proposalStreak &&
      runs.some(({ id }) => id === runId) &&
      runs.every(
        ({ status, version, restricted }) =>
          status === "completed" && version === newest.version && !restricted
      );
    if (!kept) {
      return;
    }
    await proposeOwnSkill(env, newest.principal, {
      key: await sha256Of(`${newest.workflow}:${newest.version}`),
      about: `Workflow "${newest.name}"`,
      sources: runs.map(({ id }) => runSource(id)),
    });
  } catch (error) {
    log.warn("skills.proposal_unasked", errorFields(error));
  }
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

/** `by`'s open proposals that rest on runs of theirs they may still see, each with its basis. */
const proposalsOf = async (
  env: Env,
  by: Identity
): Promise<(SkillProposal & { own: OwnSkillProposal })[]> => {
  const listed = await ownSkillProposalsAs(env, by.userId);
  const shown = await Promise.all(
    listed.map(async (own) => {
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
 * Whether `by` may add `proposal` now: no own skill of its name; `same`
 * when an own skill of its name already holds its very text (a retry of
 * an accept whose settle didn't land). A name they deleted for good is
 * refused by the add itself (`skills.name_erased`), which says so.
 */
const addable = async (
  env: Env,
  by: Identity,
  { name, text }: { name: string; text: string }
): Promise<"yes" | "same" | "no"> => {
  const current = await readCurrentSkillAs(env, by.userId, {
    scope: "person",
    name,
  });
  if (current === null) {
    return "yes";
  }
  return current.text === text ? "same" : "no";
};

/**
 * The skills proposed to `by` from their own runs: those they may add now,
 * each with what it rests on. One whose name they already use for a skill
 * of their own isn't shown: adding it would replace theirs.
 */
export const skillProposalsFor = async (
  env: Env,
  by: Identity
): Promise<SkillProposal[]> => {
  const proposals = await proposalsOf(env, by);
  const shown = await Promise.all(
    proposals.map(async ({ own: _own, ...proposal }) =>
      (await addable(env, by, proposal)) === "yes" ? [proposal] : []
    )
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
 * (none of theirs, settled, resting on what they no longer see, or named
 * as a skill of theirs that holds other text). Its change key is its
 * text's SHA-256: a retry after the add landed adds nothing twice.
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
  const state = await addable(env, by, proposal);
  if (state === "no") {
    throw skillErrors.create("skills.not_found");
  }
  const added =
    state === "same"
      ? undefined
      : await addOwnSkill(env, by.userId, {
          change: `proposal-${await sha256Of(proposal.text)}`,
          text: proposal.text,
        });
  await settleOwnSkillProposal(env, by.userId, wanted);
  const current =
    added ??
    (await readCurrentSkillAs(env, by.userId, {
      scope: "person",
      name: proposal.name,
    }));
  if (current === null) {
    throw skillErrors.create("skills.not_found");
  }
  return {
    name: proposal.name,
    version: current.version,
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
