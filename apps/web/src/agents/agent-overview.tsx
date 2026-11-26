import type { Agent, AgentApp, AgentWake } from "@grasp-os/shared/agents";
import type { InstructionFileText } from "@grasp-os/shared/instruction-files";
import type { Member } from "@grasp-os/shared/members";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import { Link } from "@grasp-os/ui/components/link";
import { Markdown } from "@grasp-os/ui/components/markdown";
import type { MarkdownLink } from "@grasp-os/ui/components/markdown";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleUserIcon,
  ClockIcon,
  EllipsisIcon,
  Icon,
  LinkIcon,
  MessageSquareIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { formatZone } from "../format.ts";
import { nextWakeAt, wakesOn } from "./agent-facts.tsx";
import { DayPills } from "./day-pills.tsx";
import { foldOf, mentionOf, withMentions } from "./instructions-read.ts";
import type { Named } from "./instructions-read.ts";
import { weekOf } from "./schedule-read.ts";
import { SectionCard } from "./section-card.tsx";
import type { AgentTab } from "./tabs.tsx";

// An agent's overview (Ruben's pick of 23 November, "Agent A · Glass"):
// one column, its name, one line on how it stands, its buttons, then what
// it is told, when it runs and what it ran. Everything is read from what
// core keeps (connections.agents, agentWakes, agentApps, the instruction
// file): the parts core doesn't keep yet (Run now, the channel a schedule
// posts in, a run's outcome in words, every run beyond each schedule's
// last) are left out until it does (handoffs/core-needs.md). The other
// tabs (Instructions, Access, Schedule) keep their editors; the cards'
// links lead there.

const styles = stylex.create({
  page: { display: "grid", gap: space["6"] },
  status: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    columnGap: space["4"],
    rowGap: space["1"],
  },
  state: {
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space["2"],
  },
  stateWord: { color: colors.foreground, fontWeight: font.weightMedium },
  dot: {
    flexShrink: 0,
    alignSelf: "center",
    width: space["2"],
    height: space["2"],
    borderRadius: radius.circle,
  },
  success: { backgroundColor: colors.success },
  neutral: { backgroundColor: colors.mutedForeground },
  danger: { backgroundColor: colors.destructive },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  schedules: { display: "grid", gap: space["6"] },
  schedule: { display: "grid", gap: space["4"] },
  // The time and its zone, its clock centred on the words, from the
  // first pill's edge.
  when: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  words: { display: "grid", gap: space["3"], justifyItems: "start" },
  date: {
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  ok: { color: colors.success, display: "inline-flex" },
  failed: { color: colors.destructive, display: "inline-flex" },
  // Didn't run, for nothing wrong with the agent: paused, or busy.
  quiet: { color: colors.mutedForeground, display: "inline-flex" },
  history: { display: "grid", gap: space["2"] },
  runs: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
  // A run's mark, its title and its date: the date keeps its line, and
  // the title gives way (DAMS-4: Item wraps a trailing date under the
  // title at phone width).
  run: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: space["3"],
    paddingBlock: space["3"],
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  runWords: { display: "grid", minWidth: 0 },
  // Which schedule ran, when there are several: what it is asked, on one line.
  runOpening: {
    overflow: "hidden",
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  runTitle: {
    minWidth: 0,
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
  },
});

/** Why a wake-up didn't run, as core says it (agent-wakes.ts). */
type Outcome =
  | "started"
  | "agent.paused"
  | "agent.not_for_you"
  | "permission.person_inactive"
  | "model.no_provider"
  | "agent.busy"
  | "other";

const outcomeOf = (code: string): Outcome =>
  code === "started" ||
  code === "agent.paused" ||
  code === "agent.not_for_you" ||
  code === "permission.person_inactive" ||
  code === "model.no_provider" ||
  code === "agent.busy"
    ? code
    : "other";

/** A run core keeps: each wake-up's last, with how it went. */
interface Run {
  wake: AgentWake;
  at: string;
  outcome: Outcome;
}

/** Each wake-up's last run, the latest first. */
export const runsOf = (wakes: readonly AgentWake[]): Run[] =>
  wakes
    .flatMap((wake) =>
      wake.lastAt === null || wake.lastOutcome === null
        ? []
        : [{ wake, at: wake.lastAt, outcome: outcomeOf(wake.lastOutcome) }]
    )
    .toSorted((a, b) => b.at.localeCompare(a.at));

/** How a run's row marks how it went: ran, didn't for a harmless reason, or failed. */
const markOf = {
  started: { icon: CircleCheckIcon, look: styles.ok },
  "agent.paused": { icon: PauseIcon, look: styles.quiet },
  "agent.busy": { icon: ClockIcon, look: styles.quiet },
  "agent.not_for_you": { icon: CircleAlertIcon, look: styles.failed },
  "permission.person_inactive": { icon: CircleAlertIcon, look: styles.failed },
  "model.no_provider": { icon: CircleAlertIcon, look: styles.failed },
  other: { icon: CircleAlertIcon, look: styles.failed },
} as const;

/** Outcomes that say nothing is wrong with the agent: it ran, was paused, or was still busy. */
const fine = new Set<Outcome>(["started", "agent.paused", "agent.busy"]);

/**
 * The run that makes the agent failing, while it is on: the latest of its
 * schedules' last runs that didn't start for a reason of its own. One
 * schedule that ran since doesn't hide another that failed.
 */
export const failingRun = (
  agent: Agent,
  wakes: readonly AgentWake[]
): Run | undefined =>
  agent.state === "on"
    ? runsOf(wakes.filter(({ state }) => state === "on")).find(
        ({ outcome }) => !fine.has(outcome)
      )
    : undefined;

/** Dates and times as this page writes them. */
const useDates = () => {
  const { i18n } = useLingui();
  const moment = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const day = new Intl.DateTimeFormat(i18n.locale, {
    day: "numeric",
    month: "short",
  });
  return {
    moment: (iso: string): string => moment.format(new Date(iso)),
    day: (iso: string): string => day.format(new Date(iso)),
  };
};

/** The address of one of the agent's tabs. */
const TabLink = ({
  agentId,
  tab,
  children,
}: {
  agentId: string;
  tab: AgentTab;
  children: string;
}) => (
  <Link asChild>
    <RouterLink
      params={{ agent: agentId }}
      search={{ tab }}
      to="/agents/$agent"
    >
      {children}
    </RouterLink>
  </Link>
);

/** How the agent stands, on the left; who last changed it and when, on the right. */
const StatusLine = ({
  agent,
  wakes,
  failing,
  people,
  userId,
}: {
  agent: Agent;
  wakes: readonly AgentWake[];
  failing: Run | undefined;
  people: readonly Member[];
  userId: string;
}) => {
  const { t } = useLingui();
  const { moment, day } = useDates();
  const next = nextWakeAt(wakes);
  const ran = wakes.some(({ lastAt }) => lastAt !== null);
  let tone: "success" | "neutral" | "danger" = "success";
  let word = t`On`;
  let detail: string | undefined;
  if (agent.state === "paused") {
    tone = "neutral";
    word = t`Paused`;
  } else if (failing !== undefined) {
    const when = moment(failing.at);
    tone = "danger";
    word = t`Failing`;
    detail = t`Didn't run ${when}`;
  } else if (agent.ownerId !== null) {
    detail = t`Just for you`;
  } else if (wakes.length > 0 && wakesOn(wakes).length === 0) {
    detail = t`Its schedule is paused`;
  } else if (next === undefined) {
    detail = t`Runs when asked`;
  } else {
    const when = moment(next);
    detail = ran ? t`Next run ${when}` : t`First run ${when}`;
  }
  const changedAt = agent.changedAt === null ? undefined : day(agent.changedAt);
  const changedBy = people.find(
    ({ userId: id }) => id === agent.changedBy
  )?.name;
  let changed: string | undefined;
  if (changedAt === undefined) {
    changed = undefined;
  } else if (agent.changedBy === userId) {
    changed = t`Last updated by you · ${changedAt}`;
  } else if (changedBy === undefined) {
    changed = t`Last updated ${changedAt}`;
  } else {
    changed = t`Last updated by ${changedBy} · ${changedAt}`;
  }
  return (
    <span {...stylex.props(styles.status)}>
      <span {...stylex.props(styles.state)}>
        <span aria-hidden="true" {...stylex.props(styles.dot, styles[tone])} />
        <span {...stylex.props(styles.stateWord)}>{word}</span>
        {detail === undefined ? null : <span>· {detail}</span>}
      </span>
      {changed === undefined ? null : <span>{changed}</span>}
    </span>
  );
};

/** The `…` menu: what is done less often than pausing it. */
const MoreMenu = ({
  agent,
  first,
  can,
  usable,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  first: boolean;
  can: boolean;
  usable: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const { t } = useLingui();
  const { name } = agent;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={t`More for ${name}`} size="icon" variant="outline">
          <Icon icon={EllipsisIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {usable && agent.state === "on" ? (
          <DropdownMenuItem asChild icon={MessageSquareIcon}>
            <RouterLink search={{ agent: agent.id }} to="/">
              {t`Chat`}
            </RouterLink>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={!can} icon={PencilIcon} onSelect={onEdit}>
          {t`Edit`}
        </DropdownMenuItem>
        {first ? null : (
          <DropdownMenuItem
            disabled={!can}
            icon={TrashIcon}
            onSelect={onDelete}
            variant="destructive"
          >
            {t`Delete`}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * A chip for each app, person and mailbox the instructions name; any other
 * link is its words alone, never one to follow (a path in Grasp, a phone
 * number, a site), as the instructions are what the agent reads, not a page.
 */
const chip = ({ href, scheme, children }: MarkdownLink): ReactNode => {
  const kind = mentionOf(href);
  if (kind !== undefined) {
    return (
      <Badge
        icon={kind === "person" ? CircleUserIcon : LinkIcon}
        variant="secondary"
      >
        {children}
      </Badge>
    );
  }
  return scheme === "mailto" ? (
    <Badge icon={LinkIcon} variant="secondary">
      {children}
    </Badge>
  ) : (
    <span>{children}</span>
  );
};

/** What the agent is told, in plain words, each app and person it names a chip. */
const Instructions = ({
  agent,
  saved,
  named,
  editable,
}: {
  agent: Agent;
  saved: InstructionFileText | null | undefined;
  named: readonly Named[];
  editable: boolean;
}) => {
  const { t } = useLingui();
  const [whole, setWhole] = useState(false);
  const text = saved?.text.trim() ?? "";
  const edit = editable ? (
    <TabLink agentId={agent.id} tab="instructions">
      {t`Edit instructions`}
    </TabLink>
  ) : undefined;
  if (saved === undefined) {
    return (
      <SectionCard boxed title={t`Instructions`}>
        <Empty align="start" size="sm">
          <EmptyHeader>
            <EmptyDescription>{t`Not shown`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SectionCard>
    );
  }
  if (text === "") {
    return (
      <SectionCard boxed title={t`Instructions`}>
        <Empty align="start" size="sm">
          <EmptyHeader>
            <EmptyDescription>
              {t`Say in plain words what it should do, as to a new colleague.`}
            </EmptyDescription>
          </EmptyHeader>
          {editable ? (
            <EmptyContent>
              <Button asChild size="sm" variant="outline">
                <RouterLink
                  params={{ agent: agent.id }}
                  search={{ tab: "instructions" }}
                  to="/agents/$agent"
                >
                  {t`Write instructions`}
                </RouterLink>
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </SectionCard>
    );
  }
  const { blocks, folded } = foldOf(text, 2);
  const more = whole
    ? t`Show less`
    : t`${plural(blocks, {
        one: "Show all # paragraph",
        other: "Show all # paragraphs",
      })}`;
  const shown = withMentions(whole ? text : folded, named);
  return (
    <SectionCard actions={edit} boxed title={t`Instructions`}>
      <div {...stylex.props(styles.words)}>
        <Markdown renderLink={chip}>{shown}</Markdown>
        {blocks > 2 ? (
          <Link asChild>
            <button
              aria-expanded={whole}
              aria-label={more}
              onClick={() => {
                setWhole(!whole);
              }}
              type="button"
            >
              {more}
            </button>
          </Link>
        ) : null}
      </div>
    </SectionCard>
  );
};

/** The week's days, Monday first: the letter each is drawn with and its whole name. */
const useWeekdays = () => {
  const { i18n } = useLingui();
  const letter = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "narrow",
    timeZone: "UTC",
  });
  const name = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    timeZone: "UTC",
  });
  // 1 January 2024 was a Monday.
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(2024, 0, 1 + index));
    return { letter: letter.format(date), name: name.format(date) };
  });
};

/** When the agent runs on its own: a row of days and the time, per wake-up. */
const Schedule = ({
  agent,
  wakes,
  editable,
}: {
  agent: Agent;
  wakes: readonly AgentWake[];
  editable: boolean;
}) => {
  const { t, i18n } = useLingui();
  const weekdays = useWeekdays();
  const own = agent.ownerId !== null;
  const time = new Intl.DateTimeFormat(i18n.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const may = editable && !own;
  if (wakes.length === 0) {
    return (
      <SectionCard boxed title={t`Schedule`}>
        <Empty align="start" size="sm">
          <EmptyHeader>
            <EmptyDescription>
              {own
                ? t`Runs only when you ask it to.`
                : t`Runs only when someone asks it to.`}
            </EmptyDescription>
          </EmptyHeader>
          {may ? (
            <EmptyContent>
              <Button asChild size="sm" variant="outline">
                <RouterLink
                  params={{ agent: agent.id }}
                  search={{ tab: "schedule" }}
                  to="/agents/$agent"
                >
                  {t`Add a schedule`}
                </RouterLink>
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </SectionCard>
    );
  }
  return (
    <SectionCard
      boxed
      actions={
        may ? (
          <TabLink agentId={agent.id} tab="schedule">
            {t`Edit schedule`}
          </TabLink>
        ) : undefined
      }
      title={t`Schedule`}
    >
      <div {...stylex.props(styles.schedules)}>
        {wakes.map((wake) => {
          const { cron } = wake;
          const paused = wake.state !== "on" || agent.state !== "on";
          const week = weekOf(cron);
          const zone = formatZone(wake.timeZone);
          const at =
            week === undefined
              ? undefined
              : time.format(
                  new Date(Date.UTC(2024, 0, 1, week.hour, week.minute))
                );
          const runsAt = at ?? cron;
          const when = paused
            ? t`${runsAt}, ${zone}, paused`
            : t`${runsAt}, ${zone}`;
          return (
            <div key={wake.id} {...stylex.props(styles.schedule)}>
              {week === undefined ? null : (
                <DayPills
                  days={weekdays.map(({ letter, name }, index) => {
                    const on = week.days[index] === true;
                    let said = t`${name}: doesn't run`;
                    if (on) {
                      said = paused ? t`${name}: paused` : t`${name}: runs`;
                    }
                    return { letter, name: said, on };
                  })}
                  label={t`Days it runs`}
                  tone={paused ? "paused" : "on"}
                />
              )}
              <span {...stylex.props(styles.when)}>
                <Icon icon={ClockIcon} />
                {when}
              </span>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
};

/** What it ran: each schedule's last run, titled by how it went. */
const RunHistory = ({
  agent,
  wakes,
}: {
  agent: Agent;
  wakes: readonly AgentWake[];
}) => {
  const { t } = useLingui();
  const { moment } = useDates();
  const runs = runsOf(wakes);
  // A paused agent keeps its schedules' times, but runs at none of them.
  const next = agent.state === "on" ? nextWakeAt(wakes) : undefined;
  const titles: Record<Outcome, string> = {
    started: t`Ran on its schedule`,
    "agent.paused": t`Didn't run: the agent was paused`,
    "agent.not_for_you": t`Didn't run: it isn't set up for the person it works for`,
    "permission.person_inactive": t`Didn't run: this person is no longer in the company`,
    "model.no_provider": t`Didn't run: no AI provider is connected`,
    "agent.busy": t`Didn't run: it was still busy`,
    other: t`Didn't run: something went wrong`,
  };
  let empty = t`No runs yet.`;
  if (next !== undefined) {
    const when = moment(next);
    empty = t`No runs yet; the first is ${when}.`;
  }
  return (
    <section {...stylex.props(styles.history)}>
      <SectionHeader title={t`Run history`} variant="group" />
      {runs.length === 0 ? (
        <Empty align="start" size="sm">
          <EmptyHeader>
            <EmptyDescription>{empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul {...stylex.props(styles.runs)}>
          {runs.map(({ wake, at, outcome }) => (
            <li key={wake.id} {...stylex.props(styles.run)}>
              <span {...stylex.props(markOf[outcome].look)}>
                <Icon icon={markOf[outcome].icon} />
              </span>
              <span {...stylex.props(styles.runWords)}>
                <span {...stylex.props(styles.runTitle)}>
                  {titles[outcome]}
                </span>
                {runs.length > 1 ? (
                  <span {...stylex.props(styles.runOpening)}>
                    {wake.opening}
                  </span>
                ) : null}
              </span>
              <span {...stylex.props(styles.date)}>{moment(at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** Why it is failing, and the next step where there is one. */
const FailingAlert = ({
  agent,
  run,
  editable,
}: {
  agent: Agent;
  run: Run;
  editable: boolean;
}) => {
  const { t } = useLingui();
  const { moment } = useDates();
  const when = moment(run.at);
  const why: Record<
    Exclude<Outcome, "started" | "agent.paused" | "agent.busy">,
    string
  > = {
    "agent.not_for_you": t`It isn't set up to answer the person its schedule works for.`,
    "permission.person_inactive": t`The person its schedule works for is no longer in the company.`,
    "model.no_provider": t`No AI provider is connected.`,
    other: t`Something went wrong. It tries again at its next run.`,
  };
  const outcome =
    run.outcome === "started" ||
    run.outcome === "agent.paused" ||
    run.outcome === "agent.busy"
      ? "other"
      : run.outcome;
  let action: ReactNode;
  if (editable && outcome === "agent.not_for_you") {
    action = (
      <TabLink agentId={agent.id} tab="access">
        {t`Edit access`}
      </TabLink>
    );
  } else if (editable && outcome === "permission.person_inactive") {
    action = (
      <TabLink agentId={agent.id} tab="schedule">
        {t`Edit schedule`}
      </TabLink>
    );
  } else if (editable && outcome === "model.no_provider") {
    action = (
      <Link asChild>
        <RouterLink to="/settings/ai-providers">{t`Connect a provider`}</RouterLink>
      </Link>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTitle>{t`It didn't run on ${when}`}</AlertTitle>
      <AlertDescription>
        {why[outcome]} {action}
      </AlertDescription>
    </Alert>
  );
};

/** The overview: Ruben's Agent A. */
export const AgentOverview = ({
  agent,
  first,
  wakes,
  instructions,
  apps,
  people,
  userId,
  editable,
  usable,
  can,
  pause,
  onEdit,
  onDelete,
  children,
}: {
  agent: Agent;
  first: boolean;
  wakes: readonly AgentWake[];
  instructions: InstructionFileText | null | undefined;
  /** The apps it has; undefined where core didn't say. */
  apps: readonly AgentApp[] | undefined;
  people: readonly Member[];
  /** Who reads the page, so a change of theirs says "you". */
  userId: string;
  editable: boolean;
  usable: boolean;
  can: boolean;
  pause: (paused: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  /** What follows the run history: a person's own agent's offer to the company. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const own = agent.ownerId !== null;
  const failing = failingRun(agent, wakes);
  const on = agent.state === "on";
  const named: Named[] = [
    ...(apps ?? [])
      .filter(({ state }) => state === "on")
      .map(({ name }) => ({ name, kind: "app" as const })),
    // A person by their whole name only: one word alone ("May") is too often an ordinary word.
    ...people
      .filter(({ name }) => name.trim().includes(" "))
      .map(({ name }) => ({ name, kind: "person" as const })),
  ];
  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader
        description={
          <StatusLine
            agent={agent}
            failing={failing}
            people={people}
            userId={userId}
            wakes={wakes}
          />
        }
        title={agent.name}
      />
      <div {...stylex.props(styles.actions)}>
        <Button
          disabled={!can}
          onClick={() => {
            pause(on);
          }}
          variant="outline"
        >
          <Icon icon={on ? PauseIcon : PlayIcon} />
          {on ? t`Pause` : t`Resume`}
        </Button>
        <MoreMenu
          agent={agent}
          can={can}
          first={first}
          onDelete={onDelete}
          onEdit={onEdit}
          usable={usable}
        />
      </div>
      {failing === undefined ? null : (
        <FailingAlert agent={agent} editable={editable} run={failing} />
      )}
      <Instructions
        agent={agent}
        editable={editable}
        named={named}
        saved={instructions}
      />
      <Schedule agent={agent} editable={editable} wakes={wakes} />
      {own ? null : <RunHistory agent={agent} wakes={wakes} />}
      {children}
    </div>
  );
};
