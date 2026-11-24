// Concept C, the week in dots: one row per team, one column per day of
// the campaign, and in each day a small square for every person who
// talked then, drawn in pixels as the brand draws. Today's column holds
// the light; the days to come wait as single dots. Beside each row the one
// thing Grasp learned there. A team under five shows only its lead's
// square; a company without teams has one row and no names.
import { AgentIndicator } from "@grasp-os/ui/components/agent-indicator";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import {
  AllFindings,
  AskList,
  OnYourComputer,
  wide,
} from "./campaign-parts.tsx";
import {
  dayCount,
  statementOf,
  talkedWords,
  whenWords,
} from "./campaign-words.ts";
import { daysBetween, talkedByDay } from "./fixtures.ts";
import type { Campaign, TeamPicture } from "./fixtures.ts";
import { usePixels } from "./pixels.ts";
import type { Put } from "./pixels.ts";

/** The rows' columns: the team, its week, what Grasp learned there. */
const ROW = {
  default: "10rem minmax(14rem, 22rem) minmax(0, 1fr)",
  [media.maxMd]: "minmax(0, 1fr)",
};

const styles = stylex.create({
  page: { display: "flex", flexDirection: "column", gap: space[10] },
  statement: { display: "flex", flexDirection: "column", gap: space[2] },
  table: { display: "flex", flexDirection: "column" },
  row: {
    display: "grid",
    gridTemplateColumns: ROW,
    alignItems: "center",
    columnGap: space[8],
    rowGap: space[2],
    paddingBlock: space[3],
  },
  team: { display: "flex", flexDirection: "column", minWidth: 0 },
  days: {
    display: "grid",
    gridTemplateColumns: "repeat(var(--days), minmax(0, 1fr))",
    justifyItems: "center",
  },
  daysCount: (days: number) => ({ "--days": days }),
  // The week's letters stand over the dots alone.
  head: { gridColumn: { default: "2", [media.maxMd]: "1" } },
  canvas: {
    display: "block",
    width: "100%",
    height: "3rem",
    imageRendering: "pixelated",
  },
  foot: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space[3],
  },
  when: { display: "flex", alignItems: "center", gap: space[2] },
});

/** A square is three cells, a cell apart, piled two wide and up to four high in a day. */
const SQUARE = 3;
const PITCH = SQUARE + 1;
const WIDE = 2;
const HIGH = 4;

const square = (
  put: Put,
  x: number,
  y: number,
  tone: "foreground" | "mint" | "border"
) => {
  for (let dx = 0; dx < SQUARE; dx += 1) {
    for (let dy = 0; dy < SQUARE; dy += 1) {
      put(x + dx, y + dy, tone);
    }
  }
};

/** One team's week: each day's squares, today's in the light, the days to come a single dot. */
const drawWeek =
  (counts: number[], today: number) =>
  (columns: number, rows: number, put: Put) => {
    const width = columns / counts.length;
    const foot = rows - SQUARE;
    for (const [day, count] of counts.entries()) {
      const left = Math.floor(day * width + (width - (WIDE * PITCH - 1)) / 2);
      if (day > today) {
        // A day to come: one quiet square where its pile will start.
        square(put, left, foot, "border");
        square(put, left + PITCH, foot, "border");
        continue;
      }
      const shown = Math.min(count, WIDE * HIGH);
      for (let i = 0; i < shown; i += 1) {
        // From the foot up, as a pile.
        const x = left + (i % WIDE) * PITCH;
        const y = foot - Math.floor(i / WIDE) * PITCH;
        square(put, x, y, day === today ? "mint" : "foreground");
      }
    }
  };

const Week = ({
  team,
  campaign,
  label,
}: {
  team: TeamPicture;
  campaign: Campaign;
  label: string;
}) => {
  const today = daysBetween(campaign.start, campaign.today);
  const canvas = usePixels(3, drawWeek(talkedByDay(team, campaign), today));
  return (
    <div>
      <span {...stylex.props(visuallyHidden)}>{label}</span>
      <canvas aria-hidden ref={canvas} {...stylex.props(styles.canvas)} />
    </div>
  );
};

/** The week's days as one letter each, today's in full ink. */
const DayLetters = ({ campaign }: { campaign: Campaign }) => {
  const days = dayCount(campaign);
  const today = daysBetween(campaign.start, campaign.today);
  return (
    <div
      aria-hidden
      {...stylex.props(styles.days, styles.daysCount(days), styles.head)}
    >
      {Array.from({ length: days }, (_, day) => {
        const date = new Date(Date.parse(`${campaign.start}T00:00:00Z`));
        date.setUTCDate(date.getUTCDate() + day);
        const letter = new Intl.DateTimeFormat("en", {
          weekday: "narrow",
          timeZone: "UTC",
        }).format(date);
        return (
          <Text
            as="span"
            color={day === today ? "default" : "muted"}
            key={letter + String(day)}
            size="xs"
            weight={day === today ? "medium" : "normal"}
          >
            {letter}
          </Text>
        );
      })}
    </div>
  );
};

/** Concept C: the campaign page as the week, in dots. */
export const CampaignDots = ({ campaign }: { campaign: Campaign }) => {
  const { lead, rest } = statementOf(campaign);
  const enough = campaign.pace === "enough";
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.statement)}>
        <Heading level={1} size="lg">
          {lead}
        </Heading>
        <Text size="lg" color="muted">
          {rest}
        </Text>
      </header>
      <div {...stylex.props(styles.table)}>
        <div {...stylex.props(styles.row)}>
          <DayLetters campaign={campaign} />
        </div>
        {campaign.teams.map((each) => {
          const counted = talkedWords(each, campaign.grouped);
          const [first] = each.findings;
          return (
            <div key={each.id} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.team)}>
                <Text as="span" size="sm" truncate weight="medium">
                  {campaign.grouped ? each.name : "Everyone"}
                </Text>
                <Text as="span" size="xs" color="muted">
                  {counted}
                </Text>
              </span>
              <Week
                campaign={campaign}
                label={`${campaign.grouped ? each.name : "Everyone"}: ${counted}, day by day`}
                team={each}
              />
              <span {...stylex.props(wide.only)}>
                <Text
                  color={first === undefined ? "muted" : "default"}
                  size="sm"
                >
                  {first?.text ?? "Nothing learned yet."}
                </Text>
              </span>
            </div>
          );
        })}
      </div>
      <OnYourComputer />
      <div {...stylex.props(wide.only)}>
        <AskList campaign={campaign} />
      </div>
      <div {...stylex.props(wide.only)}>
        <div {...stylex.props(styles.foot)}>
          <span {...stylex.props(styles.when)}>
            <AgentIndicator
              aria-label={enough ? "Done listening" : "Grasp is listening"}
              success={enough}
            />
            <Text as="span" size="sm" color="muted">
              {`${whenWords(campaign)} · ${campaign.known}% known`}
            </Text>
          </span>
          <AllFindings campaign={campaign} />
        </div>
      </div>
    </div>
  );
};
