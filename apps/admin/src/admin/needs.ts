import { needSection } from "./sections.ts";
import type { OrgSection } from "./sections.ts";
import { rolloutNeedLine, rolloutNeeds } from "./views.ts";
import type { Organization } from "./views.ts";
import { needLine } from "./words.ts";

/** Something that needs Grasp at one organization, and the section it is settled in. */
export interface OrgNeed {
  text: string;
  section: OrgSection;
}

const setupSection: OrgSection = "setup";

/**
 * What needs Grasp at one organization, the most pressing first: what its
 * own platform needs (settled in its Setup), then what its core's view
 * says. The Home and the sidebar's Inbox list the same.
 */
export const needsOf = ({ admin, view }: Organization): OrgNeed[] => [
  ...rolloutNeeds(admin.client).map((need) => ({
    text: rolloutNeedLine(need),
    section: setupSection,
  })),
  ...(view === null
    ? []
    : view.needs.map((need) => ({
        text: needLine(need, view),
        section: needSection(need),
      }))),
];
