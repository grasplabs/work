// Empty's picture of what will stand here: the place's own shape, drawn faint in the system's
// dither (src/dither), behind the words. A list keeps its rows, a grid its cards, a chart its bars
// and a thread its bubbles, so the place does not collapse to a line of text and the first real
// item arrives into a room that was already drawn for it.
//
// The picture is not content: it is hidden from a screen reader, takes no pointer, never moves,
// and thins out towards the middle so the words stay the thing read. Every dot is a 1px square on
// a whole pixel (the pattern is in the page's own pixels, never scaled). In forced colours the
// dots are the text colour.
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";

import { BAYER, GEOMETRY } from "../dither/dither";
import { grasp, media } from "../tokens/tokens.stylex";

/** What will stand in the place: `rows` a list or a table, `cards` a grid, `chart` bars, `thread` a conversation. */
export type EmptyShape = "rows" | "cards" | "chart" | "thread";

const { pitch, square } = GEOMETRY.dots;
const TILE = pitch * BAYER.length;
/** How much of the dither is lit, of 16: half, so a bar reads as a bar and not as a dotted line. */
const LEVEL = 10;
const styles = stylex.create({
  layer: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    overflow: "hidden",
    pointerEvents: "none",
  },
  // The picture round the words (EmptyShapeAround): two bands, above and below the words' cell.
  // Each holds whole pieces (a row, a row of cards, a bubble, the chart), one after the other. A
  // piece that does not fit whole is not drawn at all: the band is a column that wraps, so what
  // does not fit goes to a second column, out of the band, and the band shows only the first.
  // Nothing is ever cut, and the clearing has no edge of its own: it is simply where no piece is.
  band: {
    display: "flex",
    flexDirection: "column",
    flexWrap: "wrap",
    alignContent: "flex-start",
    gridColumn: "1 / -1",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    pointerEvents: "none",
    // A band takes the room the place gives it and asks for none: without this its pieces would
    // make the place as tall as all of them, and none would be left out.
    contain: "size",
  },
  above: { gridRow: 1 },
  below: { gridRow: 3 },
  // Below the words, the pieces keep to the place's foot, as those above keep to its top.
  toFoot: { justifyContent: "flex-end" },
  // First in each band, no height: a column that wraps keeps at least one item, so without it a
  // piece taller than its band would stay in view, cut. With it, such a piece wraps away whole.
  spacer: { display: "block", flexShrink: 0, width: "100%", height: 0 },
  // The picture alone: its pieces from the top, one under the other; a piece that does not fit whole
  // wraps away, out of the box, as in a band.
  stack: {
    display: "flex",
    flexDirection: "column",
    flexWrap: "wrap",
    alignContent: "flex-start",
  },
  // A piece: as wide as the place, as tall as itself, never squeezed.
  piece: { display: "block", flexShrink: 0, flexGrow: 0, width: "100%" },
  // A row's line stands a pixel above it, on the row before: the row draws past its top.
  row: { height: 36, overflow: "visible" },
  cards: { height: 112 },
  bubble: { height: 48 },
  // The chart is one piece and fills its band: its bars stand whole on the place's floor.
  // Its tallest bar keeps a line's room under the words, as every other shape's nearest piece does.
  chartPiece: {
    height: `calc(100% - ${grasp.space4})`,
    minHeight: 0,
    marginBlockStart: grasp.space4,
  },
  // Further from the top of a band, a piece is a little fainter, as a whole: the place goes on.
  far: { opacity: 0.7 },
  farther: { opacity: 0.4 },
  // The patterns the pieces fill with: in the page, taking no room.
  defs: { position: "absolute", width: 0, height: 0, overflow: "hidden" },
  // The line under a row: one pixel of the hairline's colour, filled, not stroked.
  rule: {
    fill: { default: grasp.line, [media.forced]: "CanvasText" },
    stroke: "none",
  },
  whole: {
    maskImage: "linear-gradient(to bottom, black 55%, transparent)",
    maskComposite: "add",
  },
  // A mask's light and dark: how much of what it masks shows, not a colour (as Spinner's mask).
  maskKeep: {
    fill: "oklch(1 0 none)",
    stroke: "none",
    forcedColorAdjust: "none",
  },
  maskCut: {
    fill: "oklch(0 0 none)",
    stroke: "oklch(0 0 none)",
    forcedColorAdjust: "none",
  },
  maskEdge: {
    fill: "oklch(1 0 none)",
    stroke: "oklch(0 0 none)",
    forcedColorAdjust: "none",
  },
  // A fill drawn pixel by pixel, so every dot at its edge is whole or not there.
  crisp: { shapeRendering: "crispEdges" },
  dot: {
    fill: { default: grasp.muted, [media.forced]: "CanvasText" },
  },
  line: {
    fill: "none",
    // The outline of a part: fainter than the dots, so it draws the shape and does not shout.
    stroke: {
      default: `color-mix(in oklch, ${grasp.muted} 45%, transparent)`,
      [media.forced]: "CanvasText",
    },
    strokeWidth: 1,
  },
});

interface Paint {
  /** Ids in the page start with it: each piece's masks add their own part. */
  id: string;
  fill: string;
  line: string | undefined;
  rule: string | undefined;
  crisp: string | undefined;
}

/** The room kept between an outline and the dots inside it, and between a line and a shape it meets. */
const GAP = 3;

/**
 * Dots inside an outline, and a clear gap between them and it: the same geometry, filled, with
 * the outline's band and the gap round it taken out. Pixel by pixel, so a dot is whole or gone.
 */
const Inside = ({
  id,
  x,
  y,
  width,
  height,
  rx,
  paint,
}: {
  id: string;
  x: string | number;
  y: string | number;
  width: string | number;
  height: string | number;
  rx: number;
  paint: Paint;
}) => (
  <>
    <mask
      id={id}
      maskUnits="userSpaceOnUse"
      x="0"
      y="0"
      width="100%"
      height="100%"
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={rx}
        strokeWidth={GAP * 2 + 1}
        {...stylex.props(styles.maskEdge)}
        shapeRendering="crispEdges"
      />
    </mask>
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      rx={rx}
      fill={paint.fill}
      mask={`url(#${id})`}
      className={paint.crisp}
    />
  </>
);

/**
 * One row of a list, whole: its mark, its name, a status chip and a fact. The line stands between
 * rows, at the top of every row but a band's first, so no line hangs over the room after the last.
 */
const RowPiece = ({
  index,
  first,
  paint,
}: {
  index: number;
  first: boolean;
  paint: Paint;
}) => {
  const name = [34, 26, 40, 22, 30, 36][index % 6] ?? 30;
  return (
    <>
      {/* On the row above's last pixel, where a real list draws its line: a real row over the first
          piece covers it, so the line reads single, never doubled beside the real one. */}
      {!first && (
        <rect x="0" y="-1" width="100%" height="1" className={paint.rule} />
      )}
      <rect
        x="16.5"
        y="12.5"
        width="11"
        height="11"
        rx="3"
        className={paint.line}
      />
      <rect
        x="40"
        y="13"
        width={`${name}%`}
        height="10"
        rx="3"
        fill={paint.fill}
        className={paint.crisp}
      />
      <rect
        x="64%"
        y="9.5"
        width="54"
        height="17"
        rx="8.5"
        className={paint.line}
      />
      <rect
        x="87%"
        y="13"
        width="8%"
        height="10"
        rx="3"
        fill={paint.fill}
        className={paint.crisp}
      />
    </>
  );
};

/** A row of three cards, whole: each with its edge, a picture's room, a title and a line. */
const CardsPiece = ({ paint }: { paint: Paint }) => (
  <>
    {[0, 1, 2].map((column) => {
      const x = 3 + column * 32.5;
      return (
        <g key={column}>
          <rect
            x={`${x}%`}
            y="8.5"
            width="29%"
            height="95"
            rx="10"
            className={paint.line}
          />
          <rect
            x={`${x + 2}%`}
            y="18"
            width="25%"
            height="36"
            rx="5"
            fill={paint.fill}
            className={paint.crisp}
          />
          <rect
            x={`${x + 2}%`}
            y="64"
            width={`${[15, 19, 12][column] ?? 15}%`}
            height="10"
            rx="3"
            fill={paint.fill}
            className={paint.crisp}
          />
          <rect
            x={`${x + 2}%`}
            y="82"
            width={`${[20, 16, 22][column] ?? 18}%`}
            height="6"
            rx="2"
            fill={paint.fill}
            className={paint.crisp}
          />
        </g>
      );
    })}
  </>
);

/** One bubble of a talk, whole: what was asked at the end, dots inside its edge; an answer at the start, with its lines. */
const BubblePiece = ({
  index,
  id,
  paint,
}: {
  index: number;
  id: string;
  paint: Paint;
}) => {
  const width = [34, 52, 28, 46, 38, 54, 30, 44][index % 8] ?? 40;
  // Both kinds the same height, in the middle of their piece, so a band's first and last bubbles
  // stand as far from its edges as each other.
  if (index % 2 === 0) {
    return (
      <>
        <rect
          x={`${96 - width}%`}
          y="8.5"
          width={`${width}%`}
          height="31"
          rx="12"
          className={paint.line}
        />
        <Inside
          id={id}
          x={`${96 - width}%`}
          y="8.5"
          width={`${width}%`}
          height="31"
          rx={12}
          paint={paint}
        />
      </>
    );
  }
  return (
    <>
      <rect
        x="4%"
        y="8.5"
        width={`${width}%`}
        height="31"
        rx="12"
        className={paint.line}
      />
      <rect
        x="6%"
        y="15"
        width={`${width - 6}%`}
        height="6"
        rx="2"
        fill={paint.fill}
        className={paint.crisp}
      />
      <rect
        x="6%"
        y="27"
        width={`${width - 16}%`}
        height="6"
        rx="2"
        fill={paint.fill}
        className={paint.crisp}
      />
    </>
  );
};

const BARS = [38, 56, 44, 70, 52, 82, 64, 48, 74, 58];
const FLOOR = 95;

/**
 * The chart, whole, as tall as its room: bars of dots standing a little clear of their floor, and
 * the lines they are read against stopping short of every bar, so no line runs through a bar.
 */
const ChartPiece = ({ id, paint }: { id: string; paint: Paint }) => (
  <>
    <mask
      id={`${id}-lines`}
      maskUnits="userSpaceOnUse"
      x="0"
      y="0"
      width="100%"
      height="100%"
    >
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        {...stylex.props(styles.maskKeep)}
      />
      {BARS.map((height, index) => (
        <rect
          key={index}
          x={`${5 + index * 9.2}%`}
          y={`${FLOOR - height}%`}
          width="6.4%"
          height={`${height}%`}
          strokeWidth={GAP * 2}
          {...stylex.props(styles.maskCut)}
        />
      ))}
    </mask>
    <mask
      id={`${id}-bars`}
      maskUnits="userSpaceOnUse"
      x="0"
      y="0"
      width="100%"
      height="100%"
    >
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        {...stylex.props(styles.maskKeep)}
      />
      <rect
        x="0"
        y={`${FLOOR}%`}
        width="100%"
        height="1"
        strokeWidth={GAP * 2}
        shapeRendering="crispEdges"
        {...stylex.props(styles.maskCut)}
      />
    </mask>
    <g mask={`url(#${id}-lines)`}>
      {[34, 67].map((at) => (
        <rect
          key={at}
          x="3%"
          y={`${at}%`}
          width="94%"
          height="1"
          className={paint.rule}
        />
      ))}
    </g>
    <g mask={`url(#${id}-bars)`}>
      {BARS.map((height, index) => (
        <rect
          key={index}
          x={`${5 + index * 9.2}%`}
          y={`${FLOOR - height}%`}
          width="6.4%"
          height={`${height}%`}
          fill={paint.fill}
          className={paint.crisp}
        />
      ))}
    </g>
    <rect
      x="3%"
      y={`${FLOOR}%`}
      width="94%"
      height="1"
      className={paint.rule}
    />
  </>
);

const usePaint = (): Paint => {
  const id = `empty-dither-${useId().replaceAll(":", "")}`;
  return {
    id,
    fill: `url(#${id})`,
    line: stylex.props(styles.line).className,
    rule: stylex.props(styles.rule).className,
    crisp: stylex.props(styles.crisp).className,
  };
};

const Patterns = ({ id }: { id: string }) => (
  <svg aria-hidden="true" focusable="false" {...stylex.props(styles.defs)}>
    <defs>
      <pattern id={id} width={TILE} height={TILE} patternUnits="userSpaceOnUse">
        {BAYER.flatMap((row, y) =>
          row.map((threshold, x) =>
            threshold < LEVEL ? (
              <rect
                key={`${x}-${y}`}
                x={x * pitch}
                y={y * pitch}
                width={square}
                height={square}
                {...stylex.props(styles.dot)}
              />
            ) : null
          )
        )}
      </pattern>
    </defs>
  </svg>
);

/** How many pieces the picture alone is given: more than any place shows; it draws those that fit whole. */
const STACKED = 14;

/**
 * The picture alone. Empty draws it under its words when they stand at the head of the place; a
 * list that has its first items and is still mostly empty may keep it under them (in a box with
 * `position: relative`), so the rows to come stay drawn. `whole` fades it out towards its foot.
 * Its pieces stack from the top and only those that fit whole are drawn, so no row is cut by the
 * box's foot and no line stands over a sliver of one.
 */
export const EmptyShapePicture = ({
  shape,
  whole = false,
}: {
  shape: EmptyShape;
  whole?: boolean;
}) => {
  const paint = usePaint();
  const kind = {
    rows: styles.row,
    cards: styles.cards,
    chart: styles.bubble,
    thread: styles.bubble,
  }[shape];
  return (
    <span
      aria-hidden="true"
      data-slot="empty-shape"
      data-shape={shape}
      {...stylex.props(styles.layer, styles.stack, whole && styles.whole)}
    >
      <Patterns id={paint.id} />
      <span {...stylex.props(styles.spacer)} />
      {shape === "chart" ? (
        <svg
          focusable="false"
          data-piece=""
          {...stylex.props(styles.piece, styles.chartPiece)}
        >
          <ChartPiece id={`${paint.id}-chart`} paint={paint} />
        </svg>
      ) : (
        Array.from({ length: STACKED }, (_, index) => (
          <svg
            key={index}
            focusable="false"
            data-piece=""
            {...stylex.props(styles.piece, kind)}
          >
            {shape === "rows" && (
              <RowPiece index={index} first={index === 0} paint={paint} />
            )}
            {shape === "cards" && <CardsPiece paint={paint} />}
            {shape === "thread" && (
              <BubblePiece
                index={index}
                id={`${paint.id}-${index}`}
                paint={paint}
              />
            )}
          </svg>
        ))
      )}
    </span>
  );
};

/** How many pieces a band is given: more than any place shows; the band draws those that fit whole. */
const PIECES = 14;

/**
 * The picture round Empty's words: a band above their cell and a band below it, each holding
 * whole pieces of the place. A piece is whole or it is not there; nothing is drawn beside the
 * words, in their box or in their margin, so the clearing is only the room the words stand in.
 * The pieces keep to the place's outer edges, so what room is left over lies round the words,
 * not at the place's top or foot.
 */
export const EmptyShapeAround = ({ shape }: { shape: EmptyShape }) => {
  const paint = usePaint();
  const kind = {
    rows: styles.row,
    cards: styles.cards,
    chart: styles.bubble,
    thread: styles.bubble,
  }[shape];
  const pieces = (band: "above" | "below") =>
    Array.from({ length: PIECES }, (_, index) => {
      const from = band === "above" ? 0 : 3;
      // Below the words, the first piece is the one nearest them; fainter further out.
      const fade =
        band === "below" &&
        (index === 1 ? styles.far : index >= 2 && styles.farther);
      return (
        <svg
          key={index}
          focusable="false"
          data-piece=""
          {...stylex.props(styles.piece, kind, fade)}
        >
          {shape === "rows" && (
            <RowPiece index={from + index} first={index === 0} paint={paint} />
          )}
          {shape === "cards" && <CardsPiece paint={paint} />}
          {shape === "thread" && (
            <BubblePiece
              index={from + index}
              id={`${paint.id}-${band}-${index}`}
              paint={paint}
            />
          )}
        </svg>
      );
    });
  return (
    <>
      <span
        aria-hidden="true"
        data-slot="empty-shape"
        data-shape={shape}
        data-band="above"
        {...stylex.props(styles.band, styles.above)}
      >
        <Patterns id={paint.id} />
        <span {...stylex.props(styles.spacer)} />
        {/* A chart stands on the place's floor: all of it is below the words. */}
        {shape !== "chart" && pieces("above")}
      </span>
      <span
        aria-hidden="true"
        data-slot="empty-shape-band"
        data-shape={shape}
        data-band="below"
        {...stylex.props(
          styles.band,
          styles.below,
          shape !== "chart" && styles.toFoot
        )}
      >
        <span {...stylex.props(styles.spacer)} />
        {shape === "chart" ? (
          <svg
            focusable="false"
            data-piece=""
            {...stylex.props(styles.piece, styles.chartPiece)}
          >
            <ChartPiece id={`${paint.id}-chart`} paint={paint} />
          </svg>
        ) : (
          pieces("below")
        )}
      </span>
    </>
  );
};
