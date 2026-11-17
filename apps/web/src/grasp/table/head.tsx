// TableHead: the name of a column (table.tsx), in muted words. A column that can be sorted has its
// name as a button, with the sort's icon after it, and says its sort to a screen reader.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { MouseEvent, ReactNode, ThHTMLAttributes } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, Sortable, SortDown, SortUp } from "../icons";
import { useHeadLook } from "./look";
import type { TableHeadLook } from "./look";
import { useDensity, useStickyHead } from "./section-context";
import type { TablePin } from "./section-context";
import { tablePlace, tableStyles as styles } from "./styles";

/** How a column is sorted. */
export type TableSort = "ascending" | "descending" | "none";

/** Every prop a TableHead takes. */
export interface TableHeadProps {
  /** The column's name, short and in sentence case ("Last edited"). */
  children?: ReactNode;
  /**
   * Where the name stands: `end` over a column of figures, so it lines up with them; `center`
   * over a column of short marks.
   * @default "start"
   */
  align?: "start" | "center" | "end";
  /** The name of a column whose head shows no words, such as a column of actions. */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * How the column is sorted now. You own the sort: sort the rows yourself and pass it here, on
   * every sortable column (`none` on the others).
   */
  sort?: TableSort;
  /**
   * Runs when the column's name is pressed: sort the rows by it, or turn the sort over. The press
   * comes with it, so Shift can add the column to a sort by several.
   */
  onSort?: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * Where the column stands in a sort by several columns, from 1. Shown after the sort's icon, and
   * said, when more than one column is sorted.
   */
  order?: number;
  /** How a column's place in a sort by several is said: ", sorted second". */
  orderWords?: (place: number) => string;
  /** Held in place while the other columns scroll sideways (a Data table's pinned column). */
  pin?: TablePin;
  /** The column's width in pixels, in a table whose columns are sized. */
  width?: number;
  /** The column's key in code, as `data-column`, for a script or a test that finds it. */
  column?: string;
  /** Controls at the head's end, after the name: a column's menu, a handle to resize it. */
  end?: ReactNode;
  /** @deprecated Use `end`. */
  after?: ReactNode;
  /** Dragging the head moves the column (a Data table that reorders); the drop's own events. */
  drag?: Pick<
    ThHTMLAttributes<HTMLTableCellElement>,
    | "draggable"
    | "onDragStart"
    | "onDragOver"
    | "onDragLeave"
    | "onDrop"
    | "onDragEnd"
  > & { "data-drop"?: "before" | "after" };
}

const icons = {
  ascending: SortUp,
  descending: SortDown,
  none: Sortable,
} as const;

/** Where a held cell stands, and how wide a sized one is, as StyleX values. */
export const placeOf = (pin: TablePin | undefined, width?: number) => [
  pin?.side === "start" && tablePlace.start(pin.offset),
  pin?.side === "end" && tablePlace.end(pin.offset),
  width !== undefined && tablePlace.width(`${String(width)}px`),
];

/** How a held cell looks: on the table's ground, its lift on its open side. */
export const pinLook = (pin: TablePin | undefined) => [
  pin !== undefined && styles.pinned,
  pin?.edge === true && pin.side === "start" && styles.edgeStart,
  pin?.edge === true && pin.side === "end" && styles.edgeEnd,
];

const places = ["first", "second", "third", "fourth", "fifth"];
const sortedPlace = (place: number) =>
  `, sorted ${places[place - 1] ?? `${String(place)}th`}`;

interface SortButtonProps {
  children?: ReactNode;
  /** The quiet look shows the place in a chip. */
  chip: boolean;
  state: TableSort;
  onSort: (event: MouseEvent<HTMLButtonElement>) => void;
  order?: number;
  orderWords: (place: number) => string;
}

/** A sortable column's name: a button, with the sort's icon and its place in a sort by several. */
const SortButton = ({
  children,
  chip,
  state,
  onSort,
  order,
  orderWords,
}: SortButtonProps) => (
  <button
    type="button"
    onClick={onSort}
    // Reached by Tab, scrolled clear of the box's fades (its scroll margin), so its ring is whole.
    onFocus={(event) => {
      event.currentTarget.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }}
    {...stylex.props(
      styles.sort,
      state !== "none" && styles.sorted,
      focus.ring
    )}
  >
    <span aria-hidden="true" {...stylex.props(styles.target)} />
    {children}
    <span {...stylex.props(state === "none" && styles.unsorted)}>
      <Icon icon={icons[state]} />
    </span>
    {order !== undefined && state !== "none" && (
      <span {...stylex.props(styles.order)}>
        <span aria-hidden="true" {...stylex.props(chip && styles.orderChip)}>
          {order}
        </span>
        <span {...stylex.props(visuallyHidden)}>{orderWords(order)}</span>
      </span>
    )}
  </button>
);

/** Where a held head stands among the other held parts: above them when it stays and is held. */
const heldLook = (pin: TablePin | undefined, stickyHead: boolean) => [
  pinLook(pin),
  pin !== undefined && styles.pinnedHead,
  stickyHead && pin !== undefined && styles.corner,
  pin?.above === true && (stickyHead ? styles.aboveHead : styles.aboveBody),
];

/** How a head looks for the table's look and its sort. */
const lookOf = (headLook: TableHeadLook, sorted: boolean) => [
  headLook === "soft" && styles.headSoft,
  headLook === "quiet" && sorted && styles.headQuietSorted,
];

/** The name of a column. It labels every cell under it for a screen reader. */
export const TableHead = ({
  children,
  align = "start",
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  sort,
  onSort,
  order,
  orderWords = sortedPlace,
  pin,
  width,
  after: afterDeprecated,
  end: after = afterDeprecated,
  drag,
  column,
}: TableHeadProps) => {
  const density = useDensity();
  const stickyHead = useStickyHead();
  const headLook = useHeadLook();
  const state = sort ?? "none";
  const drop = drag?.["data-drop"];
  return (
    <th
      data-slot="table-head"
      // A head that stays in view or is held draws the head's line itself (styles.stuck,
      // styles.pinnedHead); a row whose heads all do leaves its own off.
      data-own-line={stickyHead || pin !== undefined ? "" : undefined}
      scope="col"
      aria-label={label}
      aria-sort={onSort !== undefined && state !== "none" ? state : undefined}
      data-column={column}
      {...drag}
      {...stylex.props(
        styles.head,
        after !== undefined && styles.headWithAfter,
        density === "compact" && styles.headCompact,
        align === "end" && styles.end,
        align === "center" && styles.centre,
        stickyHead && styles.stuck,
        heldLook(pin, stickyHead),
        // After the held look: a held head stands on the head's own ground, not the table's.
        lookOf(headLook, state !== "none"),
        drop === "before" && styles.dropBefore,
        drop === "after" && styles.dropAfter,
        placeOf(pin, width)
      )}
    >
      {onSort === undefined ? (
        children
      ) : (
        <SortButton
          chip={headLook === "quiet"}
          state={state}
          onSort={onSort}
          order={order}
          orderWords={orderWords}
        >
          {children}
        </SortButton>
      )}
      {after}
    </th>
  );
};
