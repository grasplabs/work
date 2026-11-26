/**
 * The interviews of one organization, by team and by name, ported from
 * the prototype (grasplabs/prototype `components/admin/org-progress.tsx`,
 * `org-people.tsx` and `org-transcripts.tsx`): two of the Interviews
 * section's tabs. The teams themselves, and one team whole, are in
 * teams.tsx; Stephen's own two tabs are in interviewers.tsx.
 *
 * Core sends an interview as numbers only, so what was said is nowhere
 * here: someone's interview is its minutes and how much they agreed to,
 * beside their name. Staff act from here as from the company's Grasp
 * before (commands.tsx): marking the one reminder, asking a team in,
 * sending a failed mail again and giving someone a new start. The invitation and the list of links to send aren't here: a
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
import { CardContent } from "@grasp-os/ui/components/card";
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
import { Text } from "@grasp-os/ui/components/text";
import { Icon, SearchIcon } from "@grasp-os/ui/lib/icons";
import { colors, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { CommandMenu } from "./command-menu.tsx";
import { CommandButton } from "./commands.tsx";
import { BarList, Dot, markOf } from "./interview-parts.tsx";
import { Panel, PanelNote } from "./panel.tsx";
import { NoTeams, OneTeam, TeamList } from "./teams.tsx";
import { formatDate, interviewPhaseWords, linkWords } from "./words.ts";

const styles = stylex.create({
  // The two looks side by side from a laptop's width, a hairline between them.
  looks: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [media.lg]: "1fr 1fr" },
    gap: "1px",
    backgroundColor: colors.border,
  },
  look: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    paddingBlock: space["4"],
    paddingInline: space["5"],
    backgroundColor: colors.card,
  },
  lookHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space["3"],
  },
  steps: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  step: {
    display: "grid",
    gridTemplateColumns: "5.5rem minmax(0, 1fr) 2.5rem",
    alignItems: "center",
    gap: space["3"],
  },
  count: { textAlign: "end", fontVariantNumeric: "tabular-nums" },
  figures: { fontVariantNumeric: "tabular-nums" },
  // The count beside the search: on a phone, where there is no room for it, said to a screen
  // reader alone.
  shownCount: {
    position: { default: null, [media.maxSm]: "absolute" },
    width: { default: null, [media.maxSm]: "1px" },
    height: { default: null, [media.maxSm]: "1px" },
    overflow: { default: null, [media.maxSm]: "hidden" },
    clipPath: { default: null, [media.maxSm]: "inset(50%)" },
    whiteSpace: { default: null, [media.maxSm]: "nowrap" },
  },
  search: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space["3"],
  },
  searchField: { width: "14rem" },
  remindAll: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  stack: { display: "flex", flexDirection: "column" },
  nameLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  where: { display: "flex", alignItems: "center", gap: space["2"] },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space["2"],
  },
  // Columns the window's width makes room for, as the old table had them.
  fromMd: { display: { default: null, [media.maxMd]: "none" } },
  fromLg: { display: { default: null, [media.maxLg]: "none" } },
});

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
  <div {...stylex.props(styles.look)}>
    <Text as="span" color="default" size="sm" weight="medium">
      How far everyone has come
    </Text>
    <ul aria-label="How far everyone has come" {...stylex.props(styles.steps)}>
      {funnelSteps.map((step) => (
        <li key={step} {...stylex.props(styles.step)}>
          <Text
            as="span"
            color={step === "talked" ? "default" : "muted"}
            size="sm"
            truncate
          >
            {funnelWords[step]}
          </Text>
          <Progress
            aria-label={funnelWords[step]}
            max={Math.max(funnel.asked, 1)}
            value={funnel[step]}
          />
          <span {...stylex.props(styles.count)}>
            <Text as="span" color="default" size="sm">
              {String(funnel[step])}
            </Text>
          </span>
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
      <div {...stylex.props(styles.look)}>
        <Text as="span" color="default" size="sm" weight="medium">
          Talked, day by day
        </Text>
        <Text as="span" color="muted" size="sm">
          Starts the day the company tells its team.
        </Text>
      </div>
    );
  }
  const days = talkedByDay(view).filter((each) => each.total !== null);
  const talked = days.at(-1)?.total ?? 0;
  return (
    <div {...stylex.props(styles.look)}>
      <div {...stylex.props(styles.lookHead)}>
        <Text as="span" color="default" size="sm" weight="medium">
          Talked, day by day
        </Text>
        <span {...stylex.props(styles.figures)}>
          <Text as="span" color="muted" size="xs">
            {`${talked} of ${asked} by day ${view.day} of ${listenDays(view.org)}`}
          </Text>
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
      <Panel
        description={`One reminder after ${REMIND_AFTER} working days, then nothing. ${links}`}
        title="Where everyone stands"
      >
        <CardContent flush>
          <div {...stylex.props(styles.looks)}>
            <FunnelBars funnel={funnel} />
            <TalkedDays asked={funnel.asked} view={view} />
          </div>
        </CardContent>
      </Panel>
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
 * menu, give them a new start when their interview went wrong (a link
 * opened at a wrong address among it), which deletes what they said, so
 * only on their request.
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
    <span {...stylex.props(styles.actions)}>
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
                      "What they said so far is deleted, and their link opens for the next account that signs in with the address on the list. Do this only when they asked.",
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
      <Panel
        description="Names come with the company’s own list. Until it is in, nobody is known here."
        title="People"
      >
        <PanelNote>No people yet.</PanelNote>
      </Panel>
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
    <Panel
      action={
        <div {...stylex.props(styles.search)}>
          <span aria-live="polite" {...stylex.props(styles.shownCount)}>
            <span {...stylex.props(styles.figures)}>
              <Text as="span" color="muted" size="sm">
                {`${shown.length} of ${view.people.length} people`}
              </Text>
            </span>
          </span>
          <InputGroup style={styles.searchField}>
            <InputGroupInput
              aria-label="Search people"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Search by name"
              value={query}
            />
            <InputGroupAddon>
              <Icon icon={SearchIcon} />
            </InputGroupAddon>
          </InputGroup>
        </div>
      }
      description="By name, for Grasp only: the company sees numbers per team. What anyone said stays in the company’s own Grasp."
      title="People"
    >
      {/* More than one: all at once, as each row does for its own. */}
      {reminders.length > 1 ? (
        <CardContent>
          <div {...stylex.props(styles.remindAll)}>
            <Text color="muted" size="sm">
              {`${reminders.length} people can still be reminded, once each.`}
            </Text>
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
        </CardContent>
      ) : null}
      <CardContent flush>
        <Table aria-label="People">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Where the link stands</TableHead>
              <TableHead style={styles.fromMd}>Last</TableHead>
              <TableHead align="end" style={styles.fromLg}>
                Minutes
              </TableHead>
              <TableHead align="end" style={styles.fromLg}>
                Facts agreed
              </TableHead>
              <TableHead aria-label="What Grasp can do" />
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
                  <TableCell rowHeader wrap>
                    <span {...stylex.props(styles.stack)}>
                      <span {...stylex.props(styles.nameLine)}>
                        {each.person.name}
                        {each.person.lead && team?.lead ? (
                          <Badge variant="outline">Team lead</Badge>
                        ) : null}
                      </span>
                      <Text as="span" color="muted" size="xs">
                        {team?.team.name ?? ""}
                      </Text>
                    </span>
                  </TableCell>
                  <TableCell wrap>
                    <span {...stylex.props(styles.where)}>
                      <Dot mark={markOf(each.state)} />
                      <span {...stylex.props(styles.stack)}>
                        <Text
                          as="span"
                          color={
                            each.state === "completed" ? "default" : "muted"
                          }
                          size="sm"
                        >
                          {each.out && each.state === "away"
                            ? "Not asked"
                            : linkWords[each.state]}
                        </Text>
                        {beside === "" ? null : (
                          <Text as="span" color="muted" size="xs">
                            {beside}
                          </Text>
                        )}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell style={styles.fromMd}>
                    <Text as="span" color="muted" size="sm">
                      {lastOf(view, each)}
                    </Text>
                  </TableCell>
                  <TableCell align="end" style={styles.fromLg}>
                    {interview?.minutes ?? "–"}
                  </TableCell>
                  <TableCell align="end" style={styles.fromLg}>
                    {interview === undefined
                      ? "–"
                      : `${interview.approved ? interview.facts - interview.out : 0} of ${interview.facts}`}
                  </TableCell>
                  <TableCell align="end">
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
      </CardContent>
      {shown.length === 0 ? <PanelNote>Nobody matches.</PanelNote> : null}
    </Panel>
  );
};

/** Before any interview: whom they wait on. */
export const noInterviewsYet = (view: OrgView): string =>
  view.told
    ? "No interviews yet. The team leads go first."
    : "No interviews yet. They start once the company has told its team.";
