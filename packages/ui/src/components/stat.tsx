// Stat: one figure that matters, with its label and how it moved: the label small and quiet over
// the value, the change beside it in its variant's colour, and an icon at the end of the label when
// it helps. It is plain HTML.
//
//   <Stat label="Revenue" value="€45,678" change="+8.2%" variant="success" />
//   <Stat label="Open tickets" value="12" loading />
//
//   <StatGroup aria-label="This month" items={[{ label: "Revenue", value: "€45,678" }, …]} />
//   <StatGroup aria-label="This month">
//     <Stat label="Revenue" value="€45,678" />
//     <Stat label="Refunds" value="€1,204" change="+3%" variant="destructive" />
//   </StatGroup>
//
// A screen reader reads it in order: the label, which names it, then the value, then the change.
// The change says its trend in its own words ("+8.2%", "−3 since Monday"); its colour only repeats
// them. A group is one box with the system's lift, its cells parted by hairlines, at most four in a
// row and two under 768px; the last figure takes what is left of its row, so no place stands empty.
//
// It says, it does not do: nothing in it is pressed. Every value is a token. A caller may set
// layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import { createContext, isValidElement, use, useId, useState } from "react";
import type { ReactNode } from "react";

import { Icon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { fadeIn } from "../lib/styles";
import {
  colors,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { Skeleton } from "./skeleton";

/** What the change means, in colour: no judgement, good, bad, worth a look, a plain note. */
export type StatVariant =
  | "default"
  | "success"
  | "destructive"
  | "warning"
  | "info";

/** Every prop a Stat takes. */
export interface StatProps {
  /** What the figure is, in a word or two ("Revenue", "Active users"). It names the figure. */
  label: string;
  /** The figure itself, formatted for reading ("€45,678", "3.45%"). */
  value: string;
  /**
   * How it moved, beside the value, in words that say the trend by themselves ("+8.2%", "−3 since
   * Monday"): a screen reader reads them as written, and the colour only repeats them.
   */
  change?: string;
  /**
   * What the change means, in colour: `success` good, `destructive` bad, `warning` worth a look,
   * `info` a plain note, `default` no judgement. Rising is not always good: a rise in returns is
   * `destructive`. The words say it too.
   * @default "default"
   */
  variant?: StatVariant;
  /** An icon at the end of the label, in muted, from lib/icons. */
  icon?: IconData;
  /**
   * Still loading: skeletons hold the value's and the change's room, so nothing moves when they
   * arrive. The figure says it is busy.
   * @default false
   */
  loading?: boolean;
  /**
   * A small chart under the figures: a ChartSparkline at its tile size, the figure's trend. With
   * its `onPoint`, the value it shows can follow the point under the pointer.
   */
  chart?: ReactNode;
  /**
   * Inside a card that has its own room and ground: no padding, no ground and no rule of its own,
   * so its label stands on the card's start edge, as its other words do.
   * @default false
   */
  unstyled?: boolean;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop a StatGroup takes. */
export interface StatGroupProps {
  /** What the row is about, for a screen reader and an agent ("This month"). */
  "aria-label": string;
  /** The figures, in reading order: each takes a Stat's props. Or give Stats as children. */
  items?: Omit<StatProps, "style" | "unstyled">[];
  /** The Stats, in reading order, in place of `items`. */
  children?: ReactNode;
  /**
   * How many stand in a row on a wide screen. Leave it out to fit them all, up to 4.
   */
  columns?: 1 | 2 | 3 | 4;
  /**
   * Every figure is still loading.
   * @default false
   */
  loading?: boolean;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

const FORCED = media.forcedColors;
const NARROW = media.maxMd;

const styles = stylex.create({
  // One figure: the card's ground, the label over the value.
  stat: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "grid",
    alignContent: "start",
    rowGap: space["2"],
    minWidth: 0,
    boxSizing: "border-box",
    margin: 0,
    padding: space["6"],
    backgroundColor: colors.card,
    color: colors.foreground,
    fontFamily: font.sans,
  },
  // Drawn alone: a flat cell on the card's ground, no corner and no edge, with one hairline rule
  // beneath it.
  alone: {
    borderBottomWidth: size.hairline,
    borderBottomStyle: "solid",
    borderBottomColor: { default: colors.border, [FORCED]: "CanvasText" },
  },
  // Inside a card: the card's own room and ground serve, so none of its own.
  unstyled: { padding: 0, backgroundColor: "transparent" },
  // A small chart under the figures, clear of them.
  chart: { marginBlockStart: space["3"], minWidth: 0 },
  // The label row: the label, and an icon at the end, on the label's first line however many lines
  // it wraps to, so the icons of a row of figures line up.
  head: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: space["3"],
    minWidth: 0,
  },
  label: {
    margin: 0,
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
  },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    marginBlockStart: `calc((${font.textSmLine} - ${size.iconSm}) / 2)`,
    color: colors.mutedForeground,
  },
  // The value and its change, on one line when there is room.
  figures: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space["2"],
    rowGap: 0,
    margin: 0,
    minWidth: 0,
  },
  value: {
    fontSize: font.textLg,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  change: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  default: { color: colors.mutedForeground },
  success: { color: colors.success },
  destructive: { color: colors.destructive },
  warning: { color: colors.warning },
  info: { color: colors.info },
  // Loading: about four figures of the value at its size (a ch is a figure's width), so a figure
  // waits as wide as a figure, not across the cell.
  skeletonValue: {
    display: "flex",
    width: "4ch",
    maxWidth: "100%",
    fontSize: font.textLg,
  },
  skeletonChange: { display: "flex", width: "35%" },

  // The group: one box with the lift, its cells parted by hairlines: a hairline's gap between the
  // cells shows the box's ground, the line laid over the card's fill, one colour everywhere, so
  // where the lines cross there is no darker knot.
  group: {
    display: "grid",
    gap: size.hairline,
    backgroundImage: {
      default: `linear-gradient(${colors.border}, ${colors.border})`,
      [FORCED]: "none",
    },
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    overflow: "hidden",
    borderRadius: radius.base,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.md,
    outline: {
      default: "none",
      [FORCED]: `${size.hairline} solid CanvasText`,
    },
    listStyle: "none",
  },
  // The last figure takes what is left of its row, at the wide count and at the two columns under
  // 768px: one style for each pair, as a later style would replace an earlier one's.
  wide2: { gridColumn: "span 2" },
  wide3: { gridColumn: { default: "span 3", [NARROW]: null } },
  wide3narrow2: { gridColumn: { default: "span 3", [NARROW]: "span 2" } },
  wide4: { gridColumn: { default: "span 4", [NARROW]: null } },
  wide4narrow2: { gridColumn: { default: "span 4", [NARROW]: "span 2" } },
  narrow2: { gridColumn: { default: null, [NARROW]: "span 2" } },
  cols1: { gridTemplateColumns: "minmax(0, 1fr)" },
  // Under 768px, at most two in a row: a figure needs its width more than a row needs its length.
  cols2: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
  cols3: {
    gridTemplateColumns: {
      default: "repeat(3, minmax(0, 1fr))",
      [NARROW]: "repeat(2, minmax(0, 1fr))",
    },
  },
  cols4: {
    gridTemplateColumns: {
      default: "repeat(4, minmax(0, 1fr))",
      [NARROW]: "repeat(2, minmax(0, 1fr))",
    },
  },
  cell: {
    display: "grid",
    margin: 0,
    padding: 0,
    backgroundColor: colors.card,
    outline: {
      default: "none",
      [FORCED]: `${size.hairline} solid CanvasText`,
    },
  },
});

/** How many columns the last figure takes: what its row leaves, at the wide count and at two. */
const spanOf = (columns: 1 | 2 | 3 | 4, count: number) => {
  const left = (wide: number) =>
    count % wide === 0 ? 1 : wide - (count % wide) + 1;
  const wide = left(columns);
  const narrow = columns >= 3 ? left(2) : 1;
  switch (`${wide}-${narrow}`) {
    case "2-1": {
      return styles.wide2;
    }
    case "3-1": {
      return styles.wide3;
    }
    case "3-2": {
      return styles.wide3narrow2;
    }
    case "4-1": {
      return styles.wide4;
    }
    case "4-2": {
      return styles.wide4narrow2;
    }
    case "1-2": {
      return styles.narrow2;
    }
    default: {
      return null;
    }
  }
};

const columnStyles = {
  1: styles.cols1,
  2: styles.cols2,
  3: styles.cols3,
  4: styles.cols4,
} as const;

/** As many columns as figures, from one to four. */
const columnsFor = (count: number): 1 | 2 | 3 | 4 => {
  if (count <= 1) {
    return 1;
  }
  if (count === 2) {
    return 2;
  }
  if (count === 3) {
    return 3;
  }
  return 4;
};

// What a StatGroup hands the Stats in it: that they are its cells, whether they all wait, and the
// span the last one takes.
const InGroup = createContext<{
  grouped: boolean;
  loading: boolean;
  place: ReturnType<typeof spanOf>;
}>({ grouped: false, loading: false, place: null });

/** The insides: the label and its icon, the value and its change, and the chart. */
const Body = ({
  id,
  label,
  value,
  change,
  variant = "default",
  icon,
  loading,
  chart,
}: Omit<StatProps, "loading" | "unstyled" | "style"> & {
  id: string;
  loading: boolean;
}) => {
  // Figures that replace the placeholders fade in; ones there from the first paint are simply
  // there. Remembered as state, set the first time it loads.
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) {
    setWaited(true);
  }
  const arrived = waited && !loading;
  return (
    <>
      <div {...stylex.props(styles.head)}>
        <p id={id} {...stylex.props(styles.label)}>
          {label}
        </p>
        {icon && (
          <span aria-hidden="true" {...stylex.props(styles.icon)}>
            <Icon icon={icon} />
          </span>
        )}
      </div>
      {loading ? (
        <div {...stylex.props(styles.figures)}>
          <span {...stylex.props(styles.skeletonValue)}>
            <Skeleton size="default" />
          </span>
          {change !== undefined && (
            <span {...stylex.props(styles.skeletonChange)}>
              <Skeleton />
            </span>
          )}
        </div>
      ) : (
        <p {...stylex.props(styles.figures, arrived && fadeIn)}>
          <span {...stylex.props(styles.value)}>{value}</span>
          {change !== undefined && change !== "" ? (
            <span {...stylex.props(styles.change, styles[variant])}>
              {change}
            </span>
          ) : null}
        </p>
      )}
      {chart !== undefined && (
        <div {...stylex.props(styles.chart)}>{chart}</div>
      )}
    </>
  );
};

type Place = ReturnType<typeof spanOf>;

/** One cell of a StatGroup: a list item named by its label, and the span its place in the row takes. */
const Cell = ({
  place,
  loading,
  style,
  ...props
}: Omit<StatProps, "unstyled"> & { place: Place }) => {
  const id = useId();
  return (
    <li
      aria-labelledby={id}
      data-slot="stat"
      {...stylex.props(styles.cell, place, style)}
    >
      <div {...stylex.props(styles.stat)}>
        <Body {...props} id={id} loading={loading === true} />
      </div>
    </li>
  );
};

/** One figure: its label, the value, and how much it changed. Alone, or a cell of a StatGroup. */
export const Stat = ({
  loading = false,
  unstyled = false,
  style,
  ...props
}: StatProps) => {
  const id = useId();
  const group = use(InGroup);
  const waiting = loading || group.loading;
  if (group.grouped) {
    return (
      <Cell {...props} place={group.place} loading={waiting} style={style} />
    );
  }
  return (
    <section
      aria-labelledby={id}
      aria-busy={waiting || undefined}
      data-slot="stat"
      {...stylex.props(
        styles.stat,
        unstyled ? styles.unstyled : styles.alone,
        style
      )}
    >
      <Body {...props} id={id} loading={waiting} />
    </section>
  );
};

/** A row of key figures, at most four, one box with hairlines between them. */
export const StatGroup = ({
  "aria-label": ariaLabel,
  items,
  children,
  columns,
  loading = false,
  style,
}: StatGroupProps) => {
  const stats = [children].flat().filter(isValidElement);
  const figures = items ?? [];
  const total = figures.length + stats.length;
  const count = columns ?? columnsFor(total);
  // The last figure takes what is left of its row.
  const last = spanOf(count, total);
  return (
    <ul
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      data-slot="stat-group"
      {...stylex.props(styles.group, columnStyles[count], style)}
    >
      {figures.map((item, index) => (
        // Two figures may share a label; their place tells them apart.
        <Cell
          key={`${index}-${item.label}`}
          {...item}
          loading={item.loading === true || loading}
          place={index === total - 1 ? last : null}
        />
      ))}
      {stats.map((stat, index) => (
        <InGroup
          key={stat.key ?? index}
          // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
          value={{
            grouped: true,
            loading,
            place: figures.length + index === total - 1 ? last : null,
          }}
        >
          {stat}
        </InGroup>
      ))}
    </ul>
  );
};
