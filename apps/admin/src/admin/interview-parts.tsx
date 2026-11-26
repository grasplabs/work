/**
 * The marks the Interviews section draws its counts with, ported from the
 * prototype (grasplabs/prototype `components/admin/admin-parts.tsx` and
 * `components/settings.tsx`) onto Damsko: bars told apart by a word, a
 * person as a dot, a team as dots, and someone as their initials. A bar is
 * Damsko's progress bar, which is also announced as the share it is.
 */
import type {
  LinkState,
  PersonView,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Progress } from "@grasp-os/ui/components/progress";
import { Text } from "@grasp-os/ui/components/text";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  // The words take the room they need, the bars start in one line, the numbers at the end.
  bars: {
    display: "grid",
    gridTemplateColumns:
      "minmax(0, max-content) minmax(5rem, 1fr) minmax(1.5rem, auto)",
    columnGap: space["3"],
    rowGap: space["2"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  bar: {
    gridColumn: "1 / -1",
    display: "grid",
    gridTemplateColumns: "subgrid",
    alignItems: "center",
  },
  count: { textAlign: "end", fontVariantNumeric: "tabular-nums" },
  dot: {
    width: "0.5rem",
    height: "0.5rem",
    flexShrink: 0,
    borderRadius: "50%",
    boxSizing: "border-box",
  },
  talked: { backgroundColor: colors.foreground },
  started: { backgroundColor: colors.mutedForeground, opacity: 0.6 },
  not: { backgroundColor: colors.border },
  none: { borderWidth: 1, borderStyle: "solid", borderColor: colors.border },
  dots: { display: "flex", flexWrap: "wrap", gap: space["1"] },
});

/** One row of a bar list: what it counts, how many, and the number as shown when it isn't the count. */
export interface BarRow {
  id: string;
  label: string;
  value: number;
  shown?: string;
}

/**
 * A few things counted, as rows: what each is, a bar as long as its share
 * of the most, and the number. The words take the room they need and the
 * bars start in one line.
 */
export const BarList = ({
  rows,
  label,
}: {
  rows: readonly BarRow[];
  label: string;
}) => {
  const most = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul aria-label={label} {...stylex.props(styles.bars)}>
      {rows.map((row) => (
        <li key={row.id} {...stylex.props(styles.bar)}>
          <Text as="span" color="muted" size="sm" truncate>
            {row.label}
          </Text>
          <Progress aria-label={row.label} max={most} value={row.value} />
          <span {...stylex.props(styles.count)}>
            <Text as="span" color="default" size="sm">
              {row.shown ?? String(row.value)}
            </Text>
          </span>
        </li>
      ))}
    </ul>
  );
};

/** How a person shows as a dot: talked, started, has not talked, or has no link yet. */
type DotMark = "talked" | "started" | "not" | "none";

export const markOf = (state: LinkState): DotMark => {
  if (state === "completed") {
    return "talked";
  }
  if (state === "progress" || state === "incomplete") {
    return "started";
  }
  return state === "waiting" ? "none" : "not";
};

/** A person as a dot; the words beside it say where they stand. */
export const Dot = ({ mark }: { mark: DotMark }) => (
  <span aria-hidden {...stylex.props(styles.dot, styles[mark])} />
);

const dotOrder: readonly DotMark[] = ["talked", "started", "not", "none"];

/** A team as dots, one a person: who talked, who started, who has not, who has no link yet. */
export const PeopleDots = ({
  people,
  label,
}: {
  people: readonly PersonView[];
  label: string;
}) => (
  <span {...stylex.props(styles.dots)}>
    <span {...stylex.props(visuallyHidden)}>{label}</span>
    {people
      .toSorted(
        (a, b) =>
          dotOrder.indexOf(markOf(a.state)) - dotOrder.indexOf(markOf(b.state))
      )
      .map((each) => (
        <Dot key={each.person.id} mark={markOf(each.state)} />
      ))}
  </span>
);

/** Someone as the first letters of their name, in a circle, beside their name. */
export const Initials = ({ name }: { name: string }) => (
  <Avatar decorative name={name} size="xs">
    <AvatarFallback />
  </Avatar>
);
