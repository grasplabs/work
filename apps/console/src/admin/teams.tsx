/**
 * The organization as Grasp knows it, ported from the prototype
 * (grasplabs/prototype `components/admin/org-organization.tsx`,
 * `org-team.tsx` and `organization-parts.ts`): the company, its figures,
 * every team as a card with its lead, its people as dots, its work and
 * what needs a look there; a card opens the team, with everyone in it,
 * the work it does and where that work goes. Every figure is the shared
 * model's (`organizationOf`).
 *
 * Read only, as the console is: the prototype puts the list right here
 * (a team or a person added, a lead named, a team asked in or left out,
 * the one reminder sent), which writes to the company's Grasp, and the
 * console has no way to yet. A person opens nothing of their own: the
 * prototype's dialog leads to what they said, which the console never
 * shows. Nor is where a piece of work goes said in the words of whoever
 * said it, when it isn't one of the company's own teams.
 */
import type {
  ChartTeam,
  Organization,
  TeamFlag,
} from "@grasp-os/shared/admin/admin-organization";
import { organizationOf } from "@grasp-os/shared/admin/admin-organization";
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
import { Progress } from "@grasp-os/ui/components/progress";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowRightIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  Done,
  Dot,
  DotLegend,
  Figure,
  Initials,
  markOf,
  PeopleDots,
} from "./parts.tsx";
import { sectionTo } from "./sections.ts";
import { formatDate, linkWords, workflowWords } from "./words.ts";

/** `count` and the thing it counts: one for one, many for the rest. */
const counted = (count: number, one: string, other: string): string =>
  `${count} ${count === 1 ? one : other}`;

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

/** A link to one team's own page, or to all of them. */
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
    to={sectionTo.organization}
  />
);

/** How far a team's work is known, as one bar under it. */
const WorkBar = ({ team }: { team: ChartTeam }) => (
  <Progress
    aria-label={`${team.known} of ${team.works.length} pieces of work known`}
    value={(team.known / Math.max(team.works.length, 1)) * 100}
  />
);

/** What a team card says at its foot when nothing about it needs a look. */
const nextLine = (team: ChartTeam): string => {
  const { next, lead } = team.view;
  switch (next.kind) {
    case "lead-unknown": {
      return "The company still has to name the team lead.";
    }
    case "not-told": {
      return "Gets its links once the team is told.";
    }
    case "lead": {
      return `Waits for ${lead?.person.first ?? "the lead"} to talk first.`;
    }
    case "talking": {
      return `${counted(next.left, "person", "people")} still to talk.`;
    }
    case "closed": {
      return `Closed. ${counted(next.missed, "person", "people")} did not talk.`;
    }
    case "off":
    case "done": {
      return "";
    }
    default: {
      return next satisfies never;
    }
  }
};

/** The foot of a team's card: whether it takes part, what stands out there, or what comes next. */
const CardFoot = ({ team }: { team: ChartTeam }) => {
  const each = team.view;
  // No lead is said where the lead stands; the foot says what else stands out.
  const flags = team.flags.filter((one) => one.kind !== "noLead");
  const [flag] = flags;
  if (each.off) {
    return <span className="text-muted-foreground">Does not take part</span>;
  }
  if (flag !== undefined) {
    return (
      <span className="text-status-attention flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="bg-status-attention size-1.5 flex-none rounded-full"
        />
        <span className="truncate">{flagLine(flag)}</span>
        {flags.length > 1 ? (
          <span className="text-muted-foreground flex-none tabular-nums">
            +{flags.length - 1}
          </span>
        ) : null}
      </span>
    );
  }
  if (each.next.kind === "done") {
    return <Done>Everyone has talked.</Done>;
  }
  return (
    <span className="text-muted-foreground truncate">{nextLine(team)}</span>
  );
};

/** Who leads a team, on its card. */
const CardLead = ({ team }: { team: ChartTeam }) => {
  const { lead, off, next } = team.view;
  if (lead !== null) {
    return (
      <div className="flex items-center gap-2.5">
        <Initials name={lead.person.name} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{lead.person.name}</span>
          <span className="text-muted-foreground text-xs">
            {lead.state === "completed" ? "Team lead, has talked" : "Team lead"}
          </span>
        </span>
      </div>
    );
  }
  const waitsOnCompany = off || next.kind === "lead-unknown";
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="size-6 flex-none rounded-full border border-dashed"
      />
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "truncate",
            waitsOnCompany ? "text-muted-foreground" : "text-status-attention"
          )}
        >
          No team lead named
        </span>
        <span className="text-muted-foreground text-xs">
          Its people are each asked what they do
        </span>
      </span>
    </div>
  );
};

/**
 * One team as a card: what it does, who leads it, its people as dots, how
 * far its work is known, and the one thing that stands out there. A team
 * that does not take part is greyed.
 */
const TeamCard = ({
  view,
  team,
  clientId,
}: {
  view: OrgView;
  team: ChartTeam;
  clientId: string;
}) => {
  const each = team.view;
  const { name } = each.team;
  const people = each.people.length;
  const works = team.works.length;
  const talked = `${each.counts.completed} of ${each.asked} talked`;
  return (
    <li
      className={cn(
        "hover:border-foreground/25 relative flex flex-col rounded-xl border transition-colors",
        each.off ? "bg-transparent" : "bg-card"
      )}
    >
      <div className="flex flex-1 flex-col gap-3 px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            {/* The whole card opens the team: the name is the link, stretched over the card. */}
            <TeamLink
              aria-label={`Open ${name}`}
              className={cn(
                "focus-visible:after:ring-ring/50 truncate rounded-sm font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3",
                each.off && "text-muted-foreground"
              )}
              clientId={clientId}
              team={each.team.id}
            >
              {name}
            </TeamLink>
            {each.team.does === "" ? null : (
              <span className="text-muted-foreground line-clamp-1 text-xs">
                {each.team.does}
              </span>
            )}
          </div>
          <span className="text-muted-foreground flex-none text-xs tabular-nums">
            {counted(people, "person", "people")}
          </span>
        </div>

        <CardLead team={team} />

        {people > 0 ? (
          <div className="flex items-start justify-between gap-4">
            <span className="pt-1">
              <PeopleDots label={talked} people={each.people} />
            </span>
            {view.told && !each.off ? (
              <span
                aria-hidden
                className="text-muted-foreground flex-none text-xs tabular-nums"
              >
                {talked}
              </span>
            ) : null}
          </div>
        ) : null}

        {works > 0 ? (
          <div className="mt-auto flex flex-col gap-1.5">
            <WorkBar team={team} />
            <span className="text-muted-foreground flex items-baseline justify-between gap-3 text-xs tabular-nums">
              <span>{counted(works, "piece of work", "pieces of work")}</span>
              <span>{team.known} known</span>
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-10 items-center justify-between gap-3 border-t px-4 py-2 text-xs">
        <CardFoot team={team} />
        {each.off ? null : (
          <ArrowRightIcon
            aria-hidden
            className="text-muted-foreground size-3.5 flex-none"
          />
        )}
      </div>
    </li>
  );
};

/** Where the list of people comes from, under the company's name. */
const sourceLine = (view: OrgView): string => {
  if (view.org.real !== undefined) {
    return "The list as the company’s admin shared it.";
  }
  return view.state.client === "directory"
    ? "From the company’s sign-in. The team leads are not named yet."
    : "From the company’s sign-in. The team leads come from its HR platform.";
};

/** The company's figures: its teams, its people, its team leads and its pieces of work. */
const Figures = ({
  view,
  chart,
  left,
}: {
  view: OrgView;
  chart: Organization;
  left: number;
}) => {
  const teams = chart.teams.length;
  const unnamed = chart.taking - chart.leadsNamed;
  let leadsSub = view.told ? "have talked" : "are named";
  if (unnamed > 0) {
    leadsSub = `${counted(unnamed, "team", "teams")} without a lead`;
  }
  return (
    <div className="@container border-t">
      <div className="bg-border grid grid-cols-2 gap-px @3xl:grid-cols-4">
        <Figure
          label="Teams"
          ring={left > 0 ? { value: chart.taking, of: teams } : undefined}
          sub={
            left > 0
              ? `${chart.taking} ${chart.taking === 1 ? "takes" : "take"} part`
              : "All take part"
          }
          value={teams}
        />
        <Figure
          label="People"
          ring={
            view.told ? { value: chart.talked, of: chart.asked } : undefined
          }
          sub={
            view.told
              ? `${chart.talked} of ${chart.asked} asked have talked`
              : `${chart.asked} will be asked`
          }
          value={chart.people}
        />
        <Figure
          attention={unnamed > 0}
          label="Team leads"
          ring={
            view.told
              ? { value: chart.leadsTalked, of: chart.leadsNamed }
              : { value: chart.leadsNamed, of: chart.taking }
          }
          sub={leadsSub}
          value={
            view.told
              ? `${chart.leadsTalked} of ${chart.leadsNamed}`
              : `${chart.leadsNamed} of ${chart.taking}`
          }
        />
        <Figure
          label="Pieces of work"
          ring={
            chart.works > 0
              ? { value: chart.known, of: chart.works }
              : undefined
          }
          sub={
            chart.works === 0
              ? "Named by each team’s lead"
              : `${chart.known} known`
          }
          value={chart.works}
        />
      </div>
    </div>
  );
};

/** Before anyone is on the list: the teams the sponsor named, if any, by name and size. */
const NoTeams = ({ view }: { view: OrgView }) => {
  const named = view.vision?.teams ?? [];
  let line = "Nothing is known yet. It starts with the first conversation.";
  if (named.length > 0) {
    line =
      "The teams as the sponsor named them. The real teams, with everyone in them, come with the company’s own list.";
  } else if (view.org.real !== undefined) {
    line =
      "Nobody is on the list yet. The company’s admin shares its staff list in their onboarding.";
  }
  return (
    <>
      <section className="bg-card flex flex-col gap-0.5 rounded-xl border px-5 py-4">
        <h2 className="font-medium">{view.org.name}</h2>
        <p className="text-muted-foreground">{line}</p>
      </section>
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
  <section className="bg-card overflow-hidden rounded-xl border">
    <div className="flex min-w-0 flex-col gap-0.5 px-5 py-4">
      <h2 className="font-medium">Where the work goes between teams</h2>
      <p className="text-muted-foreground">
        Work one team hands to another, as the people who do it said. Work
        stalls most where it changes hands.
      </p>
    </div>
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
  </section>
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

/** Every team, to find one by its name or a person's in it, and to show only those that take part, are left out or need a look. */
const AllTeams = ({
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
      <section className="bg-card overflow-hidden rounded-xl border">
        <div className="flex min-w-0 flex-col gap-0.5 px-5 py-4">
          <h2 className="font-medium">{view.org.name}</h2>
          {view.org.about === "" && view.org.place === "" ? null : (
            <p className="text-muted-foreground">
              {[view.org.about, view.org.place]
                .filter((part) => part !== "")
                .join(" · ")}
            </p>
          )}
          <p className="text-muted-foreground text-xs">{sourceLine(view)}</p>
        </div>
        <Figures chart={chart} left={left} view={view} />
      </section>

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
        ) : (
          <DotLegend />
        )}
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

      {found.length > 0 ? (
        <Found clientId={clientId} found={found} view={view} />
      ) : null}

      <div className="@container">
        <ul className="grid gap-3 @2xl:grid-cols-2 @4xl:grid-cols-3">
          {shown.map((each) => (
            <TeamCard
              clientId={clientId}
              key={each.view.team.id}
              team={each}
              view={view}
            />
          ))}
        </ul>
        {shown.length === 0 ? (
          <p className="text-muted-foreground">No team matches.</p>
        ) : null}
      </div>

      {shownFilters.length > 1 ? <DotLegend /> : null}

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
          ring={
            counts
              ? { value: each.counts.completed, of: each.asked }
              : undefined
          }
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
          ring={works > 0 ? { value: team.known, of: works } : undefined}
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
    <section className="bg-card overflow-hidden rounded-xl border">
      <div className="flex min-w-0 flex-col gap-0.5 px-5 py-4">
        <h2 className="font-medium">People</h2>
        <p className="text-muted-foreground">
          {team.small
            ? `Fewer than ${MIN_GROUP}: the company never sees this team’s numbers apart.`
            : "By name, for Grasp only."}
        </p>
      </div>
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
    </section>
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
    <section className="bg-card overflow-hidden rounded-xl border">
      <div className="flex min-w-0 flex-col gap-0.5 px-5 py-4">
        <h2 className="font-medium">The work it does</h2>
        <p className="text-muted-foreground">
          {works === 0
            ? "Its lead names the team’s work in their interview: what there is, how much of it, and who does which."
            : "As its lead named it, with each piece’s part of the team’s work."}
        </p>
      </div>
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
    </section>
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
    <section className="bg-card overflow-hidden rounded-xl border">
      <div className="flex min-w-0 flex-col gap-0.5 px-5 py-4">
        <h2 className="font-medium">Where its work goes</h2>
        <p className="text-muted-foreground">
          Who gets each piece of work next, as the people who do it said.
        </p>
      </div>
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
    </section>
  );
};

/** What about a team needs a look, each with what to do about it; or, when it doesn't take part, that. */
const TeamFlags = ({ view, team }: { view: OrgView; team: ChartTeam }) => {
  if (team.view.off) {
    return (
      <p className="text-muted-foreground rounded-xl border border-dashed px-5 py-4">
        {view.closed
          ? "This team did not take part, and the interviews have closed."
          : "This team does not take part: nobody in it gets a link, and nothing waits for it. Asked in, its lead gets a link first, then everyone else."}
      </p>
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
          <span className="text-status-attention flex items-center gap-2">
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
const OneTeam = ({
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
          variant="ghost"
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
            <h2 className="text-2xl leading-tight font-medium tracking-tight">
              {each.team.name}
            </h2>
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
            <section className="bg-card overflow-hidden rounded-xl border">
              <div className="flex min-w-0 flex-col gap-0.5 px-5 py-4">
                <h2 className="font-medium">The apps it works in</h2>
                <p className="text-muted-foreground">
                  As the people who do the work named them, with how many pieces
                  of work each is in.
                </p>
              </div>
              <ul className="flex flex-wrap gap-2 border-t px-5 py-4">
                {team.tools.map((tool) => (
                  <li
                    className="flex items-center gap-1.5 rounded-md border px-2 py-1"
                    key={tool.name}
                  >
                    <span>{tool.name}</span>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {tool.works}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {team.to.length + team.from.length > 0 ? (
            <TeamHandoffs clientId={clientId} team={team} view={view} />
          ) : null}
        </div>
      </div>
    </>
  );
};

/**
 * The organization as Grasp knows it: its teams as cards, or the team
 * `team` names, whole. A team the company doesn't have shows them all.
 */
export const OrgOrganization = ({
  view,
  team,
  clientId,
  titles,
}: {
  view: OrgView;
  /** The team that is open. */
  team: string | undefined;
  clientId: string;
  /** Each person's title, by their id, as the company's list has it. */
  titles: ReadonlyMap<string, string>;
}) => {
  const chart = organizationOf(view);
  const open = chart.teams.find((each) => each.view.team.id === team);
  if (open !== undefined) {
    return (
      <OneTeam clientId={clientId} team={open} titles={titles} view={view} />
    );
  }
  if (chart.teams.length === 0) {
    return <NoTeams view={view} />;
  }
  return <AllTeams chart={chart} clientId={clientId} view={view} />;
};
