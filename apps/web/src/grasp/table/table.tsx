// Table: rows of facts in columns, from shadcn's (registry/bases/base/ui/table.tsx), converted from
// Tailwind to StyleX and made Grasp's: small text, a hairline between rows, the head in muted words,
// figures that line up, and a soft footer. Plain HTML table elements underneath: UI SDK has no
// table, and a table of facts needs no behaviour.
//
//   <Table caption="Reports this quarter.">
//     <TableHeader>
//       <TableRow><TableHead>Report</TableHead><TableHead align="end">Pages</TableHead></TableRow>
//     </TableHeader>
//     <TableBody>
//       <TableRow><TableCell lead>Quarterly summary</TableCell><TableCell align="end">12</TableCell></TableRow>
//     </TableBody>
//   </Table>
//
// A table wider than its column scrolls sideways inside its own box, which then takes focus so the
// keys can scroll it. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { HeadLookContext, RangeLookContext, tableLook } from "./look";
import type { TableHeadLook, TableRangeLook } from "./look";
import { DensityContext, StickyHeadContext } from "./section-context";
import type { TableDensity } from "./section-context";
import { tablePlace, tableStyles as styles } from "./styles";

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/** Every prop a Table takes. */
export interface TableProps {
  /** The head, the body and the footer: TableHeader, TableBody and TableFooter. */
  children: ReactNode;
  /**
   * What the table holds, in a short sentence under it. It names the table for a screen reader
   * and an agent. Leave it out only when a heading right above names it, and pass `label`.
   */
  caption?: ReactNode;
  /** The table's name when it has no caption, for a screen reader and an agent. */
  label?: string;
  /**
   * How much room a row has: `compact` 32px, `default` 42px (Palermo's), `roomy` 50px.
   * @default "default"
   */
  density?: TableDensity;
  /**
   * The tallest the table's box grows (a CSS length, "28rem"); taller, its rows scroll inside it
   * and the head stays in view, casting the low lift while rows are under it.
   */
  height?: string;
  /**
   * The table's width in pixels, when its columns are sized (a Data table that resizes or pins):
   * the columns then keep their widths and the table lays out at once, without measuring words.
   */
  width?: number;
  /**
   * A side with more columns beyond it fades out, since the box shows no scrollbar. A Data table
   * with held columns turns it off: their lift says it instead. The foot of a table with a height
   * fades while rows lie below it either way.
   * @default true
   */
  fade?: boolean;
  /**
   * Its rows arrive one at a time (an answer being written): the columns share the width evenly,
   * so no row that comes moves the ones above it. Keep it on once the table is whole and nothing
   * moves then either.
   */
  arriving?: boolean;
  /** Something after the table, inside its box: a Data table's mark for endless loading. */
  end?: ReactNode;
  /** How a chosen row shows (look.ts); the default is the system's. */
  rangeLook?: TableRangeLook;
  /** How the head shows (look.ts); the default is the system's. */
  headLook?: TableHeadLook;
}

// Watches the box: whether it scrolls at all (then it is a named region the keys can scroll), and
// what is scrolled under its held parts, as attributes their styles read (no render per frame):
// rows under the head, rows below the foot, columns under a held start or end.
const watch = (
  element: HTMLDivElement,
  setScrolls: (scrolls: boolean) => void
) => {
  const mark = () => {
    const along = Math.abs(element.scrollLeft);
    setScrolls(
      element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1
    );
    element.toggleAttribute("data-under-head", element.scrollTop > 0);
    element.toggleAttribute("data-under-start", along > 0);
    element.toggleAttribute(
      "data-under-end",
      along < element.scrollWidth - element.clientWidth - 1
    );
    // Rows below the box's foot, in a table with a height.
    element.toggleAttribute(
      "data-under-foot",
      element.scrollTop < element.scrollHeight - element.clientHeight - 1
    );
  };
  // Marked by the observer only: it reports the box once when it starts watching, after the page
  // is laid out, so a table that mounts while an answer streams forces no layout of its own.
  const observer = new ResizeObserver(mark);
  observer.observe(element);
  if (element.firstElementChild !== null) {
    observer.observe(element.firstElementChild);
  }
  element.addEventListener("scroll", mark, { passive: true });
  return () => {
    observer.disconnect();
    element.removeEventListener("scroll", mark);
  };
};

/** The table, in a box that scrolls sideways when the table is wider than its column. */
/** Whether a caption was given (a node that draws something). */
const isGiven = (caption: ReactNode) =>
  caption !== undefined && caption !== null && caption !== false;

/** The caption a reader sees, under the box: whole while the table scrolls, off the box's ring. */
const SeenCaption = ({ caption }: { caption: ReactNode }) =>
  caption === undefined ? null : (
    <p
      aria-hidden="true"
      data-slot="table-caption"
      {...stylex.props(styles.caption)}
    >
      {caption}
    </p>
  );

export const Table = ({
  children,
  caption,
  label,
  density = "default",
  height,
  width,
  fade = true,
  arriving,
  end,
  rangeLook = tableLook.range,
  headLook = tableLook.head,
}: TableProps) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const captionId = useId();
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const element = boxRef.current;
    const stop = element === null ? undefined : watch(element, setScrolls);
    return () => {
      stop?.();
    };
  }, []);
  const hasCaption = isGiven(caption);
  const named = hasCaption
    ? { "aria-labelledby": captionId }
    : { "aria-label": label };
  return (
    <div data-slot="table-frame" {...stylex.props(styles.frame)}>
      {/* The box and its ring, together: the ring lies over the box alone, not the caption. */}
      <div {...stylex.props(styles.box)}>
        <div
          ref={boxRef}
          data-slot="table-container"
          tabIndex={scrolls ? 0 : undefined}
          role={scrolls ? "region" : undefined}
          {...(scrolls ? named : {})}
          {...stylex.props(
            styles.scroller,
            styles.fade,
            fade && styles.fadeSides,
            height !== undefined && styles.tall,
            height !== undefined && tablePlace.tall(height),
            focus.carrier
          )}
        >
          <table
            data-slot="table"
            data-density={density === "default" ? undefined : density}
            aria-label={hasCaption ? undefined : label}
            {...stylex.props(
              styles.table,
              arriving === true && styles.arriving,
              width !== undefined && styles.sized,
              width !== undefined && tablePlace.width(`${String(width)}px`)
            )}
          >
            {/* The caption names the table for a screen reader here, unseen; the words a reader
              sees stand under the box (below), so the box's ring and its sideways scroll leave
              them alone: the ring took the caption in and touched its words. */}
            {hasCaption && (
              <caption id={captionId} {...stylex.props(styles.captionNamed)}>
                {caption}
              </caption>
            )}
            <DensityContext value={density}>
              <StickyHeadContext value={height !== undefined}>
                <RangeLookContext value={rangeLook}>
                  <HeadLookContext value={headLook}>{children}</HeadLookContext>
                </RangeLookContext>
              </StickyHeadContext>
            </DensityContext>
          </table>
          {end}
        </div>
        <span
          aria-hidden="true"
          data-slot="table-ring"
          {...stylex.props(styles.ring)}
        />
      </div>
      <SeenCaption caption={hasCaption ? caption : undefined} />
    </div>
  );
};
