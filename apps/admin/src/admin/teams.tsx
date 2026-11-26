/**
 * The company's teams as Grasp knows them, ported from the prototype
 * (grasplabs/prototype `components/admin/org-organization.tsx`,
 * `org-team.tsx` and `organization-parts.ts`) and shown where the
 * interviews are (the Teams tab of Interviews): every team as a row with
 * where it stands, its people as dots and what needs a look there; a row
 * opens the team, with everyone in it, the work it does and where that
 * work goes. Every figure is the shared model's (`organizationOf`).
 *
 * Read only but for asking a team in, as the admin is: the prototype puts
 * the list right here (a team or a person added, a lead named, a team
 * left out), which the admin has no way to yet. A person opens nothing of
 * their own: the prototype's dialog leads to what they said, which the
 * admin never shows. Nor is where a piece of work goes said in the words
 * of whoever said it, when it isn't one of the company's own teams.
 */
import type {
  ChartTeam,
  Organization,
  TeamFlag,
} from "@grasp-os/shared/admin/admin-organization";
import { MIN_GROUP } from "@grasp-os/shared/admin/interviews";
import { dateOn } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgView,
  PersonView,
  WorkEvidence,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Progress } from "@grasp-os/ui/components/progress";
import { StatGroup } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  Icon,
  SearchIcon,
} from "@grasp-os/ui/lib/icons";
import { focusRingInset, focusRingText } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { CommandButton } from "./commands.tsx";
import { Dot, Initials, markOf, PeopleDots } from "./interview-parts.tsx";
import { Attention } from "./marks.tsx";
import { EmptyPanel, Panel, PanelNote } from "./panel.tsx";
import { sectionTo } from "./sections.ts";
import { formatDate, linkWords, talkedWords, workflowWords } from "./words.ts";

const styles = stylex.create({
  // A list of rows edge to edge under a panel's header, a hairline over each.
  rows: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  row: {
    borderBlockStartWidth: size.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  firstRow: { borderBlockStartWidth: { default: null, ":first-child": 0 } },
  // A row that is one link: its pointer's quiet fill, and the keyboard's ring inside it.
  rowLink: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space["3"],
    paddingBlock: space["2"],
    paddingInline: space["4"],
    color: "inherit",
    textAlign: "start",
    textDecoration: "none",
    backgroundColor: {
      default: null,
      [media.hover]: { default: null, ":hover": colors.tableRowBgHover },
    },
  },
  rowLinkWide: { paddingBlock: "0.625rem", paddingInline: space["5"] },
  between: {
    display: "grid",
    alignItems: "center",
    columnGap: space["4"],
    rowGap: "0.125rem",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [media.sm]: "1fr 1fr" },
  },
  stack: { display: "flex", minWidth: 0, flexDirection: "column" },
  grow: { flexGrow: 1 },
  inline: {
    display: "flex",
    minWidth: 0,
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["2"],
  },
  arrow: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  aside: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
  },
  // Its words on a phone, where only the dot shows, said to a screen reader alone.
  belowSmHidden: {
    position: { default: null, [media.maxSm]: "absolute" },
    width: { default: null, [media.maxSm]: "1px" },
    height: { default: null, [media.maxSm]: "1px" },
    overflow: { default: null, [media.maxSm]: "hidden" },
    clipPath: { default: null, [media.maxSm]: "inset(50%)" },
    whiteSpace: { default: null, [media.maxSm]: "nowrap" },
  },
  named: {
    display: "grid",
    gap: space["3"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.sm]: "repeat(2, minmax(0, 1fr))",
      [media.xl]: "repeat(3, minmax(0, 1fr))",
    },
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  namedTeam: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    paddingBlock: space["3"],
    paddingInline: space["4"],
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    borderWidth: size.hairline,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
  tools: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  search: {
    width: { default: "100%", [media.sm]: "16rem" },
    marginInlineStart: { default: null, [media.sm]: "auto" },
  },
  // One team in the list: the whole row opens it, ending in a chevron.
  team: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr) auto",
      [media.md]: "minmax(0, 15rem) minmax(0, 1fr) auto",
    },
    alignItems: "center",
    columnGap: space["5"],
    rowGap: space["2"],
    paddingBlock: space["3"],
    paddingInline: space["5"],
    backgroundColor: {
      default: null,
      [media.hover]: { default: null, ":hover": colors.tableRowBgHover },
    },
  },
  teamName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "inherit",
    textDecoration: "none",
    "::after": { content: '""', position: "absolute", inset: 0 },
  },
  teamOff: { color: colors.mutedForeground },
  teamDots: {
    gridColumn: { default: "1 / -1", [media.md]: "auto" },
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space["4"],
  },
  teamEnd: {
    gridColumn: { default: "2", [media.md]: "auto" },
    gridRow: { default: "1", [media.md]: "auto" },
    display: "flex",
    alignItems: "center",
    gap: space["3"],
  },
  // Above the row's link, so it is pressed itself.
  above: { position: "relative" },
  figures: { fontVariantNumeric: "tabular-nums" },
  oneLine: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  late: {
    color: colors.warning,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  back: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    columnGap: space["8"],
    rowGap: space["4"],
  },
  headWords: {
    display: "flex",
    minWidth: 0,
    flexGrow: 1,
    flexBasis: "16rem",
    flexDirection: "column",
    gap: "0.125rem",
  },
  lead: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    gap: "0.375rem",
  },
  person: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space["3"],
    paddingBlock: "0.625rem",
    paddingInline: space["5"],
  },
  personName: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space["2"],
  },
  work: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    gap: space["1"],
    paddingBlock: space["3"],
    paddingInline: space["5"],
    color: "inherit",
    textAlign: "start",
    textDecoration: "none",
    backgroundColor: {
      default: null,
      [media.hover]: { default: null, ":hover": colors.tableRowBgHover },
    },
  },
  workHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space["3"],
  },
  workFacts: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["3"],
    rowGap: "0.125rem",
  },
  workState: { display: "flex", alignItems: "center", gap: "0.375rem" },
  // How a piece of work stands, as a mark beside its words.
  tone: {
    width: "0.375rem",
    height: "0.375rem",
    flexShrink: 0,
    borderRadius: "50%",
    backgroundColor: colors.mutedForeground,
    opacity: 0.6,
  },
  toneKnown: { backgroundColor: colors.success, opacity: 1 },
  toneBlocked: { backgroundColor: colors.warning, opacity: 1 },
  doers: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    marginBlockStart: space["1"],
  },
  faces: { display: "flex", flexShrink: 0, gap: "0.125rem" },
  workBar: { paddingInline: space["5"], paddingBlockEnd: space["4"] },
  hand: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
    paddingBlock: "0.625rem",
    paddingInline: space["5"],
  },
  handTeam: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "inherit",
    textDecoration: {
      default: "none",
      [media.hover]: { default: "none", ":hover": "underline" },
    },
  },
  flag: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
    paddingBlock: space["3"],
    paddingInline: space["5"],
  },
  // The team's own page: its people beside its work from a wide screen.
  team2: {
    display: "grid",
    alignItems: "start",
    gap: space["6"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.xl]: "minmax(0, 1fr) 22rem",
    },
  },
  side: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    gap: space["6"],
  },
});

/** `count` and the thing it counts: one for one, many for the rest. */
const counted = (count: number, one: string, other: string): string =>
  `${count} ${count === 1 ? one : other}`;

/** With more teams than this, the list can be searched and narrowed. */
const SEARCH_FROM = 8;
/** How many people a search shows by name before it asks for more of the name. */
const mostFound = 6;
/** How many of the people who do a piece of work show as their initials. */
const mostFaces = 5;
/** Up to how many of the people who do a piece of work are named by their first names. */
const mostNamed = 3;

const filters = ["all", "taking", "left", "look"] as const;
type Filter = (typeof filters)[number];

const filterWords: Record<Filter, string> = {
  all: "All",
  taking: "Take part",
  left: "Left out",
  look: "Need a look",
};

/** What about a team needs a look, in one line. */
const flagLine = (flag: TeamFlag): string => {
  if (flag.kind === "noLead") {
    return "No team lead named";
  }
  if (flag.kind === "leadLate") {
    return `${flag.name} was reminded and has not talked`;
  }
  if (flag.kind === "nobody") {
    return `Nobody is named for “${flag.work.name}”`;
  }
  return flag.count === 1
    ? "1 person is asked about no piece of work"
    : `${flag.count} people are asked about no piece of work`;
};

/** What to do about a team's flag, under its line. */
const flagAbout: Record<TeamFlag["kind"], string> = {
  noLead:
    "Its people get their links without waiting, and Stephen asks each what work they do. With a lead, he asks the lead first which work there is.",
  leadLate:
    "Everyone else in the team waits for this interview. A word from the sponsor helps.",
  nobody:
    "Its lead named it, and nobody in the team to ask about it. Someone in the team has to be picked for it.",
  unasked:
    "Stephen asks them which work comes back most, until someone names the piece of work to ask them about.",
};

const isKnown = (work: WorkEvidence): boolean =>
  work.state === "complete" || work.state === "variants";

/** How a piece of work is marked: known in the colour of agreed, waiting on an answer in the colour of attention; its words say which beside it. */
const workTone = (work: WorkEvidence) => {
  if (isKnown(work)) {
    return styles.toneKnown;
  }
  return work.state === "blocked" ? styles.toneBlocked : null;
};

/** A team's name, by its id. */
const teamName = (view: OrgView, id: string | null): string =>
  view.teams.find((each) => each.team.id === id)?.team.name ?? "";

/** Where a link to one team leads, open where the teams are, or to all of them. */
const teamLinkOf = (clientId: string, team: string | null) => ({
  params: { clientId },
  search: team === null ? {} : { team },
  to: sectionTo.interviews,
});

/** A link to one team, open where the teams are, or to all of them. */
const TeamLink = ({
  clientId,
  team,
  look,
  "aria-label": label,
  children,
}: {
  clientId: string;
  team: string | null;
  /** How it is drawn: a row's whole width, or words. */
  look?: stylex.StyleXStyles;
  "aria-label"?: string;
  children?: ReactNode;
}) => (
  <Link
    aria-label={label}
    {...teamLinkOf(clientId, team)}
    {...stylex.props(look)}
  >
    {children}
  </Link>
);

/** How far a team's work is known, as one bar under it. */
const WorkBar = ({ team }: { team: ChartTeam }) => (
  <Progress
    aria-label={`${team.known} of ${team.works.length} pieces of work known`}
    value={(team.known / Math.max(team.works.length, 1)) * 100}
  />
);

/** Before anyone is on the list: the teams the sponsor named, if any, by name and size. */
export const NoTeams = ({ view }: { view: OrgView }) => {
  const named = view.vision?.teams ?? [];
  const line =
    named.length > 0
      ? "The teams as the sponsor named them. The real teams, with everyone in them, come with the company’s own list."
      : "Nobody is on the list yet. The company’s admin shares its staff list in their onboarding.";
  return (
    <>
      <Panel description={line} title={view.org.name} />
      {named.length > 0 ? (
        <ul {...stylex.props(styles.named)}>
          {named.map((each) => {
            const count = each.people ?? 0;
            return (
              <li key={each.name} {...stylex.props(styles.namedTeam)}>
                <Text as="span" color="default" size="sm" weight="medium">
                  {each.name}
                </Text>
                <Text as="span" color="muted" size="xs">
                  {count > 0
                    ? `About ${counted(count, "person", "people")}, as the sponsor said.`
                    : "How many people is not known yet."}
                </Text>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
};

/** People whose name has `wanted` in it, each opening their team. */
const Found = ({
  view,
  found,
  clientId,
}: {
  view: OrgView;
  found: readonly PersonView[];
  clientId: string;
}) => (
  <Card size="sm">
    <CardContent flush>
      <ul {...stylex.props(styles.rows)}>
        {found.slice(0, mostFound).map((each) => (
          <li
            key={each.person.id}
            {...stylex.props(styles.row, styles.firstRow)}
          >
            <TeamLink
              clientId={clientId}
              look={[styles.rowLink, focusRingInset]}
              team={each.person.team}
            >
              <Initials name={each.person.name} />
              <span {...stylex.props(styles.stack, styles.grow)}>
                <Text as="span" color="default" size="sm" truncate>
                  {each.person.name}
                </Text>
                <Text as="span" color="muted" size="xs" truncate>
                  {teamName(view, each.person.team)}
                </Text>
              </span>
              <span {...stylex.props(styles.aside)}>
                <Dot mark={markOf(each.state)} />
                <span {...stylex.props(styles.belowSmHidden)}>
                  <Text as="span" color="muted" size="xs">
                    {each.out
                      ? "Team does not take part"
                      : linkWords[each.state]}
                  </Text>
                </span>
              </span>
            </TeamLink>
          </li>
        ))}
        {found.length > mostFound ? (
          <li {...stylex.props(styles.row, styles.rowLink)}>
            <Text as="span" color="muted" size="xs">
              {`And ${found.length - mostFound} more: type more of the name.`}
            </Text>
          </li>
        ) : null}
      </ul>
    </CardContent>
  </Card>
);

/** Work one team hands to another, as the people who do it said. */
const Between = ({
  view,
  chart,
  clientId,
}: {
  view: OrgView;
  chart: Organization;
  clientId: string;
}) => (
  <Panel
    description="Work one team hands to another, as the people who do it said. Work stalls most where it changes hands."
    title="Where the work goes between teams"
  >
    <CardContent flush>
      <ul {...stylex.props(styles.rows)}>
        {chart.between.map((each) => (
          <li key={each.work.id} {...stylex.props(styles.row, styles.firstRow)}>
            <Link
              aria-label={`Open the workflows: “${each.work.name}”`}
              params={{ clientId }}
              to={sectionTo.workflows}
              {...stylex.props(
                styles.rowLink,
                styles.rowLinkWide,
                styles.between,
                focusRingInset
              )}
            >
              <span {...stylex.props(styles.inline)}>
                <Text as="span" color="default" size="sm" truncate>
                  {teamName(view, each.from)}
                </Text>
                <span aria-hidden {...stylex.props(styles.arrow)}>
                  <Icon icon={ArrowRightIcon} />
                </span>
                <Text as="span" color="default" size="sm" truncate>
                  {teamName(view, each.to)}
                </Text>
              </span>
              <Text as="span" color="muted" size="sm" truncate>
                {each.work.name}
              </Text>
            </Link>
          </li>
        ))}
      </ul>
    </CardContent>
  </Panel>
);

/** Whether a team is shown under `filter`. */
const kept = (team: ChartTeam, filter: Filter): boolean => {
  switch (filter) {
    case "taking": {
      return !team.view.off;
    }
    case "left": {
      return team.view.off;
    }
    case "look": {
      return team.flags.length > 0;
    }
    case "all": {
      return true;
    }
    default: {
      return filter satisfies never;
    }
  }
};

/** The day `day` of the organization's interviews, as a date. */
const dayDate = (view: OrgView, day: number): string =>
  formatDate(dateOn(view.org, day));

/** Where a team stands, in a few words. */
const standsOf = (view: OrgView, team: ChartTeam["view"]): string => {
  const { next, lead } = team;
  switch (next.kind) {
    case "off": {
      return "Does not take part";
    }
    case "lead-unknown": {
      return "The company still has to name its lead";
    }
    case "not-told": {
      return "Gets its links once the team is told";
    }
    case "lead": {
      if (lead === null) {
        return "Its links go out on the first day";
      }
      return next.reminded
        ? `${lead.person.first} was reminded and has not talked yet`
        : `Waits for ${lead.person.first} to talk first`;
    }
    case "done": {
      return "Everyone has talked";
    }
    case "closed": {
      return `Closed. ${counted(next.missed, "person", "people")} did not talk`;
    }
    case "talking": {
      return team.sent === null
        ? "Links out"
        : `Links out since ${dayDate(view, team.sent)}`;
    }
    default: {
      return next satisfies never;
    }
  }
};

/** What needs a look at a team beyond where it stands, which already says a lead is missing or late. */
const besideStanding = (team: ChartTeam): readonly TeamFlag[] =>
  team.flags.filter(
    (flag) =>
      flag.kind !== "leadLate" &&
      !(flag.kind === "noLead" && team.view.next.kind === "lead-unknown")
  );

/**
 * One team in the list: its name, which opens it, who leads it and where
 * it stands, what needs a look there, and its people as dots. A team that
 * does not take part can be asked in until the interviews close.
 */
const TeamRow = ({
  view,
  team,
  clientId,
}: {
  view: OrgView;
  team: ChartTeam;
  clientId: string;
}) => {
  const each = team.view;
  const { lead, next } = each;
  const { name } = each.team;
  const people = each.people.length;
  const talked = talkedWords(each.counts.completed, each.asked);
  const line = [
    lead !== null && next.kind !== "lead" ? lead.person.name : "",
    standsOf(view, each),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const flags = each.off ? [] : besideStanding(team);
  const [flag] = flags;
  const late = next.kind === "lead" && next.reminded;
  return (
    // The whole row opens the team, as every list's rows open what they name: it answers the pointer and ends in a chevron.
    <li {...stylex.props(styles.row, styles.team)}>
      <span {...stylex.props(styles.stack)}>
        <TeamLink
          aria-label={`Open ${name}`}
          clientId={clientId}
          look={[styles.teamName, focusRingText, each.off && styles.teamOff]}
          team={each.team.id}
        >
          {name}
        </TeamLink>
        {late ? (
          // A lead who was reminded and has not talked: said in the words, marked in amber.
          <span {...stylex.props(styles.oneLine, styles.late)}>{line}</span>
        ) : (
          <Text as="span" color="muted" size="xs" truncate>
            {line}
          </Text>
        )}
        {flag === undefined ? null : (
          <Text as="span" color="default" size="xs" truncate>
            <Attention>
              {flagLine(flag)}
              {flags.length > 1 ? (
                <Text as="span" color="muted" size="xs">
                  {` +${flags.length - 1}`}
                </Text>
              ) : null}
            </Attention>
          </Text>
        )}
      </span>
      <span {...stylex.props(styles.teamDots)}>
        {each.off || !view.told ? (
          <span {...stylex.props(styles.figures)}>
            <Text as="span" color="muted" size="xs">
              {counted(people, "person", "people")}
            </Text>
          </span>
        ) : (
          <>
            <span {...stylex.props(styles.grow)}>
              <PeopleDots label={talked} people={each.people} />
            </span>
            <span aria-hidden {...stylex.props(styles.figures)}>
              <Text as="span" color="muted" size="xs">
                {talked}
              </Text>
            </span>
          </>
        )}
      </span>
      <span {...stylex.props(styles.teamEnd)}>
        {each.off && !view.closed ? (
          <span {...stylex.props(styles.above)}>
            <CommandButton
              clientId={clientId}
              command={{
                type: "onboarding.ask_in",
                payload: { team: each.team.id },
              }}
              label={`Ask ${name} in`}
            >
              Ask it in
            </CommandButton>
          </span>
        ) : null}
        <span aria-hidden {...stylex.props(styles.arrow)}>
          <Icon icon={ChevronRightIcon} />
        </span>
      </span>
    </li>
  );
};

/**
 * Every team, and the work that goes between them. A long list can be
 * searched by a team's name or a person's in it, and narrowed to the teams
 * that take part, are left out or need a look.
 */
export const TeamList = ({
  view,
  chart,
  clientId,
}: {
  view: OrgView;
  chart: Organization;
  clientId: string;
}) => {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const long = chart.teams.length > SEARCH_FROM;
  const left = chart.teams.filter((each) => each.view.off).length;
  const look = chart.teams.filter((each) => each.flags.length > 0).length;
  const counts: Record<Filter, number> = {
    all: chart.teams.length,
    taking: chart.taking,
    left,
    look,
  };
  const shownFilters = filters.filter((each) =>
    each === "all" || each === "taking"
      ? left > 0 || look > 0
      : counts[each] > 0
  );
  const wanted = query.trim().toLowerCase();
  const named = (name: string) => name.toLowerCase().includes(wanted);
  const found =
    wanted === "" ? [] : view.people.filter((each) => named(each.person.name));
  const shown = chart.teams.filter(
    (each) =>
      kept(each, filter) &&
      (wanted === "" ||
        named(each.view.team.name) ||
        each.view.people.some((one) => named(one.person.name)))
  );

  return (
    <>
      {long ? (
        <div {...stylex.props(styles.tools)}>
          {shownFilters.length > 1 ? (
            <ToggleGroup
              aria-label="Which teams to show"
              onValueChange={(value) => {
                setFilter(filters.find((each) => each === value[0]) ?? "all");
              }}
              size="sm"
              value={[filter]}
            >
              {shownFilters.map((each) => (
                <ToggleGroupItem key={each} value={each}>
                  {`${filterWords[each]} ${counts[each]}`}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
          <InputGroup style={styles.search}>
            <InputGroupInput
              aria-label="Find a team or a person"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Find a team or a person"
              value={query}
            />
            <InputGroupAddon>
              <Icon icon={SearchIcon} />
            </InputGroupAddon>
          </InputGroup>
        </div>
      ) : null}

      {found.length > 0 ? (
        <Found clientId={clientId} found={found} view={view} />
      ) : null}

      <Panel title="Teams">
        {shown.length === 0 ? (
          <PanelNote>No team matches.</PanelNote>
        ) : (
          <CardContent flush>
            <ul {...stylex.props(styles.rows)}>
              {shown.map((each) => (
                <TeamRow
                  clientId={clientId}
                  key={each.view.team.id}
                  team={each}
                  view={view}
                />
              ))}
            </ul>
          </CardContent>
        )}
      </Panel>

      {chart.between.length > 0 ? (
        <Between chart={chart} clientId={clientId} view={view} />
      ) : null}
    </>
  );
};

/** What one person in a team is asked about, under their name. */
const askedAbout = (team: ChartTeam, person: PersonView): string => {
  if (person.person.lead && team.view.lead !== null) {
    return "The team’s work, and who to ask";
  }
  const theirs = team.works.filter((work) => work.doers.includes(person));
  const about =
    theirs.find((work) => work.evidence.id === person.person.work) ?? theirs[0];
  if (about === undefined) {
    return team.works.length > 0 ? "Asked which work they do" : "";
  }
  const title = about.evidence.work.name;
  return theirs.length > 1 ? `${title}, and ${theirs.length - 1} more` : title;
};

/** A team's own figures: its people, how many talked, its pieces of work and how many are known. */
const TeamFigures = ({ view, team }: { view: OrgView; team: ChartTeam }) => {
  const each = team.view;
  const people = each.people.length;
  const works = team.works.length;
  const counts = view.told && !each.off;
  let peopleSub = "All are asked";
  if (each.off) {
    peopleSub = "None is asked";
  } else if (each.asked < people) {
    peopleSub = `${people - each.asked} ${people - each.asked === 1 ? "is" : "are"} away`;
  }
  let linksSub = each.off ? "Does not take part" : "No links out yet";
  if (each.sent !== null) {
    linksSub = `Links out since ${formatDate(dateOn(view.org, each.sent))}`;
  }
  return (
    <StatGroup
      aria-label={`${each.team.name} in numbers`}
      items={[
        { label: "People", value: String(people), change: peopleSub },
        {
          label: "Talked",
          value: counts ? `${each.counts.completed} of ${each.asked}` : "–",
          change: linksSub,
        },
        {
          label: "Pieces of work",
          value: String(works),
          change: works === 0 ? "Named by its lead" : "As its lead named them",
        },
        {
          label: "Known",
          value: works === 0 ? "–" : `${team.known} of ${works}`,
        },
      ]}
    />
  );
};

/** Everyone in a team, by name, with what each is asked about and where their link stands. */
const TeamPeople = ({
  team,
  titles,
}: {
  team: ChartTeam;
  titles: ReadonlyMap<string, string>;
}) => {
  const each = team.view;
  return (
    <Panel
      description={
        team.small
          ? `Fewer than ${MIN_GROUP}: the company never sees this team’s numbers apart.`
          : "By name, for Grasp only."
      }
      title="People"
    >
      {each.people.length === 0 ? (
        <PanelNote>Nobody is in this team yet.</PanelNote>
      ) : (
        <CardContent flush>
          <ul {...stylex.props(styles.rows)}>
            {each.people.map((one) => {
              const who = one.person;
              const about = [titles.get(who.id) ?? "", askedAbout(team, one)]
                .filter((part) => part !== "")
                .join(" · ");
              return (
                <li key={who.id} {...stylex.props(styles.row, styles.person)}>
                  <Initials name={who.name} />
                  <span {...stylex.props(styles.stack)}>
                    <span {...stylex.props(styles.personName)}>
                      <Text as="span" color="default" size="sm" truncate>
                        {who.name}
                      </Text>
                      {who.lead && each.lead !== null ? (
                        <Badge variant="outline">Team lead</Badge>
                      ) : null}
                    </span>
                    {about === "" ? null : (
                      <Text as="span" color="muted" size="xs" truncate>
                        {about}
                      </Text>
                    )}
                  </span>
                  <span {...stylex.props(styles.aside)}>
                    <Dot mark={markOf(one.state)} />
                    <span {...stylex.props(styles.belowSmHidden)}>
                      <Text as="span" color="muted" size="xs">
                        {one.out && one.state === "away"
                          ? "Not asked"
                          : linkWords[one.state]}
                      </Text>
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Panel>
  );
};

/** Who does a piece of work, as their initials and their first names. */
const Doers = ({ doers }: { doers: readonly PersonView[] }) => (
  <span {...stylex.props(styles.doers)}>
    <span aria-hidden {...stylex.props(styles.faces)}>
      {doers.slice(0, mostFaces).map((one) => (
        <Initials key={one.person.id} name={one.person.name} />
      ))}
    </span>
    <Text as="span" color="muted" size="xs" truncate>
      {doers.length <= mostNamed
        ? doers.map((one) => one.person.first).join(", ")
        : `${doers.length} do it`}
    </Text>
  </span>
);

/** The work a team does: how far each piece is known, its part of the team's work, and who does it. */
const TeamWork = ({
  team,
  clientId,
}: {
  team: ChartTeam;
  clientId: string;
}) => {
  const works = team.works.length;
  return (
    <Panel
      description={
        works === 0
          ? "Its lead names the team’s work in their interview: what there is, how much of it, and who does which."
          : "As its lead named it, with each piece’s part of the team’s work."
      }
      title="The work it does"
    >
      {works > 0 ? (
        <CardContent flush>
          <div {...stylex.props(styles.workBar)}>
            <WorkBar team={team} />
          </div>
          <ul {...stylex.props(styles.rows)}>
            {team.works.map((work) => {
              const title = work.evidence.work.name;
              const doers = work.doers.length;
              return (
                <li key={work.evidence.id} {...stylex.props(styles.row)}>
                  <Link
                    aria-label={`Open the workflows: “${title}”`}
                    params={{ clientId }}
                    to={sectionTo.workflows}
                    {...stylex.props(styles.work, focusRingInset)}
                  >
                    <span {...stylex.props(styles.workHead)}>
                      <Text as="span" color="default" size="sm">
                        {title}
                      </Text>
                      <span {...stylex.props(styles.figures)}>
                        <Text as="span" color="muted" size="xs">
                          {`${Math.round(work.share * 100)}%`}
                        </Text>
                      </span>
                    </span>
                    <span {...stylex.props(styles.workFacts)}>
                      <span {...stylex.props(styles.workState)}>
                        <span
                          aria-hidden
                          {...stylex.props(
                            styles.tone,
                            workTone(work.evidence)
                          )}
                        />
                        <Text as="span" color="muted" size="xs">
                          {workflowWords[work.evidence.state]}
                        </Text>
                      </span>
                      <span {...stylex.props(styles.figures)}>
                        <Text as="span" color="muted" size="xs">
                          {doers > 0
                            ? `${work.evidence.approved} of ${doers} talked`
                            : "Nobody named for it"}
                        </Text>
                      </span>
                    </span>
                    {doers > 0 ? <Doers doers={work.doers} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </CardContent>
      ) : null}
    </Panel>
  );
};

/** One hand-over: from where to where, and the work. */
const Hand = ({
  from,
  to,
  work,
}: {
  from: ReactNode;
  to: ReactNode;
  work: string;
}) => (
  <li {...stylex.props(styles.row, styles.hand)}>
    <span {...stylex.props(styles.inline)}>
      {from}
      <span aria-hidden {...stylex.props(styles.arrow)}>
        <Icon icon={ArrowRightIcon} />
      </span>
      {to}
    </span>
    <Text as="span" color="muted" size="xs" truncate>
      {work}
    </Text>
  </li>
);

/** Where a team's work comes from and goes to, by the company's own teams. */
const TeamHandoffs = ({
  view,
  team,
  clientId,
}: {
  view: OrgView;
  team: ChartTeam;
  clientId: string;
}) => {
  const { name } = team.view.team;
  const own = (
    <Text as="span" color="muted" size="sm" truncate>
      {name}
    </Text>
  );
  const other = (id: string) => (
    <TeamLink
      clientId={clientId}
      look={[styles.handTeam, focusRingText]}
      team={id}
    >
      {teamName(view, id)}
    </TeamLink>
  );
  return (
    <Panel
      description="Who gets each piece of work next, as the people who do it said."
      title="Where its work goes"
    >
      <CardContent flush>
        <ul {...stylex.props(styles.rows)}>
          {team.from.map((hand) => (
            <Hand
              from={other(hand.from)}
              key={`from-${hand.work.id}`}
              to={own}
              work={hand.work.name}
            />
          ))}
          {team.to.map((hand) => (
            <Hand
              from={own}
              key={`to-${hand.work.id}`}
              // Somewhere outside the teams is said in someone's words: not shown here.
              to={
                hand.to === null ? (
                  <Text as="span" color="muted" size="sm" truncate>
                    Outside the company’s teams
                  </Text>
                ) : (
                  other(hand.to)
                )
              }
              work={hand.work.name}
            />
          ))}
        </ul>
      </CardContent>
    </Panel>
  );
};

/** What about a team needs a look, each with what to do about it; or, when it doesn't take part, that. */
const TeamFlags = ({ view, team }: { view: OrgView; team: ChartTeam }) => {
  if (team.view.off) {
    return (
      <EmptyPanel>
        {view.closed
          ? "This team did not take part, and the interviews have closed."
          : "This team does not take part: nobody in it gets a link, and nothing waits for it. Asked in, its lead gets a link first, then everyone else."}
      </EmptyPanel>
    );
  }
  if (team.flags.length === 0) {
    return null;
  }
  return (
    <Card size="sm">
      <CardContent flush>
        <ul {...stylex.props(styles.rows)}>
          {team.flags.map((flag) => (
            <li
              key={
                flag.kind === "nobody" ? `nobody-${flag.work.id}` : flag.kind
              }
              {...stylex.props(styles.row, styles.firstRow, styles.flag)}
            >
              <Text as="span" color="default" size="sm">
                <Attention>{flagLine(flag)}</Attention>
              </Text>
              <Text as="span" color="muted" size="sm">
                {flagAbout[flag.kind]}
              </Text>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
};

/**
 * One team, whole: who leads it, everyone in it with what each is asked
 * about and where they stand, the work it does with who does which piece
 * and how far each is known, the apps it works in, and where its work
 * comes from and goes to.
 */
export const OneTeam = ({
  view,
  team,
  clientId,
  titles,
}: {
  view: OrgView;
  team: ChartTeam;
  clientId: string;
  titles: ReadonlyMap<string, string>;
}) => {
  const each = team.view;
  const { lead } = each;
  return (
    <>
      <div {...stylex.props(styles.back)}>
        <Button asChild size="sm" variant="outline">
          <Link {...teamLinkOf(clientId, null)}>
            <Icon icon={ArrowLeftIcon} />
            All teams
          </Link>
        </Button>
        <Text as="span" color={each.off ? "muted" : "default"} size="sm">
          {each.off
            ? "Does not take part in the interviews"
            : "Takes part in the interviews"}
        </Text>
      </div>

      <Card asChild size="sm">
        <section aria-label={each.team.name}>
          <CardContent>
            <div {...stylex.props(styles.head)}>
              <div {...stylex.props(styles.headWords)}>
                <Heading level={2} size="lg">
                  {each.team.name}
                </Heading>
                {each.team.does === "" ? null : (
                  <Text color="muted" size="sm">
                    {each.team.does}
                  </Text>
                )}
              </div>
              <div {...stylex.props(styles.lead)}>
                <Text as="span" color="muted" size="xs">
                  Team lead
                </Text>
                <span {...stylex.props(styles.personName)}>
                  {lead === null ? null : <Initials name={lead.person.name} />}
                  <Text
                    as="span"
                    color={lead === null ? "muted" : "default"}
                    size="sm"
                  >
                    {lead === null ? "Not named yet" : lead.person.name}
                  </Text>
                </span>
              </div>
            </div>
          </CardContent>
          <CardContent>
            <TeamFigures team={team} view={view} />
          </CardContent>
        </section>
      </Card>

      <TeamFlags team={team} view={view} />

      <div {...stylex.props(styles.team2)}>
        <TeamPeople team={team} titles={titles} />
        <div {...stylex.props(styles.side)}>
          <TeamWork clientId={clientId} team={team} />
          {team.tools.length > 0 ? (
            <Panel
              description="As the people who do the work named them, with how many pieces of work each is in."
              title="The apps it works in"
            >
              <CardContent>
                <ul {...stylex.props(styles.rows, styles.tools)}>
                  {team.tools.map((tool) => (
                    <li key={tool.name}>
                      <Badge variant="outline">
                        {`${tool.name} · ${tool.works}`}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Panel>
          ) : null}
          {team.to.length + team.from.length > 0 ? (
            <TeamHandoffs clientId={clientId} team={team} view={view} />
          ) : null}
        </div>
      </div>
    </>
  );
};
