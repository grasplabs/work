import { failureText } from "@grasp-os/shared/errors";
import {
  leadsOfTeam,
  minTalkedShown,
  minTeamShown,
  remindAfterWorkingDays,
} from "@grasp-os/shared/onboarding";
import type { LinkToSend, OnboardingView } from "@grasp-os/shared/onboarding";
import type {
  Campaign,
  CampaignTeam,
} from "@grasp-os/shared/onboarding-campaign";
import { Alert } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
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
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { StatGroup } from "@grasp-os/ui/components/stat";
import type { StatProps } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { formatDay, formatDayMonth, formatList } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  isGrouped,
  rowName,
  say,
  todayIndex,
} from "../onboarding/campaign/campaign-words.ts";
import { useCore } from "../use-core.ts";
import { InterviewLinks } from "./interview-links.tsx";
import { interviewStyles as styles } from "./interviews.styles.ts";
import { ReadOnlyRow } from "./read-only-row.tsx";
import {
  LoadingLines,
  NamedRows,
  RowNote,
  SettingRow,
  SettingsGroup,
} from "./section.tsx";

// Settings › Interviews, for the company's own admins: where the
// onboarding's interviews stand, in one calm column. Everything here is
// what core already tells the admin (`onboarding.campaign`, `links` and
// `view`): numbers per team by core's own rules (a team's numbers once
// `minTeamShown` were asked, how many talked once `minTalkedShown` did),
// never who talked or what anyone said. A person is named only where core
// names them: a team's lead, a link to send, a mail that failed. The
// campaign page (`/setup?step=listening`) draws the same campaign as a
// week; this is the place to read it and act on it.

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

/** The way to the campaign page, the week as a drawing. */
const CampaignLink = () => {
  const { t } = useLingui();
  return (
    <Button asChild size="sm" variant="outline">
      <Link search={{ step: "listening" }} to="/setup">
        {t`Open the campaign page`}
      </Link>
    </Button>
  );
};

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

/** The interviews at a glance: who talked, the days, and how near Grasp's go is. */
const Glance = ({ campaign }: { campaign: Campaign }) => {
  const { t } = useLingui();
  const { talked, asked, leadsTalked, leads, known, threshold, days } =
    campaign;
  const waiting = Math.max(asked - talked, 0);
  const leadsWaiting = Math.max(leads - leadsTalked, 0);
  const start = formatDay(campaign.start);
  const close = formatDay(campaign.closes);
  return (
    <StatGroup
      aria-label={t`The interviews at a glance`}
      columns={2}
      items={[
        {
          label: t`Colleagues talked`,
          value: t`${talked} of ${asked}`,
          change: plural(waiting, {
            0: "Everyone has talked",
            one: "# still to talk",
            other: "# still to talk",
          }),
        },
        {
          label: t`Team leads talked`,
          value: t`${leadsTalked} of ${leads}`,
          change: plural(leadsWaiting, {
            0: "Every lead has talked",
            one: "# still to talk",
            other: "# still to talk",
          }),
        },
        dayStat(campaign, {
          label: t`Day`,
          notStarted: t`Not started`,
          over: t`Over`,
          starts: t`Starts ${start}`,
          closes: t`Closes ${close}`,
          closed: t`Closed ${close}`,
          dayOf: (day) => t`${day} of ${days}`,
        }),
        {
          label: t`Grasp knows`,
          value: t`${known}%`,
          change: campaign.ready
            ? t`Enough for Grasp’s go`
            : t`Grasp opens from ${threshold}%`,
          variant: campaign.ready ? "success" : "default",
        },
      ]}
    />
  );
};

/** A team's numbers in one sentence, as far as the admin may see them. */
const useTeamWords = (team: CampaignTeam): string => {
  const { t } = useLingui();
  const leastAsked = minTeamShown;
  const leastTalked = minTalkedShown;
  const { asked, talked } = team;
  if (asked === null) {
    return t`Fewer than ${leastAsked} people were asked: too few to show numbers.`;
  }
  if (talked === null) {
    return t`${asked} asked. Fewer than ${leastTalked} have talked: too few to show more.`;
  }
  const inProgress = team.inProgress ?? 0;
  const notStarted = team.notStarted ?? 0;
  return t`${talked} of ${asked} talked, ${inProgress} in progress, ${notStarted} not started.`;
};

/** Whether the interviews run today: a nudge goes only then. */
const runsToday = (campaign: Campaign): boolean =>
  todayIndex(campaign) >= 0 && campaign.today <= campaign.closes;

/**
 * One team: its name, whether its lead talked, whether it is quiet, its
 * numbers, and the nudge: Grasp's reminder to whoever in it hasn't
 * finished, whom the admin never sees. Core takes one a day for a team,
 * and none for a team under five: its refusal is said in the row.
 */
const TeamRow = ({
  campaign,
  team,
  onChanged,
}: {
  campaign: Campaign;
  team: CampaignTeam;
  onChanged: () => Promise<void>;
}) => {
  const { t, i18n } = useLingui();
  const core = useCore();
  const [mailed, setMailed] = useState<number>();
  const [failure, setFailure] = useState<string>();
  const name = say(i18n, rowName(team, isGrouped(campaign)));
  const numbers = useTeamWords(team);
  const nudgedToday = campaign.asks.some(
    (ask) => ask.kind === "quiet" && ask.team === team.id && ask.nudged
  );
  const everyoneTalked =
    team.asked !== null && team.talked !== null && team.talked >= team.asked;
  const mayNudge =
    runsToday(campaign) &&
    team.asked !== null &&
    !everyoneTalked &&
    !nudgedToday &&
    mailed === undefined;
  const nudge = async (): Promise<void> => {
    setFailure(undefined);
    try {
      const sent = await core.withSession(
        async (session) => await session.onboarding.nudge(team.id)
      );
      setMailed(sent.mailed);
    } catch (error) {
      setFailure(failureText(error));
      throw error;
    }
    await onChanged();
  };
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>
          {name}{" "}
          {team.quiet ? (
            <Badge size="sm" variant="warning">{t`Quiet`}</Badge>
          ) : null}{" "}
          {team.led ? (
            <Badge size="sm" variant={team.leadTalked ? "success" : "outline"}>
              {team.leadTalked ? t`Lead talked` : t`Lead not yet`}
            </Badge>
          ) : null}{" "}
          {nudgedToday || mailed !== undefined ? (
            <Badge size="sm" variant="secondary">{t`Nudged today`}</Badge>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          <RowNote failure={failure}>
            {mailed === undefined
              ? numbers
              : plural(mailed, {
                  one: "Your nudge went to # person.",
                  other: "Your nudge went to # people.",
                })}
          </RowNote>
        </ItemDescription>
      </ItemContent>
      {mayNudge ? (
        <ItemActions>
          <Button
            aria-label={t`Nudge ${name}`}
            errorText={t`Not sent`}
            onClick={nudge}
            size="sm"
            successText={t`Sent`}
            variant="outline"
          >
            {t`Nudge`}
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
};

/** Every team that takes part, in the staff list's order. */
const Teams = ({
  campaign,
  onChanged,
}: {
  campaign: Campaign;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const leastAsked = minTeamShown;
  const leastTalked = minTalkedShown;
  return (
    <SettingsGroup
      description={t`A nudge sends Grasp’s reminder to everyone in a team who hasn’t finished, once a day at most.`}
      flush
      footer={
        <Text color="muted" size="xs">
          {t`A team shows its numbers once ${leastAsked} people in it were asked and ${leastTalked} have talked, so nobody can be singled out. Nobody here sees who talked or what anyone said.`}
        </Text>
      }
      title={t`By team`}
    >
      <ItemGroup aria-label={t`By team`} separated>
        {campaign.teams.map((team) => (
          <TeamRow
            campaign={campaign}
            key={team.id}
            onChanged={onChanged}
            team={team}
          />
        ))}
      </ItemGroup>
    </SettingsGroup>
  );
};

/** The names of a team's leads, as the staff list has them; none for an erased lead. */
const leadNames = (view: OnboardingView, team: string): string[] => {
  const listed = view.roster?.teams.find(({ id }) => id === team);
  if (listed === undefined) {
    return [];
  }
  const names = new Map(
    view.roster?.people.map((person) => [person.id, person.name])
  );
  return leadsOfTeam(listed).flatMap((lead) => {
    const name = names.get(lead) ?? "";
    return name === "" ? [] : [name];
  });
};

/** A lead still to talk: the company knows its own leads, so they are named. */
const LeadWaiting = ({
  team,
  name,
  leads,
}: {
  team: CampaignTeam;
  name: string;
  leads: string[];
}) => {
  const { t } = useLingui();
  const names = formatList(leads);
  let words = t`Its lead hasn’t talked yet.`;
  if (leads.length === 1) {
    words = t`${names}, its lead, hasn’t talked yet.`;
  } else if (leads.length > 1) {
    words = t`None of its leads has talked yet: ${names}.`;
  }
  return (
    <Item key={team.id} size="xs">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>{words}</ItemDescription>
      </ItemContent>
    </Item>
  );
};

/** How many of a team are still to talk, where its numbers show. */
const ColleaguesWaiting = ({
  team,
  name,
}: {
  team: CampaignTeam;
  name: string;
}) => {
  const { t } = useLingui();
  const asked = team.asked ?? 0;
  const leastTalked = minTalkedShown;
  const waiting = asked - (team.talked ?? 0);
  const notStarted = team.notStarted ?? 0;
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        <ItemDescription>
          {team.talked === null
            ? t`Fewer than ${leastTalked} of its ${asked} have talked so far.`
            : plural(waiting, {
                one: `# person is still to talk; ${notStarted} of them haven’t started.`,
                other: `# people are still to talk; ${notStarted} of them haven’t started.`,
              })}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
};

/**
 * Who still has to talk, as far as the admin may know: the leads by name,
 * everyone else as a number per team whose numbers show.
 */
const StillToTalk = ({
  campaign,
  view,
}: {
  campaign: Campaign;
  view: OnboardingView;
}) => {
  const { t, i18n } = useLingui();
  const grouped = isGrouped(campaign);
  const nameOf = (team: CampaignTeam): string =>
    say(i18n, rowName(team, grouped));
  const leads = campaign.teams.filter((team) => team.led && !team.leadTalked);
  const colleagues = campaign.teams.filter(
    (team) =>
      team.asked !== null && (team.talked === null || team.talked < team.asked)
  );
  const hidden = campaign.teams.filter((team) => team.asked === null).length;
  const nobody = leads.length === 0 && colleagues.length === 0;
  return (
    <SettingsGroup
      flush={!nobody}
      footer={
        hidden === 0 ? undefined : (
          <Text color="muted" size="xs">
            {plural(hidden, {
              one: "One team is too small to show how many of it are still to talk.",
              other:
                "# teams are too small to show how many of them are still to talk.",
            })}
          </Text>
        )
      }
      title={t`Still to talk`}
    >
      {nobody ? (
        <Text color="muted">{t`Everyone the numbers cover has talked.`}</Text>
      ) : null}
      {leads.length === 0 ? null : (
        <NamedRows label={t`Team leads`}>
          <ItemGroup aria-label={t`Team leads still to talk`} separated>
            {leads.map((team) => (
              <LeadWaiting
                key={team.id}
                leads={leadNames(view, team.id)}
                name={nameOf(team)}
                team={team}
              />
            ))}
          </ItemGroup>
        </NamedRows>
      )}
      {colleagues.length === 0 ? null : (
        <NamedRows label={t`Colleagues`}>
          <ItemGroup aria-label={t`Colleagues still to talk`} separated>
            {colleagues.map((team) => (
              <ColleaguesWaiting
                key={team.id}
                name={nameOf(team)}
                team={team}
              />
            ))}
          </ItemGroup>
        </NamedRows>
      )}
    </SettingsGroup>
  );
};

/** How tall the days' chart stands: a small one, under the lists. */
const daysChartHeight = 180;

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
  return (
    <SettingsGroup
      description={t`Interviews finished on each day, in the teams whose numbers show.`}
      title={t`Talks per day`}
    >
      {total === 0 ? (
        <Text color="muted">
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
      )}
    </SettingsGroup>
  );
};

/** The plan's facts, and the way to the campaign page. */
const Schedule = ({
  campaign,
  view,
}: {
  campaign: Campaign;
  view: OnboardingView;
}) => {
  const { t } = useLingui();
  const wait = remindAfterWorkingDays;
  const domain = view.mailDomain;
  let mailHelp = t`You send every link yourself, from Links on this page.`;
  if (view.mailSends) {
    mailHelp =
      domain === null
        ? t`Grasp emails everyone their own link on their day.`
        : t`Grasp emails everyone their own link on their day, from ${domain}.`;
  }
  return (
    <SettingsGroup flush title={t`Schedule`}>
      <FieldGroup>
        <ReadOnlyRow label={t`First day`} value={formatDay(campaign.start)} />
        <ReadOnlyRow
          help={t`The links close after this day`}
          label={t`Last day`}
          value={formatDay(campaign.closes)}
        />
        <ReadOnlyRow
          help={mailHelp}
          label={t`Links`}
          value={view.mailSends ? t`Emailed by Grasp` : t`Sent by you`}
        />
        <ReadOnlyRow
          help={t`To whoever hasn’t finished by then. A nudge of yours comes on top.`}
          label={t`Grasp’s reminder`}
          value={plural(wait, {
            one: "Once, after # working day",
            other: "Once, after # working days",
          })}
        />
        <SettingRow
          help={t`The week as a drawing, team by team`}
          label={t`Campaign page`}
        >
          <CampaignLink />
        </SettingRow>
      </FieldGroup>
    </SettingsGroup>
  );
};

/** The section once read: nothing to show before the list and the plan are in. */
const Interviews = ({
  data,
  onChanged,
}: {
  data: InterviewsData;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { view, campaign, links } = data;
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
    <>
      <Notices view={view} />
      <Glance campaign={campaign} />
      <Teams campaign={campaign} onChanged={onChanged} />
      <StillToTalk campaign={campaign} view={view} />
      <InterviewLinks
        campaign={campaign}
        links={links}
        mailSends={view.mailSends}
        onChanged={onChanged}
      />
      <PerDay campaign={campaign} />
      <Schedule campaign={campaign} view={view} />
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
    return (
      <SettingsGroup title={t`Progress`}>
        <LoadingLines lines={4} />
      </SettingsGroup>
    );
  }
  return loaded.state === "ready" ? (
    <Interviews data={loaded.data} onChanged={reload} />
  ) : (
    <SettingsGroup title={t`Progress`}>
      <NotLoadedState heading="h3" page={loaded} reread={reload} />
    </SettingsGroup>
  );
};
