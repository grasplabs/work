/**
 * The admin's Home, composed as Grasp Work composes a page: four figures
 * that say how Grasp is doing, what needs Grasp as rows that open where
 * each is settled, where every organization is on its way to working in
 * Grasp, every organization in one table (cards below 84rem, as the
 * product's Workflows), and the runs every organization made. Drawn from
 * each organization's summary alone (counts and dates, which no core
 * audits) and what Grasp's AI cost on its keys: no person, nothing anyone
 * wrote, and no organization's snapshot read.
 */
import { fewPeople } from "@grasp-os/shared/admin-summary";
import type { AdminSummary } from "@grasp-os/shared/admin-summary";
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  ChartBar,
  ChartBarList,
  ChartContainer,
  ChartGrid,
  ChartLegend,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from "@grasp-os/ui/components/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Progress } from "@grasp-os/ui/components/progress";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { CircleCheckIcon, Icon, PlusIcon } from "@grasp-os/ui/lib/icons";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { Suspense } from "react";
import type { ReactElement, ReactNode } from "react";

import type { ClientSummary } from "../clients/summary.ts";
import { needCount, summaryNeedsOf } from "./needs.ts";
import type { OrgNeed } from "./needs.ts";
import { microsPerDollar } from "./platform-spend-sums.ts";
import type {
  OrganizationSpend,
  PlatformSpend,
} from "./platform-spend-sums.ts";
import { rowTarget } from "./row-target.ts";
import { sectionTo } from "./sections.ts";
import { useSettled } from "./settled.tsx";
import type { Deferred } from "./settled.tsx";
import {
  phaseOf,
  phases,
  standingOf,
  standingTones,
  standingWords,
  whereWords,
} from "./standing.ts";
import type { Phase, Standing } from "./standing.ts";
import { formatDay, plural } from "./words.ts";

const STACKED = "@media (width < 84rem)";
const WIDE = "@media (width >= 64rem)";

const styles = stylex.create({
  table: { display: { default: "block", [STACKED]: "none" } },
  cards: { display: { default: "none", [STACKED]: "block" } },
  // What needs Grasp beside where everyone is, on a wide window.
  pair: {
    display: "grid",
    gap: space["6"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDE]: "minmax(0, 3fr) minmax(0, 2fr)",
    },
    alignItems: "start",
  },
  part: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    minWidth: 0,
  },
  cell: { display: "grid", justifyItems: "start", rowGap: space["1"] },
  quiet: {
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  failed: { color: colors.destructive },
  meter: { display: "grid", gap: space["1"], minWidth: "7rem" },
  card: {
    display: "grid",
    justifyItems: "start",
    rowGap: space["2"],
    marginBlockStart: space["1"],
  },
  facts: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space["4"],
    rowGap: space["1"],
    color: colors.foreground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  label: { color: colors.mutedForeground },
  clamp: {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
  },
});

/** At most this many of what needs Grasp on Home: the rest is in the sidebar's Inbox. */
const needsShown = 6;

/** From this share of its limit on, an organization's AI use is near it. */
const nearShare = 0.8;

/** The days of runs the table counts, today's included. */
const weekDays = 7;

/** What Grasp's AI cost, once read: each organization's, or null when it couldn't be. */
type Spend = PlatformSpend | null;

/** What Grasp's AI cost as Home's loader has it: undefined while it isn't asked yet (a preload). */
type SpendRead = Deferred<Spend> | undefined;

/** One organization as Home says it. */
interface Row {
  entry: ClientSummary;
  id: string;
  name: string;
  standing: Standing;
  /** Its summary, while its core answers one. */
  summary: AdminSummary | null;
  needs: OrgNeed[];
}

/** Dollars, whole: what a month of AI cost, said at a glance. */
const wholeDollars = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const dollarsOf = (micros: number): string =>
  wholeDollars.format(micros / microsPerDollar);

const rowOf = (entry: ClientSummary): Row => ({
  entry,
  id: entry.client.id,
  name: entry.client.name,
  standing: standingOf(entry),
  summary: entry.state === "answered" ? entry.summary : null,
  needs: summaryNeedsOf(entry),
});

/** Organization `row`'s AI spend, as its core reported it, if it did. */
const spendOf = (
  spend: PlatformSpend,
  row: Row
): OrganizationSpend | undefined =>
  spend.byOrganization.find(({ clientId }) => clientId === row.id);

/** What spend shows until it is read: words for a cell, a figure's own skeleton. */
const Reading = () => <span {...stylex.props(styles.quiet)}>Reading…</span>;

const SpendSettled = ({
  spend,
  children,
}: {
  spend: Deferred<Spend>;
  children: (spend: Spend) => ReactElement | string;
}) => children(useSettled(spend));

/**
 * What Grasp's AI cost, in its own place once read: every core is asked,
 * so the rest of Home never waits on it. `fallback` until then.
 */
const WithSpend = ({
  spend,
  fallback,
  children,
}: {
  spend: SpendRead;
  fallback: ReactElement | string;
  children: (spend: Spend) => ReactElement | string;
}) =>
  spend === undefined ? (
    fallback
  ) : (
    <Suspense fallback={fallback}>
      <SpendSettled spend={spend}>{children}</SpendSettled>
    </Suspense>
  );

/** The order the table lists them in: what goes wrong or waits on Grasp first, live last. */
const order: Readonly<Record<Standing, number>> = {
  at_risk: 0,
  unreachable: 1,
  waiting: 2,
  older: 3,
  interviews: 4,
  setting_up: 5,
  not_deployed: 6,
  live: 7,
};

/** Its runs of the last seven days; null when its summary doesn't share them. */
const weekOf = (
  summary: AdminSummary | null
): { done: number; failed: number } | null => {
  if (summary?.activity === null || summary?.activity === undefined) {
    return null;
  }
  const week = summary.activity.runs.slice(-weekDays);
  return {
    done: week.reduce((sum, day) => sum + day.done, 0),
    failed: week.reduce((sum, day) => sum + day.failed, 0),
  };
};

/** Why a figure of a row isn't there, in words: never a bare dash. */
const missingWords = (row: Row): string => {
  switch (row.entry.state) {
    case "older": {
      return "Update to see";
    }
    case "not_deployed": {
      return "Not set up yet";
    }
    case "unreachable": {
      return "Not read now";
    }
    case "answered": {
      // Its summary is in, without how it uses Grasp: it ended Grasp's staff access.
      return "Not shared";
    }
    default: {
      return row.entry satisfies never;
    }
  }
};

/** Its AI on Grasp's key at or past `nearShare` of its limit. */
const nearLimit = (spend: OrganizationSpend | undefined): boolean =>
  spend?.graspAi !== null &&
  spend?.graspAi !== undefined &&
  spend.graspAi.limit > 0 &&
  spend.graspAi.spent >= spend.graspAi.limit * nearShare;

/** "+12% on last month", or how it compares when last month was nothing. */
const changeWords = (now: number, before: number): string => {
  if (before === 0) {
    return now === 0 ? "Nothing this month or last" : "Nothing last month";
  }
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) {
    return "As much as last month";
  }
  return `${change > 0 ? "+" : "−"}${Math.abs(change)}% on last month`;
};

/** Grasp's AI this month against last, and how many organizations are near their limit. */
const AiFigure = ({ rows, spend }: { rows: Row[]; spend: Spend }) => {
  if (spend === null) {
    return (
      <Stat
        change="Its cores couldn’t be read now"
        label="Grasp AI this month"
        value="Not read"
      />
    );
  }
  const near = rows.filter((row) => nearLimit(spendOf(spend, row))).length;
  return (
    <Stat
      change={[
        changeWords(spend.thisMonth.micros, spend.lastMonth.micros),
        near > 0 ? `${near} near ${plural(near, "its", "their")} limit` : null,
      ]
        .filter((part) => part !== null)
        .join(" · ")}
      label="Grasp AI this month"
      value={dollarsOf(spend.thisMonth.micros)}
      {...(near > 0 ? { variant: "warning" as const } : {})}
    />
  );
};

const Figures = ({ rows, spend }: { rows: Row[]; spend: SpendRead }) => {
  const live = rows.filter(({ standing }) => standing === "live").length;
  const onboarding = rows.filter(
    ({ summary }) => summary !== null && phaseOf(summary.onboarding) !== "live"
  );
  const risky = onboarding.filter(
    ({ standing }) => standing === "at_risk"
  ).length;
  const needing = rows.filter(({ needs }) => needs.length > 0);
  const needs = needing.reduce((sum, row) => sum + needCount(row.needs), 0);
  return (
    <StatGroup aria-label="How Grasp is doing" columns={4}>
      <Stat
        change={`of ${rows.length} ${plural(rows.length, "organization", "organizations")}`}
        label="Live"
        value={String(live)}
      />
      <Stat
        change={risky === 0 ? "None at risk" : `${risky} at risk`}
        label="Onboarding"
        value={String(onboarding.length)}
        {...(risky > 0 ? { variant: "destructive" as const } : {})}
      />
      <Stat
        change={
          needing.length === 0
            ? "Nothing waits on Grasp"
            : `at ${needing.length} ${plural(needing.length, "organization", "organizations")}`
        }
        label="Needs Grasp"
        value={String(needs)}
        {...(needs > 0 ? { variant: "warning" as const } : {})}
      />
      <WithSpend
        fallback={<Stat label="Grasp AI this month" loading value="" />}
        spend={spend}
      >
        {(read) => <AiFigure rows={rows} spend={read} />}
      </WithSpend>
    </StatGroup>
  );
};

/** A need's line, with how many of it where there are more than one. */
const needText = ({ text, count }: OrgNeed): string =>
  count > 1 ? `${text} (${count})` : text;

const NeedsGrasp = ({ rows }: { rows: Row[] }) => {
  // Each organization's most pressing first, then each one's next, in turn,
  // so the first few can't fill the list before the rest are heard.
  const deepest = Math.max(0, ...rows.map(({ needs }) => needs.length));
  const all = Array.from({ length: deepest }, (_, rank) =>
    rows.flatMap((row) => {
      const need = row.needs[rank];
      return need === undefined ? [] : [{ row, need }];
    })
  ).flat();
  const more = all.length - needsShown;
  return (
    <section {...stylex.props(styles.part)}>
      <SectionHeader
        headingLevel={2}
        size="sm"
        title="Needs Grasp"
        variant="group"
      />
      {all.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia icon={CircleCheckIcon} />
            <EmptyTitle>Nothing needs Grasp now</EmptyTitle>
            <EmptyDescription>
              What waits on Grasp at an organization shows here, and in the
              sidebar’s Inbox.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-label="Needs Grasp" separated>
          {all.slice(0, needsShown).map(({ row, need }, at) => (
            // The same line can stand twice at one older core, for two teams.
            <Item asChild key={`${row.id}-${String(at)}`} size="sm">
              <Link
                params={{ clientId: row.id }}
                search={need.search}
                to={sectionTo[need.section]}
              >
                <ItemContent>
                  <ItemTitle>{needText(need)}</ItemTitle>
                  <ItemDescription>{row.name}</ItemDescription>
                </ItemContent>
              </Link>
            </Item>
          ))}
        </ItemGroup>
      )}
      {more > 0 ? (
        <span {...stylex.props(styles.quiet)}>
          {`${more} more in the sidebar’s Inbox.`}
        </span>
      ) : null}
    </section>
  );
};

const phaseWords: Readonly<Record<Phase, string>> = {
  setting_up: standingWords.setting_up,
  interviews: standingWords.interviews,
  waiting: standingWords.waiting,
  live: standingWords.live,
};

const Funnel = ({ rows }: { rows: Row[] }) => {
  const read = rows.flatMap(({ summary }) =>
    summary === null ? [] : [phaseOf(summary.onboarding)]
  );
  const data = phases.map((phase) => ({
    phase: phaseWords[phase],
    organizations: read.filter((each) => each === phase).length,
  }));
  const unread = rows.length - read.length;
  return (
    <section {...stylex.props(styles.part)}>
      <SectionHeader
        headingLevel={2}
        size="sm"
        title="Where everyone is"
        variant="group"
      />
      <ChartBarList
        aria-label="Organizations by where they are"
        config={{ organizations: { label: "Organizations" } }}
        data={data}
        nameKey="phase"
        pattern="dither-dots"
        sortOrder="none"
        summary={`${read.length} ${plural(read.length, "organization", "organizations")}, from setting up to live.`}
      />
      {unread > 0 ? (
        <span {...stylex.props(styles.quiet)}>
          {`${unread} more ${plural(unread, "isn’t", "aren’t")} counted here: not set up, not answering or on an older release.`}
        </span>
      ) : null}
    </section>
  );
};

/** Every organization's runs, day by day, the last 30 days: those that share them. */
const runsByDay = (rows: readonly Row[]) => {
  const days = new Map<string, { day: string; done: number; failed: number }>();
  for (const { summary } of rows) {
    for (const { day, done, failed } of summary?.activity?.runs ?? []) {
      const at = days.get(day) ?? { day, done: 0, failed: 0 };
      days.set(day, { day, done: at.done + done, failed: at.failed + failed });
    }
  }
  return [...days.values()]
    .toSorted((one, other) => one.day.localeCompare(other.day))
    .map((each) => ({ ...each, day: formatDay(each.day) }));
};

const Runs = ({ rows }: { rows: Row[] }) => {
  const data = runsByDay(rows);
  const done = data.reduce((sum, day) => sum + day.done, 0);
  const failed = data.reduce((sum, day) => sum + day.failed, 0);
  const share =
    done + failed === 0
      ? 0
      : Math.round((failed / (done + failed)) * 1000) / 10;
  return (
    <section {...stylex.props(styles.part)}>
      <SectionHeader
        description={
          done + failed === 0
            ? "No workflow ran at any organization in the last 30 days."
            : `${done} done and ${failed} failed (${share}%) in the last 30 days, at every organization that shares its runs.`
        }
        headingLevel={2}
        size="sm"
        title="Workflow runs"
        variant="group"
      />
      {done + failed === 0 ? null : (
        <ChartContainer
          aria-label="Workflow runs per day"
          config={{ done: { label: "Done" }, failed: { label: "Failed" } }}
          data={data}
          height={220}
          summary={`${done} runs done and ${failed} failed over the last 30 days.`}
          xKey="day"
        >
          <ChartGrid />
          <ChartXAxis />
          <ChartYAxis />
          <ChartBar dataKey="done" pattern="dither-pixels" />
          <ChartBar dataKey="failed" />
          <ChartTooltip />
          <ChartLegend />
        </ChartContainer>
      )}
    </section>
  );
};

/** Why its summary isn't read, under how it stands. */
const unreadLines: Readonly<
  Record<Exclude<ClientSummary["state"], "answered">, string>
> = {
  older: "Its release is older",
  not_deployed: "Not deployed yet",
  unreachable: "Its core didn’t answer",
};

/** How it stands: a toned dot and its word, over where it is within it. */
const State = ({ row }: { row: Row }) => (
  <span {...stylex.props(styles.cell)}>
    <Badge dot variant={standingTones[row.standing]}>
      {standingWords[row.standing]}
    </Badge>
    <span {...stylex.props(styles.quiet)}>
      {row.entry.state === "answered"
        ? whereWords(row.entry.summary)
        : unreadLines[row.entry.state]}
    </span>
  </span>
);

/**
 * How far it has come: how much Grasp knows against what it opens at
 * while it onboards; once live, what runs there.
 */
const Progressed = ({ row }: { row: Row }) => {
  const { summary } = row;
  if (summary === null) {
    return <span {...stylex.props(styles.quiet)}>{missingWords(row)}</span>;
  }
  const { known, threshold } = summary.onboarding;
  if (phaseOf(summary.onboarding) !== "live") {
    return (
      <span {...stylex.props(styles.meter)}>
        <Progress
          aria-label={`${row.name}: ${known}% known, opens at ${threshold}%`}
          value={known}
          variant={row.standing === "at_risk" ? "destructive" : "default"}
        />
        <span
          {...stylex.props(styles.quiet)}
        >{`${known}% of ${threshold}% known`}</span>
      </span>
    );
  }
  const { activity } = summary;
  if (activity === null) {
    return <span {...stylex.props(styles.quiet)}>{missingWords(row)}</span>;
  }
  const { workflowsLive, appsLive, agentsOn } = activity;
  return (
    <span {...stylex.props(styles.cell)}>
      <span>{`${workflowsLive} ${plural(workflowsLive, "workflow", "workflows")} live`}</span>
      <span {...stylex.props(styles.quiet)}>
        {`${appsLive} ${plural(appsLive, "App", "Apps")}, ${agentsOn} ${plural(agentsOn, "agent", "agents")} on`}
      </span>
    </span>
  );
};

/** Its AI on Grasp's key this month against its limit, or why that isn't there. */
const Ai = ({ row, spend }: { row: Row; spend: Spend }) => {
  const own = spend === null ? undefined : spendOf(spend, row);
  if (own === undefined) {
    return (
      <span {...stylex.props(styles.quiet)}>
        {spend?.unreported.includes(row.name) === true
          ? "Not reported by its release"
          : "Not read now"}
      </span>
    );
  }
  const { graspAi } = own;
  if (graspAi === null || graspAi.limit === 0) {
    // On its own key, or a release that doesn't report the limit.
    return (
      <span {...stylex.props(styles.cell)}>
        <span>No limit reported</span>
        <span
          {...stylex.props(styles.quiet)}
        >{`${dollarsOf(own.thisMonth)} on Grasp’s keys`}</span>
      </span>
    );
  }
  const share = Math.min(
    100,
    Math.round((graspAi.spent / graspAi.limit) * 100)
  );
  return (
    <span {...stylex.props(styles.meter)}>
      <Progress
        aria-label={`${row.name}: ${share}% of its AI limit`}
        value={share}
        variant={nearLimit(own) ? "warning" : "default"}
      />
      <span
        {...stylex.props(styles.quiet)}
      >{`${dollarsOf(graspAi.spent)} of ${dollarsOf(graspAi.limit)}`}</span>
    </span>
  );
};

/** Its AI in words, for a card. */
const aiWords = (row: Row, spend: Spend): string => {
  const own = spend === null ? undefined : spendOf(spend, row);
  if (own === undefined) {
    return "Not read now";
  }
  return own.graspAi === null || own.graspAi.limit === 0
    ? `${dollarsOf(own.thisMonth)}, no limit reported`
    : `${dollarsOf(own.graspAi.spent)} of ${dollarsOf(own.graspAi.limit)}`;
};

/**
 * How many people did something themselves last week (the last whole
 * week, core's next to last): none, a few ("1–4", as core sends 1 to 4),
 * else how many; null when its summary doesn't share it.
 */
const peopleOf = (row: Row): AdminPeople | null => {
  const activity = row.summary?.activity;
  return activity === null || activity === undefined
    ? null
    : (activity.activePeople.at(-2)?.people ?? 0);
};

type AdminPeople = NonNullable<
  AdminSummary["activity"]
>["activePeople"][number]["people"];

/** Last week's active people in words: "Nobody", "1–4", "12", or why it isn't there. */
const peopleWords = (row: Row): string => {
  const people = peopleOf(row);
  if (people === null) {
    return missingWords(row);
  }
  if (people === 0) {
    return "Nobody";
  }
  return people === fewPeople ? fewPeople : String(people);
};

/**
 * How it is used: its runs of the last seven days, what failed in red,
 * over how many people did something themselves last week.
 */
const Use = ({ row }: { row: Row }) => {
  const week = weekOf(row.summary);
  if (week === null) {
    return <span {...stylex.props(styles.quiet)}>{missingWords(row)}</span>;
  }
  const runs = week.done + week.failed;
  return (
    <span {...stylex.props(styles.cell)}>
      <span>
        {runs === 0
          ? "No runs"
          : `${week.done} ${plural(week.done, "run", "runs")}`}
        {week.failed > 0 ? (
          <span {...stylex.props(styles.failed)}>
            {`, ${week.failed} failed`}
          </span>
        ) : null}
      </span>
      <span
        {...stylex.props(styles.quiet)}
      >{`${peopleWords(row)} active last week`}</span>
    </span>
  );
};

/** How its platform runs: a toned dot and a few words. */
const healthOf = (row: Row): { tone: BadgeVariant; words: string } => {
  const { client } = row.entry;
  if (row.entry.state === "unreachable") {
    return { tone: "destructive", words: "Core not answering" };
  }
  if (row.entry.state === "not_deployed") {
    return client.setup?.state === "needs_attention"
      ? { tone: "destructive", words: "Setup needs a person" }
      : { tone: "default", words: "Being set up" };
  }
  if (client.rollout.failed !== null) {
    return { tone: "destructive", words: "Last deploy failed" };
  }
  const connectors = row.summary?.connectors;
  if (connectors !== null && connectors !== undefined) {
    if (connectors.stopped > 0) {
      return {
        tone: "destructive",
        words: `${connectors.stopped} ${plural(connectors.stopped, "connector", "connectors")} stopped`,
      };
    }
    if (connectors.again > 0) {
      return {
        tone: "warning",
        words: `${connectors.again} ${plural(connectors.again, "connector waits", "connectors wait")} for a sign-in`,
      };
    }
  }
  if (client.rollout.behind > 0) {
    return {
      tone: "warning",
      words: `${client.rollout.behind} ${plural(client.rollout.behind, "release", "releases")} behind`,
    };
  }
  return {
    tone: "success",
    words: "Running",
  };
};

const Health = ({ row }: { row: Row }) => {
  const { tone, words } = healthOf(row);
  return (
    <Badge dot variant={tone}>
      {words}
    </Badge>
  );
};

/** What it waits on first, and how many more. */
const Next = ({ row }: { row: Row }) => {
  const [first] = row.needs;
  if (first === undefined) {
    return <span {...stylex.props(styles.quiet)}>Nothing waits</span>;
  }
  const more = needCount(row.needs) - first.count;
  return (
    <span {...stylex.props(styles.cell)}>
      <span {...stylex.props(styles.clamp)}>{needText(first)}</span>
      {more > 0 ? (
        <span {...stylex.props(styles.quiet)}>{`and ${more} more`}</span>
      ) : null}
    </span>
  );
};

/** Its use in a line, for a card: runs, what failed, and last week's people. */
const useWords = (
  row: Row,
  week: { done: number; failed: number } | null
): string => {
  if (week === null) {
    return missingWords(row);
  }
  const runs =
    week.done + week.failed === 0
      ? "No runs"
      : `${week.done} ${plural(week.done, "run", "runs")}, ${week.failed} failed`;
  return `${runs}; ${peopleWords(row)} active last week`;
};

/** One fact on a card: its quiet label, then its value. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <span>
    <span {...stylex.props(styles.label)}>{label}</span> {children}
  </span>
);

const OrganizationRow = ({ row, spend }: { row: Row; spend: SpendRead }) => (
  <TableRow interactive>
    <TableCell rowHeader wrap>
      <Link
        data-row-target=""
        params={{ clientId: row.id }}
        to="/organizations/$clientId"
        {...stylex.props(rowTarget)}
      >
        {row.name}
      </Link>
    </TableCell>
    <TableCell>
      <State row={row} />
    </TableCell>
    <TableCell>
      <Progressed row={row} />
    </TableCell>
    <TableCell>
      <Use row={row} />
    </TableCell>
    <TableCell>
      <WithSpend fallback={<Reading />} spend={spend}>
        {(read) => <Ai row={row} spend={read} />}
      </WithSpend>
    </TableCell>
    <TableCell>
      <Health row={row} />
    </TableCell>
    <TableCell wrap>
      <Next row={row} />
    </TableCell>
  </TableRow>
);

/** One organization as a card, below 84rem: its name, how it stands, then its facts. */
const OrganizationCard = ({ row, spend }: { row: Row; spend: SpendRead }) => {
  const week = weekOf(row.summary);
  return (
    <Item asChild>
      <Link params={{ clientId: row.id }} to="/organizations/$clientId">
        <ItemContent>
          <ItemTitle>{row.name}</ItemTitle>
          <ItemDescription>
            <span {...stylex.props(styles.card)}>
              <State row={row} />
              <span {...stylex.props(styles.facts)}>
                <Fact label="Health">{healthOf(row).words}</Fact>
                <Fact label="Last 7 days">{useWords(row, week)}</Fact>
                <Fact label="Grasp AI">
                  <WithSpend fallback="Reading…" spend={spend}>
                    {(read) => aiWords(row, read)}
                  </WithSpend>
                </Fact>
                <Fact label="Next">
                  {row.needs[0] === undefined
                    ? "Nothing waits on Grasp"
                    : needText(row.needs[0])}
                </Fact>
              </span>
            </span>
          </ItemDescription>
        </ItemContent>
      </Link>
    </Item>
  );
};

const Organizations = ({ rows, spend }: { rows: Row[]; spend: SpendRead }) => (
  <section {...stylex.props(styles.part)}>
    <SectionHeader
      headingLevel={2}
      size="sm"
      title="Organizations"
      variant="group"
    />
    <div {...stylex.props(styles.table)}>
      <Table aria-label="Organizations" density="comfortable">
        <TableHeader>
          <TableRow>
            <TableHead>Organization</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Use, 7 days</TableHead>
            <TableHead>Grasp AI</TableHead>
            <TableHead>Health</TableHead>
            <TableHead>Next</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <OrganizationRow key={row.id} row={row} spend={spend} />
          ))}
        </TableBody>
      </Table>
    </div>
    <div {...stylex.props(styles.cards)}>
      <ItemGroup aria-label="Organizations" separated>
        {rows.map((row) => (
          <OrganizationCard key={row.id} row={row} spend={spend} />
        ))}
      </ItemGroup>
    </div>
  </section>
);

/** Everything Home shows below its heading, once the summaries are in. */
export const HomeBody = ({
  summaries,
  spend,
}: {
  summaries: readonly ClientSummary[];
  /** Read from every core apart: each part that shows it fills in once it is in. */
  spend: SpendRead;
}) => {
  const rows = summaries
    .map(rowOf)
    .toSorted(
      (one, other) =>
        order[one.standing] - order[other.standing] ||
        needCount(other.needs) - needCount(one.needs) ||
        one.name.localeCompare(other.name)
    );
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={PlusIcon} />
          <EmptyTitle>No organizations yet</EmptyTitle>
          <EmptyDescription>
            Add the first company with Grasp: its own platform is set up, and
            its onboarding starts from here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <Figures rows={rows} spend={spend} />
      <div {...stylex.props(styles.pair)}>
        <NeedsGrasp rows={rows} />
        <Funnel rows={rows} />
      </div>
      <Organizations rows={rows} spend={spend} />
      <Runs rows={rows} />
    </>
  );
};

/** Home's one action. */
export const NewOrganization = () => (
  <Button asChild size="sm">
    <Link to="/new-organization">
      <Icon icon={PlusIcon} />
      New organization
    </Link>
  </Button>
);
