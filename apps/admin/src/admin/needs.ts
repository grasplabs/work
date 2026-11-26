import { NEED_ORDER } from "@grasp-os/shared/admin/admin-view";
import type { Need } from "@grasp-os/shared/admin/onboarding-admin";

import type { ClientSummary } from "../clients/summary.ts";
import { needWhere } from "./sections.ts";
import type { OrgSection } from "./sections.ts";
import { billingNeeds, rolloutNeedLine, rolloutNeeds } from "./views.ts";
import type { Organization } from "./views.ts";
import { needKindLines, needLine } from "./words.ts";

/**
 * Something that needs Grasp at one organization, how many of it there
 * are, and where it is settled: its section, and the tab there when not
 * the first.
 */
export interface OrgNeed {
  text: string;
  count: number;
  section: OrgSection;
  search: { tab: "contract" } | undefined;
}

const setupSection: OrgSection = "setup";

/** What its own platform needs, settled in its Setup: the first of what needs Grasp. */
const rolloutOf = (client: ClientSummary["client"]): OrgNeed[] =>
  rolloutNeeds(client).map((need) => ({
    text: rolloutNeedLine(need),
    count: 1,
    section: setupSection,
    search: undefined,
  }));

/**
 * What needs Grasp at one organization, the most pressing first, each in
 * full: what its own platform needs, then what its core's view says. Home
 * and the open organization's level of the sidebar list it.
 */
export const needsOf = ({ admin, view }: Organization): OrgNeed[] => [
  ...rolloutOf(admin.client),
  ...(view === null
    ? []
    : view.needs.map((need) => ({
        text: needLine(need, view),
        count: 1,
        ...needWhere(need),
      }))),
];

/**
 * What needs Grasp at one organization as its summary says it, the most
 * pressing first: what its own platform needs, then what its summary and
 * its billing say, a line for each kind with how many of it, naming
 * nothing (`needKindLines`). The sidebar's counts and its Inbox list it.
 */
export const summaryNeedsOf = (entry: ClientSummary): OrgNeed[] => {
  const rollout = rolloutOf(entry.client);
  if (entry.state !== "answered") {
    return rollout;
  }
  const kinds: { kind: Need["kind"]; count: number }[] = [
    ...entry.summary.needs,
    ...billingNeeds(entry.billing).map(({ kind }) => ({ kind, count: 1 })),
  ];
  return [
    ...rollout,
    ...kinds
      .toSorted(
        (a, b) => NEED_ORDER.indexOf(a.kind) - NEED_ORDER.indexOf(b.kind)
      )
      .map(({ kind, count }) => ({
        text: needKindLines[kind],
        count,
        ...needWhere({ kind }),
      })),
  ];
};

/** How many things need Grasp in `needs`, each counted as many times as there are of it. */
export const needCount = (needs: readonly OrgNeed[]): number =>
  needs.reduce((sum, need) => sum + need.count, 0);
