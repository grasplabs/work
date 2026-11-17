// A person in a Data table's cell: their picture (or initials), their name, and a muted second line
// such as an email, as a members table has them. Give it from a column's `cell`:
//
//   { key: "name", header: "Name", value: (m) => m.name, cell: (m) => <DataTablePerson name={m.name} detail={m.email} /> }
//
// Also here: dataTableCompactControl, the layout that makes a field control 28px in a compact row.
import * as stylex from "@stylexjs/stylex";

import { Avatar, AvatarFallback, AvatarImage } from "../avatar";
import { grasp } from "../tokens/tokens.stylex";

/** Every prop a DataTablePerson takes. */
export interface DataTablePersonProps {
  /** Their name, as the row's first words; the avatar's initials come from it. */
  name: string;
  /** A muted second line under the name, such as their email. */
  detail?: string;
  /** Their picture; without it, the initials. */
  src?: string;
}

const styles = stylex.create({
  person: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
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
}: DataTablePersonProps) => (
  <span data-slot="data-table-person" {...stylex.props(styles.person)}>
    {/* The name stands beside it in words, so the picture is decorative. */}
    <Avatar name={name} size="sm" decorative>
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

const control = stylex.create({
  // A field control (a Select's field look) in a compact row: control-xs (28px), so its box clears
  // the row's hairlines. The text look needs nothing.
  compact: { height: grasp.controlXs, minHeight: grasp.controlXs },
});

/** Layout for a field control in a compact Data table row: give it as the control's `layout`. */
export const dataTableCompactControl = control.compact;
