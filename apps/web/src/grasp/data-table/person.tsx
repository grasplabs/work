// A person in a Data table's cell: their picture (or initials), their name, and a muted second line
// such as an email, as a members table has them. Give it from a column's `cell`:
//
//   { key: "name", header: "Name", value: (m) => m.name, cell: (m) => <DataTablePerson name={m.name} detail={m.email} /> }
//
// Also here: dataTableCompactControl, the layout that makes a field control 28px in a compact row.
import * as stylex from "@stylexjs/stylex";

import { Avatar, AvatarFallback, AvatarImage } from "../avatar";
import { Skeleton } from "../skeleton";
import { grasp } from "../tokens/tokens.stylex";

/** Every prop a DataTablePerson takes. */
export interface DataTablePersonProps {
  /** Their name, as the row's first words; the avatar's initials come from it. */
  name: string;
  /** A muted second line under the name, such as their email. */
  detail?: string;
  /** Their picture; without it, the initials. */
  src?: string;
  /**
   * The avatar's size: `sm` beside two lines (a name and its email), `xs` for a dense row or a name
   * alone. The words keep the table's text size.
   * @default "sm"
   */
  size?: "xs" | "sm";
}

const styles = stylex.create({
  person: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  // A name alone stands in a box one line of the table's text tall, as a control in a cell does:
  // the picture, taller than the line, reaches into the cell's padding and the row keeps its height.
  oneLine: { height: grasp.tableTextLine },
  words: { display: "grid", minWidth: 0 },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.ink,
  },
  detail: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: grasp.muted,
  },
});

/** A person in a table's cell: picture, name and a muted second line. */
export const DataTablePerson = ({
  name,
  detail,
  src,
  size = "sm",
}: DataTablePersonProps) => (
  <span
    data-slot="data-table-person"
    {...stylex.props(
      styles.person,
      (detail === undefined || detail === "") && styles.oneLine
    )}
  >
    {/* The name stands beside it in words, so the picture is decorative. */}
    <Avatar name={name} size={size} decorative>
      {src !== undefined && src !== "" && <AvatarImage src={src} />}
      <AvatarFallback />
    </Avatar>
    <span {...stylex.props(styles.words)}>
      <span {...stylex.props(styles.name)}>{name}</span>
      {detail !== undefined && detail !== "" && (
        <span {...stylex.props(styles.detail)}>{detail}</span>
      )}
    </span>
  </span>
);

const waiting = stylex.create({
  // The picture's place: an sm avatar's circle.
  picture: { width: grasp.avatarSm, height: grasp.avatarSm },
  // Each line a line of the table's text tall, as the name and the detail stand.
  line: { display: "flex", alignItems: "center", height: grasp.tableTextLine },
  name: { width: "8rem" },
  detail: { width: "11rem", maxWidth: "100%" },
});

/**
 * A person's cell while the table is loading (a column's `placeholder: "person"`): the picture's
 * circle and two quiet lines in the name's and the detail's boxes, so the row keeps its height.
 */
export const DataTablePersonWaiting = () => (
  <span aria-hidden="true" {...stylex.props(styles.person)}>
    <Skeleton variant="circle" layout={waiting.picture} />
    <span {...stylex.props(styles.words)}>
      <span {...stylex.props(waiting.line)}>
        <Skeleton layout={waiting.name} />
      </span>
      <span {...stylex.props(waiting.line)}>
        <Skeleton layout={waiting.detail} />
      </span>
    </span>
  </span>
);

const control = stylex.create({
  // A field control (a Select's field look) in a compact row: control-xs (28px), so its box clears
  // the row's hairlines. The text look needs nothing.
  compact: { height: grasp.controlXs, minHeight: grasp.controlXs },
});

/** Layout for a field control in a compact Data table row: give it as the control's `layout`. */
export const dataTableCompactControl = control.compact;
