/**
 * The interviews of one organization, by team and by name, ported from
 * the prototype (grasplabs/prototype `components/admin/org-progress.tsx`,
 * `org-people.tsx` and `org-transcripts.tsx`): two of the Interviews
 * section's tabs. The teams themselves, and one team whole, are in
 * teams.tsx; Stephen and Claire's own two tabs are in interviewers.tsx.
 *
 * Core sends an interview as numbers only, so what was said is nowhere
 * here: someone's interview is its minutes and how much they agreed to,
 * beside their name. Staff act from here as from the company's Grasp
 * before (commands.tsx): marking the one reminder, asking a team in,
 * sending a failed mail again and giving someone who lost their device a
 * new start. The invitation and the list of links to send aren't here: a
 * link is a credential, which core never sends.
 */
import type { AdminLink } from "@grasp-os/shared/admin-snapshot";
import type { Funnel } from "@grasp-os/shared/admin/admin-interviews";
import { funnelOf, talkedByDay } from "@grasp-os/shared/admin/admin-interviews";
import { organizationOf } from "@grasp-os/shared/admin/admin-organization";
import {
  dateOn,
  listenDays,
  REMIND_AFTER,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgView,
  PersonView,
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

import { CommandMenu } from "./command-menu.tsx";
import { CommandButton } from "./commands.tsx";
import { BarList, Dot, markOf } from "./interview-parts.tsx";
import { Section } from "./section.tsx";
import { NoTeams, OneTeam, TeamList } from "./teams.tsx";
import { formatDate, interviewPhaseWords, linkWords } from "./words.ts";

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
  // Under a title of its own and from the top of its cell, as the days
  // beside it are: centred, five bars floated in the middle of a cell as
  // tall as that list.
  <div className="bg-card flex flex-col gap-3 px-5 py-4">
    <span className="font-medium">How far everyone has come</span>
    <ul
      aria-label="How far everyone has come"
      className="flex flex-col gap-2.5"
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
  </div>
);

/**
 * How many had talked by each day so far, against everyone who is asked:
 * from the day the team was told until the links close.
 */
const TalkedDays = ({ view, asked }: { view: OrgView; asked: number }) => {
  if (!view.told) {
    return (
      <div className="bg-card flex flex-col gap-1 px-5 py-4">
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

/**
 * The Teams tab: the team `team` names, whole; or where the interviews
 * stand in one look (how far everyone who is asked has come with their
 * link, how many had talked by each day), then every team with who talked
 * there. A team the company doesn't have shows them all.
 */
export const InterviewTeams = ({
  view,
  clientId,
  team,
  titles,
}: {
  view: OrgView;
  clientId: string;
  /** The team that is open. */
  team: string | undefined;
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
  const funnel = funnelOf(view);
  // The links close at the end of the plan's last day, counting its first as day 0.
  const lastDay = dayDate(view, listenDays(view.org) - 1);
  let links = "The links go out once the company has told its team.";
  if (view.closed) {
    links = `The links closed after ${lastDay}.`;
  } else if (view.told) {
    links = `The links work until ${lastDay}.`;
  }
  return (
    <>
      <Section
        description={`One reminder after ${REMIND_AFTER} working days, then nothing. ${links}`}
        title="Where everyone stands"
      >
        <div className="bg-border grid gap-px border-t lg:grid-cols-2">
          <FunnelBars funnel={funnel} />
          <TalkedDays asked={funnel.asked} view={view} />
        </div>
      </Section>
      <TeamList chart={chart} clientId={clientId} view={view} />
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
const besideOf = (each: PersonView, link: AdminLink | undefined): string => {
  const failed = link?.failedMail ?? null;
  if (failed !== null) {
    const mail = failed.kind === "reminder" ? "reminder" : "link";
    return `Their ${mail} failed on ${formatDate(failed.at)}: ${failed.reason ?? "no reason given"}`;
  }
  if (each.deleted) {
    return "Deleted because they asked";
  }
  if (each.stoppedAt !== null) {
    return interviewPhaseWords[each.stoppedAt];
  }
  return each.out ? "Team does not take part" : "";
};

/**
 * What Grasp can do for one person: note the one reminder, send their
 * failed mail again once what stopped it is put right, and, in the row's
 * menu, give them a new start when they lost the device their interview
 * was on, which deletes what they said, so only on their request.
 */
const PersonActions = ({
  clientId,
  each,
  failed,
}: {
  clientId: string;
  each: PersonView;
  failed: boolean;
}) => {
  const { id, name } = each.person;
  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {each.mayRemind ? (
        <CommandButton
          clientId={clientId}
          command={{ type: "onboarding.remind", payload: { people: [id] } }}
          label={`Mark ${name} reminded`}
          variant="outline"
        >
          Mark reminded
        </CommandButton>
      ) : null}
      {failed ? (
        <CommandButton
          clientId={clientId}
          command={{
            type: "onboarding.send_mail_again",
            payload: { person: id },
          }}
          label={`Send ${name}’s mail again`}
        >
          Send again
        </CommandButton>
      ) : null}
      <CommandMenu
        clientId={clientId}
        items={
          each.sent === null
            ? []
            : [
                {
                  words: "New start",
                  command: {
                    type: "onboarding.new_start",
                    payload: { person: id },
                  },
                  confirm: {
                    title: `Give ${name} a new start?`,
                    description:
                      "What they said so far is deleted, and their link opens on the next device that opens it. Do this only when they asked.",
                    action: "Delete and start over",
                  },
                },
              ]
        }
        label={`More for ${name}`}
      />
    </span>
  );
};

/**
 * Where every person stands with their link, by name: for Grasp only.
 * The company never sees this list: it gets numbers per team.
 */
export const InterviewPeople = ({
  view,
  clientId,
  links,
}: {
  view: OrgView;
  clientId: string;
  /** Each link as core sends it: whose mail failed. */
  links: readonly AdminLink[];
}) => {
  const [query, setQuery] = useState("");
  if (view.people.length === 0) {
    return (
      <Section
        description="Names come with the company’s own list. Until it is in, nobody is known here."
        title="People"
      >
        <p className="text-muted-foreground border-t px-5 py-4">
          No people yet.
        </p>
      </Section>
    );
  }
  const teams = new Map(view.teams.map((team) => [team.team.id, team]));
  const linkOf = new Map(links.map((link) => [link.person, link]));
  // Someone's interview, finished or stopped halfway, by who held it.
  const interviewOf = new Map(
    view.interviews.map((interview) => [interview.id, interview])
  );
  // Everyone who can still have the one reminder, whatever the search shows.
  const reminders = view.closed
    ? []
    : view.people
        .filter((each) => each.mayRemind)
        .map((each) => each.person.id);
  const wanted = query.trim().toLowerCase();
  const shown = view.people.filter(
    (each) => wanted === "" || each.person.name.toLowerCase().includes(wanted)
  );
  return (
    <Section
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
      description="By name, for Grasp only: the company sees numbers per team. What anyone said stays in the company’s own Grasp."
      title="People"
    >
      {/* More than one: all at once, as each row does for its own. */}
      {reminders.length > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          <p className="text-muted-foreground">
            {`${reminders.length} people can still be reminded, once each.`}
          </p>
          <CommandButton
            clientId={clientId}
            command={{
              type: "onboarding.remind",
              payload: { people: reminders },
            }}
            variant="outline"
          >
            {`Mark ${reminders.length} people reminded`}
          </CommandButton>
        </div>
      ) : null}
      <div className="border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Name</TableHead>
              <TableHead variant="card">Where the link stands</TableHead>
              <TableHead className="hidden md:table-cell" variant="card">
                Last
              </TableHead>
              <TableHead
                className="hidden text-right lg:table-cell"
                variant="card"
              >
                Minutes
              </TableHead>
              <TableHead
                className="hidden text-right lg:table-cell"
                variant="card"
              >
                Facts agreed
              </TableHead>
              <TableHead variant="card">
                <span className="sr-only">What Grasp can do</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((each) => {
              const team = teams.get(each.person.team);
              const link = linkOf.get(each.person.id);
              const beside = besideOf(each, link);
              const interview = interviewOf.get(each.person.id);
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
                  <TableCell
                    className="hidden text-right lg:table-cell"
                    variant="card"
                  >
                    <span className="tabular-nums">
                      {interview?.minutes ?? "–"}
                    </span>
                  </TableCell>
                  <TableCell
                    className="hidden text-right lg:table-cell"
                    variant="card"
                  >
                    <span className="tabular-nums">
                      {interview === undefined
                        ? "–"
                        : `${interview.approved ? interview.facts - interview.out : 0} of ${interview.facts}`}
                    </span>
                  </TableCell>
                  <TableCell variant="card">
                    <PersonActions
                      clientId={clientId}
                      each={each}
                      failed={(link?.failedMail ?? null) !== null}
                    />
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
    </Section>
  );
};

/** Before any interview: whom they wait on. */
export const noInterviewsYet = (view: OrgView): string =>
  view.told
    ? "No interviews yet. The team leads go first."
    : "No interviews yet. They start once the company has told its team.";
