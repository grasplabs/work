/**
 * An organization's overview, composed as Grasp Work composes a page:
 * what comes next first (who it waits on, for how long, and the one
 * thing to do about it), then the few figures that say how it is doing,
 * how it ran over the last weeks, what else needs Grasp, what staff and
 * the admin did lately, and a way into each section with how that
 * section stands in a line. Counts and organization-level facts only:
 * no interview's words, and no person but the staff in its history. How
 * it is used comes from its summary (counts only, src/clients/summary.ts),
 * which the frame reads.
 */
import { fewPeople } from "@grasp-os/shared/admin-summary";
import type { AdminSummary } from "@grasp-os/shared/admin-summary";
import { brainOf, healthOf } from "@grasp-os/shared/admin/admin-health";
import { historyOf } from "@grasp-os/shared/admin/admin-view";
import type { AdminView } from "@grasp-os/shared/admin/admin-view";
import { listenDays } from "@grasp-os/shared/admin/onboarding-admin";
import type { Need } from "@grasp-os/shared/admin/onboarding-admin";
import type { AiStatusReport } from "@grasp-os/shared/ai-status-report";
import { Button } from "@grasp-os/ui/components/button";
import {
  ChartBar,
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
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGrid,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import type { StatVariant } from "@grasp-os/ui/components/stat";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  CircleCheckIcon,
  ClockIcon,
  Icon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Suspense, use } from "react";

import type { ClientSetup } from "../clients/setup.ts";
import type { ClientSummary } from "../clients/summary.ts";
import { LoadingLines } from "../frame/page.tsx";
import { LoadingFigure, MissingFigure } from "./figures.tsx";
import { NextRow, WaitsOn } from "./next-row.tsx";
import { needAction, needSince, partyOf, partyWords } from "./org-status.ts";
import type { Party } from "./org-status.ts";
import type { AnsweredOrganization } from "./organization.tsx";
import { useOrganization } from "./organization.tsx";
import { needWhere, sectionTo, sectionWords } from "./sections.ts";
import type { OrgSection } from "./sections.ts";
import { Ago, useSettled } from "./settled.tsx";
import { actorWords, entryWords, shownEntries } from "./setup-history.ts";
import {
  dayCount,
  daysBetween,
  interviewDay,
  standingOfView,
} from "./standing.ts";
import type { Standing } from "./standing.ts";
import { rolloutNeedLine, rolloutNeeds } from "./views.ts";
import {
  contractWords,
  dollars,
  formatDay,
  needLine,
  plural,
  stageLines,
  stageWords,
  talkedWords,
  whole,
} from "./words.ts";

const WIDE = "@media (width >= 64rem)";

const styles = stylex.create({
  // The page's parts, a step further apart than the lines within each.
  parts: { display: "flex", flexDirection: "column", gap: space["10"] },
  // Runs and people side by side once there is room for both.
  charts: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDE]: "repeat(2, minmax(0, 1fr))",
    },
    gap: space["8"],
  },
});

const root = getRouteApi("__root__");

type Activity = NonNullable<AdminSummary["activity"]>;

/** How the company uses Grasp, from its summary; or, in words, why that isn't there. */
type Use = { activity: Activity } | { missing: string };

const useOf = (entry: ClientSummary | undefined): Use => {
  if (entry === undefined) {
    return { missing: "Not read now" };
  }
  switch (entry.state) {
    case "answered": {
      return entry.summary.activity === null
        ? { missing: "Not shared" }
        : { activity: entry.summary.activity };
    }
    case "older": {
      return { missing: "Update to see" };
    }
    case "not_deployed":
    case "unreachable": {
      return { missing: "Not read now" };
    }
    default: {
      return entry satisfies never;
    }
  }
};

/** How organization `clientId` uses Grasp, once the frame's summaries are in. */
const useUse = (clientId: string): Use => {
  const { summaries } = root.useLoaderData();
  const read = useSettled(summaries);
  return useOf(read?.find(({ client }) => client.id === clientId));
};

/** Grasp AI this month against its limit, in dollars, from the AI status its core reported. */
const graspAiOf = (
  report: AiStatusReport | null
): { spent: number; limit: number; reached: boolean } | null => {
  const grasp = report?.graspAi;
  if (grasp === undefined) {
    return null;
  }
  return {
    spent: grasp.spentMicros / 1_000_000,
    limit: grasp.limitMicros / 1_000_000,
    reached: grasp.reached,
  };
};

/** From this share of its limit on, Grasp AI is worth a look. */
const nearLimit = 0.8;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

// ---- Next ---------------------------------------------------------------

const capitalized = (words: string): string =>
  `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

/** The needs that only stand while an organization isn't open yet. */
const beforeOpening: ReadonlySet<Need["kind"]> = new Set([
  "go",
  "short",
  "transcript",
  "ask",
  "conflict",
  "paused",
  "lead",
  "quiet",
  "few",
]);

/** Something that waits, as the overview lists it: what, on whom, where it is settled, and since when. */
interface Waiting {
  key: string;
  title: string;
  party: Party;
  section: OrgSection;
  search: { tab: "contract" } | undefined;
  /** The page's action for it, as its button says it. */
  action: string;
  since: string | null;
}

/**
 * Everything that waits, the most pressing first: what its own platform
 * needs (settled on its Setup, by Grasp), then what its core's view says.
 */
const waitingOf = (
  { admin, view }: AnsweredOrganization,
  standing: Standing
): Waiting[] => [
  ...rolloutNeeds(admin.client).map((need, at) => ({
    key: `rollout-${String(at)}`,
    title: rolloutNeedLine(need),
    party: "grasp" as const,
    section: "setup" as const,
    search: undefined,
    action: "Open its Setup",
    since: null,
  })),
  ...view.needs
    // Open already, though no go is recorded (a deployment that started
    // open): what only stands before opening doesn't wait on anyone.
    .filter((need) => standing !== "live" || !beforeOpening.has(need.kind))
    .map((need, at) => ({
      // The same need can stand twice, for two teams.
      key: `${need.kind}-${String(at)}`,
      title: needLine(need, view),
      party: partyOf(need),
      ...needWhere(need),
      action: needAction(need),
      since: needSince(need, standing, admin.snapshot),
    })),
];

/** How long something has waited, in a few words: "for 3 days", "since today". */
const waitedWords = (since: string, now: string): string => {
  const days = daysBetween(since, now);
  return days === 0 ? "since today" : `for ${dayCount(days)}`;
};

/**
 * What comes next: the most pressing of what waits, who it waits on and
 * for how long, and the page's one primary action, to the section it is
 * settled in. With nothing waiting, a live company's own Grasp is the way
 * on.
 */
const NextStep = ({
  standing,
  next,
}: {
  standing: Standing;
  next: Waiting | undefined;
}) => {
  const { admin } = useOrganization();
  const clientId = admin.client.id;
  if (next === undefined) {
    const { hostname } = admin.client;
    return (
      <NextRow
        action={
          hostname === null || standing !== "live" ? undefined : (
            <Button asChild>
              <a
                href={`https://${hostname}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                Open its Grasp
                <Icon icon={ArrowUpRightIcon} />
              </a>
            </Button>
          )
        }
        description={
          standing === "live"
            ? "How it is used is below."
            : "Its next step starts on its own."
        }
        icon={CircleCheckIcon}
        title="Nothing waits on Grasp or the company"
      />
    );
  }
  const where = `Settled in ${sectionWords[next.section].title}`;
  return (
    <NextRow
      action={
        <Button asChild>
          <Link
            params={{ clientId }}
            search={next.search}
            to={sectionTo[next.section]}
          >
            {next.action}
            <Icon icon={ArrowRightIcon} />
          </Link>
        </Button>
      }
      description={
        <WaitsOn grasp={next.party === "grasp"} words={partyWords[next.party]}>
          {next.since === null
            ? where
            : `${capitalized(waitedWords(next.since, admin.snapshot.now))} · ${where.toLowerCase()}`}
        </WaitsOn>
      }
      icon={next.party === "grasp" ? ClockIcon : UsersIcon}
      title={next.title}
    />
  );
};

// ---- Figures ------------------------------------------------------------

/** Grasp AI this month as a figure, once its core's AI status is in. */
const GraspAiStat = ({
  status,
}: {
  status: Promise<AiStatusReport | null>;
}) => {
  const report = use(status);
  const ai = graspAiOf(report);
  if (ai === null) {
    return report === null ? (
      <Stat
        change="Its core didn’t answer"
        label="Grasp AI this month"
        value="Not read"
      />
    ) : (
      // Absent on its own key, and from a release before it was reported:
      // which isn't said.
      <Stat
        change="On its own key, or its release doesn’t report it"
        label="Grasp AI this month"
        value="Not reported"
      />
    );
  }
  const share = ai.limit === 0 ? 0 : ai.spent / ai.limit;
  let variant: StatVariant = "default";
  if (ai.reached) {
    variant = "destructive";
  } else if (share >= nearLimit) {
    variant = "warning";
  }
  return (
    <Stat
      change={
        ai.reached
          ? "Its limit is reached"
          : `${Math.round(share * 100)}% of its ${dollars(ai.limit)} limit`
      }
      label="Grasp AI this month"
      value={dollars(ai.spent)}
      variant={variant}
    />
  );
};

const AiStat = ({ status }: { status: Promise<AiStatusReport | null> }) => (
  <Suspense fallback={<LoadingFigure label="Grasp AI this month" />}>
    <GraspAiStat status={status} />
  </Suspense>
);

/** The days a week has, for the runs of the last one. */
const week = 7;

/** A week's active people in words: "Nobody", "1–4" as core sends a few, or how many. */
const peopleWords = (people: number | typeof fewPeople): string => {
  if (people === 0) {
    return "Nobody";
  }
  return people === fewPeople ? fewPeople : whole(people);
};

/**
 * People active last week (the last whole week), of its members, with how
 * that moved on the week before where both are counted exactly.
 */
const peopleStat = (
  activity: Activity,
  members: number
): { value: string; change: string; variant?: StatVariant } => {
  const weeks = activity.activePeople;
  const last = weeks.at(-2)?.people ?? 0;
  const before = weeks.at(-3)?.people ?? 0;
  const of = `of ${members} ${plural(members, "member", "members")}`;
  if (last === fewPeople || before === fewPeople) {
    return { value: peopleWords(last), change: of };
  }
  const moved = last - before;
  if (moved === 0) {
    return { value: peopleWords(last), change: `${of}, as the week before` };
  }
  return {
    value: peopleWords(last),
    change: `${of}, ${moved > 0 ? "+" : "−"}${Math.abs(moved)} on the week before`,
    variant: moved > 0 ? "success" : "warning",
  };
};

/** What troubles its connections, in a few words: stopped, waiting for a sign-in, not checked now. */
const connectorTrouble = ({
  stopped,
  again,
  unread,
}: {
  stopped: number;
  again: number;
  unread: number;
}): string => {
  const parts = [
    stopped > 0 ? `${stopped} stopped` : null,
    again > 0 ? `${again} to sign in again` : null,
    unread > 0 ? `${unread} not checked now` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "All working" : capitalized(parts.join(", "));
};

/** Its company connections that work, of all of them, how many stopped, and how many wait for a sign-in. */
const connectorCounts = (
  organization: AnsweredOrganization
): {
  works: number;
  all: number;
  stopped: number;
  again: number;
  unread: number;
} | null => {
  const { integrations } = organization.admin.snapshot;
  if (integrations === null) {
    return null;
  }
  const { connected } = integrations;
  const count = (state: (typeof connected)[number]["state"]) =>
    connected.filter((each) => each.state === state).length;
  return {
    works: count("works"),
    all: connected.length,
    stopped: count("stopped"),
    again: count("again"),
    // Composio couldn't be asked about these now.
    unread: count("unread"),
  };
};

/** A live company's figures: people, runs, its AI, what is live and its connectors. */
const LiveFigures = ({
  aiStatus,
}: {
  aiStatus: Promise<AiStatusReport | null>;
}) => {
  const organization = useOrganization();
  const used = useUse(organization.admin.client.id);
  const connectors = connectorCounts(organization);
  const connectorsChange =
    connectors === null ? "Not reported" : connectorTrouble(connectors);
  const connectorsStat = (
    <Stat
      change={connectorsChange}
      label="Connectors working"
      value={
        connectors === null
          ? "Not read"
          : `${connectors.works} of ${connectors.all}`
      }
      variant={
        connectors !== null && connectors.stopped + connectors.again > 0
          ? "warning"
          : "default"
      }
    />
  );
  if ("missing" in used) {
    return (
      <StatGroup aria-label="How it is doing" columns={3}>
        <MissingFigure
          label="People active last week"
          missing={used.missing}
          why="From its summary"
        />
        <MissingFigure
          label="Runs, last 7 days"
          missing={used.missing}
          why="From its summary"
        />
        <AiStat status={aiStatus} />
        <MissingFigure
          label="Workflows live"
          missing={used.missing}
          why="From its summary"
        />
        <MissingFigure
          label="Apps live"
          missing={used.missing}
          why="From its summary"
        />
        {connectorsStat}
      </StatGroup>
    );
  }
  const { activity } = used;
  const runs = activity.runs.slice(-week);
  const done = sum(runs.map((day) => day.done));
  const failed = sum(runs.map((day) => day.failed));
  return (
    <StatGroup aria-label="How it is doing" columns={3}>
      <Stat
        label="People active last week"
        {...peopleStat(activity, organization.admin.snapshot.members.length)}
      />
      <Stat
        change={failed > 0 ? `${whole(failed)} failed` : "None failed"}
        label="Runs, last 7 days"
        value={whole(done + failed)}
        variant={failed > 0 ? "destructive" : "default"}
      />
      <AiStat status={aiStatus} />
      <Stat
        change={`${activity.agentsOn} ${plural(activity.agentsOn, "agent", "agents")} on`}
        label="Workflows live"
        value={whole(activity.workflowsLive)}
      />
      <Stat
        change="Published, in use"
        label="Apps live"
        value={whole(activity.appsLive)}
      />
      {connectorsStat}
    </StatGroup>
  );
};

/** An onboarding company's figures: how much is known, the interviews' day, who talked, its AI. */
const OnboardingFigures = ({
  aiStatus,
}: {
  aiStatus: Promise<AiStatusReport | null>;
}) => {
  const { view } = useOrganization();
  const { percent, threshold, ready } = view.knowledge;
  const days = listenDays(view.org);
  const day = interviewDay(view) ?? days;
  const left = Math.max(0, days - day);
  let interviews = { value: "Not started", change: "The team isn’t told yet" };
  if (view.told) {
    interviews = view.closed
      ? { value: `${days} of ${days}`, change: "Closed" }
      : {
          value: `Day ${day} of ${days}`,
          change: `${dayCount(left)} left`,
        };
  }
  return (
    <StatGroup aria-label="How its onboarding is doing" columns={4}>
      <Stat
        change={
          ready ? `Enough to open at ${threshold}%` : `Opens at ${threshold}%`
        }
        label="Known"
        value={`${percent}%`}
        variant={ready ? "success" : "default"}
      />
      <Stat label="Interviews" {...interviews} />
      <Stat
        change={
          view.asked === 0
            ? "Nobody asked yet"
            : `${view.asked - view.counts.completed} still to talk`
        }
        label="Talked"
        value={
          view.asked === 0
            ? "Nobody yet"
            : `${view.counts.completed} of ${view.asked}`
        }
      />
      <AiStat status={aiStatus} />
    </StatGroup>
  );
};

// ---- Charts -------------------------------------------------------------

/**
 * Runs per day over 30 days, and people active per week over 8, side by
 * side. A week of 1 to 4 people, as its summary sends it, is a bar of its
 * own up to 4, named as such: never one number.
 */
const Charts = ({ activity }: { activity: Activity }) => {
  const runs = activity.runs.map((day) => ({
    day: formatDay(day.day),
    done: day.done,
    failed: day.failed,
  }));
  const done = sum(activity.runs.map((day) => day.done));
  const failed = sum(activity.runs.map((day) => day.failed));
  const weeks = activity.activePeople.map(({ week: monday, people }) => ({
    week: formatDay(monday),
    // A week of a few: its people said as core sends them, "1–4", in the
    // chart's table and tooltip; its bar is the few series', drawn to 4.
    people,
    few: people === fewPeople ? 4 : 0,
  }));
  const counted = activity.activePeople.map(({ people }) =>
    people === fewPeople ? 0 : people
  );
  const most = Math.max(0, ...counted);
  const fewWeeks = activity.activePeople.filter(
    ({ people }) => people === fewPeople
  ).length;
  return (
    <div {...stylex.props(styles.charts)}>
      <Part aria-labelledby="runs">
        <SectionHeader
          description={`Last 30 days: ${whole(done)} done, ${whole(failed)} failed`}
          id="runs"
          size="sm"
          title="Runs per day"
          variant="group"
        />
        <ChartContainer
          aria-label="Runs per day, last 30 days"
          config={{ done: { label: "Done" }, failed: { label: "Failed" } }}
          data={runs}
          summary={`${whole(done)} runs done and ${whole(failed)} failed in the last 30 days.`}
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
      </Part>
      <Part aria-labelledby="people">
        <SectionHeader
          description="Each week, the last 8"
          id="people"
          size="sm"
          title="People active"
          variant="group"
        />
        {weeks.length === 0 ? (
          <Empty align="start" size="sm">
            <EmptyHeader>
              <EmptyDescription>Not counted yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChartContainer
            aria-label="People active each week, the last 8"
            config={{
              people: { label: "People" },
              few: { label: "1 to 4 people, drawn to 4" },
            }}
            data={weeks}
            summary={[
              most === 0
                ? null
                : `At most ${most} people were active in a week.`,
              fewWeeks === 0
                ? null
                : `In ${fewWeeks} ${plural(fewWeeks, "week", "weeks")}, 1 to 4.`,
            ]
              .filter((part) => part !== null)
              .join(" ")}
            xKey="week"
          >
            <ChartGrid />
            <ChartXAxis />
            <ChartYAxis />
            {fewWeeks === 0 ? (
              <ChartBar dataKey="people" pattern="dither-dots" />
            ) : (
              <>
                <ChartBar
                  dataKey="people"
                  pattern="dither-dots"
                  stackId="week"
                />
                <ChartBar dataKey="few" stackId="week" />
                <ChartLegend />
              </>
            )}
            <ChartTooltip />
          </ChartContainer>
        )}
      </Part>
    </div>
  );
};

/** Its charts, once the frame's summaries are in: only while it shares how it is used. */
const UseCharts = () => {
  const { admin } = useOrganization();
  const used = useUse(admin.client.id);
  return "activity" in used ? <Charts activity={used.activity} /> : null;
};

// ---- What needs Grasp ---------------------------------------------------

/** Everything else that waits, past the one in Next, each a row to the section it is settled in. */
const MoreNeeds = ({ waiting }: { waiting: readonly Waiting[] }) => {
  const { admin } = useOrganization();
  if (waiting.length === 0) {
    return null;
  }
  return (
    <Part aria-labelledby="needs">
      <SectionHeader
        id="needs"
        size="sm"
        title="What else needs Grasp"
        variant="group"
      />
      <ItemGroup aria-labelledby="needs" separated>
        {waiting.map((each) => (
          <Item asChild key={each.key}>
            <Link
              params={{ clientId: admin.client.id }}
              search={each.search}
              to={sectionTo[each.section]}
            >
              <ItemContent>
                <ItemTitle>{each.title}</ItemTitle>
                <ItemDescription>
                  {`${partyWords[each.party]} · ${sectionWords[each.section].title}`}
                </ItemDescription>
              </ItemContent>
            </Link>
          </Item>
        ))}
      </ItemGroup>
    </Part>
  );
};

// ---- Recent activity ----------------------------------------------------

/**
 * What the admin did by itself that the overview tells: a deploy and a
 * setting up, begun or ended. Each step of either is on its Setup's history.
 */
const deployed: ReadonlySet<string> = new Set([
  "deploy.start",
  "deploy.done",
  "deploy.fail",
  "provision.start",
  "provision.done",
  "provision.fail",
  "client.rotation_live",
]);

/** How many of its latest entries the overview shows. */
const recentCount = 5;

const RecentEntries = ({ setup }: { setup: Promise<ClientSetup | null> }) => {
  const read = use(setup);
  if (read === null) {
    return (
      <Empty align="start" size="sm">
        <EmptyHeader>
          <EmptyDescription>
            Its history couldn’t be read just now.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const entries = shownEntries(read.history)
    .filter(({ actor, action }) => actor !== "system" || deployed.has(action))
    .slice(0, recentCount);
  if (entries.length === 0) {
    return (
      <Empty align="start" size="sm">
        <EmptyHeader>
          <EmptyDescription>Nothing yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup aria-labelledby="recent" separated>
      {entries.map((entry) => (
        <Item key={entry.id} size="sm">
          <ItemContent>
            <ItemTitle>{entryWords(entry)}</ItemTitle>
            <ItemDescription>
              {`${actorWords(entry.actor)} · `}
              <Ago at={entry.at.toISOString()} />
            </ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
};

/** What staff and the admin did lately: its latest deploys and changes, from the admin's audit log. */
const Recent = ({ setup }: { setup: Promise<ClientSetup | null> }) => {
  const { admin } = useOrganization();
  return (
    <Part aria-labelledby="recent">
      <SectionHeader
        actions={
          <Button asChild size="xs" variant="ghost">
            <Link
              params={{ clientId: admin.client.id }}
              search={{ tab: "history" }}
              to="/organizations/$clientId/setup"
            >
              All of it
            </Link>
          </Button>
        }
        id="recent"
        size="sm"
        title="Recent activity"
        variant="group"
      />
      <Suspense fallback={<LoadingLines lines={recentCount} />}>
        <RecentEntries setup={setup} />
      </Suspense>
    </Part>
  );
};

// ---- Sections -----------------------------------------------------------

/** The sections the overview leads into, in the column's order. */
const ways: readonly Exclude<OrgSection, "overview">[] = [
  "details",
  "steps",
  "interviews",
  "workflows",
  "setup",
  "integrations",
  "usage",
  "value",
  "brain",
  "log",
];

/** How the Setup stands, from what the admin recorded: its standing and the release it runs. */
const setupLine = (organization: AnsweredOrganization): string => {
  const { client } = organization.admin;
  const [need] = rolloutNeeds(client);
  let standing = "Healthy";
  if (need?.kind === "channel_stopped") {
    standing = "Nothing deploys on its channel";
  } else if (need?.kind === "deploy_failed") {
    standing = "Its deploy failed";
  } else if (need?.kind === "behind") {
    standing = `${need.releases} releases behind`;
  } else if (client.setup !== null) {
    standing = "Being set up";
  }
  return client.release === null ? standing : `${standing} · ${client.release}`;
};

/** How its connectors stand, in a line. */
const connectorsLine = (organization: AnsweredOrganization): string => {
  const counts = connectorCounts(organization);
  if (counts === null) {
    return "Not reported";
  }
  if (counts.all === 0) {
    return "Nothing connected yet";
  }
  const trouble = connectorTrouble(counts);
  return trouble === "All working"
    ? `${counts.works} working`
    : `${counts.works} working, ${trouble.toLowerCase()}`;
};

/** How the work is known, or how much runs once it is live. */
const WorkflowsLine = ({ view, live }: { view: AdminView; live: boolean }) => {
  const used = useUse(view.org.id);
  if (live && "activity" in used) {
    return `${used.activity.workflowsLive} live`;
  }
  const signal = healthOf(view).find(({ area }) => area === "workflows");
  if (signal?.area !== "workflows" || signal.of === 0) {
    return "Nothing heard yet";
  }
  return `${signal.known} of ${signal.of} known`;
};

/** Hours freed once workflows run, else the hours in the work that is known. */
const hoursLine = (view: AdminView): string => {
  const { freed, hours } = view.value;
  if (freed > 0) {
    return `${whole(freed)} hours a week freed`;
  }
  return hours > 0
    ? `${whole(hours)} hours a week in known work`
    : "Not counted yet";
};

/** Where the steps stand: open since its go, or the step it is at. */
const stepsLine = (view: AdminView, live: boolean): string => {
  if (!live) {
    return stageWords[view.stage];
  }
  // Open from the start: no go was ever given.
  return view.knowledge.opened === null
    ? "Open, without Grasp’s go"
    : stageLines(view).open;
};

/** The contract and its members, in a line. */
const detailsLine = (view: AdminView, members: number): string => {
  const people = `${members} ${plural(members, "member", "members")}`;
  return view.unknown.contract
    ? people
    : `${contractWords[view.contract.status]} · ${people}`;
};

const AiUseLine = ({ status }: { status: Promise<AiStatusReport | null> }) => {
  const report = use(status);
  const ai = graspAiOf(report);
  if (ai === null) {
    return report === null ? "Not read now" : "Not reported";
  }
  return `${dollars(ai.spent)} this month`;
};

/** One section's line: how it stands now. */
const SectionLine = ({
  section,
  aiStatus,
}: {
  section: Exclude<OrgSection, "overview">;
  aiStatus: Promise<AiStatusReport | null>;
}) => {
  const organization = useOrganization();
  const { view, admin } = organization;
  const live = standingOfView(view, admin.snapshot.gate.open) === "live";
  switch (section) {
    case "details": {
      return detailsLine(view, admin.snapshot.members.length);
    }
    case "steps": {
      return stepsLine(view, live);
    }
    case "interviews": {
      return view.told
        ? talkedWords(view.counts.completed, view.asked)
        : "Not started";
    }
    case "workflows": {
      return (
        <Suspense fallback="Reading…">
          <WorkflowsLine live={live} view={view} />
        </Suspense>
      );
    }
    case "setup": {
      return setupLine(organization);
    }
    case "integrations": {
      return connectorsLine(organization);
    }
    case "usage": {
      return (
        <Suspense fallback="Reading…">
          <AiUseLine status={aiStatus} />
        </Suspense>
      );
    }
    case "value": {
      return hoursLine(view);
    }
    case "brain": {
      const brain = brainOf(view);
      if (brain.interviews === 0) {
        return "Nothing heard yet";
      }
      return `${whole(brain.facts)} facts from ${brain.interviews} ${plural(brain.interviews, "interview", "interviews")}`;
    }
    case "log": {
      const events = historyOf(view).length;
      return `${whole(events)} ${plural(events, "event", "events")}`;
    }
    default: {
      return section satisfies never;
    }
  }
};

/** A way into each section, with how it stands in one quiet line. */
const Sections = ({
  aiStatus,
}: {
  aiStatus: Promise<AiStatusReport | null>;
}) => {
  const { admin } = useOrganization();
  return (
    <Part aria-labelledby="sections">
      <SectionHeader id="sections" size="sm" title="Sections" variant="group" />
      <ItemGrid aria-labelledby="sections">
        {ways.map((section) => (
          <Item asChild key={section} variant="outline">
            <Link
              params={{ clientId: admin.client.id }}
              to={sectionTo[section]}
            >
              <ItemMedia variant="icon">
                <Icon icon={sectionWords[section].icon} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{sectionWords[section].title}</ItemTitle>
                <ItemDescription>
                  <SectionLine aiStatus={aiStatus} section={section} />
                </ItemDescription>
              </ItemContent>
            </Link>
          </Item>
        ))}
      </ItemGrid>
    </Part>
  );
};

// ---- The page -----------------------------------------------------------

/**
 * The overview of an organization whose core answered. Its Setup's read
 * (for the history), its AI status and the frame's summaries (for how it
 * is used) come in after, each into its own place.
 */
export const Overview = ({
  setup,
  aiStatus,
}: {
  setup: Promise<ClientSetup | null>;
  aiStatus: Promise<AiStatusReport | null>;
}) => {
  const organization = useOrganization();
  const { admin, view } = organization;
  const standing = standingOfView(view, admin.snapshot.gate.open);
  const [next, ...more] = waitingOf(organization, standing);
  return (
    <div {...stylex.props(styles.parts)}>
      <NextStep next={next} standing={standing} />
      {standing === "live" ? (
        <Suspense fallback={<LoadingLines lines={4} />}>
          <LiveFigures aiStatus={aiStatus} />
          <UseCharts />
        </Suspense>
      ) : (
        <OnboardingFigures aiStatus={aiStatus} />
      )}
      <MoreNeeds waiting={more} />
      <Recent setup={setup} />
      <Sections aiStatus={aiStatus} />
    </div>
  );
};
