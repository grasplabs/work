import { minTalkedShown } from "@grasp-os/shared/onboarding";
import type { LinkToSend, TeamProgress } from "@grasp-os/shared/onboarding";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { copyText } from "../copy.ts";
import { downloadCsv } from "../csv.ts";
import type { Interviews } from "../dashboard/waiting.ts";
import { formatDate, formatList } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Avatar } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { ArrowRight, Copy, Download, Tick } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Progress } from "../grasp/progress/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { StatsGrid } from "../grasp/stats/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { quietTeamOf } from "../onboarding/interviews-progress.tsx";
import { fullLink, linksCsv, linksOf } from "../onboarding/links-to-send.ts";
import { closesOn, listeningOf, teamNumbersOf } from "../onboarding/setup.ts";
import type { Listening } from "../onboarding/setup.ts";
import { useCoreAction } from "../use-core-action.ts";

// The onboarding's interviews as the inbox's pinned item, for the admins
// Settings, Onboarding was for: what keeps the links from going out, how
// far the days are, the leads and colleagues who talked, every team (a
// team under five only as whether its lead talked, so nobody can be
// singled out), and everyone's own link to copy or take as a list. The
// numbers and rules are the onboarding's own (onboarding/setup.ts,
// links-to-send.ts, interviews-progress.tsx), read as Settings read them.

const styles = stylex.create({
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    minWidth: 0,
  },
  days: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  teamFigure: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
  },
  teamBar: { width: "6rem", flexShrink: 0 },
});

/** A date as the page's language writes it, from an ISO day. */
const formatDay = (day: string): string => formatDate(`${day}T12:00:00Z`);

/** One team: how many talked of those asked, or, for a small team, whether its lead did. */
const TeamRow = ({ team }: { team: TeamProgress }) => {
  const { t } = useLingui();
  const numbers = teamNumbersOf(team);
  const least = minTalkedShown;
  let figure = (
    <Badge size="sm" tone={team.leadTalked ? "success" : "neutral"}>
      {team.leadTalked ? t`Lead talked` : t`Lead not yet`}
    </Badge>
  );
  if (numbers.shown === "both") {
    const { talked, asked } = numbers;
    figure = (
      <span {...stylex.props(styles.teamFigure)}>
        <Progress
          label={team.name}
          layout={styles.teamBar}
          max={Math.max(asked, 1)}
          showLabel={false}
          size="sm"
          value={talked}
          valueText={() => t`${talked} of ${asked}`}
        />
        <Text element="span" size="xs" tone="muted" wrap="truncate">
          {t`${talked} of ${asked}`}
        </Text>
      </span>
    );
  } else if (numbers.shown === "asked") {
    const { asked } = numbers;
    figure = (
      <Text element="span" size="xs" tone="muted">
        {t`Fewer than ${least} of ${asked}`}
      </Text>
    );
  }
  return (
    <Item size="xs">
      <ItemContent>
        <ItemTitle>{team.name}</ItemTitle>
      </ItemContent>
      <ItemActions>{figure}</ItemActions>
    </Item>
  );
};

/**
 * Everyone's own link, to send from the company's own mail or chat: one
 * by one, or the new ones (or all out) as a list. Taking one tells core,
 * which keeps it for next time, so nobody gets theirs twice.
 */
const LinksToSend = ({ links }: { links: LinkToSend[] }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { run, failure } = useCoreAction();
  const [copied, setCopied] = useState<string | null>(null);
  const { out, fresh, list } = linksOf(links);
  const { origin } = window.location;
  const taken = async (people: string[]) => {
    if (people.length === 0) {
      return;
    }
    await run(async (session) => {
      await session.onboarding.linksTaken(people);
    });
    await router.invalidate();
  };
  const freshCount = fresh.length;
  const outCount = out.length;
  /** What a link's row says of it, under its owner's name. */
  const stateOf = (link: LinkToSend): string => {
    const { team } = link;
    if (link.mailFailed) {
      return t`${team} · our email didn’t reach them`;
    }
    if (link.fresh) {
      return t`${team} · new`;
    }
    return link.path === null ? t`${team} · not out yet` : team;
  };
  const copy = async (link: LinkToSend) => {
    if (link.path === null || !(await copyText(fullLink(link.path, origin)))) {
      return;
    }
    setCopied(link.person);
    if (link.fresh) {
      await taken([link.person]);
    }
  };
  return (
    <SectionCard
      actions={
        <Button
          disabled={list.length === 0}
          icon={Download}
          onClick={() => {
            downloadCsv(
              linksCsv(list, origin, [t`Name`, t`Email`, t`Team`, t`Link`]),
              "grasp-links.csv"
            );
            void taken(list.map(({ person }) => person));
          }}
          size="sm"
          variant="quiet"
        >
          {freshCount > 0
            ? plural(freshCount, {
                one: "# new, as a list",
                other: "# new, as a list",
              })
            : plural(outCount, {
                one: "# out, as a list",
                other: "# out, as a list",
              })}
        </Button>
      }
      density="compact"
      description={t`Each link is its owner's own: send it only to them.`}
      flush
      title={t`Links to send`}
    >
      {failure === undefined ? null : <Alert variant="danger">{failure}</Alert>}
      <ItemGroup aria-label={t`Links to send`} separated>
        {links.map((link) => {
          const { name } = link;
          return (
            <Item key={link.person} size="xs">
              <ItemMedia>
                <Avatar name={name} size="xs" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
                <ItemDescription>{stateOf(link)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  disabled={link.path === null}
                  icon={copied === link.person ? Tick : Copy}
                  aria-label={t`Copy the link for ${name}`}
                  onClick={() => {
                    void copy(link);
                  }}
                  size="sm"
                  variant="ghost"
                />
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </SectionCard>
  );
};

/** What keeps the links from going out, who didn't get theirs, and the team gone quiet. */
const Notes = ({
  interviews: { view, links },
  listening,
}: {
  interviews: Interviews;
  listening: Listening;
}) => {
  const { t } = useLingui();
  const quiet = quietTeamOf(view, listening);
  const quietTeam = quiet?.team.name ?? "";
  const quietLead = quiet?.lead ?? "";
  const failed = links.filter(({ mailFailed }) => mailFailed);
  const unreached = formatList(failed.map(({ name }) => name));
  return (
    <>
      {view.plan === null && view.roster !== null ? (
        <Text size="sm" tone="muted">
          {t`Stephen talks to nobody until you pick the day the interviews start.`}
        </Text>
      ) : null}
      {view.paused ? (
        <Alert variant="attention">
          {t`Paused: no link opens and none goes out.`}
        </Alert>
      ) : null}
      {view.agreed ? null : (
        <Alert>
          {t`Grasp is still putting the agreements in place. The links go out once that is done.`}
        </Alert>
      )}
      {failed.length === 0 ? null : (
        <Alert variant="danger">
          {t`Our email didn’t reach ${unreached}. Copy their link below and send it yourself.`}
        </Alert>
      )}
      {quiet === undefined ? null : (
        <Alert variant="attention">
          {t`${quietTeam} is quiet. A word from ${quietLead}, their lead, usually helps.`}
        </Alert>
      )}
    </>
  );
};

/** How far the days are, and the leads and colleagues who talked. */
const Days = ({
  interviews: { view },
  listening,
  today,
}: {
  interviews: Interviews;
  listening: Listening;
  today: string;
}) => {
  const { t } = useLingui();
  const { plan, progress } = view;
  if (plan === null) {
    return null;
  }
  const { days, leadsHeard, colleaguesHeard } = listening;
  const day = Math.max(listening.day, plan.start <= today ? 1 : 0);
  const leads = progress?.leads ?? 0;
  const starts = formatDay(plan.start);
  const dayLine =
    plan.start > today ? t`Starts ${starts}` : t`Day ${day} of ${days}`;
  return (
    <>
      <div {...stylex.props(styles.days)}>
        <Progress
          label={dayLine}
          max={days}
          showLabel={false}
          value={day}
          valueText={() => dayLine}
        />
        <Text element="span" size="xs" tone="muted">
          {dayLine}
        </Text>
      </div>
      <StatsGrid
        aria-label={t`Who talked`}
        columns={2}
        items={[
          {
            title: t`Team leads talked`,
            value: t`${leadsHeard} of ${leads}`,
          },
          { title: t`Colleagues talked`, value: String(colleaguesHeard) },
        ]}
      />
    </>
  );
};

/** The interviews, opened from the inbox's pinned item. */
export const InterviewsDetail = ({
  interviews,
  today,
}: {
  interviews: Interviews;
  today: string;
}) => {
  const { t } = useLingui();
  const { view, links } = interviews;
  const { plan } = view;
  const listening = listeningOf(view, today);
  const teams = view.progress?.teams.filter((team) => !team.off) ?? [];
  // Who works where is in, but nobody is asked yet: planning them waits in the onboarding.
  const linksToDo = plan === null && view.roster !== null;
  const closes = plan === null ? undefined : formatDay(closesOn(plan));
  return (
    <div {...stylex.props(styles.stack)}>
      <SectionCard
        actions={
          linksToDo || view.waiting > 0 ? (
            <Button
              iconEnd={ArrowRight}
              render={
                <Link
                  search={linksToDo ? { step: "team" } : { step: "listening" }}
                  to="/setup"
                />
              }
              size="sm"
              variant="ink"
            >
              {t`Open your onboarding`}
            </Button>
          ) : undefined
        }
        density="compact"
        description={closes === undefined ? undefined : t`Closes ${closes}`}
        title={t`Interviews`}
      >
        <div {...stylex.props(styles.stack)}>
          <Notes interviews={interviews} listening={listening} />
          <Days interviews={interviews} listening={listening} today={today} />
        </div>
      </SectionCard>
      {teams.length === 0 ? null : (
        <SectionCard
          density="compact"
          flush
          info={t`Teams under five show only their lead.`}
          infoLabel={t`More about the teams`}
          title={t`By team`}
        >
          <ItemGroup aria-label={t`By team`} separated>
            {teams.map((team) => (
              <TeamRow key={team.id} team={team} />
            ))}
          </ItemGroup>
        </SectionCard>
      )}
      {links.length === 0 ? null : <LinksToSend links={links} />}
    </div>
  );
};
