/**
 * The interviews of one organization, by team, by name and one by one,
 * ported from the prototype (grasplabs/prototype
 * `components/admin/org-progress.tsx`, `org-people.tsx` and
 * `org-transcripts.tsx`): three of the Interviews section's tabs. Stephen
 * and Claire's own two are in interviewers.tsx.
 *
 * Core sends an interview as numbers only, so what was said is nowhere
 * here: the transcripts tab lists the interviews without a word of them.
 * And the console acts on nothing yet: the prototype's reminders, a team
 * asked in, the invitation and the list of links to send (a link is a
 * credential, which core never sends) aren't here.
 */
import type { Funnel } from "@grasp-os/shared/admin/admin-interviews";
import { funnelOf, talkedByDay } from "@grasp-os/shared/admin/admin-interviews";
import {
  dateOn,
  listenDays,
  REMIND_AFTER,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgView,
  PersonView,
  TeamView,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { cn } from "@grasp-os/ui/lib/utils";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import {
  BarList,
  Dot,
  Empty,
  markOf,
  Panel,
  PeopleDots,
} from "./interview-parts.tsx";
import {
  formatDate,
  interviewPhaseWords,
  linkWords,
  talkedWords,
} from "./words.ts";

/** The day `day` of the organization's interviews, as a date. */
const dayDate = (view: OrgView, day: number): string =>
  formatDate(dateOn(view.org, day));

/** The steps everyone goes through with their link, from being asked to having talked. */
const funnelSteps = ["asked", "out", "opened", "started", "talked"] as const;
type FunnelStep = (typeof funnelSteps)[number];

const funnelWords: Record<FunnelStep, string> = {
  asked: "Asked",
  out: "Link out",
  opened: "Opened",
  started: "Started",
  talked: "Talked",
};

/** How far everyone has come, as five bars: each as long as its share of everyone who is asked. */
const FunnelBars = ({ funnel }: { funnel: Funnel }) => (
  <ul
    aria-label="How far everyone has come"
    className="bg-card flex flex-col justify-center gap-2.5 px-5 py-5"
  >
    {funnelSteps.map((step) => (
      <li
        className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.5rem] items-center gap-3"
        key={step}
      >
        <span
          className={cn(
            "truncate",
            step === "talked" ? undefined : "text-muted-foreground"
          )}
        >
          {funnelWords[step]}
        </span>
        <Progress
          aria-label={funnelWords[step]}
          max={Math.max(funnel.asked, 1)}
          value={funnel[step]}
        />
        <span className="text-right tabular-nums">{funnel[step]}</span>
      </li>
    ))}
  </ul>
);

/**
 * How many had talked by each day so far, against everyone who is asked:
 * from the day the team was told until the links close.
 */
const TalkedDays = ({ view, asked }: { view: OrgView; asked: number }) => {
  if (!view.told) {
    return (
      <div className="bg-card flex flex-col justify-center gap-1 px-5 py-5">
        <span className="font-medium">Talked, day by day</span>
        <span className="text-muted-foreground">
          Starts the day the company tells its team.
        </span>
      </div>
    );
  }
  const days = talkedByDay(view).filter((each) => each.total !== null);
  const talked = days.at(-1)?.total ?? 0;
  return (
    <div className="bg-card flex flex-col gap-3 px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">Talked, day by day</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {`${talked} of ${asked} by day ${view.day} of ${listenDays(view.org)}`}
        </span>
      </div>
      <BarList
        label="Talked by each day"
        rows={days.map((each) => ({
          id: String(each.day),
          label: dayDate(view, each.day),
          value: each.total ?? 0,
        }))}
      />
    </div>
  );
};

/** Where a team stands, in a few words. */
const standsOf = (view: OrgView, team: TeamView): string => {
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
      return next.missed === 1
        ? "Closed. 1 person did not talk"
        : `Closed. ${next.missed} people did not talk`;
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

/** One team in the list: who leads it and where it stands, and its people as dots. */
const TeamRow = ({ view, team }: { view: OrgView; team: TeamView }) => {
  const { lead, next } = team;
  const talked = team.counts.completed;
  const people = team.people.length;
  const line = [
    lead !== null && next.kind !== "lead" ? lead.person.name : "",
    standsOf(view, team),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 border-t px-5 py-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <span className="flex min-w-0 flex-col">
        <span className={cn("truncate", team.off && "text-muted-foreground")}>
          {team.team.name}
        </span>
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
      </span>
      <span className="col-span-2 flex min-w-0 items-center gap-4 md:col-span-1">
        {team.off || !view.told ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {people === 1 ? "1 person" : `${people} people`}
          </span>
        ) : (
          <>
            <span className="min-w-0 flex-1">
              <PeopleDots
                label={talkedWords(talked, team.asked)}
                people={team.people}
              />
            </span>
            <span
              aria-hidden
              className="text-muted-foreground flex-none text-xs tabular-nums"
            >
              {talkedWords(talked, team.asked)}
            </span>
          </>
        )}
      </span>
    </li>
  );
};

/**
 * Where the interviews stand, in one look: how far everyone who is asked
 * has come with their link, how many had talked by each day, and every
 * team with who talked there.
 */
export const InterviewTeams = ({ view }: { view: OrgView }) => {
  if (view.teams.length === 0) {
    return (
      <Empty>
        Nobody is known here yet. The people come with the company’s own list.
      </Empty>
    );
  }
  const funnel = funnelOf(view);
  const closes = dayDate(view, listenDays(view.org));
  let links = "The links go out once the company has told its team.";
  if (view.closed) {
    links = `The links closed on ${closes}.`;
  } else if (view.told) {
    links = `The links close on ${closes}.`;
  }
  return (
    <>
      <Panel
        description={`Team leads go first, then their team. One reminder after ${REMIND_AFTER} working days, then nothing. ${links}`}
        title="Where everyone stands"
      >
        <div className="bg-border grid gap-px border-t lg:grid-cols-2">
          <FunnelBars funnel={funnel} />
          <TalkedDays asked={funnel.asked} view={view} />
        </div>
      </Panel>
      <Panel
        description="Every team, whether it takes part or not."
        title="Teams"
      >
        <ul className="flex flex-col">
          {view.teams.map((team) => (
            <TeamRow key={team.team.id} team={team} view={view} />
          ))}
        </ul>
      </Panel>
    </>
  );
};

/** The last thing that happened with someone's link, and when. */
const lastOf = (view: OrgView, each: PersonView): string => {
  if (each.last === null) {
    return "";
  }
  const date = dayDate(view, each.last.day);
  const lines: Record<NonNullable<PersonView["last"]>["what"], string> = {
    sent: `Link sent on ${date}`,
    opened: `Opened on ${date}`,
    reminded: `Reminded on ${date}`,
    stopped: `Stopped on ${date}`,
    completed: `Finished on ${date}`,
  };
  return lines[each.last.what];
};

/** What goes with where someone's link stands, on a second line. */
const besideOf = (each: PersonView): string => {
  if (each.deleted) {
    return "Deleted because they asked";
  }
  if (each.stoppedAt !== null) {
    return interviewPhaseWords[each.stoppedAt];
  }
  return each.out ? "Team does not take part" : "";
};

/**
 * Where every person stands with their link, by name: for Grasp only.
 * The company never sees this list: it gets numbers per team.
 */
export const InterviewPeople = ({ view }: { view: OrgView }) => {
  const [query, setQuery] = useState("");
  if (view.people.length === 0) {
    return (
      <Panel
        description="Names come with the company’s own list. Until it is in, nobody is known here."
        title="People"
      >
        <p className="text-muted-foreground border-t px-5 py-4">
          No people yet.
        </p>
      </Panel>
    );
  }
  const teams = new Map(view.teams.map((team) => [team.team.id, team]));
  const wanted = query.trim().toLowerCase();
  const shown = view.people.filter(
    (each) => wanted === "" || each.person.name.toLowerCase().includes(wanted)
  );
  return (
    <Panel
      action={
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-live="polite"
            className="text-muted-foreground tabular-nums max-sm:sr-only"
          >
            {`${shown.length} of ${view.people.length} people`}
          </span>
          <InputGroup className="w-56">
            <InputGroupInput
              aria-label="Search people"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search by name"
              value={query}
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
        </div>
      }
      description="By name, for Grasp only. The company sees numbers per team."
      title="People"
    >
      <div className="border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Name</TableHead>
              <TableHead variant="card">Where the link stands</TableHead>
              <TableHead className="hidden md:table-cell" variant="card">
                Last
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((each) => {
              const team = teams.get(each.person.team);
              const beside = besideOf(each);
              return (
                <TableRow key={each.person.id}>
                  <TableCell className="whitespace-normal" variant="card">
                    <span className="flex flex-col">
                      <span className="flex flex-wrap items-center gap-2">
                        {each.person.name}
                        {each.person.lead && team?.lead ? (
                          <Badge variant="outline">Team lead</Badge>
                        ) : null}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {team?.team.name ?? ""}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-normal" variant="card">
                    <span className="flex items-center gap-2">
                      <Dot mark={markOf(each.state)} />
                      <span className="flex flex-col">
                        <span
                          className={
                            each.state === "completed"
                              ? undefined
                              : "text-muted-foreground"
                          }
                        >
                          {each.out && each.state === "away"
                            ? "Not asked"
                            : linkWords[each.state]}
                        </span>
                        {beside === "" ? null : (
                          <span className="text-muted-foreground text-xs">
                            {beside}
                          </span>
                        )}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell" variant="card">
                    <span className="text-muted-foreground">
                      {lastOf(view, each)}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {shown.length === 0 ? (
          <p className="text-muted-foreground border-t px-5 py-4">
            Nobody matches.
          </p>
        ) : null}
      </div>
    </Panel>
  );
};

/** Before any interview: whom they wait on. */
export const noInterviewsYet = (view: OrgView): string =>
  view.told
    ? "No interviews yet. The team leads go first."
    : "No interviews yet. They start once the company has told its team.";

/**
 * The interviews themselves, every one finished or stopped halfway, as
 * numbers: when, how far, how long and how much was agreed to. The words
 * stay in the company's own Grasp: the console is sent none of them.
 */
export const InterviewList = ({ view }: { view: OrgView }) => {
  const teams = new Map(view.teams.map((team) => [team.team.id, team]));
  return (
    <Panel
      description="Every interview, finished or stopped halfway. What anyone said stays in the company’s own Grasp: the console is sent none of it, so no transcript is read here."
      title="Transcripts"
    >
      {view.interviews.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          {noInterviewsYet(view)}
        </p>
      ) : (
        <div className="border-t">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead variant="card">Who</TableHead>
                <TableHead variant="card">When</TableHead>
                <TableHead className="text-right" variant="card">
                  Minutes
                </TableHead>
                <TableHead className="text-right" variant="card">
                  Facts agreed
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.interviews.map((interview) => {
                const team = teams.get(interview.person.team);
                const kept = interview.approved
                  ? interview.facts - interview.out
                  : 0;
                return (
                  <TableRow key={interview.id}>
                    <TableCell className="whitespace-normal" variant="card">
                      <span className="flex flex-col">
                        {interview.person.name}
                        <span className="text-muted-foreground text-xs">
                          {team?.team.name ?? ""}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal" variant="card">
                      <span className="flex flex-col">
                        {dayDate(view, interview.day)}
                        {interview.stoppedAt === null ? null : (
                          <span className="text-muted-foreground text-xs">
                            {`Stopped at: ${interviewPhaseWords[interview.stoppedAt]}`}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right" variant="card">
                      <span className="tabular-nums">
                        {interview.minutes ?? "–"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right" variant="card">
                      <span className="tabular-nums">
                        {`${kept} of ${interview.facts}`}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
};
