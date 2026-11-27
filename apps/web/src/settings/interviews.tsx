import { remindAfterWorkingDays } from "@grasp-os/shared/onboarding";
import type { LinkToSend, OnboardingView } from "@grasp-os/shared/onboarding";
import type { Campaign } from "@grasp-os/shared/onboarding-campaign";
import { Alert } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  ChartBar,
  ChartContainer,
  ChartGrid,
  ChartTooltip,
  ChartXAxis,
  ChartYAxis,
} from "@grasp-os/ui/components/chart";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { Progress } from "@grasp-os/ui/components/progress";
import { Separator } from "@grasp-os/ui/components/separator";
import { Stat, StatGroup } from "@grasp-os/ui/components/stat";
import type { StatProps } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { formatDay, formatDayMonth } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { todayIndex } from "../onboarding/campaign/campaign-words.ts";
import { useCore } from "../use-core.ts";
import { InterviewLinks } from "./interview-links.tsx";
import type { LinksFilter } from "./interview-links.tsx";
import { linkRows, needsAdmin } from "./interview-rows.ts";
import type { LinkRow } from "./interview-rows.ts";
import { InterviewTeams } from "./interview-teams.tsx";
import { interviewStyles as styles } from "./interviews.styles.ts";
import { LoadingLines, SettingsGroup } from "./section.tsx";

// Settings › Interviews, for the company's own admins: where the
// onboarding's interviews stand, on one page. The figures and, in one
// line, what needs the admin; the teams in one table, with the reminder
// to those ticked (interview-teams.tsx); the links in another, with what
// to do with each (interview-links.tsx); then, quieter, the talks per day
// and the plan's facts. Everything here is what core already tells the
// admin (`onboarding.campaign`, `links` and `view`): numbers per team by
// core's own rules (a team's numbers once `minTeamShown` were asked, how
// many talked once `minTalkedShown` did), never who talked or what anyone
// said. A person is named only where core names them: a team's lead, a
// link that is out, a mail that failed. The campaign page
// (`/setup?step=listening`) draws the same campaign as a week; this is
// the place to read it and act on it.

/** What the section shows, as core answers it. */
interface InterviewsData {
  view: OnboardingView;
  campaign: Campaign | null;
  links: LinkToSend[];
}

const readInterviews = async (
  core: Pick<CoreConnection, "withSession">,
  left?: AbortSignal
): Promise<Loaded<InterviewsData>> =>
  await loadFromCore(
    core,
    async (session) => {
      const [view, campaign, links] = await Promise.all([
        session.onboarding.view(),
        session.onboarding.campaign(),
        session.onboarding.links(),
      ]);
      return { view, campaign, links };
    },
    left
  );

/** Where the line of what needs the admin jumps to: each table's place on the page. */
const teamsPlace = "interview-teams";
const linksPlace = "interview-links";

/** What keeps the links from going out, said before anything else. */
const Notices = ({ view }: { view: OnboardingView }) => {
  const { t } = useLingui();
  const { waiting } = view;
  return (
    <>
      {view.paused ? (
        <Alert variant="warning">
          {t`Grasp paused the interviews: no link opens and none goes out. The links that are due go out once they run again.`}
        </Alert>
      ) : null}
      {view.agreed ? null : (
        <Alert>
          {t`Grasp is still putting the agreements in place. Your people’s links go out once that is done.`}
        </Alert>
      )}
      {waiting > 0 ? (
        <Alert variant="warning">
          {plural(waiting, {
            one: "# person waits for you to confirm the organization before their link can go out.",
            other:
              "# people wait for you to confirm the organization before their links can go out.",
          })}
        </Alert>
      ) : null}
    </>
  );
};

/** Where the days stand: before the first, on one of them, or after the last. */
const dayStat = (
  campaign: Campaign,
  words: {
    label: string;
    notStarted: string;
    over: string;
    starts: string;
    closes: string;
    closed: string;
    dayOf: (day: number) => string;
  }
): Omit<StatProps, "style" | "unstyled"> => {
  const index = todayIndex(campaign);
  if (index < 0) {
    return {
      label: words.label,
      value: words.notStarted,
      change: words.starts,
    };
  }
  if (campaign.today > campaign.closes) {
    return { label: words.label, value: words.over, change: words.closed };
  }
  return {
    label: words.label,
    value: words.dayOf(index + 1),
    change: words.closes,
  };
};

/** The four figures' names, which the placeholders keep while the page is read. */
const useFigureNames = () => {
  const { t } = useLingui();
  return {
    colleagues: t`Colleagues talked`,
    leads: t`Team leads talked`,
    day: t`Day`,
    known: t`Grasp knows`,
  };
};

/** The interviews at a glance: who talked, the days, and how near Grasp's go is. */
const Glance = ({ campaign }: { campaign: Campaign }) => {
  const { t } = useLingui();
  const names = useFigureNames();
  const { talked, asked, leadsTalked, leads, known, threshold, days } =
    campaign;
  const waiting = Math.max(asked - talked, 0);
  const leadsWaiting = Math.max(leads - leadsTalked, 0);
  const start = formatDay(campaign.start);
  const close = formatDay(campaign.closes);
  return (
    <StatGroup aria-label={t`The interviews at a glance`} columns={2}>
      <Stat
        change={plural(waiting, {
          0: "Everyone has talked",
          one: "# still to talk",
          other: "# still to talk",
        })}
        chart={
          <Progress
            aria-label={names.colleagues}
            getAriaValueText={() => t`${talked} of ${asked}`}
            max={Math.max(asked, 1)}
            size="sm"
            value={talked}
            variant={asked > 0 && talked >= asked ? "success" : "default"}
          />
        }
        label={names.colleagues}
        value={t`${talked} of ${asked}`}
      />
      <Stat
        change={plural(leadsWaiting, {
          0: "Every lead has talked",
          one: "# still to talk",
          other: "# still to talk",
        })}
        label={names.leads}
        value={t`${leadsTalked} of ${leads}`}
      />
      <Stat
        {...dayStat(campaign, {
          label: names.day,
          notStarted: t`Not started`,
          over: t`Over`,
          starts: t`Starts ${start}`,
          closes: t`Closes ${close}`,
          closed: t`Closed ${close}`,
          dayOf: (day) => t`${day} of ${days}`,
        })}
      />
      <Stat
        change={
          campaign.ready
            ? t`Enough for Grasp’s go`
            : t`Grasp opens from ${threshold}%`
        }
        chart={
          <Progress
            aria-label={names.known}
            size="sm"
            value={known}
            variant={campaign.ready ? "success" : "default"}
          />
        }
        label={names.known}
        value={t`${known}%`}
        variant={campaign.ready ? "success" : "default"}
      />
    </StatGroup>
  );
};

/** Goes to a table's place on the page, and gives it the focus, so the keys go on from there. */
const goTo = (place: string): void => {
  const target = document.querySelector<HTMLElement>(`#${place}`);
  target?.scrollIntoView();
  target?.focus({ preventScroll: true });
};

/**
 * What needs the admin, in one line under the figures: each part a link to
 * its table. Counted from the same rows the tables show, so the line and
 * the tables never disagree. Calm when nothing does.
 */
const NeedsYou = ({
  campaign,
  rows,
  onLinks,
}: {
  campaign: Campaign;
  rows: readonly LinkRow[];
  /** Before the jump to the links: they show what needs the admin. */
  onLinks: () => void;
}) => {
  const { t } = useLingui();
  const failed = rows.filter((row) => row.status === "failed").length;
  const toSend = rows.filter((row) => row.status === "send").length;
  const leads = campaign.teams.filter(
    (team) => team.led && !team.leadTalked
  ).length;
  const quiet = campaign.teams.filter((team) => team.quiet).length;
  const parts = [
    {
      id: "failed",
      count: failed,
      place: linksPlace,
      words: plural(failed, {
        one: "# email didn’t arrive",
        other: "# emails didn’t arrive",
      }),
    },
    {
      id: "send",
      count: toSend,
      place: linksPlace,
      words: plural(toSend, {
        one: "# link to send",
        other: "# links to send",
      }),
    },
    {
      id: "leads",
      count: leads,
      place: teamsPlace,
      words: plural(leads, {
        one: "# team lead hasn’t talked",
        other: "# team leads haven’t talked",
      }),
    },
    {
      id: "quiet",
      count: quiet,
      place: teamsPlace,
      words: plural(quiet, {
        one: "# quiet team",
        other: "# quiet teams",
      }),
    },
  ].filter(({ count }) => count > 0);
  if (parts.length === 0) {
    return (
      <Text color="muted" size="sm" style={styles.calm}>
        {t`Nothing needs you right now.`}
      </Text>
    );
  }
  return (
    <ul aria-label={t`What needs you`} {...stylex.props(styles.needs)}>
      {parts.map(({ id, place, words }, index) => (
        <li key={id} {...stylex.props(styles.need)}>
          {index === 0 ? null : (
            <span aria-hidden="true" {...stylex.props(styles.dot)}>
              ·
            </span>
          )}
          <Text as="span" size="sm">
            <TextLink
              href={`#${place}`}
              onClick={(event) => {
                event.preventDefault();
                if (place === linksPlace) {
                  onLinks();
                }
                goTo(place);
              }}
            >
              {words}
            </TextLink>
          </Text>
        </li>
      ))}
    </ul>
  );
};

/** How tall the days' chart stands: a small one, under the tables. */
const daysChartHeight = 160;

/**
 * The interviews finished on each day of the plan, in the teams whose
 * numbers show together: core's `byDay`, summed. A day from today on
 * counts nothing yet.
 */
const PerDay = ({ campaign }: { campaign: Campaign }) => {
  const { t } = useLingui();
  const shown = campaign.teams.flatMap((team) =>
    team.byDay === null ? [] : [team.byDay]
  );
  const first = Date.parse(`${campaign.start}T00:00:00Z`);
  const dayMs = 86_400_000;
  const rows = Array.from({ length: campaign.days }, (_, day) => ({
    day: formatDayMonth(first + day * dayMs),
    talks: shown.reduce((sum, byDay) => sum + (byDay[day] ?? 0), 0),
  }));
  const total = rows.reduce((sum, row) => sum + row.talks, 0);
  return total === 0 ? (
    <Text color="muted" size="sm">
      {t`Too few have talked to show the days yet.`}
    </Text>
  ) : (
    <ChartContainer
      aria-label={t`Interviews finished, day by day`}
      config={{ talks: { label: t`Talked` } }}
      data={rows}
      height={daysChartHeight}
      style={styles.chart}
      summary={plural(total, {
        one: "# interview finished so far.",
        other: "# interviews finished so far.",
      })}
      xKey="day"
      xLabel={t`Day`}
    >
      <ChartGrid />
      <ChartXAxis />
      <ChartYAxis />
      <ChartBar dataKey="talks" />
      <ChartTooltip />
    </ChartContainer>
  );
};

/**
 * The talks per day and the plan's facts, quieter than the tables, and
 * the way to the campaign page, the week as a drawing.
 */
const Activity = ({
  campaign,
  view,
}: {
  campaign: Campaign;
  view: OnboardingView;
}) => {
  const { t } = useLingui();
  const wait = remindAfterWorkingDays;
  const domain = view.mailDomain;
  let linksGo = t`Sent by you`;
  if (view.mailSends) {
    linksGo =
      domain === null
        ? t`Emailed by Grasp`
        : t`Emailed by Grasp, from ${domain}`;
  }
  return (
    <SettingsGroup
      actions={
        <Button asChild size="sm" variant="outline">
          <Link search={{ step: "listening" }} to="/setup">
            {t`Open the campaign page`}
          </Link>
        </Button>
      }
      description={t`Interviews finished on each day, in the teams whose numbers show.`}
      title={t`Activity`}
    >
      <div {...stylex.props(styles.activity)}>
        <PerDay campaign={campaign} />
        <Separator decorative />
        <KeyValueList
          items={[
            {
              id: "first",
              label: t`First day`,
              value: formatDay(campaign.start),
            },
            {
              id: "last",
              label: t`Last day`,
              value: formatDay(campaign.closes),
            },
            { id: "links", label: t`Links`, value: linksGo },
            {
              id: "reminder",
              label: t`Grasp’s reminder`,
              value: plural(wait, {
                one: "Once, after # working day",
                other: "Once, after # working days",
              }),
            },
          ]}
          orientation="horizontal"
        />
      </div>
    </SettingsGroup>
  );
};

/** The section once read: nothing to show before the list and the plan are in. */
const Interviews = ({
  view,
  campaign,
  links,
  onChanged,
}: {
  view: OnboardingView;
  campaign: Campaign;
  links: LinkToSend[];
  onChanged: () => Promise<void>;
}) => {
  const rows = linkRows(campaign, links, view.mailSends);
  // The links start on what needs the admin, when anything does.
  const [filter, setFilter] = useState<LinksFilter>(() =>
    rows.some(needsAdmin) ? "attention" : "all"
  );
  return (
    <>
      <Notices view={view} />
      <Glance campaign={campaign} />
      <NeedsYou
        campaign={campaign}
        onLinks={() => {
          setFilter("attention");
        }}
        rows={rows}
      />
      <div id={teamsPlace} tabIndex={-1} {...stylex.props(styles.place)}>
        <InterviewTeams campaign={campaign} onChanged={onChanged} view={view} />
      </div>
      <div id={linksPlace} tabIndex={-1} {...stylex.props(styles.place)}>
        <InterviewLinks
          filter={filter}
          links={links}
          mailSends={view.mailSends}
          onChanged={onChanged}
          onFilter={setFilter}
          rows={rows}
        />
      </div>
      <Activity campaign={campaign} view={view} />
    </>
  );
};

/** The page while it is read: the figures' and a table's placeholders. */
const InterviewsLoading = () => {
  const { t } = useLingui();
  const names = useFigureNames();
  return (
    <>
      <StatGroup
        aria-label={t`The interviews at a glance`}
        columns={2}
        items={Object.values(names).map((label) => ({
          label,
          value: "",
          change: "",
        }))}
        loading
      />
      <SettingsGroup loading title="">
        <LoadingLines lines={5} />
      </SettingsGroup>
    </>
  );
};

/** Settings › Interviews: read when it is opened, and again after each change. */
export const InterviewsPanel = () => {
  const { t } = useLingui();
  const core = useCore();
  const [loaded, setLoaded] = useState<Loaded<InterviewsData>>();
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const first = await readInterviews(core, left.signal);
      if (!left.signal.aborted) {
        setLoaded(first);
      }
    };
    void read();
    return () => {
      left.abort();
    };
  }, [core]);
  const reload = async (): Promise<void> => {
    setLoaded(await readInterviews(core));
  };
  if (loaded === undefined) {
    return <InterviewsLoading />;
  }
  if (loaded.state !== "ready") {
    return (
      <SettingsGroup title={t`Progress`}>
        <NotLoadedState heading="h3" page={loaded} reread={reload} />
      </SettingsGroup>
    );
  }
  const { view, campaign, links } = loaded.data;
  if (campaign === null) {
    return (
      <SettingsGroup title={t`Progress`}>
        <Empty>
          <EmptyHeader>
            <EmptyTitle level={3}>{t`No interviews yet`}</EmptyTitle>
            <EmptyDescription>
              {t`They start once who works where and the plan are in. You set both in the onboarding.`}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild size="sm" variant="outline">
              <Link to="/setup">{t`Open the onboarding`}</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </SettingsGroup>
    );
  }
  return (
    <Interviews
      campaign={campaign}
      links={links}
      onChanged={reload}
      view={view}
    />
  );
};
