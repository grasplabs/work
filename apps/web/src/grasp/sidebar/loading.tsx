// The Sidebar's list while its rows are not there yet (`loading`): the first paint of a reload, before
// the data. Drawn in the list's own place and boxes (the nav's body, its groups and lists, a group's
// label and the sidebar's row, handed in by sidebar.tsx), so when the rows arrive nothing moves: each
// placeholder row is a real row's height, its icon a row icon's box, its words a line as tall as the
// row's text. The shapes are the same on every paint: a fixed run of groups and widths, never random,
// so a server's first paint and the page's own agree. The lines wait as Skeleton's field does, on the
// document's one clock, so every row moves as one wave and none races another; under reduced motion
// they are still. A screen reader hears the list as busy, and "Loading" once.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { visuallyHidden } from "../hidden/hidden";
import { Skeleton } from "../skeleton";
import { grasp } from "../tokens/tokens.stylex";
import { navStyles } from "./nav";

const styles = stylex.create({
  // A placeholder row keeps the row's box but none of its answers: no hover, no pointer.
  row: { cursor: "default", backgroundColor: "transparent" },
  icon: { flexShrink: 0, width: grasp.shellIcon, height: grasp.shellIcon },
  // The words' widths, as shares of the row's room: a fixed run, the same on every paint.
  w44: { width: "44%" },
  w50: { width: "50%" },
  w56: { width: "56%" },
  w62: { width: "62%" },
  w68: { width: "68%" },
  w74: { width: "74%" },
  // A group's label: shorter than its rows.
  label: { width: "36%" },
});

const WIDTHS = [
  styles.w62,
  styles.w50,
  styles.w74,
  styles.w56,
  styles.w68,
  styles.w44,
  styles.w56,
  styles.w62,
  styles.w50,
  styles.w68,
];

/** The run of groups drawn: a first group with no label, then two labelled ones; `from` is where its rows start in WIDTHS. */
const GROUPS = [
  { label: false, rows: 3, from: 0 },
  { label: true, rows: 4, from: 3 },
  { label: true, rows: 3, from: 7 },
] as const;

interface LoadingNavProps {
  /** The sidebar's own row box (sidebar.tsx), so a placeholder row is a real row's size. */
  row: StyleXStyles;
  /** The navigation's name, as the real list's. */
  label: string;
  /** Said once while it loads ("Loading"). */
  said: string;
}

/** The list's placeholder: rows as quiet bars in the rows' own boxes. */
export const LoadingNav = ({ row, label, said }: LoadingNavProps) => (
  <nav
    aria-label={label}
    aria-busy="true"
    data-slot="sidebar-loading"
    {...stylex.props(navStyles.body)}
  >
    <output {...stylex.props(visuallyHidden)}>{said}</output>
    {GROUPS.map((group, index) => (
      <div key={index} aria-hidden="true" {...stylex.props(navStyles.group)}>
        {group.label ? (
          <div {...stylex.props(navStyles.groupLabel)}>
            <Skeleton text="sm" layout={styles.label} />
          </div>
        ) : null}
        <ul {...stylex.props(navStyles.list)}>
          {Array.from({ length: group.rows }, (_, at) => (
            <li key={at}>
              <div
                data-slot="sidebar-loading-row"
                {...stylex.props(row, styles.row)}
              >
                <Skeleton variant="block" layout={styles.icon} />
                <Skeleton
                  text="sm"
                  layout={
                    WIDTHS[(group.from + at) % WIDTHS.length] ?? styles.w56
                  }
                />
              </div>
            </li>
          ))}
        </ul>
      </div>
    ))}
  </nav>
);
