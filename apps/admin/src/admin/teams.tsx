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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
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
import { PageHeaderTitle } from "@grasp-os/ui/components/page-header";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { CommandButton } from "./commands.tsx";
import {
  AttentionDot,
  Dot,
  Figure,
  Initials,
  markOf,
  PeopleDots,
} from "./parts.tsx";
import { EmptySection, Section } from "./section.tsx";
import { sectionTo } from "./sections.ts";
import { formatDate, linkWords, talkedWords, workflowWords } from "./words.ts";

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

/** How a piece of work is marked: known in the colour of agreed, waiting on an answer in the colour of attention. */
const workTone = (work: WorkEvidence): string => {
  if (isKnown(work)) {
    return "bg-status-agreed";
  }
  return work.state === "blocked"
    ? "bg-status-attention"
    : "bg-muted-foreground/60";
};

/** A team's name, by its id. */
const teamName = (view: OrgView, id: string | null): string =>
  view.teams.find((each) => each.team.id === id)?.team.name ?? "";

/** A link to one team, open where the teams are, or to all of them. */
const TeamLink = ({
  clientId,
  team,
  ...props
}: {
  clientId: string;
  team: string | null;
  className?: string;
  "aria-label"?: string;
  children?: ReactNode;
}) => (
  <Link
    {...props}
    params={{ clientId }}
    search={team === null ? {} : { team }}
    to={sectionTo.interviews}
  />
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
      <Section description={line} title={view.org.name} />
      {named.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {named.map((each) => {
            const count = each.people ?? 0;
            return (
              <li
                className="flex flex-col gap-1 rounded-xl border border-dashed px-4 py-3"
                key={each.name}
              >
                <span className="font-medium">{each.name}</span>
                <span className="text-muted-foreground text-xs">
                  {count > 0
                    ? `About ${counted(count, "person", "people")}, as the sponsor said.`
                    : "How many people is not known yet."}
                </span>
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
  <ul className="bg-card flex flex-col overflow-hidden rounded-xl border">
    {found.slice(0, mostFound).map((each) => (
      <li className="border-t first:border-t-0" key={each.person.id}>
        <TeamLink
          className="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 px-4 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset"
          clientId={clientId}
          team={each.person.team}
        >
          <Initials name={each.person.name} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{each.person.name}</span>
            <span className="text-muted-foreground truncate text-xs">
              {teamName(view, each.person.team)}
            </span>
          </span>
          <span className="text-muted-foreground flex flex-none items-center gap-2 text-xs">
            <Dot mark={markOf(each.state)} />
            <span className="max-sm:sr-only">
              {each.out ? "Team does not take part" : linkWords[each.state]}
            </span>
          </span>
        </TeamLink>
      </li>
    ))}
    {found.length > mostFound ? (
      <li className="text-muted-foreground border-t px-4 py-2 text-xs">
        And {found.length - mostFound} more: type more of the name.
      </li>
    ) : null}
  </ul>
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
  <Section
    description="Work one team hands to another, as the people who do it said. Work stalls most where it changes hands."
    title="Where the work goes between teams"
  >
    <ul className="flex flex-col">
      {chart.between.map((each) => (
        <li className="border-t" key={each.work.id}>
          <Link
            aria-label={`Open the workflows: “${each.work.name}”`}
            className="hover:bg-muted/50 focus-visible:ring-ring/50 grid w-full items-center gap-x-4 gap-y-0.5 px-5 py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset sm:grid-cols-2"
            params={{ clientId }}
            to={sectionTo.workflows}
          >
            <span className="flex min-w-0 flex-wrap items-center gap-x-2">
              <span className="truncate">{teamName(view, each.from)}</span>
              <ArrowRightIcon
                aria-hidden
                className="text-muted-foreground size-3.5 flex-none"
              />
              <span className="truncate">{teamName(view, each.to)}</span>
            </span>
            <span className="text-muted-foreground min-w-0 truncate">
              {each.work.name}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  </Section>
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
  return (
    // The whole row opens the team, as every list's rows open what they name: it answers the pointer and ends in a chevron.
    <li className="hover:bg-muted/50 relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 border-t px-5 py-3 transition-colors md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto]">
      <span className="flex min-w-0 flex-col">
        <TeamLink
          aria-label={`Open ${name}`}
          className={cn(
            "focus-visible:ring-ring/50 truncate rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-3",
            each.off && "text-muted-foreground"
          )}
          clientId={clientId}
          team={each.team.id}
        >
          {name}
        </TeamLink>
        <span
          className={cn(
            "truncate text-xs",
            next.kind === "lead" && next.reminded
              ? "text-status-attention"
              : "text-muted-foreground"
          )}
        >
          {line}
        </span>
        {flag === undefined ? null : (
          <span className="flex items-baseline gap-1.5 truncate text-xs">
            <AttentionDot />
            {flagLine(flag)}
            {flags.length > 1 ? (
              <span className="text-muted-foreground tabular-nums">
                {` +${flags.length - 1}`}
              </span>
            ) : null}
          </span>
        )}
      </span>
      <span className="col-span-2 flex min-w-0 items-center gap-4 md:col-span-1">
        {each.off || !view.told ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {counted(people, "person", "people")}
          </span>
        ) : (
          <>
            <span className="min-w-0 flex-1">
              <PeopleDots label={talked} people={each.people} />
            </span>
            <span
              aria-hidden
              className="text-muted-foreground flex-none text-xs tabular-nums"
            >
              {talked}
            </span>
          </>
        )}
      </span>
      <span className="col-start-2 row-start-1 flex items-center gap-3 md:col-start-auto md:row-start-auto">
        {each.off && !view.closed ? (
          // Above the row's link, so it is pressed itself.
          <span className="relative">
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
        <ChevronRightIcon
          aria-hidden
          className="text-muted-foreground size-4 flex-none"
        />
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
        <div className="flex flex-wrap items-center gap-2">
          {shownFilters.length > 1 ? (
            <ToggleGroup
              aria-label="Which teams to show"
              className="flex-wrap"
              onValueChange={(value) => {
                setFilter(filters.find((each) => each === value[0]) ?? "all");
              }}
              size="sm"
              spacing={0}
              value={[filter]}
              variant="outline"
            >
              {shownFilters.map((each) => (
                <ToggleGroupItem key={each} value={each}>
                  {filterWords[each]}
                  <span className="text-muted-foreground tabular-nums">
                    {counts[each]}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
          <div className="w-full sm:ml-auto sm:w-64">
            <InputGroup>
              <InputGroupInput
                aria-label="Find a team or a person"
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder="Find a team or a person"
                value={query}
              />
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
            </InputGroup>
          </div>
        </div>
      ) : null}

      {found.length > 0 ? (
        <Found clientId={clientId} found={found} view={view} />
      ) : null}

      <Section title="Teams">
        {shown.length === 0 ? (
          <p className="text-muted-foreground border-t px-5 py-4">
            No team matches.
          </p>
        ) : (
          <ul className="flex flex-col">
            {shown.map((each) => (
              <TeamRow
                clientId={clientId}
                key={each.view.team.id}
                team={each}
                view={view}
              />
            ))}
          </ul>
        )}
      </Section>

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
    <div className="@container border-t">
      <div className="bg-border grid grid-cols-2 gap-px @3xl:grid-cols-4">
        <Figure label="People" sub={peopleSub} value={people} />
        <Figure
          label="Talked"
          sub={linksSub}
          value={counts ? `${each.counts.completed} of ${each.asked}` : "–"}
        />
        <Figure
          label="Pieces of work"
          sub={works === 0 ? "Named by its lead" : "As its lead named them"}
          value={works}
        />
        <Figure
          label="Known"
          value={works === 0 ? "–" : `${team.known} of ${works}`}
        />
      </div>
    </div>
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
    <Section
      description={
        team.small
          ? `Fewer than ${MIN_GROUP}: the company never sees this team’s numbers apart.`
          : "By name, for Grasp only."
      }
      title="People"
    >
      {each.people.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          Nobody is in this team yet.
        </p>
      ) : (
        <ul className="flex flex-col">
          {each.people.map((one) => {
            const who = one.person;
            const about = [titles.get(who.id) ?? "", askedAbout(team, one)]
              .filter((part) => part !== "")
              .join(" · ");
            return (
              <li
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-t px-5 py-2.5"
                key={who.id}
              >
                <Initials name={who.name} />
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{who.name}</span>
                    {who.lead && each.lead !== null ? (
                      <Badge variant="outline">Team lead</Badge>
                    ) : null}
                  </span>
                  {about === "" ? null : (
                    <span className="text-muted-foreground truncate text-xs">
                      {about}
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground flex flex-none items-center gap-2 text-xs">
                  <Dot mark={markOf(one.state)} />
                  <span className="max-sm:sr-only">
                    {one.out && one.state === "away"
                      ? "Not asked"
                      : linkWords[one.state]}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
};

/** Who does a piece of work, as their initials and their first names. */
const Doers = ({ doers }: { doers: readonly PersonView[] }) => (
  <span className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
    <span aria-hidden className="flex flex-none gap-0.5">
      {doers.slice(0, mostFaces).map((one) => (
        <Initials key={one.person.id} name={one.person.name} />
      ))}
    </span>
    <span className="min-w-0 truncate">
      {doers.length <= mostNamed
        ? doers.map((one) => one.person.first).join(", ")
        : `${doers.length} do it`}
    </span>
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
    <Section
      description={
        works === 0
          ? "Its lead names the team’s work in their interview: what there is, how much of it, and who does which."
          : "As its lead named it, with each piece’s part of the team’s work."
      }
      title="The work it does"
    >
      {works > 0 ? (
        <>
          <div className="px-5 pb-4">
            <WorkBar team={team} />
          </div>
          <ul className="flex flex-col">
            {team.works.map((work) => {
              const title = work.evidence.work.name;
              const doers = work.doers.length;
              return (
                <li className="border-t" key={work.evidence.id}>
                  <Link
                    aria-label={`Open the workflows: “${title}”`}
                    className="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full flex-col gap-1 px-5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset"
                    params={{ clientId }}
                    to={sectionTo.workflows}
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0">{title}</span>
                      <span className="text-muted-foreground flex-none text-xs tabular-nums">
                        {Math.round(work.share * 100)}%
                      </span>
                    </span>
                    <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 rounded-full",
                            workTone(work.evidence)
                          )}
                        />
                        {workflowWords[work.evidence.state]}
                      </span>
                      <span className="tabular-nums">
                        {doers > 0
                          ? `${work.evidence.approved} of ${doers} talked`
                          : "Nobody named for it"}
                      </span>
                    </span>
                    {doers > 0 ? <Doers doers={work.doers} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </Section>
  );
};

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
  const otherLink =
    "truncate rounded-sm hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 outline-none";
  return (
    <Section
      description="Who gets each piece of work next, as the people who do it said."
      title="Where its work goes"
    >
      <ul className="flex flex-col">
        {team.from.map((hand) => (
          <li
            className="flex flex-col gap-0.5 border-t px-5 py-2.5"
            key={`from-${hand.work.id}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <TeamLink
                className={otherLink}
                clientId={clientId}
                team={hand.from}
              >
                {teamName(view, hand.from)}
              </TeamLink>
              <ArrowRightIcon
                aria-hidden
                className="text-muted-foreground size-3.5 flex-none"
              />
              <span className="text-muted-foreground truncate">{name}</span>
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {hand.work.name}
            </span>
          </li>
        ))}
        {team.to.map((hand) => (
          <li
            className="flex flex-col gap-0.5 border-t px-5 py-2.5"
            key={`to-${hand.work.id}`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground truncate">{name}</span>
              <ArrowRightIcon
                aria-hidden
                className="text-muted-foreground size-3.5 flex-none"
              />
              {/* Somewhere outside the teams is said in someone's words: not shown here. */}
              {hand.to === null ? (
                <span className="text-muted-foreground truncate">
                  Outside the company’s teams
                </span>
              ) : (
                <TeamLink
                  className={otherLink}
                  clientId={clientId}
                  team={hand.to}
                >
                  {teamName(view, hand.to)}
                </TeamLink>
              )}
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {hand.work.name}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
};

/** What about a team needs a look, each with what to do about it; or, when it doesn't take part, that. */
const TeamFlags = ({ view, team }: { view: OrgView; team: ChartTeam }) => {
  if (team.view.off) {
    return (
      <EmptySection>
        {view.closed
          ? "This team did not take part, and the interviews have closed."
          : "This team does not take part: nobody in it gets a link, and nothing waits for it. Asked in, its lead gets a link first, then everyone else."}
      </EmptySection>
    );
  }
  if (team.flags.length === 0) {
    return null;
  }
  return (
    <ul className="bg-card flex flex-col overflow-hidden rounded-xl border">
      {team.flags.map((flag) => (
        <li
          className="flex flex-col gap-0.5 border-t px-5 py-3 first:border-t-0"
          key={flag.kind === "nobody" ? `nobody-${flag.work.id}` : flag.kind}
        >
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="bg-status-attention size-1.5 flex-none rounded-full"
            />
            {flagLine(flag)}
          </span>
          <span className="text-muted-foreground">{flagAbout[flag.kind]}</span>
        </li>
      ))}
    </ul>
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          className="-ml-2"
          nativeButton={false}
          render={<TeamLink clientId={clientId} team={null} />}
          size="sm"
          variant="outline"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          All teams
        </Button>
        <span className={each.off ? "text-muted-foreground" : undefined}>
          {each.off
            ? "Does not take part in the interviews"
            : "Takes part in the interviews"}
        </span>
      </div>

      <section className="bg-card overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4 px-5 py-4">
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
            <PageHeaderTitle render={<h2>{each.team.name}</h2>} />
            {each.team.does === "" ? null : (
              <p className="text-muted-foreground">{each.team.does}</p>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted-foreground text-xs">Team lead</span>
            <span className="flex items-center gap-2">
              {lead === null ? null : <Initials name={lead.person.name} />}
              <span
                className={lead === null ? "text-muted-foreground" : undefined}
              >
                {lead === null ? "Not named yet" : lead.person.name}
              </span>
            </span>
          </div>
        </div>
        <TeamFigures team={team} view={view} />
      </section>

      <TeamFlags team={team} view={view} />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <TeamPeople team={team} titles={titles} />
        <div className="flex min-w-0 flex-col gap-6">
          <TeamWork clientId={clientId} team={team} />
          {team.tools.length > 0 ? (
            <Section
              description="As the people who do the work named them, with how many pieces of work each is in."
              title="The apps it works in"
            >
              <ul className="flex flex-wrap gap-2 border-t px-5 py-4">
                {team.tools.map((tool) => (
                  <li key={tool.name}>
                    <Badge variant="outline">
                      {`${tool.name} · ${tool.works}`}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {team.to.length + team.from.length > 0 ? (
            <TeamHandoffs clientId={clientId} team={team} view={view} />
          ) : null}
        </div>
      </div>
    </>
  );
};
