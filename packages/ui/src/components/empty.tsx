// Empty: what a list, a card or a page says when there is nothing in it, or when it could not
// load: centred, quiet, a short title over one sentence, in one of three sizes.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Empty>
//     <EmptyHeader>
//       <EmptyMedia illustration="nothing" />
//       <EmptyTitle>No projects yet</EmptyTitle>
//       <EmptyDescription>Projects appear here once someone creates one.</EmptyDescription>
//     </EmptyHeader>
//     <EmptyContent><Button>New project</Button></EmptyContent>
//   </Empty>
//
// `variant="destructive"` is "it did not load": its empty EmptyMedia shows the alert icon, its
// empty EmptyTitle the catalogue's `empty.error`, and its title and sentence are said to a screen
// reader as they appear. "Nothing here" and "it did not load" are kept apart on purpose: telling
// someone a list is empty when its request failed is the one answer that is wrong.
//
// An `illustration` is a small drawing that tells the case apart (nothing yet, nothing found, all
// done, no access, offline, it failed, no page here). What will stand in the place while it loads
// is the product's own composition of Skeletons, never Empty's.
//
// Every value is a token. A caller may set layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import { createContext, use, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { Icon, TriangleAlertIcon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import {
  colors,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { announce, BAYER_MATRIX, DITHER_GEOMETRY } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";

/**
 * Which case the state is: `nothing` nothing made yet, `search` nothing matches, `done` all
 * cleared, `locked` no access, `offline` no connection, `broken` it failed, `lost` no page at this
 * address.
 */
export type EmptyIllustration =
  | "nothing"
  | "search"
  | "done"
  | "locked"
  | "offline"
  | "broken"
  | "lost";

/** Every prop an Empty takes. */
export interface EmptyProps {
  /** Its parts: an EmptyHeader (with EmptyMedia, EmptyTitle and EmptyDescription), then an EmptyContent for the way on. */
  children: ReactNode;
  /**
   * `default`: there is nothing here. `destructive`: it did not load, said to a screen reader at once.
   * @default "default"
   */
  variant?: "default" | "destructive";
  /**
   * A destructive Empty's title and sentence are said to a screen reader as they appear, never its
   * actions. Set `false` where the page itself is the error, a route's error page, which is read
   * as any page is, not as a live update. Nothing is said for `variant="default"`.
   * @default true
   */
  announce?: boolean;
  /**
   * `lg` stands for a whole list or page (at least 400px tall), `default` for a card or one tab
   * (at least 150px), `sm` for a small box, with no height of its own.
   * @default "default"
   */
  size?: "sm" | "default" | "lg";
  /**
   * Where the words stand. `center`: in the middle of the place. `start`: at the head of the place,
   * from its start edge, where the first item will land. Use `start` for a list or a table that
   * will fill downwards.
   * @default "center"
   */
  align?: "center" | "start";
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an EmptyHeader takes: the media, the title and the sentence. */
export interface EmptyHeaderProps {
  /** An EmptyMedia, an EmptyTitle and an EmptyDescription, in that order. */
  children: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an EmptyMedia takes: what stands above the title. Give one of the three, or none. */
export interface EmptyMediaProps {
  /** An icon, when it says what is missing faster: InboxIcon. From lib/icons. */
  icon?: IconData;
  /**
   * `default`, the icon alone in the muted colour; `icon`, the icon on a small muted tile.
   * @default "default"
   */
  variant?: "default" | "icon";
  /**
   * A small drawing that tells the case apart at a glance, in place of the icon: `nothing` nothing
   * made yet, `search` nothing matches, `done` all cleared, `locked` no access, `offline` no
   * connection, `broken` it failed, `lost` no page at this address. A picture only: the title says
   * the same in words.
   */
  illustration?: EmptyIllustration;
  /**
   * A part of its own in the icon's place: an Agent indicator (or a Spinner) while the place is
   * being set up, sized and centred as the icon is. Leave `icon` and `illustration` out with it.
   * With none of the three, a destructive Empty shows the alert icon, and any other nothing.
   */
  children?: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an EmptyTitle takes. */
export interface EmptyTitleProps {
  /**
   * A short title. Keep it for a page or a whole list, where the state stands alone; in a card or
   * a tab the sentence alone says it. A destructive Empty always has one: leave it empty for the
   * catalogue's `empty.error` ("This did not load").
   */
  children?: ReactNode;
  /**
   * The title as a heading of this level, for when the state is the page or a section of it: `1`
   * on a not-found or error page, where the title is the page's h1; `2` or `3` in a section. The
   * look stays the same. Leave it out and the title is plain text, as the page's own heading names
   * the list.
   */
  level?: 1 | 2 | 3 | 4;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an EmptyDescription takes. */
export interface EmptyDescriptionProps {
  /** One sentence: what will appear here, and when ("Projects appear here once someone creates one."). */
  children: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an EmptyContent takes. */
export interface EmptyContentProps {
  /**
   * The way on, under the sentence: one Button, or a quiet second beside it ("New project";
   * "Clear the filter"; "Try again"). Its words say what it does.
   */
  children: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

const { pitch, square } = DITHER_GEOMETRY.dots;
/** How much of the dither is lit, of 16: so a bar reads as a bar and not as a dotted line. */
const LEVEL = 10;

// ---- Illustrations: one exact drawing per case ----------------------------------------------------
//
// Each is drawn in its own pixels (96 by 64, never scaled): outlines one pixel wide, surfaces in
// the system's dither, and one accent where the case has good news. A drawing is not content: a
// screen reader does not meet it, and the title says the same thing. Nothing in it moves. In
// forced colours it is drawn in the text colour.

/** The lens in "search": its rim, and the room the rows keep from it. */
const LENS = { cx: 56.5, cy: 29.5, r: 15.5 + 5 };

const illustrationStyles = stylex.create({
  picture: {
    display: "block",
    justifySelf: "center",
    width: 96,
    height: 64,
    marginBottom: space["3"],
    overflow: "visible",
  },
  // At the start edge, when the words stand at the head of the place.
  start: { justifySelf: "start" },
  line: {
    fill: "none",
    stroke: {
      default: colors.mutedForeground,
      [media.forcedColors]: "CanvasText",
    },
    strokeWidth: 1,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  sheet: {
    fill: { default: colors.card, [media.forcedColors]: "Canvas" },
    stroke: {
      default: colors.mutedForeground,
      [media.forcedColors]: "CanvasText",
    },
    strokeWidth: 1,
    strokeLinejoin: "round",
  },
  good: {
    fill: "none",
    stroke: { default: colors.mintDeep, [media.forcedColors]: "CanvasText" },
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  bad: {
    fill: "none",
    stroke: { default: colors.destructive, [media.forcedColors]: "CanvasText" },
    strokeWidth: 1,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  dot: {
    fill: {
      default: colors.mutedForeground,
      [media.forcedColors]: "CanvasText",
    },
  },
});

/**
 * At the start edge, each drawing pulled in by the room its own ink leaves at that side of its
 * box, so its outline stands on the words' edge (the room differs per case; right to left, the
 * other side's room).
 */
const illustrationShift = stylex.create({
  nothing: { marginInlineStart: { default: -18, ":dir(rtl)": -17 } },
  search: { marginInlineStart: { default: -12, ":dir(rtl)": -17 } },
  done: { marginInlineStart: { default: -18, ":dir(rtl)": -17 } },
  locked: { marginInlineStart: { default: -18, ":dir(rtl)": -17 } },
  offline: { marginInlineStart: { default: -6, ":dir(rtl)": -6 } },
  broken: { marginInlineStart: { default: -18, ":dir(rtl)": -17 } },
  lost: { marginInlineStart: { default: -8, ":dir(rtl)": -7 } },
});

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
        (BAYER_MATRIX[row % BAYER_MATRIX.length]?.[
          column % BAYER_MATRIX.length
        ] ?? LEVEL) < LEVEL;
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
    <g {...stylex.props(illustrationStyles.dot)}>
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

/** The pull at the start edge for a drawing, by its case. */
const shiftOf = (illustration: EmptyIllustration) => {
  if (illustration === "nothing") {
    return illustrationShift.nothing;
  }
  if (illustration === "search") {
    return illustrationShift.search;
  }
  if (illustration === "done") {
    return illustrationShift.done;
  }
  if (illustration === "locked") {
    return illustrationShift.locked;
  }
  if (illustration === "offline") {
    return illustrationShift.offline;
  }
  return illustration === "broken"
    ? illustrationShift.broken
    : illustrationShift.lost;
};

const Illustration = ({
  illustration: picture,
  start,
  style,
}: {
  illustration: EmptyIllustration;
  start: boolean;
  style: LayoutStyle | undefined;
}) => {
  const line = stylex.props(illustrationStyles.line);
  const sheet = stylex.props(illustrationStyles.sheet);
  const good = stylex.props(illustrationStyles.good);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 96 64"
      data-slot="empty-illustration"
      data-illustration={picture}
      {...stylex.props(
        illustrationStyles.picture,
        start && illustrationStyles.start,
        start && shiftOf(picture),
        style
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
            {...stylex.props(illustrationStyles.bad)}
          />
        </>
      )}
    </svg>
  );
};

// ---- The parts ---------------------------------------------------------------------------------

const styles = stylex.create({
  box: {
    [iconVars.size]: sizes.iconDefault,
    [iconVars.stroke]: sizes.iconStroke,
    display: "grid",
    justifyItems: "center",
    alignContent: "center",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    // Room at the sides too, so its words never touch the edges of a narrow list.
    paddingInline: space[4],
    textAlign: "center",
    fontFamily: font.sans,
  },
  // At the head of the place: the words from the start edge, where the first item will land.
  start: {
    justifyItems: "stretch",
    alignContent: "start",
    textAlign: "start",
    paddingBlock: space[5],
  },
  startWords: { justifyItems: "start" },
  startContent: { justifyContent: "flex-start" },
  content: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space[2],
    marginTop: space[4],
  },
  lg: { minHeight: sizes.emptyPage },
  default: { minHeight: sizes.emptySection },
  sm: { padding: space[4] },
  // The media, the title and the sentence, at the words' gap.
  header: { display: "grid", rowGap: space[2], minWidth: 0 },
  words: {
    display: "grid",
    rowGap: space[2],
    maxWidth: sizes.emptyMeasure,
    // A word longer than the measure breaks; common words are not hyphenated at this short width.
    overflowWrap: "anywhere",
  },
  media: {
    display: "inline-flex",
    justifySelf: "center",
    marginBottom: space[3],
    color: colors.mutedForeground,
  },
  mediaStart: { justifySelf: "start" },
  // A part in the icon's place keeps the icon's box: its height and width, centred in it.
  mediaPart: {
    alignItems: "center",
    justifyContent: "center",
    width: sizes.iconDefault,
    height: sizes.iconDefault,
  },
  // The icon on a small muted tile.
  mediaTile: {
    alignItems: "center",
    justifyContent: "center",
    width: space[10],
    height: space[10],
    borderRadius: radius.mark,
    cornerShape: radius.shape,
    color: colors.foreground,
    backgroundColor: colors.muted,
  },
  mediaDestructive: {
    color: colors.destructive,
  },
  title: {
    // Its own tracking: a host page's heading rules never reach it.
    letterSpacing: font.trackingUi,
    margin: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
    textWrap: "balance",
  },
  description: {
    margin: 0,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.subtleForeground,
    textWrap: "pretty",
  },
});

// What the root hands its parts: it did not load, its title and sentence are said as they
// appear, and its words stand at the head of the place.
const EmptyDestructive = createContext(false);
const EmptySaid = createContext(false);
const EmptyStart = createContext(false);

const hasPart = (part: ReactNode) =>
  part !== undefined && part !== null && part !== false;

/** What stands above the title: an icon, a drawing, or a part of its own. A destructive Empty's alert icon by default. */
export const EmptyMedia = ({
  icon,
  variant = "default",
  illustration,
  children,
  style,
}: EmptyMediaProps) => {
  const destructive = use(EmptyDestructive);
  const start = use(EmptyStart);
  // A drawing stands where the icon would: one or the other, never both.
  if (illustration !== undefined) {
    return (
      <Illustration illustration={illustration} start={start} style={style} />
    );
  }
  // A part of its own in the icon's place: the icon's box, centred, its own colours; its words, if
  // any, are its own.
  if (hasPart(children)) {
    return (
      <span
        data-slot="empty-media"
        {...stylex.props(
          styles.media,
          styles.mediaPart,
          start && styles.mediaStart,
          style
        )}
      >
        {children}
      </span>
    );
  }
  const mark = icon ?? (destructive ? TriangleAlertIcon : undefined);
  return mark === undefined ? null : (
    <span
      aria-hidden="true"
      data-slot="empty-media"
      data-variant={variant}
      {...stylex.props(
        styles.media,
        variant === "icon" && styles.mediaTile,
        destructive && styles.mediaDestructive,
        start && styles.mediaStart,
        style
      )}
    >
      <Icon icon={mark} />
    </span>
  );
};

/**
 * The media, the title and the sentence. A destructive Empty's are said to a screen reader as
 * they appear (an assertive live region, never its actions), and again when their words change.
 */
export const EmptyHeader = ({ children, style }: EmptyHeaderProps) => {
  const said = use(EmptySaid);
  const start = use(EmptyStart);
  const header = useRef<HTMLDivElement | null>(null);
  const spoken = useRef("");
  useEffect(() => {
    // The title and the sentence, each its own phrase; the media says nothing, a part in the
    // icon's place (a labelled Spinner) neither.
    const words =
      said && header.current !== null
        ? [...header.current.children]
            .filter(
              (part) =>
                !(part instanceof HTMLElement) ||
                part.dataset.slot !== "empty-media"
            )
            .map((part) => part.textContent.trim())
            .filter((part) => part !== "")
            .join(". ")
        : "";
    if (words !== spoken.current) {
      spoken.current = words;
      if (words !== "") {
        announce(words, "assertive");
      }
    }
  });
  return (
    <div
      ref={header}
      data-slot="empty-header"
      {...stylex.props(styles.header, start && styles.startWords, style)}
    >
      {children}
    </div>
  );
};

/** The short title. A destructive Empty's is the catalogue's `empty.error` unless it is given words. */
export const EmptyTitle = ({ children, level, style }: EmptyTitleProps) => {
  const destructive = use(EmptyDestructive);
  const { empty } = useI18n();
  const words = children ?? (destructive ? empty.error : undefined);
  const Title = level === undefined ? "p" : (`h${level}` as const);
  return hasPart(words) && words !== "" ? (
    <Title data-slot="empty-title" {...stylex.props(styles.title, style)}>
      {words}
    </Title>
  ) : null;
};

/** The one sentence: what will appear here, and when. */
export const EmptyDescription = ({
  children,
  style,
}: EmptyDescriptionProps) => (
  <p data-slot="empty-description" {...stylex.props(styles.description, style)}>
    {children}
  </p>
);

/** The way on, under the sentence. */
export const EmptyContent = ({ children, style }: EmptyContentProps) => {
  const start = use(EmptyStart);
  return hasPart(children) ? (
    <div
      data-slot="empty-content"
      {...stylex.props(styles.content, start && styles.startContent, style)}
    >
      {children}
    </div>
  ) : null;
};

export const Empty = ({
  children,
  variant = "default",
  announce: said = true,
  size = "default",
  align = "center",
  style,
}: EmptyProps) => {
  const destructive = variant === "destructive";
  const start = align === "start";
  return (
    <div
      data-slot="empty"
      data-variant={variant}
      data-align={align}
      {...stylex.props(
        styles.box,
        size === "sm" && styles.sm,
        size === "default" && styles.default,
        size === "lg" && styles.lg,
        start && styles.start,
        style
      )}
    >
      <div {...stylex.props(styles.words, start && styles.startWords)}>
        <EmptyDestructive value={destructive}>
          <EmptySaid value={destructive && said}>
            <EmptyStart value={start}>{children}</EmptyStart>
          </EmptySaid>
        </EmptyDestructive>
      </div>
    </div>
  );
};
