// ChartRing: parts of a whole as a ring, a figure in its centre. Each part is one series of the
// config, in order round from twelve o'clock, with a clear gap between. The first is the value
// colour (or its dither, lit at the outer edge); the rest step down the light's deep tone. The
// names live in a quiet list (key, name, value, share), never hung round the ring: beside it, its
// middle on the ring's middle, or under it on a narrow chart. Hover or focus a part: it lifts a
// little and the centre says it; nothing else steps back.
//
//   <ChartRing label="October's invoices" summary="Two in three matched themselves."
//     values={{ auto: 812, person: 344, disputed: 61 }} config={…} caption="invoices in October" />
//
// One share (62% of a target) is its simplest form: one value and a `whole` it is part of.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { visuallyHidden } from "../hidden/hidden";
import { grasp, media } from "../tokens/tokens.stylex";
import type { ChartLayoutStyle } from "./chart";
import type { ChartConfig } from "./chart-context";
import { ChartPatterns, patternId, textureOf } from "./chart-patterns";
import type { ChartFill, ChartTexture } from "./chart-patterns";
import { saidStyles } from "./chart-said";
import { GEOMETRY, LEVELS } from "./dither";
import { ditherEdges } from "./dither-edges";
import { arcPath, arcsOf, pointAt, restOf } from "./ring";
import type { Arc } from "./ring";

/** Every prop a ChartRing takes. */
export interface ChartRingProps {
  /** What the ring shows, as a screen reader and an agent say it ("October's invoices"). */
  label: string;
  /** One sentence that says what the parts mean ("Two in three matched themselves"). */
  summary: string;
  /** Each part's value, by its key in the config, in the order they go round. */
  values: Readonly<Record<string, number>>;
  /** The parts, by key, with their names. Five at most: past that, use bars across. */
  config: ChartConfig;
  /** The one line of words under the centre's figure ("invoices in October"). */
  caption: string;
  /** For one share: the whole it is part of (100, a target). The rest of the ring is an empty track. */
  whole?: number;
  /**
   * How the first part is filled: `plain` in the value colour, or a dither lit at its outer edge.
   * @default "plain"
   */
  fill?: ChartFill;
  /** Writes a value as people read it ("812", "€12.4k"). */
  format?: (value: number) => string;
  /** Writes a share as people read it ("62%"). */
  formatShare?: (share: number) => string;
  /** Its width and where it sits. */
  style?: ChartLayoutStyle;
}

// The ring's size, its thickness, the gap between parts and a part's lift, in CSS pixels: SVG
// geometry.
const OUTER = 96;
const THICK = 20;
const GAP = 3;
const LIFT = 4;
const CAP = 2;

// The tones round the ring after the first, which is the value colour.
const TONES = [
  "chartPlain",
  "chartTone2",
  "chartTone3",
  "chartTone4",
  "chartTone5",
] as const;

const NARROW = "@container (width < 30rem)";

const styles = stylex.create({
  // The ring's own width decides how it folds, not the window's.
  room: { containerType: "inline-size", minWidth: 0 },
  box: {
    display: "grid",
    gridTemplateColumns: {
      default: "auto minmax(0, 1fr)",
      [NARROW]: "minmax(0, 1fr)",
    },
    alignItems: "center",
    justifyItems: { default: "start", [NARROW]: "center" },
    columnGap: grasp.space8,
    rowGap: grasp.space5,
  },
  boxAlone: { gridTemplateColumns: "minmax(0, 1fr)", justifyItems: "stretch" },
  stack: { display: "grid", placeItems: "center", minWidth: 0, width: "100%" },
  drawing: {
    gridArea: "1 / 1",
    display: "block",
    overflow: "visible",
    maxWidth: "100%",
  },
  centre: {
    gridArea: "1 / 1",
    display: "grid",
    justifyItems: "center",
    rowGap: grasp.space1,
    maxWidth: (OUTER - THICK) * 1.7,
    textAlign: "center",
    pointerEvents: "none",
  },
  figure: {
    color: grasp.ink,
    fontSize: grasp.titleMd,
    lineHeight: grasp.titleMdLine,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: grasp.trackingTitle,
  },
  caption: { color: grasp.muted, textWrap: "balance" },
  part: {
    cursor: "default",
    outline: "none",
    transitionProperty: "transform, opacity",
    transitionDuration: { default: grasp.durationHover, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
    stroke: { default: "transparent", ":focus-visible": grasp.ring },
    strokeWidth: 2,
  },
  lift: (x: number, y: number) => ({ transform: `translate(${x}px, ${y}px)` }),
  // The row of the part under the pointer or the keys: its name in ink. Nothing else dims.
  rowActive: { color: grasp.ink },
  tone: (colour: string) => ({
    fill: { default: colour, [media.forced]: "CanvasText" },
  }),
  // A share's empty track: quiet, as it is no part.
  track: {
    fill: { default: grasp.chartQuietFill, [media.forced]: "GrayText" },
  },
  dither: { display: { default: null, [media.forced]: "none" } },
  cap: {
    fill: "none",
    stroke: { default: grasp.chartLine, [media.forced]: "CanvasText" },
  },
  crisp: { shapeRendering: "crispEdges" },
  list: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    alignItems: "baseline",
    margin: 0,
    padding: 0,
    listStyle: "none",
    minWidth: 0,
    width: "100%",
    maxWidth: 360,
  },
  row: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "subgrid",
    transitionProperty: "opacity",
    transitionDuration: { default: grasp.durationHover, [media.reduced]: "0s" },
  },
  swatch: { width: 8, height: 8, borderRadius: 2, alignSelf: "center" },
  swatchTone: (colour: string) => ({
    backgroundColor: { default: colour, [media.forced]: "CanvasText" },
  }),
  rowName: { color: grasp.text, minWidth: 0 },
  rowValue: {
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
  },
  rowShare: {
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
    textAlign: "end",
    minWidth: "4ch",
  },
});

const toneOf = (index: number) =>
  grasp[TONES[Math.min(index, TONES.length - 1)] ?? "chartTone5"];

const plainNumber = (value: number) => value.toLocaleString();
const plainShare = (share: number) =>
  share.toLocaleString(undefined, {
    style: "percent",
    maximumFractionDigits: 0,
  });

interface Part {
  key: string;
  name: string;
  value: number;
  arc: Arc;
}

// The dither on the first part: rings of density from its outer edge (lit) in to its inner edge,
// clipped to the part, with a solid cap along the outer edge saying where it ends.
const DitherArc = ({
  chart,
  clip,
  texture,
  cx,
  cy,
  d,
}: {
  chart: string;
  clip: string;
  texture: ChartTexture;
  cx: number;
  cy: number;
  d: string;
}) => {
  const edges = ditherEdges(OUTER, OUTER - THICK, GEOMETRY[texture].pitch);
  return (
    <>
      <clipPath id={clip}>
        <path d={d} />
      </clipPath>
      <g clipPath={`url(#${clip})`} {...stylex.props(styles.dither)}>
        {edges.slice(0, -1).map((from, index) => {
          const to = edges[index + 1] ?? from;
          return from > to ? (
            <circle
              key={index}
              cx={cx}
              cy={cy}
              r={(from + to) / 2}
              strokeWidth={from - to}
              fill="none"
              stroke={`url(#${patternId(chart, texture, LEVELS - index)})`}
              {...stylex.props(styles.crisp)}
            />
          ) : null;
        })}
        <circle
          cx={cx}
          cy={cy}
          r={OUTER - CAP / 2}
          strokeWidth={CAP}
          {...stylex.props(styles.cap)}
        />
      </g>
    </>
  );
};

interface DrawingProps {
  chart: string;
  parts: readonly Part[];
  whole: number | undefined;
  width: number;
  height: number;
  texture: ChartTexture | null;
  active: number | null;
  setActive: (index: number | null) => void;
  said: (part: Part) => string;
}

const Drawing = ({
  chart,
  parts,
  whole,
  width,
  height,
  texture,
  active,
  setActive,
  said,
}: DrawingProps) => {
  const cx = width / 2;
  const cy = height / 2;
  const rest =
    whole === undefined
      ? null
      : restOf(
          parts.map((part) => part.arc),
          GAP / (OUTER - THICK / 2)
        );
  return (
    <svg width={width} height={height} {...stylex.props(styles.drawing)}>
      <ChartPatterns id={chart} />
      {rest !== null && (
        <path
          aria-hidden="true"
          d={arcPath(cx, cy, OUTER, OUTER - THICK, rest.from, rest.to)}
          {...stylex.props(styles.track)}
        />
      )}
      <g>
        {parts.map((part, index) => {
          const d = arcPath(
            cx,
            cy,
            OUTER,
            OUTER - THICK,
            part.arc.from,
            part.arc.to
          );
          const lifted = pointAt(
            0,
            0,
            active === index ? LIFT : 0,
            part.arc.middle
          );
          const dithered = index === 0 && texture !== null;
          return (
            <g
              key={part.key}
              role="graphics-symbol"
              tabIndex={0}
              aria-label={said(part)}
              data-part={part.key}
              onPointerEnter={() => {
                setActive(index);
              }}
              onPointerLeave={() => {
                setActive(null);
              }}
              onFocus={() => {
                setActive(index);
              }}
              onBlur={() => {
                setActive(null);
              }}
              {...stylex.props(styles.part, styles.lift(lifted.x, lifted.y))}
            >
              <path d={d} {...stylex.props(styles.tone(toneOf(index)))} />
              {dithered && (
                <DitherArc
                  chart={chart}
                  clip={`${chart}-arc`}
                  texture={texture}
                  cx={cx}
                  cy={cy}
                  d={d}
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
};

// The quiet list beside the ring: each part's swatch, name, value and share.
const List = ({
  parts,
  active,
  setActive,
  format,
  formatShare,
}: {
  parts: readonly Part[];
  active: number | null;
  setActive: (index: number | null) => void;
  format: (value: number) => string;
  formatShare: (share: number) => string;
}) => (
  <ul aria-hidden="true" {...stylex.props(styles.list)}>
    {parts.map((part, index) => (
      <li
        key={part.key}
        onPointerEnter={() => {
          setActive(index);
        }}
        onPointerLeave={() => {
          setActive(null);
        }}
        {...stylex.props(styles.row)}
      >
        <span
          {...stylex.props(styles.swatch, styles.swatchTone(toneOf(index)))}
        />
        <span
          {...stylex.props(
            styles.rowName,
            active === index && styles.rowActive
          )}
        >
          {part.name}
        </span>
        <span {...stylex.props(styles.rowValue)}>{format(part.value)}</span>
        <span {...stylex.props(styles.rowShare)}>
          {formatShare(part.arc.share)}
        </span>
      </li>
    ))}
  </ul>
);

/** The parts, from the config's order (five at most) and their values. */
const partsOf = (
  config: ChartConfig,
  values: Readonly<Record<string, number>>,
  whole: number | undefined
): Part[] => {
  const keys = Object.keys(config).slice(0, 5);
  const arcs = arcsOf(
    keys.map((key) => values[key] ?? 0),
    GAP / (OUTER - THICK / 2),
    whole
  );
  return keys.map((key, index) => ({
    key,
    name: config[key]?.label ?? key,
    value: values[key] ?? 0,
    arc: arcs[index] ?? { from: 0, to: 0, middle: 0, share: 0 },
  }));
};

interface Says {
  format: (value: number) => string;
  formatShare: (share: number) => string;
}

/** What the centre says: the part under the pointer or the keys, else the total (or the one share) and the caption. */
const centreOf = (
  parts: readonly Part[],
  shown: Part | undefined,
  whole: number | undefined,
  caption: string,
  { format, formatShare }: Says
) => {
  if (shown !== undefined) {
    return {
      figure: format(shown.value),
      words: `${shown.name} · ${formatShare(shown.arc.share)}`,
    };
  }
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  const figure =
    whole === undefined ? format(total) : formatShare(parts[0]?.arc.share ?? 0);
  return { figure, words: caption };
};

export const ChartRing = ({
  label,
  summary,
  values,
  config,
  caption,
  whole,
  fill = "plain",
  format = plainNumber,
  formatShare = plainShare,
  style,
}: ChartRingProps) => {
  const chart = `chart-${useId().replaceAll(/[^a-zA-Z0-9-]/gu, "")}`;
  const parts = partsOf(config, values, whole);
  const [active, setActive] = useState<number | null>(null);
  const said = (part: Part) =>
    `${part.name}: ${format(part.value)}, ${formatShare(part.arc.share)}`;
  // The drawing: the ring and room for a part's lift.
  const size = 2 * (OUTER + LIFT + 2);
  const { figure, words } = centreOf(
    parts,
    active === null ? undefined : parts[active],
    whole,
    caption,
    { format, formatShare }
  );
  return (
    <figure
      aria-labelledby={`${chart}-label`}
      data-slot="chart-ring"
      {...stylex.props(saidStyles.figure, style)}
    >
      <figcaption {...stylex.props(visuallyHidden)}>
        <span id={`${chart}-label`}>{label}</span> <span>{summary}</span>
      </figcaption>
      <div {...stylex.props(styles.room)}>
        <div {...stylex.props(styles.box, parts.length < 2 && styles.boxAlone)}>
          <div {...stylex.props(styles.stack)}>
            <Drawing
              chart={chart}
              parts={parts}
              whole={whole}
              width={size}
              height={size}
              texture={textureOf(fill)}
              active={active}
              setActive={setActive}
              said={said}
            />
            <div {...stylex.props(styles.centre)}>
              <span {...stylex.props(styles.figure)}>{figure}</span>
              <span {...stylex.props(styles.caption)}>{words}</span>
            </div>
          </div>
          {parts.length > 1 && (
            <List
              parts={parts}
              active={active}
              setActive={setActive}
              format={format}
              formatShare={formatShare}
            />
          )}
        </div>
      </div>
    </figure>
  );
};
