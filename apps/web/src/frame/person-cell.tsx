import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

// A person in a table's cell: their face, their name and a muted second
// line (their email), the table's words. The old library's DataTablePerson;
// Damsko's DataTable has none (the rename map's "DataTablePerson →
// apps/web/src/frame/person-cell.tsx"); while the table loads, its
// column's `meta.skeleton: "person"` draws the same shape waiting.

const styles = stylex.create({
  person: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
  },
  // A name alone stands in a box one line of the table's text tall, as a
  // control in a cell does: the picture, taller than the line, reaches
  // into the cell's padding and the row keeps its height.
  oneLine: { height: size.tableTextLine },
  words: { display: "grid", minWidth: 0 },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.foreground,
  },
  detail: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
  },
});

/** A person in a table's cell: picture, name and a muted second line. */
export const PersonCell = ({
  name,
  detail,
}: {
  /** Their name, as the row's first words; the avatar's initials come from it. */
  name: string;
  /** A muted second line under the name, such as their email. */
  detail?: string;
}) => {
  const alone = detail === undefined || detail === "";
  return (
    <span {...stylex.props(styles.person, alone && styles.oneLine)}>
      {/* The name stands beside it in words, so the picture is decorative. */}
      <Avatar decorative name={name} size="sm">
        <AvatarFallback />
      </Avatar>
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.name)}>{name}</span>
        {alone ? null : <span {...stylex.props(styles.detail)}>{detail}</span>}
      </span>
    </span>
  );
};
