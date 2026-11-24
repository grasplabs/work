import { missingOf } from "./admin-missing.ts";
import type { WorkflowState } from "./interviews.ts";
import { recordOf } from "./onboarding-admin-record.ts";
import { knownWorks } from "./onboarding-admin.ts";
import type { OrgView, WorkEvidence } from "./onboarding-admin.ts";

/**
 * Every piece of work at one organization as the admin lists its workflows, ported from the
 * prototype's Workflows section (grasplabs/prototype `components/admin/org-workflows.tsx`): how
 * far each is known, as the list groups them, and how much each still lacks before it is known
 * (`missingOf` on its record). Pure.
 */

/** How far a piece of work is, as the list groups them. */
export type Standing = "known" | "nearly" | "mapping" | "blocked";

/** The standings, the one that holds work up first. */
export const STANDINGS = [
  "blocked",
  "mapping",
  "nearly",
  "known",
] as const satisfies readonly Standing[];

const standings: Record<WorkflowState, Standing> = {
  mapping: "mapping",
  saturating: "nearly",
  complete: "known",
  variants: "known",
  blocked: "blocked",
};

/** Known once complete, in one way or in more; nearly once new facts dry up; held up by a difference nobody can explain. */
export const standingOf = (work: WorkEvidence): Standing =>
  standings[work.state];

/** One piece of work in the list. */
export interface WorkflowRow {
  work: WorkEvidence;
  standing: Standing;
  /** How many things it still lacks before it is known. */
  missing: number;
}

export interface WorkflowList {
  rows: WorkflowRow[];
  /** How many pieces of work stand at each standing. */
  counts: Record<Standing, number>;
  /** How many count as known. */
  known: number;
  /** How many are still being mapped: everything not known. */
  mapping: number;
  /** Everything still missing, over every piece of work. */
  missing: number;
}

/**
 * The workflows of `view`, in its own order. The questions a drawing left for the next interviews
 * count as missing in the prototype; the model's work doesn't carry them yet, so none are counted.
 */
export const workflowListOf = (view: OrgView): WorkflowList => {
  const rows = view.works.map((work): WorkflowRow => {
    const record = recordOf(view, work.id);
    return {
      work,
      standing: standingOf(work),
      missing: record ? missingOf(record).length : 0,
    };
  });
  const counts: Record<Standing, number> = {
    blocked: 0,
    mapping: 0,
    nearly: 0,
    known: 0,
  };
  for (const row of rows) {
    counts[row.standing] += 1;
  }
  const known = knownWorks(view.works);
  return {
    rows,
    counts,
    known,
    mapping: rows.length - known,
    missing: rows.reduce((sum, row) => sum + row.missing, 0),
  };
};
