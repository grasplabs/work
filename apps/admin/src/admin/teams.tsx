/**
 * The company's teams as Grasp knows them, ported from the prototype
 * (grasplabs/prototype `components/admin/org-organization.tsx`,
 * `org-team.tsx` and `organization-parts.ts`) and shown where the
 * interviews are (the Teams tab of Interviews), composed as Grasp Work
 * lists things: every team a row of a table (a card on a phone) with who
 * leads it, where it stands, what needs a look and who talked; a row
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
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGrid,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  ArrowLeftIcon,
  Icon,
  SearchIcon,
  TriangleAlertIcon,
} from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { CommandButton } from "./commands.tsx";
import { DataRows } from "./data-rows.tsx";
import type { DataColumn, RowLook } from "./data-rows.tsx";
import { Dot, Initials, markOf, PeopleDots } from "./interview-parts.tsx";
import { sectionTo } from "./sections.ts";
import { formatDate, linkWords, talkedWords, workflowWords } from "./words.ts";

const styles = stylex.create({
  // The parts of a page, a step further apart than the lines within each.
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
  part: { display: "flex", flexDirection: "column", gap: space["4"] },
  // The filters and the search on one line, the search under them on a phone.
  tools: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  search: { width: { default: "100%", [media.sm]: "16rem" } },
  // Who talked: the dots, then how many in words.
  talked: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["3"],
    rowGap: space["1"],
  },
  // A control in a row that opens its team: above the row's stretched press.
  raised: { position: "relative", zIndex: 1 },
  // Where someone's link stands: their dot, then the words.
  stands: { display: "inline-flex", alignItems: "center", gap: space["2"] },
  // A team's people beside its work, once there is room for both.
  team: {
    display: "grid",
    alignItems: "start",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.xl]: "minmax(0, 1fr) 24rem",
    },
    gap: space["10"],
  },
  // The way back, then where the team stands, on one line.
  back: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  badges: { display: "flex", flexWrap: "wrap", gap: space["2"] },
});

/** `count` and the thing it counts: one for one, many for the rest. */
const counted = (count: number, one: string, other: string): string =>
  `${count} ${count === 1 ? one : other}`;

/** With more teams than this, the list can be searched and narrowed. */
const SEARCH_FROM = 8;
/** How many people a search shows by name before it asks for more of the name. */
const mostFound = 6;
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

/** How a piece of work stands, as a Badge: green once known, amber while it waits on an answer. */
const workTone = (work: WorkEvidence): BadgeVariant => {
  if (work.state === "complete" || work.state === "variants") {
    return "success";
  }
  return work.state === "blocked" ? "warning" : "default";
};

/** A team's name, by its id. */
const teamName = (view: OrgView, id: string | null): string =>
  view.teams.find((each) => each.team.id === id)?.team.name ?? "";

/** Where someone's link stands, in words: one who isn't asked says so. */
const linkLine = (one: PersonView): string =>
  one.out && one.state === "away" ? "Not asked" : linkWords[one.state];

/** Where someone's link stands: their dot, then the words. */
const LinkStands = ({ one }: { one: PersonView }) => (
  <span {...stylex.props(styles.stands)}>
    <Dot mark={markOf(one.state)} />
    {linkLine(one)}
  </span>
);

/** Before anyone is on the list: the teams the sponsor named, if any, by name and size. */
export const NoTeams = ({ view }: { view: OrgView }) => {
  const named = view.vision?.teams ?? [];
  return (
    <div {...stylex.props(styles.part)}>
      <Empty align="start" size="sm">
        <EmptyHeader>
          <EmptyDescription>
            {named.length > 0
              ? "The teams as the sponsor named them. The real teams, with everyone in them, come with the company’s own list."
              : "Nobody is on the list yet. The company’s admin shares its staff list in their onboarding."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
      {named.length > 0 ? (
        <ItemGrid aria-label="The teams as the sponsor named them">
          {named.map((each) => {
            const count = each.people ?? 0;
            return (
              <Item key={each.name} variant="outline">
                <ItemContent>
                  <ItemTitle>{each.name}</ItemTitle>
                  <ItemDescription>
                    {count > 0
                      ? `About ${counted(count, "person", "people")}, as the sponsor said.`
                      : "How many people is not known yet."}
                  </ItemDescription>
                </ItemContent>
              </Item>
            );
          })}
        </ItemGrid>
      ) : null}
    </div>
  );
};

/** People whose name has what was searched in it, each opening their team. */
const Found = ({
  view,
  found,
  clientId,
}: {
  view: OrgView;
  found: readonly PersonView[];
  clientId: string;
}) => (
  <Part aria-labelledby="found">
    <SectionHeader
      description={
        found.length > mostFound
          ? `And ${found.length - mostFound} more: type more of the name.`
          : undefined
      }
      id="found"
      title="People"
      variant="group"
    />
    <ItemGroup aria-labelledby="found" separated>
      {found.slice(0, mostFound).map((each) => (
        <Item asChild key={each.person.id} size="sm">
          <Link
            params={{ clientId }}
            search={{ team: each.person.team }}
            to={sectionTo.interviews}
          >
            <ItemMedia>
              <Initials name={each.person.name} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{each.person.name}</ItemTitle>
              <ItemDescription>
                {`${teamName(view, each.person.team)} · ${
                  each.out ? "Team does not take part" : linkWords[each.state]
                }`}
              </ItemDescription>
            </ItemContent>
          </Link>
        </Item>
      ))}
    </ItemGroup>
  </Part>
);

/** Work one team hands to another, as the people who do it said, each opening the workflows. */
const Between = ({
  view,
  chart,
  clientId,
}: {
  view: OrgView;
  chart: Organization;
  clientId: string;
}) => (
  <Part aria-labelledby="between">
    <SectionHeader
      description="Work one team hands to another, as the people who do it said. Work stalls most where it changes hands."
      id="between"
      title="Where the work goes between teams"
      variant="group"
    />
    <ItemGroup aria-labelledby="between" separated>
      {chart.between.map((each) => (
        <Item asChild key={each.work.id} size="sm">
          <Link params={{ clientId }} to={sectionTo.workflows}>
            <ItemContent>
              <ItemTitle>
                {`${teamName(view, each.from)} → ${teamName(view, each.to)}`}
              </ItemTitle>
              <ItemDescription>{each.work.name}</ItemDescription>
            </ItemContent>
          </Link>
        </Item>
      ))}
    </ItemGroup>
  </Part>
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

/** One team as the list has it, with what its row needs to say it. */
interface TeamRow {
  team: ChartTeam;
  view: OrgView;
  clientId: string;
}

/** A team's lead, or that it has none named. */
const leadOf = ({ team }: TeamRow): string =>
  team.view.lead?.person.name ?? "Not named";

/** Where a team stands, amber while its lead was reminded and hasn't talked. */
const Standing = ({ team, view }: TeamRow) => {
  const { next } = team.view;
  const words = standsOf(view, team.view);
  return next.kind === "lead" && next.reminded ? (
    <Badge variant="warning">{words}</Badge>
  ) : (
    words
  );
};

/** What needs a look at a team, the first and how many more; none for a team left out. */
const lookOf = ({ team }: TeamRow): string => {
  const flags = team.view.off ? [] : besideStanding(team);
  const [flag] = flags;
  if (flag === undefined) {
    return "";
  }
  return flags.length > 1
    ? `${flagLine(flag)}, and ${flags.length - 1} more`
    : flagLine(flag);
};

/** Who talked there: its people as dots and in words, or how many while nobody is asked. */
const TalkedCell = ({ team, view }: TeamRow) => {
  const each = team.view;
  if (each.off || !view.told) {
    return counted(each.people.length, "person", "people");
  }
  const talked = talkedWords(each.counts.completed, each.asked);
  return (
    <span {...stylex.props(styles.talked)}>
      <PeopleDots label={talked} people={each.people} />
      <span aria-hidden>{talked}</span>
    </span>
  );
};

/** Who talked there, in words, on a card. */
const talkedFact = ({ team, view }: TeamRow): string =>
  team.view.off || !view.told
    ? counted(team.view.people.length, "person", "people")
    : talkedWords(team.view.counts.completed, team.view.asked);

/** Asking a team in that doesn't take part, until the interviews close: above the row's press. */
const AskIn = ({ team, view, clientId }: TeamRow) =>
  team.view.off && !view.closed ? (
    <span {...stylex.props(styles.raised)}>
      <CommandButton
        clientId={clientId}
        command={{
          type: "onboarding.ask_in",
          payload: { team: team.view.team.id },
        }}
        label={`Ask ${team.view.team.name} in`}
      >
        Ask it in
      </CommandButton>
    </span>
  ) : null;

const teamColumns: readonly DataColumn<TeamRow>[] = [
  { id: "lead", head: "Team lead", cell: leadOf },
  {
    id: "stands",
    head: "Where it stands",
    cell: (row) => <Standing {...row} />,
    wrap: true,
    fact: () => null,
  },
  {
    id: "look",
    head: "Needs a look",
    cell: lookOf,
    wrap: true,
    fact: (row) => (lookOf(row) === "" ? null : lookOf(row)),
  },
  {
    id: "talked",
    head: "Talked",
    cell: (row) => <TalkedCell {...row} />,
    fact: talkedFact,
  },
  {
    id: "ask",
    head: "",
    cell: (row) => <AskIn {...row} />,
    // A card is its link whole: a team is asked in from its own page.
    fact: () => null,
  },
];

/** Under a team's name on a card: where it stands. */
const teamLead = (row: TeamRow) => <Standing {...row} />;

const teamLink = ({ team, clientId }: TeamRow, look: RowLook) => (
  <Link
    params={{ clientId }}
    search={{ team: team.view.team.id }}
    to={sectionTo.interviews}
    {...look}
  />
);

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
      <Part aria-labelledby="teams">
        <SectionHeader
          description={`${counted(chart.teams.length, "team", "teams")}, ${chart.taking} taking part.`}
          id="teams"
          title="Teams"
          variant="group"
        />
        {shown.length === 0 ? (
          <Empty align="start" size="sm">
            <EmptyHeader>
              <EmptyDescription>No team matches.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DataRows
            columns={teamColumns}
            label="Teams"
            lead={teamLead}
            link={teamLink}
            name={({ team }) => team.view.team.name}
            nameHead="Team"
            rowKey={({ team }) => team.view.team.id}
            rows={shown.map((team) => ({ team, view, clientId }))}
          />
        )}
      </Part>
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
    linksSub = `Links out since ${dayDate(view, each.sent)}`;
  }
  return (
    <StatGroup aria-label={`${each.team.name} in figures`} columns={4}>
      <Stat change={peopleSub} label="People" value={String(people)} />
      <Stat
        change={linksSub}
        label="Talked"
        value={counts ? `${each.counts.completed} of ${each.asked}` : "Not yet"}
      />
      <Stat
        change={works === 0 ? "Named by its lead" : "As its lead named them"}
        label="Pieces of work"
        value={String(works)}
      />
      <Stat
        change={works === 0 ? "Once its lead named them" : undefined}
        label="Known"
        value={works === 0 ? "None yet" : `${team.known} of ${works}`}
        variant={works > 0 && team.known === works ? "success" : "default"}
      />
    </StatGroup>
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
    <Part aria-labelledby="team-people">
      <SectionHeader
        description={
          team.small
            ? `Fewer than ${MIN_GROUP}: the company never sees this team’s numbers apart.`
            : "By name, for Grasp only."
        }
        id="team-people"
        title="People"
        variant="group"
      />
      {each.people.length === 0 ? (
        <Empty align="start" size="sm">
          <EmptyHeader>
            <EmptyDescription>Nobody is in this team yet.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-labelledby="team-people" separated>
          {each.people.map((one) => {
            const who = one.person;
            const about = [titles.get(who.id) ?? "", askedAbout(team, one)]
              .filter((part) => part !== "")
              .join(" · ");
            return (
              <Item key={who.id} size="sm">
                <ItemMedia>
                  <Initials name={who.name} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {who.name}
                    {who.lead && each.lead !== null ? (
                      <ItemDetail>
                        <Badge variant="outline">Team lead</Badge>
                      </ItemDetail>
                    ) : null}
                  </ItemTitle>
                  {about === "" ? null : (
                    <ItemDescription>{about}</ItemDescription>
                  )}
                </ItemContent>
                <ItemActions>
                  <Text color="muted" size="sm">
                    <LinkStands one={one} />
                  </Text>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
    </Part>
  );
};

/** Who does a piece of work, by their first names, or how many. */
const doersWords = (doers: readonly PersonView[]): string =>
  doers.length <= mostNamed
    ? doers.map((one) => one.person.first).join(", ")
    : `${doers.length} do it`;

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
    <Part aria-labelledby="team-work">
      <SectionHeader
        description={
          works === 0
            ? "Its lead names the team’s work in their interview: what there is, how much of it, and who does which."
            : "As its lead named it, with each piece’s part of the team’s work."
        }
        id="team-work"
        title="The work it does"
        variant="group"
      />
      {works > 0 ? (
        <div {...stylex.props(styles.part)}>
          <Progress
            aria-label={`${team.known} of ${works} pieces of work known`}
            max={works}
            value={team.known}
          />
          <ItemGroup aria-labelledby="team-work" separated>
            {team.works.map((work) => {
              const doers = work.doers.length;
              const talked =
                doers > 0
                  ? `${work.evidence.approved} of ${doers} talked: ${doersWords(work.doers)}`
                  : "Nobody named for it";
              return (
                <Item asChild key={work.evidence.id} size="sm">
                  <Link params={{ clientId }} to={sectionTo.workflows}>
                    <ItemContent>
                      <ItemTitle>
                        {work.evidence.work.name}
                        <ItemDetail>{`${Math.round(work.share * 100)}%`}</ItemDetail>
                      </ItemTitle>
                      <ItemDescription>{talked}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Badge variant={workTone(work.evidence)}>
                        {workflowWords[work.evidence.state]}
                      </Badge>
                    </ItemActions>
                  </Link>
                </Item>
              );
            })}
          </ItemGroup>
        </div>
      ) : null}
    </Part>
  );
};

/** One hand-over of a team's work: to the other team's page when it is one of the company's own. */
const Handoff = ({
  clientId,
  other,
  title,
  work,
}: {
  clientId: string;
  /** The other team, or none for somewhere outside the company's teams. */
  other: string | null;
  title: string;
  work: string;
}) => {
  const content = (
    <ItemContent>
      <ItemTitle>{title}</ItemTitle>
      <ItemDescription>{work}</ItemDescription>
    </ItemContent>
  );
  return other === null ? (
    <Item size="sm">{content}</Item>
  ) : (
    <Item asChild size="sm">
      <Link
        params={{ clientId }}
        search={{ team: other }}
        to={sectionTo.interviews}
      >
        {content}
      </Link>
    </Item>
  );
};

/** Where a team's work comes from and goes to, by the company's own teams, each opening the other team. */
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
  return (
    <Part aria-labelledby="team-handoffs">
      <SectionHeader
        description="Who gets each piece of work next, as the people who do it said."
        id="team-handoffs"
        title="Where its work goes"
        variant="group"
      />
      <ItemGroup aria-labelledby="team-handoffs" separated>
        {team.from.map((hand) => (
          <Handoff
            clientId={clientId}
            key={`from-${hand.work.id}`}
            other={hand.from}
            title={`${teamName(view, hand.from)} → ${name}`}
            work={hand.work.name}
          />
        ))}
        {team.to.map((hand) => (
          <Handoff
            clientId={clientId}
            key={`to-${hand.work.id}`}
            other={hand.to}
            // Somewhere outside the teams is said in someone's words: not shown here.
            title={`${name} → ${hand.to === null ? "Outside the company’s teams" : teamName(view, hand.to)}`}
            work={hand.work.name}
          />
        ))}
      </ItemGroup>
    </Part>
  );
};

/** What about a team needs a look, each with what to do about it; or, when it doesn't take part, that. */
const TeamFlags = ({ view, team }: { view: OrgView; team: ChartTeam }) => {
  if (team.view.off) {
    return (
      <Empty align="start" size="sm">
        <EmptyHeader>
          <EmptyDescription>
            {view.closed
              ? "This team did not take part, and the interviews have closed."
              : "This team does not take part: nobody in it gets a link, and nothing waits for it. Asked in, its lead gets a link first, then everyone else."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (team.flags.length === 0) {
    return null;
  }
  return (
    <Part aria-labelledby="team-look">
      <SectionHeader id="team-look" title="Needs a look" variant="group" />
      <ItemGroup aria-labelledby="team-look" separated>
        {team.flags.map((flag) => (
          <Item
            key={flag.kind === "nobody" ? `nobody-${flag.work.id}` : flag.kind}
          >
            <ItemMedia variant="icon">
              <Icon icon={TriangleAlertIcon} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{flagLine(flag)}</ItemTitle>
              <ItemDescription>{flagAbout[flag.kind]}</ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </Part>
  );
};

/** The apps a team works in, with how many pieces of work each is in. */
const TeamTools = ({ team }: { team: ChartTeam }) => (
  <Part aria-labelledby="team-tools">
    <SectionHeader
      description="As the people who do the work named them, with how many pieces of work each is in."
      id="team-tools"
      title="The apps it works in"
      variant="group"
    />
    <span {...stylex.props(styles.badges)}>
      {team.tools.map((tool) => (
        <Badge key={tool.name} variant="outline">
          {`${tool.name} · ${tool.works}`}
        </Badge>
      ))}
    </span>
  </Part>
);

/** A team's heading: its name, what it does and who leads it. */
const teamLine = (team: ChartTeam): string => {
  const { lead, team: named } = team.view;
  const led =
    lead === null ? "No team lead named yet." : `Led by ${lead.person.name}.`;
  return named.does === "" ? led : `${named.does}. ${led}`;
};

/**
 * One team, whole: who leads it, its figures, what needs a look there,
 * everyone in it with what each is asked about and where they stand, the
 * work it does with who does which piece and how far each is known, the
 * apps it works in, and where its work comes from and goes to.
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
  return (
    <div {...stylex.props(styles.parts)}>
      <div {...stylex.props(styles.part)}>
        <div {...stylex.props(styles.back)}>
          <Button asChild size="sm" variant="ghost">
            <Link params={{ clientId }} to={sectionTo.interviews}>
              <Icon icon={ArrowLeftIcon} />
              All teams
            </Link>
          </Button>
          <AskIn clientId={clientId} team={team} view={view} />
        </div>
        <SectionHeader
          badge={
            each.off ? (
              <Badge>Does not take part in the interviews</Badge>
            ) : (
              <Badge variant="success">Takes part in the interviews</Badge>
            )
          }
          description={teamLine(team)}
          title={each.team.name}
        />
        <TeamFigures team={team} view={view} />
      </div>
      <TeamFlags team={team} view={view} />
      <div {...stylex.props(styles.team)}>
        <TeamPeople team={team} titles={titles} />
        <div {...stylex.props(styles.parts)}>
          <TeamWork clientId={clientId} team={team} />
          {team.tools.length > 0 ? <TeamTools team={team} /> : null}
          {team.to.length + team.from.length > 0 ? (
            <TeamHandoffs clientId={clientId} team={team} view={view} />
          ) : null}
        </div>
      </div>
    </div>
  );
};
