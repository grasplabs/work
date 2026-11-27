/**
 * The marks the Interviews section draws its counts with, ported from the
 * prototype (grasplabs/prototype `components/admin/admin-parts.tsx` and
 * `components/settings.tsx`), drawn with Damsko: a person as a dot, a
 * team as dots, and someone as their initials.
 */
import type {
  LinkState,
  PersonView,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  dot: {
    width: "0.5rem",
    height: "0.5rem",
    flexShrink: 0,
    borderRadius: radius.circle,
    boxSizing: "border-box",
  },
  talked: { backgroundColor: colors.foreground },
  started: { backgroundColor: colors.mutedForeground, opacity: 0.6 },
  not: { backgroundColor: colors.border },
  none: {
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
  },
  dots: { display: "flex", flexWrap: "wrap", gap: space["1"] },
});

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
