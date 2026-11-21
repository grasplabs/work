// Empty's small pictures: one exact drawing per case, so "nothing yet", "nothing found", "all
// done", "no access", "offline" and "something broke" are told apart at a glance and not by the
// words alone. Each is drawn in its own pixels (96 by 64, never scaled): outlines one pixel wide,
// surfaces in the system's dither (src/dither), and one accent where the case has good news.
//
// A picture is not content: a screen reader does not meet it, and the title says the same thing.
// Nothing in it moves. In forced colours it is drawn in the text colour.
import * as stylex from "@stylexjs/stylex";

import { BAYER, GEOMETRY } from "../dither/dither";
import { grasp, media } from "../tokens/tokens.stylex";

/**
 * Which case the state is: `nothing` nothing made yet, `search` nothing matches, `done` all
 * cleared, `locked` no access, `offline` no connection, `broken` it failed, `lost` no page at this address.
 */
export type EmptyPicture =
  | "nothing"
  | "search"
  | "done"
  | "locked"
  | "offline"
  | "broken"
  | "lost";

const { pitch, square } = GEOMETRY.dots;
/** The lens in "search": its rim, and the room the rows keep from it. */
const LENS = { cx: 56.5, cy: 29.5, r: 15.5 + 5 };

const styles = stylex.create({
  picture: {
    display: "block",
    justifySelf: "center",
    width: 96,
    height: 64,
    marginBottom: grasp.space3,
    overflow: "visible",
  },
  // At the start edge, when the words stand at the head of the place.
  start: { justifySelf: "start" },
  line: {
    fill: "none",
    stroke: { default: grasp.muted, [media.forced]: "CanvasText" },
    strokeWidth: 1,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  sheet: {
    fill: { default: grasp.raised, [media.forced]: "Canvas" },
    stroke: { default: grasp.muted, [media.forced]: "CanvasText" },
    strokeWidth: 1,
    strokeLinejoin: "round",
  },
  good: {
    fill: "none",
    stroke: { default: grasp.mintDeep, [media.forced]: "CanvasText" },
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  bad: {
    fill: "none",
    stroke: { default: grasp.danger, [media.forced]: "CanvasText" },
    strokeWidth: 1,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  dot: { fill: { default: grasp.muted, [media.forced]: "CanvasText" } },
});

/**
 * At the start edge, each drawing pulled in by the room its own ink leaves at that side of its
 * box, so its outline stands on the words' edge (the room differs per case; right to left, the
 * other side's room).
 */
const shift = stylex.create({
  nothing: { marginInlineStart: { default: -18, ":dir(rtl)": -17 } },
  search: { marginInlineStart: { default: -12, ":dir(rtl)": -17 } },
  done: { marginInlineStart: { default: -18, ":dir(rtl)": -17 } },
  locked: { marginInlineStart: { default: -18, ":dir(rtl)": -17 } },
  offline: { marginInlineStart: { default: -6, ":dir(rtl)": -6 } },
  broken: { marginInlineStart: { default: -18, ":dir(rtl)": -17 } },
  lost: { marginInlineStart: { default: -8, ":dir(rtl)": -7 } },
});

/** How much of the dither is lit, of 16. */
const LEVEL = 10;

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
  /** A circle no dot comes within: a shape that stands over the dots keeps this room round it. */
  clear?: { cx: number; cy: number; r: number };
}

/**
 * A surface in the system's dither, as whole dots: only a dot that lies wholly inside the area is
 * drawn, so no dot is cut by an edge, and none comes within the clear circle.
 */
const Dots = ({ x, y, width, height, clear }: Area) => {
  const dots: { left: number; top: number }[] = [];
  for (
    let row = Math.ceil(y / pitch);
    row * pitch + square <= y + height;
    row += 1
  ) {
    for (
      let column = Math.ceil(x / pitch);
      column * pitch + square <= x + width;
      column += 1
    ) {
      const lit =
        (BAYER[row % BAYER.length]?.[column % BAYER.length] ?? LEVEL) < LEVEL;
      const left = column * pitch;
      const top = row * pitch;
      const away =
        !clear ||
        Math.hypot(
          Math.max(Math.abs(left + square / 2 - clear.cx) - square / 2, 0),
          Math.max(Math.abs(top + square / 2 - clear.cy) - square / 2, 0)
        ) >= clear.r;
      if (lit && away) {
        dots.push({ left, top });
      }
    }
  }
  return (
    <g {...stylex.props(styles.dot)}>
      {dots.map(({ left, top }) => (
        <rect
          key={`${left}-${top}`}
          x={left}
          y={top}
          width={square}
          height={square}
        />
      ))}
    </g>
  );
};

export const EmptyPictureDrawing = ({
  picture,
  start = false,
}: {
  picture: EmptyPicture;
  start?: boolean;
}) => {
  const line = stylex.props(styles.line);
  const sheet = stylex.props(styles.sheet);
  const good = stylex.props(styles.good);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 96 64"
      data-slot="empty-picture"
      data-picture={picture}
      {...stylex.props(
        styles.picture,
        start && styles.start,
        start && shift[picture]
      )}
    >
      {picture === "nothing" && (
        <>
          {/* A list that waits: its rows in dither, the first one's place drawn and still open. */}
          <rect x="18.5" y="6.5" width="60" height="52" rx="6" {...sheet} />
          <rect
            x="24.5"
            y="12.5"
            width="48"
            height="13"
            rx="3"
            strokeDasharray="2 3"
            {...line}
          />
          <Dots x={25} y={30} width={36} height={6} />
          <Dots x={25} y={42} width={27} height={6} />
          {/* The plus inside the first row's place, clear of its dashed edge. */}
          <path d="M48.5 16.5v5M46 19h5" {...line} />
        </>
      )}
      {picture === "search" && (
        <>
          {/* The list is there, behind; the glass over it holds nothing, and the rows keep clear of its rim. */}
          <Dots x={12} y={12} width={42} height={6} clear={LENS} />
          <Dots x={12} y={24} width={30} height={6} clear={LENS} />
          <Dots x={12} y={36} width={36} height={6} clear={LENS} />
          <Dots x={12} y={48} width={24} height={6} clear={LENS} />
          <circle cx="56.5" cy="29.5" r="15" {...sheet} />
          <path d="M67.5 40.5l11 11" {...line} />
          <path d="M51.5 29.5h10" {...line} />
        </>
      )}
      {picture === "done" && (
        <>
          {/* Every row dealt with: the list ticked through, and one clear tick on it, inside its edge. */}
          <rect x="18.5" y="6.5" width="60" height="52" rx="6" {...sheet} />
          <Dots x={25} y={15} width={30} height={6} />
          <Dots x={25} y={29} width={26} height={6} />
          <Dots x={25} y={43} width={20} height={6} />
          <circle cx="64.5" cy="43.5" r="9.5" {...good} />
          <path d="M60 43.75l3 3 5.5-6.25" {...good} />
        </>
      )}
      {picture === "locked" && (
        <>
          {/* The thing is there, and shut: a sheet with its lock on it. */}
          <rect x="18.5" y="6.5" width="60" height="52" rx="6" {...sheet} />
          <Dots x={25} y={14} width={34} height={6} />
          <Dots x={25} y={26} width={22} height={6} />
          <path d="M57.5 39.5v-5a6 6 0 0112 0v5" {...line} />
          <rect x="53.5" y="39.5" width="20" height="14" rx="3" {...sheet} />
          <path d="M63.5 44.5v4" {...line} />
        </>
      )}
      {picture === "offline" && (
        <>
          {/* Two ends and a line that does not reach: this device, and what it cannot get to. */}
          <rect x="6.5" y="20.5" width="28" height="24" rx="5" {...sheet} />
          <Dots x={12} y={27} width={17} height={4} />
          <Dots x={12} y={35} width={11} height={4} />
          <rect
            x="61.5"
            y="20.5"
            width="28"
            height="24"
            rx="5"
            strokeDasharray="2 3"
            {...line}
          />
          <path d="M34.5 32.5h8" {...line} />
          <path d="M53.5 32.5h8" strokeDasharray="2 3" {...line} />
          {/* The break: a drawn cross, square, of the lines' own stroke. */}
          <path d="M45 29l7 7M52 29l-7 7" {...line} />
        </>
      )}
      {picture === "lost" && (
        <>
          {/* A link that leads nowhere: the page it came from, a dashed way out, and no page at its end. */}
          <rect x="8.5" y="10.5" width="34" height="44" rx="5" {...sheet} />
          <Dots x={14} y={18} width={20} height={5} />
          <Dots x={14} y={29} width={14} height={5} />
          <Dots x={14} y={40} width={18} height={5} />
          {/* The way out leaves from the page's edge, never from inside it. */}
          <path d="M43 31.5h3" {...line} />
          <path d="M48.5 31.5c6 0 6-12 12-12" strokeDasharray="2 3" {...line} />
          <rect
            x="62.5"
            y="6.5"
            width="26"
            height="34"
            rx="5"
            strokeDasharray="2 3"
            {...line}
          />
          <path d="M71.5 19.5l8 8M79.5 19.5l-8 8" {...line} />
        </>
      )}
      {picture === "broken" && (
        <>
          {/* It came apart on the way: one sheet in two halves, a step out of line. */}
          <path
            d="M24.5 8.5h22l-5 14 7 8-6 12 4 14h-22a6 6 0 01-6-6v-36a6 6 0 016-6z"
            {...sheet}
          />
          <path
            d="M52.5 6.5h20a6 6 0 016 6v36a6 6 0 01-6 6h-18l-4-14 6-12-7-8z"
            {...sheet}
          />
          <Dots x={25} y={16} width={14} height={5} />
          <Dots x={25} y={28} width={16} height={5} />
          <Dots x={25} y={40} width={12} height={5} />
          <Dots x={58} y={14} width={14} height={5} />
          <Dots x={60} y={26} width={12} height={5} />
          <path
            d="M46.5 8.5l-5 14 7 8-6 12 4 14"
            {...stylex.props(styles.bad)}
          />
        </>
      )}
    </svg>
  );
};
