import { skillCardOf } from "@grasp-os/brain-next/skills";
import { identifierSchema } from "@grasp-os/shared/ids";
import type { Identity } from "@grasp-os/shared/rpc";
import { skillErrors } from "@grasp-os/shared/skills";
import type { ListedSkill, SkillProposal } from "@grasp-os/shared/skills";
import { workflowNameSchema } from "@grasp-os/shared/workflow-resources";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { activeMember } from "./auth/membership-sql.ts";
import { addOwnSkill, readCurrentSkillAs } from "./brain-next.ts";
import {
  personErasures,
  skillDeletions,
  skillProposalDismissals,
  workflowResourceRuns,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { listWorkflowResources } from "./workflow-resources.ts";

// Skill proposals (GRA-1756): a person's own runs of a workflow that keep
// succeeding the same way propose a skill to them, as a draft of their
// own skill. Design on the issue; what could go wrong, and what stops it:
//
// - A proposal shaped by what its person may not read, or shown to
//   someone else: it is built from their own runs (`principal_id`, as
//   their run page shows them) of a workflow they have a role in now, and
//   its name, which they see; nothing else. It is worked out for them
//   alone, at each read, so a role they lost or a run retention removed
//   counts from that read on. Nothing of it is stored but a dismissal.
// - A proposal used before its person says so: it isn't in the Brain at
//   all until they add it, and then it is their own skill like any they
//   write (skill-shares.ts): used in their own chat alone, shared only
//   through an admin's approval of their ask.
// - A proposal written over a skill of theirs: none is made, or added,
//   for a name they have an own skill of, or deleted one of for good.
// - Text from a builder steering the agent: the text is Grasp's own, in
//   code; the workflow's name is the one thing in it, and workflow names
//   are lowercase letters, digits and dashes. No model writes it.
// - Not audited, as their own skills aren't (skill-shares.ts): a person's
//   own skill affects no one else.

/**
 * How many of a person's latest ended runs of a workflow, all completed at
 * one version, make it "keep succeeding".
 */
export const proposalRuns = 5;

const versionSchema = z.int().positive();

/** The runs a proposal can rest on: those they started, themselves or through their agent. */
const startedByThem = inArray(workflowStartReceipts.invokerType, [
  "person",
  "agent",
]);

/** A workflow `by` has a role in, as proposals read it. */
interface Workflow {
  id: string;
  name: string;
}

/**
 * The `SKILL.md` proposed for workflow `name`: what it rests on is shown
 * beside it, never written into it, where it would go stale.
 */
const proposalText = (name: string): string => {
  const words = name.replaceAll("-", " ");
  const description = `Start the workflow ${name} when I ask for ${words}.`;
  // A JSON string is a YAML scalar: nothing in the name can break the
  // frontmatter.
  return `---
name: ${name}
description: ${JSON.stringify(description)}
---

# ${words}

When I ask for ${words}, start the workflow \`${name}\` rather than doing its work step by step.
`;
};

/**
 * `by`'s latest {@link proposalRuns} ended runs of workflow `id` that they
 * started, newest first.
 */
const latestRunsOf = (
  db: ReturnType<typeof drizzle>,
  by: Identity,
  id: string
) =>
  db
    .select({
      id: workflowResourceRuns.id,
      version: workflowResourceRuns.version,
      status: workflowResourceRuns.status,
      restricted: workflowResourceRuns.restricted,
      endedAt: workflowResourceRuns.endedAt,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .where(
      and(
        eq(workflowResourceRuns.workflowResourceId, id),
        eq(workflowResourceRuns.principalId, by.userId),
        isNotNull(workflowResourceRuns.endedAt),
        startedByThem
      )
    )
    .orderBy(
      desc(workflowResourceRuns.createdAt),
      desc(workflowResourceRuns.id)
    )
    .limit(proposalRuns);

type RunRow = Awaited<ReturnType<typeof latestRunsOf>>[number];

/**
 * The proposal `runs` of `workflow` make: undefined unless there are
 * {@link proposalRuns} of them, all completed, outside restricted mode, at
 * one version.
 */
const proposalOf = (
  workflow: Workflow,
  runs: readonly RunRow[]
): SkillProposal | undefined => {
  const [first] = runs;
  if (
    first === undefined ||
    runs.length < proposalRuns ||
    runs.some(
      ({ status, restricted, version }) =>
        status !== "completed" || restricted || version !== first.version
    ) ||
    !workflowNameSchema.safeParse(workflow.name).success
  ) {
    return undefined;
  }
  return {
    name: workflow.name,
    text: proposalText(workflow.name),
    basis: {
      workflow: { id: workflow.id, name: workflow.name },
      version: first.version,
      runs: runs.map(({ id, endedAt }) => ({
        id,
        endedAt: endedAt?.toISOString() ?? "",
      })),
    },
  };
};

/**
 * The skills proposed to `by` now, by name: one per workflow they have a
 * role in whose latest runs they started keep succeeding, unless they
 * dismissed it for that version, have an own skill of its name
 * (`ownNames`), or deleted one of its name for good.
 */
export const skillProposalsFor = async (
  env: Env,
  by: Identity,
  ownNames: ReadonlySet<string>
): Promise<SkillProposal[]> => {
  const listed = await listWorkflowResources(env, by);
  const workflows = listed.filter(({ name }) => !ownNames.has(name));
  if (workflows.length === 0) {
    return [];
  }
  const db = drizzle(env.DB);
  const [first, ...rest] = workflows.map(({ id }) => latestRunsOf(db, by, id));
  if (first === undefined) {
    return [];
  }
  const [runs, dismissed, deleted] = await Promise.all([
    db.batch([first, ...rest]),
    db
      .select({
        id: skillProposalDismissals.workflowResourceId,
        version: skillProposalDismissals.version,
      })
      .from(skillProposalDismissals)
      .where(eq(skillProposalDismissals.personId, by.userId)),
    db
      .select({ name: skillDeletions.name })
      .from(skillDeletions)
      .where(eq(skillDeletions.personId, by.userId)),
  ]);
  const dismissals = new Set(
    dismissed.map(({ id, version }) => `${id} ${version}`)
  );
  const erased = new Set(deleted.map(({ name }) => name));
  return workflows
    .flatMap((workflow, index) => {
      const proposal = proposalOf(workflow, runs[index] ?? []);
      return proposal === undefined ||
        erased.has(proposal.name) ||
        dismissals.has(`${workflow.id} ${proposal.basis.version}`)
        ? []
        : [proposal];
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

/** `workflow` and `version` as a proposal is named; `skills.not_found` otherwise. */
const proposalKeyOf = (
  workflow: unknown,
  version: unknown
): { workflow: string; version: number } => {
  const parsed = z
    .strictObject({ workflow: identifierSchema, version: versionSchema })
    .safeParse({ workflow, version });
  if (!parsed.success) {
    throw skillErrors.create("skills.not_found");
  }
  return parsed.data;
};

/**
 * Adds the skill proposed to `by` from their runs of `workflow` at
 * `version` as their own, worked out again now: `skills.not_found` unless
 * it is still proposed to them at that version (a role they lost, a run
 * that failed since, a dismissal, an own skill of its name). Its change
 * key is the proposal's, so adding it again adds nothing.
 */
export const acceptSkillProposal = async (
  env: Env,
  by: Identity,
  workflow: unknown,
  version: unknown
): Promise<ListedSkill> => {
  const key = proposalKeyOf(workflow, version);
  const proposals = await skillProposalsFor(env, by, new Set());
  const proposal = proposals.find(
    ({ basis }) =>
      basis.workflow.id === key.workflow && basis.version === key.version
  );
  if (
    proposal === undefined ||
    (await readCurrentSkillAs(env, by.userId, {
      scope: "person",
      name: proposal.name,
    })) !== null
  ) {
    throw skillErrors.create("skills.not_found");
  }
  const saved = await addOwnSkill(env, by.userId, {
    change: `proposal:${key.workflow}:${key.version}`,
    text: proposal.text,
  });
  return {
    name: saved.name,
    version: saved.version,
    description: skillCardOf(proposal.text)?.description ?? "",
  };
};

/**
 * Dismisses the skill proposed to `by` from their runs of `workflow` at
 * `version`: it isn't proposed to them again until another version keeps
 * succeeding. Safe to repeat, and alike for one that isn't proposed.
 */
export const dismissSkillProposal = async (
  env: Env,
  by: Identity,
  workflow: unknown,
  version: unknown
): Promise<void> => {
  const key = proposalKeyOf(workflow, version);
  // Only for someone still here, as their other writes check
  // (skill-shares.ts): one that waited while they were removed and erased
  // leaves nothing of theirs behind.
  await drizzle(env.DB)
    .insert(skillProposalDismissals)
    .select(
      sql`SELECT ${by.userId}, ${key.workflow}, ${key.version}, ${Date.now()}
        WHERE ${activeMember(by.userId)}
          AND NOT EXISTS (SELECT 1 FROM ${personErasures}
            WHERE ${personErasures.userId} = ${by.userId})`
    )
    .onConflictDoNothing();
};
