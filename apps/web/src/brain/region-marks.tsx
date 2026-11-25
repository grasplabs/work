import { Text } from "@grasp-os/ui/components/text";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { Plural } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { AtlasRegion } from "./brain-atlas.ts";

// The marks of the brain's dots, as in the prototype (grasplabs/prototype,
// packages/grasp: components/knowledge/region-marks.tsx).

const styles = stylex.create({
  mark: {
    display: "block",
    flexShrink: 0,
    boxSizing: "border-box",
    width: space["2"],
    height: space["2"],
    borderRadius: radius.circle,
  },
  known: { backgroundColor: colors.foreground },
  waiting: {
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: colors.mutedForeground,
  },
  open: { backgroundColor: colors.warning },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: size.sidePanelDot,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  line: { display: "flex", alignItems: "center", gap: space["2"] },
});

/** The mark a dot of the brain has, drawn the same in the legend and in every list: filled where something is known, hollow where it is still waiting, the attention colour where a question is open. */
export const Mark = ({ state }: { state: "known" | "waiting" | "open" }) => (
  <span {...stylex.props(styles.mark, styles[state])} />
);

/**
 * The list's own look, with what the caller places it by: the atlas
 * (atlas-canvas.tsx) still hands its popover's place as the old kit's
 * classes, which go on the same element.
 */
const withPlacement = (
  own: ReturnType<typeof stylex.props>,
  className: string | undefined
): ReturnType<typeof stylex.props> =>
  className === undefined
    ? own
    : { ...own, className: [own.className, className].join(" ") };

/** What a region holds, one line per mark: what is known, what is still waiting, and how many questions are open. Only the lines there is something to say on. */
export const RegionMarks = ({
  region,
  className,
}: {
  region: AtlasRegion;
  className?: string;
}) => {
  const open = region.open.length;
  return (
    <ul {...withPlacement(stylex.props(styles.list), className)}>
      <li {...stylex.props(styles.line)}>
        <Mark state="known" />
        <Text as="span" size="xs" color="default">
          {region.facts.join(" · ")}
        </Text>
      </li>
      {region.waitingLabel === undefined ? null : (
        <li {...stylex.props(styles.line)}>
          <Mark state="waiting" />
          <Text as="span" size="xs" color="muted">
            {region.waitingLabel}
          </Text>
        </li>
      )}
      {open > 0 ? (
        <li {...stylex.props(styles.line)}>
          <Mark state="open" />
          <Text as="span" size="xs" color="muted">
            <Plural
              one="# open question"
              other="# open questions"
              value={open}
            />
          </Text>
        </li>
      ) : null}
    </ul>
  );
};
