// The campaign page, what the admin sees while the interviews run: is it
// going well, what needs them, and the week in dots, one row per team,
// one column per day, a square for every person who talked. On a wide
// screen the one thing Grasp learned in a team stands beside its row; on
// a narrower one the findings follow the week as a short list, so neither
// is squeezed. A phone shows the week and says where the rest is.
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

import { Asks } from "./campaign-asks.tsx";
import { AllFindings } from "./campaign-findings.tsx";
import {
  dayCount,
  declinedWords,
  findingWords,
  rowName,
  runningWords,
  say,
  statementOf,
  talkedWords,
  todayIndex,
} from "./campaign-words.ts";
import { findingsOf, talkedByDay } from "./fixtures.ts";
import type { Campaign, TeamPicture } from "./fixtures.ts";
import { WeekDrawing } from "./week-drawing.tsx";

/** How tall a team's row stands at least: room for a pile four high. */
const ROW_HEIGHT = { default: "6rem", [media.maxSm]: "4rem" };

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space[12], [media.maxSm]: space[8] },
  },
  statement: { display: "flex", flexDirection: "column", gap: space[3] },
  // Left out on a phone: the admin's onboarding is meant for a computer.
  wide: { display: { default: "flex", [media.maxSm]: "none" } },
  phone: { display: { default: "none", [media.maxSm]: "block" } },
  week: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 11rem) minmax(0, 1fr) minmax(0, 20rem)",
      [media.maxLg]: "minmax(0, 11rem) minmax(0, 1fr)",
      [media.maxSm]: "minmax(0, 9.5rem) minmax(0, 1fr)",
    },
    columnGap: { default: space[8], [media.maxSm]: space[4] },
  },
  // Before anything is learned, the week takes the findings' room too.
  weekAlone: {
    gridTemplateColumns: {
      default: "minmax(0, 11rem) minmax(0, 1fr)",
      [media.maxSm]: "minmax(0, 9.5rem) minmax(0, 1fr)",
    },
  },
  letters: {
    display: "grid",
    gridTemplateColumns: "repeat(var(--days), minmax(0, 1fr))",
    justifyItems: "center",
    gridColumn: "2",
    paddingBlockEnd: space[2],
  },
  days: (days: number) => ({ "--days": days }),
  team: {
    gridColumn: "1",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    minWidth: 0,
    minHeight: ROW_HEIGHT,
  },
  drawing: { gridColumn: "2", minHeight: ROW_HEIGHT },
  beside: {
    gridColumn: "3",
    display: { default: "flex", [media.maxLg]: "none" },
    flexDirection: "column",
    justifyContent: "center",
    gap: space[2],
    paddingBlock: space[4],
  },
  // Below a wide screen the findings follow the week, one a team.
  after: {
    display: { default: "none", [media.maxLg]: "flex", [media.maxSm]: "none" },
    flexDirection: "column",
    gap: space[3],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  foot: {
    alignItems: "flex-end",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space[4],
  },
  lines: { display: "flex", flexDirection: "column" },
});

/** The week's days as one letter each, today's in full ink. */
const DayLetters = ({ campaign }: { campaign: Campaign }) => {
  const { i18n } = useLingui();
  const days = dayCount(campaign);
  const today = todayIndex(campaign);
  const letter = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "narrow",
    timeZone: "UTC",
  });
  return (
    <div aria-hidden {...stylex.props(styles.letters, styles.days(days))}>
      {Array.from({ length: days }, (_, day) => {
        const date = new Date(Date.parse(`${campaign.start}T00:00:00Z`));
        date.setUTCDate(date.getUTCDate() + day);
        return (
          <Text
            as="span"
            color={day === today ? "default" : "muted"}
            key={date.toISOString()}
            size="xs"
          >
            {letter.format(date)}
          </Text>
        );
      })}
    </div>
  );
};

/** What Grasp learned in a team, beside its row: the first, or all for a company without teams. */
const Beside = ({ team, grouped }: { team: TeamPicture; grouped: boolean }) => {
  const { t, i18n } = useLingui();
  const shown = grouped ? team.findings.slice(0, 1) : team.findings;
  return (
    <div {...stylex.props(styles.beside)}>
      {shown.length === 0 ? (
        <Text color="muted" size="lg">{t`Nothing learned here yet.`}</Text>
      ) : (
        shown.map((finding) => (
          <Text color="default" key={finding.id} size="lg">
            {say(i18n, findingWords(finding, grouped))}
          </Text>
        ))
      )}
    </div>
  );
};

/** The findings after the week, below a wide screen: one a team, its name first. */
const After = ({ campaign }: { campaign: Campaign }) => {
  const { i18n } = useLingui();
  const { grouped } = campaign;
  const lines = campaign.teams.flatMap((each) =>
    (grouped ? each.findings.slice(0, 1) : each.findings).map((finding) => {
      const words = say(i18n, findingWords(finding, grouped));
      const team = each.name;
      return {
        id: finding.id,
        words: grouped ? i18n._(msg`${team}: ${words}`) : words,
      };
    })
  );
  return (
    <ul {...stylex.props(styles.after)}>
      {lines.map((line) => (
        <li key={line.id}>
          <Text color="default" size="lg">
            {line.words}
          </Text>
        </li>
      ))}
    </ul>
  );
};

/** The campaign page's content, in one state. */
export const CampaignWeek = ({ campaign }: { campaign: Campaign }) => {
  const { t, i18n } = useLingui();
  const { lead, rest } = statementOf(campaign);
  const { grouped } = campaign;
  const today = todayIndex(campaign);
  const learned = findingsOf(campaign).length > 0;
  // The sheet holds more than the page only where a team has more than its first finding.
  const more =
    grouped && campaign.teams.some((each) => each.findings.length > 1);
  const declined = declinedWords(campaign);
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.statement)}>
        <Heading level={1} size="xl">
          {i18n._(lead)}
        </Heading>
        <Text size="lg">{i18n._(rest)}</Text>
      </header>
      <div {...stylex.props(styles.wide)}>
        <Asks asks={campaign.asks} />
      </div>
      <div {...stylex.props(styles.week, !learned && styles.weekAlone)}>
        <DayLetters campaign={campaign} />
        {campaign.teams.map((each) => {
          const name = say(i18n, rowName(each, grouped));
          const counted = i18n._(talkedWords(each));
          return (
            <Fragment key={each.id}>
              <div {...stylex.props(styles.team)}>
                <Text as="span" color="default" size="lg" truncate>
                  {name}
                </Text>
                <Text as="span" color="muted" size="lg" truncate>
                  {counted}
                </Text>
              </div>
              <div {...stylex.props(styles.drawing)}>
                <WeekDrawing
                  counts={talkedByDay(each, campaign)}
                  label={t`${name}: ${counted}, day by day`}
                  today={today}
                />
              </div>
              {learned ? <Beside grouped={grouped} team={each} /> : null}
            </Fragment>
          );
        })}
      </div>
      {learned ? (
        <After campaign={campaign} />
      ) : (
        <div {...stylex.props(styles.wide)}>
          <Text color="muted" size="lg">
            {t`Nothing learned yet. The first findings come tomorrow.`}
          </Text>
        </div>
      )}
      <div {...stylex.props(styles.wide, styles.foot)}>
        <div {...stylex.props(styles.lines)}>
          <Text color="muted" size="lg">
            {i18n._(runningWords(campaign))}
          </Text>
          {declined === null ? null : (
            <Text color="muted" size="lg">
              {i18n._(declined)}
            </Text>
          )}
        </div>
        {more ? <AllFindings campaign={campaign} /> : null}
      </div>
      <div {...stylex.props(styles.phone)}>
        <Text color="muted" size="lg">
          {t`The whole picture is on your computer.`}
        </Text>
      </div>
    </div>
  );
};
