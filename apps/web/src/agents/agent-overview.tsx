import type { Agent, AgentApp, AgentWake } from "@grasp-os/shared/agents";
import type { InstructionFileText } from "@grasp-os/shared/instruction-files";
import type { Member } from "@grasp-os/shared/members";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { formatZone } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { DayPills } from "../grasp/day-pills/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "../grasp/empty/index.ts";
import {
  Clock,
  Conversation,
  Done,
  Edit,
  Icon,
  Failed,
  Link as LinkIcon,
  More,
  Pause,
  Person,
  Play,
  Trash,
} from "../grasp/icons/index.ts";
import { Link } from "../grasp/link/index.ts";
import { Markdown } from "../grasp/markdown/index.ts";
import type { MarkdownDrawn, MarkdownLink } from "../grasp/markdown/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { Tag } from "../grasp/tag/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { foldOf, mentionOf, withMentions } from "./instructions-read.ts";
import type { Named } from "./instructions-read.ts";
import { weekOf } from "./schedule-read.ts";
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
  page: { display: "grid", gap: grasp.space6 },
  status: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    rowGap: grasp.space1,
  },
  state: {
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: grasp.space2,
  },
  stateWord: { color: grasp.ink, fontWeight: grasp.weightMedium },
  dot: {
    flexShrink: 0,
    alignSelf: "center",
    width: grasp.space2,
    height: grasp.space2,
    borderRadius: grasp.cornerCircle,
  },
  success: { backgroundColor: grasp.success },
  neutral: { backgroundColor: grasp.muted },
  danger: { backgroundColor: grasp.danger },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  schedules: { display: "grid", gap: grasp.space6 },
  schedule: { display: "grid", gap: grasp.space4 },
  // The time and its zone, its clock centred on the words, from the
  // first pill's edge.
  when: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  words: { display: "grid", gap: grasp.space3, justifyItems: "start" },
  date: {
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  ok: { color: grasp.success, display: "inline-flex" },
  failed: { color: grasp.danger, display: "inline-flex" },
  history: { display: "grid", gap: grasp.space2 },
  runs: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
  // A run's mark, its title and its date: the date keeps its line, and
  // the title gives way (DAMS-4: Item wraps a trailing date under the
  // title at phone width).
  run: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "center",
    columnGap: grasp.space3,
    paddingBlock: grasp.space3,
    borderBlockEndWidth: grasp.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: grasp.line,
  },
  runTitle: {
    minWidth: 0,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
  },
});

/** Why a wake-up didn't run, as core says it (agent-wakes.ts). */
type Outcome =
  | "started"
  | "agent.paused"
  | "agent.not_for_you"
  | "permission.person_inactive"
  | "model.no_provider"
  | "other";

const outcomeOf = (code: string): Outcome =>
  code === "started" ||
  code === "agent.paused" ||
  code === "agent.not_for_you" ||
  code === "permission.person_inactive" ||
  code === "model.no_provider"
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

/**
 * The run that makes the agent failing: the latest, when it didn't start
 * for a reason other than the agent being paused, while the agent is on.
 */
export const failingRun = (
  agent: Agent,
  wakes: readonly AgentWake[]
): Run | undefined => {
  const [latest] = runsOf(wakes.filter(({ state }) => state === "on"));
  return agent.state === "on" &&
    latest !== undefined &&
    latest.outcome !== "started" &&
    latest.outcome !== "agent.paused"
    ? latest
    : undefined;
};

/** Dates and times as this page writes them. */
const useDates = () => {
  const { i18n } = useLingui();
  const moment = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
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
  <Link
    render={
      <RouterLink
        params={{ agent: agentId }}
        search={{ tab }}
        to="/agents/$agent"
      />
    }
  >
    {children}
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
  const next = wakes
    .filter(({ state }) => state === "on")
    .flatMap(({ nextAt }) => (nextAt === null ? [] : [nextAt]))
    .toSorted()
    .at(0);
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
    detail = t`Last run ${when}`;
  } else if (agent.ownerId !== null) {
    detail = t`Just for you`;
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
      <DropdownMenuTrigger aria-label={t`More for ${name}`} icon={More} />
      <DropdownMenuContent align="end">
        {usable && agent.state === "on" ? (
          <DropdownMenuItem
            icon={Conversation}
            render={<RouterLink search={{ agent: agent.id }} to="/" />}
          >
            {t`Chat`}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={!can} icon={Edit} onSelect={onEdit}>
          {t`Edit`}
        </DropdownMenuItem>
        {first ? null : (
          <DropdownMenuItem
            disabled={!can}
            icon={Trash}
            onSelect={onDelete}
            variant="danger"
          >
            {t`Delete`}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** A chip for each app, person and mailbox the instructions name; any other link as Markdown draws it. */
const chip = ({
  href,
  scheme,
  children,
}: MarkdownLink): MarkdownDrawn | undefined => {
  const kind = mentionOf(href);
  if (kind !== undefined) {
    return <Tag icon={kind === "person" ? Person : LinkIcon}>{children}</Tag>;
  }
  return scheme === "mailto" ? (
    <Tag icon={LinkIcon}>{children}</Tag>
  ) : undefined;
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
      <SectionCard title={t`Instructions`}>
        <Empty place="top" size="sm">
          <EmptyHeader>
            <EmptyDescription>{t`Not shown`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SectionCard>
    );
  }
  if (text === "") {
    return (
      <SectionCard title={t`Instructions`}>
        <Empty place="top" size="sm">
          <EmptyHeader>
            <EmptyDescription>
              {t`Say in plain words what it should do, as to a new colleague.`}
            </EmptyDescription>
          </EmptyHeader>
          {editable ? (
            <EmptyContent>
              <Button
                render={
                  <RouterLink
                    params={{ agent: agent.id }}
                    search={{ tab: "instructions" }}
                    to="/agents/$agent"
                  />
                }
                size="sm"
              >
                {t`Write instructions`}
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
    : plural(blocks, {
        one: "Show all # paragraph",
        other: "Show all # paragraphs",
      });
  const shown = withMentions(whole ? text : folded, named);
  return (
    <SectionCard actions={edit} title={t`Instructions`}>
      <div {...stylex.props(styles.words)}>
        <Markdown renderLink={chip} source={shown} />
        {blocks > 2 ? (
          <Link
            render={
              <button
                aria-expanded={whole}
                aria-label={more}
                onClick={() => {
                  setWhole(!whole);
                }}
                type="button"
              />
            }
          >
            {more}
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
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const may = editable && !own;
  if (wakes.length === 0) {
    return (
      <SectionCard title={t`Schedule`}>
        <Empty place="top" size="sm">
          <EmptyHeader>
            <EmptyDescription>
              {own
                ? t`Runs only when you ask it to.`
                : t`Runs only when someone asks it to.`}
            </EmptyDescription>
          </EmptyHeader>
          {may ? (
            <EmptyContent>
              <Button
                render={
                  <RouterLink
                    params={{ agent: agent.id }}
                    search={{ tab: "schedule" }}
                    to="/agents/$agent"
                  />
                }
                size="sm"
              >
                {t`Add a schedule`}
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      </SectionCard>
    );
  }
  return (
    <SectionCard
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
          const week = weekOf(cron);
          const zone = formatZone(wake.timeZone);
          const at =
            week === undefined
              ? undefined
              : time.format(
                  new Date(Date.UTC(2024, 0, 1, week.hour, week.minute))
                );
          return (
            <div key={wake.id} {...stylex.props(styles.schedule)}>
              {week === undefined ? null : (
                <DayPills
                  days={weekdays.map((day, index) => ({
                    ...day,
                    on: week.days[index] === true,
                  }))}
                  label={t`Runs on`}
                  offLabel={t`off`}
                  onLabel={t`on`}
                  tone={
                    wake.state === "on" && agent.state === "on"
                      ? "on"
                      : "paused"
                  }
                />
              )}
              <span {...stylex.props(styles.when)}>
                <Icon icon={Clock} />
                {at === undefined ? t`${cron}, ${zone}` : t`${at}, ${zone}`}
              </span>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
};

/** What it ran: each schedule's last run, titled by how it went. */
const RunHistory = ({ wakes }: { wakes: readonly AgentWake[] }) => {
  const { t } = useLingui();
  const { moment } = useDates();
  const runs = runsOf(wakes);
  const next = wakes
    .filter(({ state }) => state === "on")
    .flatMap(({ nextAt }) => (nextAt === null ? [] : [nextAt]))
    .toSorted()
    .at(0);
  const titles: Record<Outcome, string> = {
    started: t`Ran on its schedule`,
    "agent.paused": t`Didn't run: the agent was paused`,
    "agent.not_for_you": t`Didn't run: it isn't set up to answer this person`,
    "permission.person_inactive": t`Didn't run: this person is no longer in the company`,
    "model.no_provider": t`Didn't run: no AI provider is connected`,
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
        <Empty place="top" size="sm">
          <EmptyHeader>
            <EmptyDescription>{empty}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul {...stylex.props(styles.runs)}>
          {runs.map(({ wake, at, outcome }) => (
            <li key={wake.id} {...stylex.props(styles.run)}>
              <span
                {...stylex.props(
                  outcome === "started" ? styles.ok : styles.failed
                )}
              >
                <Icon icon={outcome === "started" ? Done : Failed} />
              </span>
              <span {...stylex.props(styles.runTitle)}>{titles[outcome]}</span>
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
  const why: Record<Exclude<Outcome, "started" | "agent.paused">, string> = {
    "agent.not_for_you": t`It isn't set up to answer the person its schedule works for.`,
    "permission.person_inactive": t`The person its schedule works for is no longer in the company.`,
    "model.no_provider": t`No AI provider is connected.`,
    other: t`Something went wrong. It tries again at its next run.`,
  };
  const outcome =
    run.outcome === "started" || run.outcome === "agent.paused"
      ? "other"
      : run.outcome;
  let action: ReactNode;
  if (editable && outcome === "agent.not_for_you") {
    action = (
      <TabLink agentId={agent.id} tab="access">
        {t`Open access`}
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
      <Link render={<RouterLink to="/settings/ai-providers" />}>
        {t`Connect a provider`}
      </Link>
    );
  }
  return (
    <Alert title={t`It didn't run on ${when}`} tone="danger">
      {why[outcome]} {action}
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
    ...people.map(({ name }) => ({ name, kind: "person" as const })),
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
        size="lg"
        title={agent.name}
      />
      <div {...stylex.props(styles.actions)}>
        <Button
          disabled={!can}
          icon={on ? Pause : Play}
          onClick={() => {
            pause(on);
          }}
        >
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
      {own ? null : <RunHistory wakes={wakes} />}
      {children}
    </div>
  );
};
