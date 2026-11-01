import type { AdminSnapshot } from "@grasp-os/shared/admin-snapshot";
import { adminOrgOf } from "@grasp-os/shared/admin/admin-snapshot-adapter";
import { adminViewOf } from "@grasp-os/shared/admin/admin-view";
import type { WorkflowState } from "@grasp-os/shared/admin/interviews";
import type {
  OrgView,
  WorkEvidence,
} from "@grasp-os/shared/admin/onboarding-admin";
import type { StaffWorks } from "@grasp-os/shared/onboarding-staff";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { Session } from "../core.ts";

// What the onboarding area says of the work drawn from the interviews, as
// the prototype's admin does (`interview-words.ts`, `org-workflows.tsx`,
// `work-record.tsx`): one place for the words, so the list and a piece of
// work say the same.

/** The work, and everyone it was heard from, as one read gives both. */
export interface WorkRead {
  snapshot: AdminSnapshot;
  works: StaffWorks;
}

/** Reads the interviews and the work drawn from them, each on record in core. */
export const readWorks = async (session: Session): Promise<WorkRead> => {
  const [snapshot, works] = await Promise.all([
    session.onboardingStaff.interviews(),
    session.onboardingStaff.works(),
  ]);
  return { snapshot, works };
};

/** Everything Grasp's admin knows of the organization on the day core answered, with its work. */
export const workViewOf = ({ snapshot, works }: WorkRead): OrgView => {
  // The snapshot holds the work too; `works` is read on its own for its list.
  const { org, state } = adminOrgOf(
    { ...snapshot, works },
    { id: "organization" }
  );
  return adminViewOf(org, state, snapshot.now.slice(0, 10));
};

/** Where a piece of work stands, as the list says it: how far it is known, or better split in two. */
export type Standing = WorkflowState | "split";

/** The standings, the one that holds work up first. */
export const standings = [
  "blocked",
  "split",
  "mapping",
  "saturating",
  "variants",
  "complete",
] as const satisfies readonly Standing[];

export const standingOf = (work: WorkEvidence): Standing =>
  work.split ? "split" : work.state;

export const standingTitles: Record<Standing, MessageDescriptor> = {
  mapping: msg({ message: "Being heard", context: "where a workflow stands" }),
  saturating: msg({
    message: "Nearly there",
    context: "where a workflow stands",
  }),
  complete: msg({ message: "Known", context: "where a workflow stands" }),
  variants: msg({
    message: "Known in more than one way",
    context: "where a workflow stands",
  }),
  blocked: msg({
    message: "Waits on an answer",
    context: "where a workflow stands",
  }),
  split: msg({
    message: "Better split in two",
    context: "where a workflow stands",
  }),
};

/** Known, in one way or in more. */
export const isKnown = (work: WorkEvidence): boolean =>
  work.state === "complete" || work.state === "variants";
