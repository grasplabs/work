// Concept D, the canvas: the company's work as Grasp learns it, built up
// on one board as interviews end. It opens blank and replays the week:
// each team's pieces of work appear under its name, the tools they run on
// pop up below and wire themselves to the teams that named them, work
// that goes from one team to another draws its line across, and what
// Grasp sees across it all, and the ideas it is forming, collect under
// the board. A day picker replays any day. Drawn as the brand draws, in
// exact pixels: lines, icons and marks on a canvas, words in the page.
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Text } from "@grasp-os/ui/components/text";
import { colors, media, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { Asks } from "../campaign-asks.tsx";
import { AllFindings } from "../campaign-findings.tsx";
import {
  dayCount,
  declinedWords,
  rowName,
  runningWords,
  say,
  statementOf,
  talkedWords,
  todayIndex,
} from "../campaign-words.ts";
import { pictureFor, pictureOn } from "../canvas-fixtures.ts";
import type {
  CanvasNote,
  CanvasPicture,
  CanvasTool,
  ToolKind,
} from "../canvas-fixtures.ts";
import type { Campaign } from "../fixtures.ts";
import { usePixels } from "../pixels.ts";
import type { Put, Tone } from "../pixels.ts";
import { dayAfter } from "../reading.ts";

/** A team's name and count, and each piece of work under it, in pixels: as the page draws them. */
const HEAD = 68;
const WORK = 44;
/** The board's cell, in pixels. */
const CELL = 2;
/** How long each day takes as the week replays. */
const BEAT = 900;

const arrive = stylex.keyframes({
  "0%": { opacity: 0, transform: "scale(0.6)" },
  "100%": { opacity: 1, transform: "scale(1)" },
});

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: { default: space[10], [media.maxSm]: space[8] },
  },
  opening: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    maxWidth: "48rem",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: space[6],
    rowGap: space[3],
  },
  days: { display: "flex", gap: space[1] },
  // On a narrow screen the board keeps its width and scrolls sideways.
  scroll: {
    overflowX: "auto",
    marginInline: { default: 0, [media.maxSm]: `calc(-1 * ${space[4]})` },
    paddingInline: { default: 0, [media.maxSm]: space[4] },
  },
  height: (height: number) => ({ height: `${height}px` }),
  board: {
    position: "relative",
    transitionProperty: { default: "height", [media.reducedMotion]: "none" },
    transitionDuration: "320ms",
    transitionTimingFunction: "steps(4, end)",
    minWidth: "56rem",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.xl,
    backgroundColor: colors.card,
    overflow: "hidden",
  },
  canvas: {
    position: "absolute",
    inset: 0,
    display: "block",
    width: "100%",
    height: "100%",
    imageRendering: "pixelated",
    pointerEvents: "none",
  },
  team: (left: number, width: number) => ({
    position: "absolute",
    top: 0,
    left: `${left * 100}%`,
    width: `${width * 100}%`,
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    padding: space[5],
  }),
  teamHead: { display: "flex", flexDirection: "column" },
  works: {
    display: "flex",
    flexDirection: "column",
    gap: space[2],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  work: {
    display: "flex",
    flexDirection: "column",
    gap: space[1],
    height: "2.25rem",
    justifyContent: "center",
    paddingInline: space[2],
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    minWidth: 0,
    transformOrigin: "left center",
  },
  popped: (delay: number) => ({
    animationName: { default: arrive, [media.reducedMotion]: "none" },
    animationDuration: "320ms",
    animationTimingFunction: "steps(4, end)",
    animationFillMode: "both",
    animationDelay: `${delay}ms`,
  }),
  tool: (x: number, top: number) => ({
    position: "absolute",
    top: `${top}px`,
    left: `${x * 100}%`,
    transform: "translateX(-50%)",
    whiteSpace: "nowrap",
  }),
  toolInner: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    paddingBlock: space[1],
    paddingInline: space[2],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    transformOrigin: "center",
  },
  handoff: (x: number, top: number) => ({
    position: "absolute",
    top: `${top}px`,
    left: `${x * 100}%`,
    transform: "translateX(-50%)",
    paddingInline: space[1],
    backgroundColor: colors.card,
    whiteSpace: "nowrap",
  }),
  blank: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  icon: (size: number) => ({
    display: "block",
    flexShrink: 0,
    width: `${size}px`,
    height: `${size}px`,
    imageRendering: "pixelated",
  }),
  dots: (width: number, height: number) => ({
    display: "block",
    width: `${width}px`,
    height: `${height}px`,
    imageRendering: "pixelated",
  }),
  key: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space[6],
    rowGap: space[2],
  },
  notes: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      [media.maxMd]: "minmax(0, 1fr)",
    },
    columnGap: space[12],
    rowGap: space[10],
  },
  column: { display: "flex", flexDirection: "column", gap: space[4] },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space[4],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  note: { display: "flex", gap: space[3], alignItems: "baseline" },
  foot: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: space[4],
  },
  lines: { display: "flex", flexDirection: "column" },
});

// The tools' pictures, seven cells a side: `#` is ink.
const icons: Record<ToolKind, readonly string[]> = {
  system: [
    "#######",
    "#######",
    "#.....#",
    "#.....#",
    "#.....#",
    "#.....#",
    "#######",
  ],
  sheet: [
    "#######",
    "#..#..#",
    "#######",
    "#..#..#",
    "#######",
    "#..#..#",
    "#######",
  ],
  chat: [
    ".#####.",
    "#.....#",
    "#.#.#.#",
    "#.....#",
    ".#####.",
    ".#.....",
    "#......",
  ],
  mail: [
    "#######",
    "##...##",
    "#.#.#.#",
    "#..#..#",
    "#.....#",
    "#.....#",
    "#######",
  ],
  paper: [
    "#####..",
    "#...##.",
    "#....##",
    "#.....#",
    "#.###.#",
    "#.....#",
    "#######",
  ],
  ai: [
    "...#...",
    "...#...",
    "..###..",
    "#######",
    "..###..",
    "...#...",
    "...#...",
  ],
};

const drawIcon =
  (kind: ToolKind, tone: Tone) =>
  (_columns: number, _rows: number, put: Put) => {
    for (const [y, line] of icons[kind].entries()) {
      for (let x = 0; x < line.length; x += 1) {
        if (line.charAt(x) === "#") {
          put(x, y, tone);
        }
      }
    }
  };

/** A tool's picture: pine for a list or sheet of someone's own, beside the systems. */
const ToolIcon = ({ kind, own }: { kind: ToolKind; own: boolean }) => {
  const canvas = usePixels(CELL, drawIcon(kind, own ? "pine" : "foreground"));
  return (
    <canvas aria-hidden ref={canvas} {...stylex.props(styles.icon(7 * CELL))} />
  );
};

/** A piece of work's steps as dots, a step told two ways in pine. */
const drawSteps =
  (steps: number, twoWays: boolean) =>
  (_columns: number, _rows: number, put: Put) => {
    for (let step = 0; step < steps; step += 1) {
      const tone = twoWays && step === steps - 2 ? "pine" : "muted-foreground";
      put(step * 3, 0, tone);
      put(step * 3 + 1, 0, tone);
      put(step * 3, 1, tone);
      put(step * 3 + 1, 1, tone);
    }
  };

const Steps = ({ steps, twoWays }: { steps: number; twoWays: boolean }) => {
  const canvas = usePixels(CELL, drawSteps(steps, twoWays));
  return (
    <canvas
      aria-hidden
      ref={canvas}
      {...stylex.props(styles.dots((steps * 3 - 1) * CELL, 2 * CELL))}
    />
  );
};

/** Where a team stands across the board, as a share of its width: its middle. */
const middleOf = (index: number, count: number): number =>
  (index + 0.5) / count;

/** Where each tool sits: under the teams that named it, in two rows so none overlap. */
const placeTools = (
  tools: readonly CanvasTool[],
  teamIds: readonly string[]
): Map<string, { x: number; row: 0 | 1 }> => {
  const xOf = (tool: CanvasTool) => {
    const xs = tool.teams.map((team) =>
      middleOf(Math.max(0, teamIds.indexOf(team)), teamIds.length)
    );
    return xs.reduce((sum, x) => sum + x, 0) / Math.max(1, xs.length);
  };
  const placed = new Map<string, { x: number; row: 0 | 1 }>();
  const last: [number, number] = [-1, -1];
  const gap = 0.165;
  for (const tool of tools.toSorted((a, b) => xOf(a) - xOf(b))) {
    let x = Math.min(0.93, Math.max(0.07, xOf(tool)));
    const row: 0 | 1 = x - last[0] >= gap || x - last[1] < x - last[0] ? 0 : 1;
    x = Math.max(x, last[row] + gap);
    last[row] = x;
    placed.set(tool.id, { x: Math.min(0.94, x), row });
  }
  return placed;
};

/** Where the board's bands fall, in pixels from its top, for what it holds on a day. */
interface Layout {
  /** Under each team's last piece of work. */
  bottoms: Map<string, number>;
  /** The line of each hand-over, in order. */
  handoffAt: (index: number) => number;
  bus: number;
  rows: readonly [number, number];
  height: number;
}

const layoutOf = (
  picture: CanvasPicture,
  teamIds: readonly string[]
): Layout => {
  const bottoms = new Map(
    teamIds.map((id) => [
      id,
      HEAD + WORK * picture.works.filter((work) => work.team === id).length,
    ])
  );
  const lowest = Math.max(HEAD + WORK, ...bottoms.values());
  const handoffTop = lowest + 28;
  const bus = handoffTop + picture.handoffs.length * 22 + 12;
  return {
    bottoms,
    handoffAt: (index) => handoffTop + index * 22,
    bus,
    rows: [bus + 36, bus + 92],
    height: Math.max(420, bus + 148),
  };
};

/** Every line on the board: tools wired to their teams, and work going from team to team. */
const drawBoard =
  (
    picture: CanvasPicture,
    teamIds: readonly string[],
    places: Map<string, { x: number; row: 0 | 1 }>,
    layout: Layout,
    today: number
  ) =>
  (columns: number, _rows: number, put: Put) => {
    const cellX = (share: number) => Math.round(share * columns);
    const cellY = (pixels: number) => Math.round(pixels / CELL);
    const across = (x0: number, x1: number, y: number, tone: Tone) => {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 2) {
        put(x, y, tone);
      }
    };
    const down = (x: number, y0: number, y1: number, tone: Tone) => {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 2) {
        put(x, y, tone);
      }
    };
    const bottomOf = (team: string) =>
      cellY(layout.bottoms.get(team) ?? HEAD) + 2;
    for (const [index, tool] of picture.tools.entries()) {
      const place = places.get(tool.id);
      if (place === undefined) {
        continue;
      }
      const tone: Tone = tool.day === today ? "pine" : "border";
      const bus = cellY(layout.bus) + (index % 4) * 3;
      const to = cellX(place.x);
      for (const team of tool.teams) {
        const from = cellX(middleOf(teamIds.indexOf(team), teamIds.length));
        down(from, bottomOf(team), bus, tone);
        across(from, to, bus, tone);
      }
      down(to, bus, cellY(layout.rows[place.row]) - 1, tone);
    }
    const span = 1 / Math.max(1, teamIds.length);
    for (const [index, handoff] of picture.handoffs.entries()) {
      const fromIndex = teamIds.indexOf(handoff.from);
      const toIndex = teamIds.indexOf(handoff.to);
      const lean = fromIndex < toIndex ? 0.28 : -0.28;
      const from = cellX(middleOf(fromIndex, teamIds.length) + lean * span);
      const to = cellX(middleOf(toIndex, teamIds.length) - lean * span);
      const tone: Tone = handoff.day === today ? "pine" : "foreground";
      const y = cellY(layout.handoffAt(index));
      const top = bottomOf(handoff.to);
      down(from, bottomOf(handoff.from), y, tone);
      across(from, to, y, tone);
      down(to, top, y, tone);
      // The arrow's head, pointing up into the team that takes it over.
      put(to - 1, top + 1, tone);
      put(to + 1, top + 1, tone);
      put(to, top, tone);
    }
  };

/** The days as letters, for the replay; today's last. */
const DayPicker = ({
  campaign,
  shown,
  onPick,
}: {
  campaign: Campaign;
  shown: number;
  onPick: (day: number) => void;
}) => {
  const { i18n } = useLingui();
  const today = todayIndex(campaign);
  const letter = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  return (
    <div {...stylex.props(styles.days)}>
      {Array.from({ length: dayCount(campaign) }, (_, day) => {
        const iso = dayAfter(campaign.start, day);
        return (
          <Button
            aria-pressed={day === shown}
            disabled={day > today}
            key={iso}
            onClick={() => {
              onPick(day);
            }}
            size="sm"
            variant={day === shown ? "outline" : "ghost"}
          >
            {letter.format(new Date(`${iso}T00:00:00Z`))}
          </Button>
        );
      })}
    </div>
  );
};

/** The board on one day. */
const Board = ({
  campaign,
  picture,
  shown,
}: {
  campaign: Campaign;
  picture: CanvasPicture;
  shown: number;
}) => {
  const { t, i18n } = useLingui();
  const { grouped, teams } = campaign;
  const teamIds = teams.map((team) => team.id);
  const places = placeTools(picture.tools, teamIds);
  const layout = layoutOf(picture, teamIds);
  const canvas = usePixels(
    CELL,
    drawBoard(picture, teamIds, places, layout, shown)
  );
  const width = 1 / teams.length;
  const empty = picture.works.length === 0 && picture.tools.length === 0;
  const span = 1 / Math.max(1, teamIds.length);
  return (
    <div {...stylex.props(styles.board, styles.height(layout.height))}>
      <canvas aria-hidden ref={canvas} {...stylex.props(styles.canvas)} />
      {empty ? (
        <div {...stylex.props(styles.blank)}>
          <Text color="muted" size="lg">
            {t`Blank for now. It fills in as each interview ends.`}
          </Text>
        </div>
      ) : null}
      {teams.map((team, index) => {
        const works = picture.works.filter((work) => work.team === team.id);
        return (
          <section
            aria-label={say(i18n, rowName(team, grouped))}
            key={team.id}
            {...stylex.props(styles.team(index * width, width))}
          >
            <div {...stylex.props(styles.teamHead)}>
              <Text as="span" color="default" truncate>
                {say(i18n, rowName(team, grouped))}
              </Text>
              <Text as="span" color="muted" size="sm" truncate>
                {i18n._(talkedWords(team))}
              </Text>
            </div>
            <ul {...stylex.props(styles.works)}>
              {works.map((work, order) => (
                <li
                  key={work.id}
                  {...stylex.props(
                    styles.work,
                    styles.popped(work.day === shown ? order * 120 : 0)
                  )}
                >
                  <Text as="span" color="default" size="sm" truncate>
                    {work.name}
                  </Text>
                  <Steps steps={work.steps} twoWays={work.twoWays === true} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {picture.handoffs.map((handoff, index) => {
        const from = middleOf(teamIds.indexOf(handoff.from), teamIds.length);
        const to = middleOf(teamIds.indexOf(handoff.to), teamIds.length);
        const lean = from < to ? 0.28 : -0.28;
        const middle = (from + lean * span + to - lean * span) / 2;
        return (
          <span
            key={handoff.id}
            {...stylex.props(
              styles.handoff(middle, layout.handoffAt(index) - 9),
              styles.popped(handoff.day === shown ? 400 : 0)
            )}
          >
            <Text
              as="span"
              color={handoff.day === shown ? "default" : "muted"}
              size="xs"
            >
              {handoff.what}
            </Text>
          </span>
        );
      })}
      {picture.tools.map((tool, order) => {
        const place = places.get(tool.id);
        if (place === undefined) {
          return null;
        }
        return (
          <div
            key={tool.id}
            {...stylex.props(styles.tool(place.x, layout.rows[place.row]))}
          >
            <span
              {...stylex.props(
                styles.toolInner,
                styles.popped(tool.day === shown ? 300 + order * 90 : 0)
              )}
            >
              <ToolIcon kind={tool.kind} own={tool.own === true} />
              <Text as="span" color="default" size="sm">
                {tool.name}
              </Text>
              {tool.teams.length > 1 ? (
                <Text as="span" color="muted" size="xs">
                  {`×${tool.teams.length}`}
                </Text>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
};

/** What Grasp sees, or the ideas it is forming: newest first, today's marked. */
const Notes = ({
  title,
  notes,
  shown,
  none,
}: {
  title: string;
  notes: CanvasNote[];
  shown: number;
  none: string;
}) => {
  const { t } = useLingui();
  return (
    <section {...stylex.props(styles.column)}>
      <Heading level={2} size="xs">
        {title}
      </Heading>
      {notes.length === 0 ? (
        <Text color="muted" size="lg">
          {none}
        </Text>
      ) : (
        <ul {...stylex.props(styles.list)}>
          {notes.toReversed().map((note) => (
            <li
              key={note.id}
              {...stylex.props(
                styles.note,
                styles.popped(note.day === shown ? 600 : 0)
              )}
            >
              <Text color="default" size="lg">
                {note.text}
                {note.day === shown ? (
                  <Text as="span" color="muted" size="sm">
                    {` ${t`New`}`}
                  </Text>
                ) : null}
              </Text>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** Whether motion is wanted: under reduced motion the board opens on today, whole. */
const stillWanted = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The canvas, in one state. */
export const Canvas = ({ campaign }: { campaign: Campaign }) => {
  const { t, i18n } = useLingui();
  const { lead, rest } = statementOf(campaign);
  const today = todayIndex(campaign);
  // -1: before the first interview ended, the board blank.
  const [shown, setShown] = useState(() => (stillWanted() ? today : -1));
  const [replaying, setReplaying] = useState(() => !stillWanted());
  const playing = replaying && shown < today;
  useEffect(() => {
    if (!playing) {
      return () => {
        // Nothing playing, nothing to stop.
      };
    }
    const timer = setInterval(() => {
      setShown((was) => was + 1);
    }, BEAT);
    return () => {
      clearInterval(timer);
    };
  }, [playing]);
  const picture = pictureOn(pictureFor(campaign.grouped), shown);
  const works = picture.works.length;
  const tools = picture.tools.length;
  const handoffs = picture.handoffs.length;
  const declined = declinedWords(campaign);
  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.opening)}>
        <Heading level={1} size="xl">
          {i18n._(lead)}
        </Heading>
        <Text size="lg">
          {i18n._(rest)}{" "}
          {campaign.grouped
            ? t`So far: ${plural(works, { one: "# piece of work", other: "# pieces of work" })}, ${plural(tools, { one: "# tool", other: "# tools" })} and ${plural(handoffs, { one: "# hand-over between teams", other: "# hand-overs between teams" })}.`
            : t`So far: ${plural(works, { one: "# piece of work", other: "# pieces of work" })} and ${plural(tools, { one: "# tool", other: "# tools" })}.`}
        </Text>
      </header>
      {campaign.asks.length === 0 ? null : <Asks asks={campaign.asks} />}
      <div {...stylex.props(styles.bar)}>
        <DayPicker
          campaign={campaign}
          onPick={(day) => {
            setReplaying(false);
            setShown(day);
          }}
          shown={shown}
        />
        <Button
          disabled={playing}
          onClick={() => {
            setShown(-1);
            setReplaying(true);
          }}
          size="sm"
          variant="link"
        >
          {t`Replay the week`}
        </Button>
      </div>
      <div {...stylex.props(styles.scroll)}>
        <Board campaign={campaign} picture={picture} shown={shown} />
      </div>
      <div {...stylex.props(styles.key)}>
        <span {...stylex.props(styles.bar)}>
          <ToolIcon kind="sheet" own />
          <Text as="span" color="muted" size="sm">
            {t`A list or sheet of their own, beside the systems`}
          </Text>
        </span>
        <span {...stylex.props(styles.bar)}>
          <Steps steps={3} twoWays />
          <Text as="span" color="muted" size="sm">
            {t`Steps; one told two ways in green`}
          </Text>
        </span>
        <Text as="span" color="muted" size="sm">
          {t`Green lines: new that day`}
        </Text>
      </div>
      <div {...stylex.props(styles.notes)}>
        <Notes
          none={t`Nothing yet. Patterns show once a few interviews are in.`}
          notes={picture.notes.filter((note) => note.kind === "trend")}
          shown={shown}
          title={t`What we see`}
        />
        <Notes
          none={t`No ideas yet. They come once we see how the work runs.`}
          notes={picture.notes.filter((note) => note.kind === "idea")}
          shown={shown}
          title={t`Ideas taking shape`}
        />
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
