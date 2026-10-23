import type {
  MemberState,
  OrganizationTeam,
  StaffOrganization,
  TeamFlag,
  TeamTurn,
} from "@grasp-os/shared/onboarding-organization";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";

import { formatDateTime, formatDay } from "../format.ts";

// What the organization page says of where someone stands, what needs a
// look at a team and when its links go out (prototype
// `components/admin/admin-words.ts` and `organization-parts.tsx`), and
// which teams and people a search and a filter keep. Pure, but the words.

export const stateTitles: Record<MemberState, MessageDescriptor> = {
  out: msg({
    message: "Team doesn't take part",
    context: "where someone stands",
  }),
  away: msg({ message: "Away", context: "where someone stands" }),
  waiting: msg({ message: "No link yet", context: "where someone stands" }),
  sent: msg({ message: "Link out", context: "where someone stands" }),
  opened: msg({ message: "Opened the link", context: "where someone stands" }),
  started: msg({ message: "Talking", context: "where someone stands" }),
  talked: msg({ message: "Has talked", context: "where someone stands" }),
};

/** What needs a look at a team, in words. */
export const flagText = (i18n: I18n, flag: TeamFlag): string => {
  if (flag.kind === "noLead") {
    return i18n._(msg`No team lead named`);
  }
  if (flag.kind === "leadLate") {
    const { lead } = flag;
    return i18n._(msg`${lead} hasn't talked yet`);
  }
  if (flag.kind === "noMap") {
    return i18n._(msg`No map of its work came of the lead's interview`);
  }
  if (flag.kind === "nobody") {
    const { work } = flag;
    return i18n._(msg`Nobody is asked about “${work}”`);
  }
  const { count } = flag;
  return i18n._(
    plural(count, {
      one: "# person is asked about no piece of work",
      other: "# people are asked about no piece of work",
    })
  );
};

/** What to do about it, in a sentence. */
export const flagHelp = (i18n: I18n, flag: TeamFlag): string => {
  if (flag.kind === "noLead") {
    return i18n._(
      msg`Its people get their links without waiting, and Stephen asks each what work they do. With a lead, he asks the lead first which work there is.`
    );
  }
  if (flag.kind === "leadLate") {
    return i18n._(
      msg`Everyone else in the team waits for this interview, a few working days at most. A word from the sponsor helps.`
    );
  }
  if (flag.kind === "noMap") {
    return i18n._(
      msg`Drawing it failed, or the lead named no work. Draw it again from what the lead agreed to.`
    );
  }
  if (flag.kind === "nobody") {
    return i18n._(
      msg`Its lead named it, and nobody in the team is asked about it. Pick someone under People.`
    );
  }
  return i18n._(
    msg`Stephen asks them which work comes back most. To ask about a piece of work, open the person.`
  );
};

/** When a team's links go out, in a sentence. */
export const turnText = (i18n: I18n, turn: TeamTurn): string => {
  if (turn.kind === "off") {
    return i18n._(msg`Doesn't take part: nobody in it gets a link.`);
  }
  if (turn.kind === "unplanned") {
    return i18n._(msg`Its links wait for the day the interviews start.`);
  }
  if (turn.kind === "from") {
    const at = formatDateTime(turn.at);
    return i18n._(msg`Its links go out from ${at}, its lead first.`);
  }
  if (turn.kind === "lead") {
    const { lead } = turn;
    const by = formatDay(turn.by);
    return i18n._(
      msg`${lead} talks first. Everyone else's link waits for that, until ${by} at the latest.`
    );
  }
  return turn.kind === "due"
    ? i18n._(msg`Everyone's link is due: out once the interviews run.`)
    : i18n._(msg`Everyone taking part has their link.`);
};

/** Which teams the page shows. */
export const teamFilters = ["all", "taking", "left", "look"] as const;
export type TeamFilter = (typeof teamFilters)[number];

export const filterTitles: Record<TeamFilter, MessageDescriptor> = {
  all: msg({ message: "All", context: "filter: every team" }),
  taking: msg({
    message: "Taking part",
    context: "filter: teams that take part in the interviews",
  }),
  left: msg({
    message: "Left out",
    context: "filter: teams that don't take part in the interviews",
  }),
  look: msg({
    message: "Needs a look",
    context: "filter: teams where something needs a person at Grasp",
  }),
};

const kept: Record<TeamFilter, (team: OrganizationTeam) => boolean> = {
  all: () => true,
  taking: (team) => !team.off,
  left: (team) => team.off,
  look: (team) => team.flags.length > 0,
};

/** How many teams each filter keeps. */
export const filterCounts = (
  organization: StaffOrganization
): Record<TeamFilter, number> => ({
  all: organization.teams.length,
  taking: organization.teams.filter(kept.taking).length,
  left: organization.teams.filter(kept.left).length,
  look: organization.teams.filter(kept.look).length,
});

const matches = (text: string, query: string): boolean =>
  text.toLocaleLowerCase().includes(query);

/** The teams the filter keeps whose name, or someone in them, matches `search`. */
export const teamsShown = (
  organization: StaffOrganization,
  filter: TeamFilter,
  search: string
): OrganizationTeam[] => {
  const query = search.trim().toLocaleLowerCase();
  return organization.teams.filter(
    (team) =>
      kept[filter](team) &&
      (query === "" ||
        matches(team.name, query) ||
        organization.people.some(
          (person) => person.team === team.id && matches(person.name, query)
        ))
  );
};

/** The people whose name matches `search`; none without one. */
export const peopleFound = (
  organization: StaffOrganization,
  search: string
): StaffOrganization["people"] => {
  const query = search.trim().toLocaleLowerCase();
  return query === ""
    ? []
    : organization.people.filter((person) => matches(person.name, query));
};
