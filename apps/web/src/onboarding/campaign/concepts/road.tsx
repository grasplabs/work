// Concept C, the road: the interviews as one stretch of time that runs on
// past the close to the day Grasp opens. Day by day a pile of squares
// grows, one a person who talked, today's lit; the days to come show
// where this pace leads, against the line where we know enough to
// understand every team. After the close the road goes on to what we do
// with it. Under it, three short columns: what needs the admin, who we
// still need to hear, and what stood out.
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Asks } from "../campaign-asks.tsx";
import { AllFindings } from "../campaign-findings.tsx";
import {
  dayCount,
  declinedWords,
  findingWords,
  runningWords,
  say,
  statementOf,
  todayIndex,
} from "../campaign-words.ts";
import type { Campaign } from "../fixtures.ts";
import { bayerAt, usePixels } from "../pixels.ts";
import type { Put } from "../pixels.ts";
import {
  companyByDay,
  companyEnoughOf,
  dayAfter,
  projectedOf,
  standingOf,
  strikingOf,
} from "../reading.ts";
import {
  forecastWords,
  nothingForYou,
  standingWords,
} from "./concept-words.ts";
import { square } from "./seats.tsx";

/** The pile: squares three across, four cells a side, a cell apart, three pixels a cell. */
const ACROSS = 3;
const SIDE = 4;
const PITCH = SIDE + 1;
const CELL = 3;
/** The steps after the close, each a column of the road. */
const AFTER = 3;

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space[12], [media.maxSm]: space[8] },
  },
  opening: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    maxWidth: "48rem",
  },
  road: { display: "flex", flexDirection: "column", gap: space[3] },
  // On a narrow screen the road keeps its width and scrolls sideways, so no pile is squeezed.
  scroll: {
    overflowX: "auto",
    marginInline: { default: 0, [media.maxSm]: `calc(-1 * ${space[4]})` },
    paddingInline: { default: 0, [media.maxSm]: space[4] },
  },
  wide: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    minWidth: "44rem",
  },
  frame: (height: number) => ({ position: "relative", height: `${height}px` }),
  canvas: {
    position: "absolute",
    inset: 0,
    display: "block",
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
  },
  labels: {
    display: "grid",
    gridTemplateColumns: "repeat(var(--slots), minmax(0, 1fr))",
    justifyItems: "center",
    textAlign: "center",
  },
  slots: (slots: number) => ({ "--slots": slots }),
  label: { display: "flex", flexDirection: "column", alignItems: "center" },
  key: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space[6],
    rowGap: space[2],
  },
  columns: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      [media.maxLg]: "minmax(0, 1fr)",
    },
    columnGap: space[12],
    rowGap: space[10],
  },
  column: { display: "flex", flexDirection: "column", gap: space[4] },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  still: { display: "flex", flexDirection: "column" },
  foot: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space[4],
  },
  lines: { display: "flex", flexDirection: "column" },
});

/** How tall the road stands: room for everyone invited, and the ground under them. */
const roadHeight = (invited: number): number =>
  (Math.ceil(invited / ACROSS) * PITCH + 4) * CELL;

/** Where the count stands at the end of each day to come, at this pace, up to the close. */
const ahead = (campaign: Campaign, totals: number[]): number[] => {
  const today = todayIndex(campaign);
  const last = dayCount(campaign) - 1;
  const now = totals[today] ?? 0;
  const projected = projectedOf(campaign) ?? now;
  return Array.from({ length: dayCount(campaign) }, (_, day) => {
    if (day <= today) {
      return 0;
    }
    const share = (day - today) / Math.max(1, last - today);
    // The pace slows: most of what is still to come comes first.
    return Math.round(now + (projected - now) * (1 - (1 - share) ** 2));
  });
};

/** Today's light: the brand's dither, thickest at the ground. */
const light = (put: Put, left: number, ground: number, rows: number) => {
  const pile = ACROSS * PITCH - 1;
  for (let x = left - 3; x < left + pile + 3; x += 1) {
    for (let y = 0; y < ground; y += 1) {
      const near = 1 - Math.abs(y - ground) / rows;
      if (bayerAt(x, rows - y) < 0.05 + 0.22 * near * near) {
        put(x, y, "sea");
      }
    }
  }
};

/** One day's pile: who talked by its end, today's lit; a day to come, where the pace leads, empty. */
const pileOf = (
  put: Put,
  at: (index: number) => number,
  left: number,
  day: { done: number; fresh: number; waiting: number }
) => {
  for (let index = 0; index < Math.max(day.done, day.waiting); index += 1) {
    const x = left + (index % ACROSS) * PITCH;
    if (index >= day.done) {
      square(put, x, at(index), SIDE, "muted-foreground", "outline");
    } else {
      const tone = index >= day.done - day.fresh ? "pine" : "foreground";
      square(put, x, at(index), SIDE, tone, "solid");
    }
  }
};

const drawRoad =
  (campaign: Campaign) => (columns: number, rows: number, put: Put) => {
    const totals = companyByDay(campaign).map((each) => each.total);
    const future = ahead(campaign, totals);
    const days = dayCount(campaign);
    const over = campaign.pace === "enough";
    const today = over ? days - 1 : todayIndex(campaign);
    const slots = days + AFTER;
    const width = columns / slots;
    const pile = ACROSS * PITCH - 1;
    const ground = rows - 2;
    const foot = ground - 1 - SIDE;
    /** The top of the pile's line that holds square `index`, from 0. */
    const at = (index: number) => foot - Math.floor(index / ACROSS) * PITCH;
    for (let slot = 0; slot < slots; slot += 1) {
      const start = Math.floor(slot * width);
      const end = Math.floor((slot + 1) * width);
      const left = Math.floor(start + (width - pile) / 2);
      if (slot === today && !over) {
        light(put, left, ground, rows);
      }
      // The ground: solid under the days gone, dotted under what is to come.
      for (let x = start + 2; x < end - 2; x += 1) {
        if (slot <= today || x % 2 === 0) {
          put(x, ground, "border");
        }
      }
      if (slot < days) {
        const past = slot <= today;
        const done = past ? (totals[slot] ?? 0) : 0;
        const before = slot === 0 ? 0 : (totals[slot - 1] ?? 0);
        pileOf(put, at, left, {
          done,
          fresh: slot === today && !over ? done - before : 0,
          waiting: past ? 0 : (future[slot] ?? 0),
        });
      } else {
        // A step after the close: one larger square on the ground, still to come.
        const big = SIDE * 2 + 1;
        const x = Math.floor(start + (width - big) / 2);
        square(put, x, ground - 1 - big, big, "muted-foreground", "outline");
      }
    }
    // Enough to understand every team: a dotted line across the interview days.
    const enough = Math.min(campaign.invited, companyEnoughOf(campaign));
    const line = at(Math.max(0, enough - 1)) - 1;
    for (let x = 0; x < Math.floor(days * width); x += 2) {
      put(x, line, "pine");
    }
  };

/** The road as a drawing, said in words to a screen reader. */
const Road = ({ campaign }: { campaign: Campaign }) => {
  const { t, i18n } = useLingui();
  const canvas = usePixels(CELL, drawRoad(campaign));
  const days = dayCount(campaign);
  const today = todayIndex(campaign);
  const letter = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "narrow",
    timeZone: "UTC",
  });
  const date = new Intl.DateTimeFormat(i18n.locale, {
    day: "numeric",
    timeZone: "UTC",
  });
  const after = [t`Written up`, t`Your look`, t`Grasp opens`];
  const enough = companyEnoughOf(campaign);
  const { talked, invited } = campaign;
  return (
    <div {...stylex.props(styles.scroll)}>
      <div {...stylex.props(styles.wide)}>
        <div {...stylex.props(styles.frame(roadHeight(campaign.invited)))}>
          <span {...stylex.props(visuallyHidden)}>
            {t`${talked} of ${invited} have talked; ${enough} are enough to understand every team.`}
          </span>
          <canvas aria-hidden ref={canvas} {...stylex.props(styles.canvas)} />
        </div>
        <div
          aria-hidden
          {...stylex.props(styles.labels, styles.slots(days + AFTER))}
        >
          {Array.from({ length: days }, (_, day) => {
            const iso = dayAfter(campaign.start, day);
            const when = new Date(`${iso}T00:00:00Z`);
            const close = day === days - 1;
            return (
              <span key={iso} {...stylex.props(styles.label)}>
                <Text
                  as="span"
                  color={day === today ? "default" : "muted"}
                  size="xs"
                >
                  {letter.format(when)} {date.format(when)}
                </Text>
                {close ? (
                  <Text as="span" color="default" size="xs">
                    {t`Closes`}
                  </Text>
                ) : null}
              </span>
            );
          })}
          {after.map((words) => (
            <Text as="span" color="muted" key={words} size="xs">
              {words}
            </Text>
          ))}
        </div>
      </div>
    </div>
  );
};

/** The progress page as a road, in one state. */
export const RoadPage = ({ campaign }: { campaign: Campaign }) => {
  const { t, i18n } = useLingui();
  const { lead, rest } = statementOf(campaign);
  const forecast = forecastWords(i18n, campaign);
  const { grouped } = campaign;
  const still = campaign.teams.filter(
    (team) => standingOf(team, campaign) !== "heard"
  );
  const striking = strikingOf(campaign, 2);
  const declined = declinedWords(campaign);
  const enough = companyEnoughOf(campaign);
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.opening)}>
        <Heading level={1} size="xl">
          {i18n._(lead)}
        </Heading>
        <Text size="lg">
          {i18n._(rest)}
          {forecast === null ? null : ` ${i18n._(forecast)}`}
        </Text>
      </header>
      <div {...stylex.props(styles.road)}>
        <Road campaign={campaign} />
        <Text color="muted" size="sm">
          {grouped
            ? t`The dotted line: ${enough} people, enough to understand every team.`
            : t`The dotted line: ${enough} people, enough to understand the work.`}
          {campaign.pace === "enough"
            ? null
            : ` ${t`Empty squares: where this pace leads.`}`}
        </Text>
      </div>
      <div {...stylex.props(styles.columns)}>
        <section {...stylex.props(styles.column)}>
          <Heading level={2} size="xs">
            {t`For you`}
          </Heading>
          {campaign.asks.length === 0 ? (
            <Text color="muted" size="lg">
              {i18n._(nothingForYou)}
            </Text>
          ) : (
            <Asks asks={campaign.asks} />
          )}
        </section>
        <section {...stylex.props(styles.column)}>
          <Heading level={2} size="xs">
            {t`Still to hear`}
          </Heading>
          {still.length === 0 ? (
            <Text color="muted" size="lg">
              {grouped
                ? t`Every team has said enough.`
                : t`We have heard enough.`}
            </Text>
          ) : (
            <ul {...stylex.props(styles.list)}>
              {still.map((team) => (
                <li key={team.id} {...stylex.props(styles.still)}>
                  <Text as="span" color="default" size="lg">
                    {grouped ? team.name : t`Everyone`}
                  </Text>
                  <Text as="span" color="muted">
                    {i18n._(standingWords(team, campaign))}
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section {...stylex.props(styles.column)}>
          <Heading level={2} size="xs">
            {t`What stood out`}
          </Heading>
          {striking.length === 0 ? (
            <Text color="muted" size="lg">
              {t`Nothing learned yet. The first findings come tomorrow.`}
            </Text>
          ) : (
            <ul {...stylex.props(styles.list)}>
              {striking.map(({ team, finding }) => (
                <li key={finding.id}>
                  <Text color="default" size="lg">
                    {say(i18n, findingWords(finding, grouped))}
                  </Text>
                  {grouped ? (
                    <Text color="muted" size="sm">
                      {team.name}
                    </Text>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <footer {...stylex.props(styles.foot)}>
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
        <AllFindings campaign={campaign} />
      </footer>
    </div>
  );
};
