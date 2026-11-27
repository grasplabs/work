// The campaign page, what the admin sees while the interviews run: where
// they stand, what needs the admin, and the week in dots, one row per
// team, one column per day, a square for every person who talked, as far
// as the admin may count them. A phone shows the week and says where the
// rest is.
import type {
  Campaign,
  CampaignTeam,
} from "@grasp-os/shared/onboarding-campaign";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Asks } from "./campaign-asks.tsx";
import {
  isGrouped,
  knownWords,
  rowName,
  runningWords,
  say,
  statementOf,
  talkedWords,
  todayIndex,
} from "./campaign-words.ts";
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
      default: "minmax(0, 11rem) minmax(0, 1fr)",
      [media.maxSm]: "minmax(0, 9.5rem) minmax(0, 1fr)",
    },
    columnGap: { default: space[8], [media.maxSm]: space[4] },
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
  lines: { flexDirection: "column" },
});

/** The week's days as one letter each, today's in full ink. */
const DayLetters = ({ campaign }: { campaign: Campaign }) => {
  const { i18n } = useLingui();
  const { days } = campaign;
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

/** A team's days with nothing counted on them: all a team shows whose numbers aren't the admin's. */
const noneCounted = (campaign: Campaign): number[] =>
  Array.from({ length: campaign.days }, () => 0);

/** One team's row: its name and numbers, then its week. */
const TeamRow = ({
  campaign,
  team,
}: {
  campaign: Campaign;
  team: CampaignTeam;
}) => {
  const { t, i18n } = useLingui();
  const name = say(i18n, rowName(team, isGrouped(campaign)));
  const words = talkedWords(team);
  const counted = words === null ? null : i18n._(words);
  return (
    <>
      <div {...stylex.props(styles.team)}>
        <Text as="span" color="default" size="lg" truncate>
          {name}
        </Text>
        {counted === null ? null : (
          <Text as="span" color="muted" size="lg" truncate>
            {counted}
          </Text>
        )}
      </div>
      <div {...stylex.props(styles.drawing)}>
        <WeekDrawing
          counts={team.byDay ?? noneCounted(campaign)}
          label={
            counted === null || team.byDay === null
              ? name
              : t`${name}: ${counted}, day by day`
          }
          today={todayIndex(campaign)}
        />
      </div>
    </>
  );
};

/** The campaign page's content, as core tells the campaign. */
export const CampaignWeek = ({
  campaign,
  onChanged,
}: {
  campaign: Campaign;
  /** Called once the admin did something that changes what core tells. */
  onChanged: () => Promise<void>;
}) => {
  const { t, i18n } = useLingui();
  const { lead, rest } = statementOf(campaign);
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.statement)}>
        <Heading level={1} size="xl">
          {i18n._(lead)}
        </Heading>
        <Text size="lg">{i18n._(rest)}</Text>
      </header>
      <div {...stylex.props(styles.wide)}>
        <Asks asks={campaign.asks} onChanged={onChanged} />
      </div>
      <div {...stylex.props(styles.week)}>
        <DayLetters campaign={campaign} />
        {campaign.teams.map((each) => (
          <TeamRow campaign={campaign} key={each.id} team={each} />
        ))}
      </div>
      <div {...stylex.props(styles.wide, styles.lines)}>
        <Text color="muted" size="lg">
          {i18n._(runningWords(campaign))}
        </Text>
        <Text color="muted" size="lg">
          {i18n._(knownWords(campaign))}
        </Text>
      </div>
      <div {...stylex.props(styles.phone)}>
        <Text color="muted" size="lg">
          {t`The whole picture is on your computer.`}
        </Text>
      </div>
    </div>
  );
};
