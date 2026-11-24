import { Text } from "@grasp-os/ui/components/text";
import { Icon } from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  colors,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

// A part of a project with nothing in it yet: one sentence on a dashed
// line, and the one thing to do about it at its end for whoever may.
// Composed in work: Damsko has no line this light yet (DAMS-4's `Empty
// line` gap candidate).

const styles = stylex.create({
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space["3"],
    rowGap: space["2"],
    minHeight: size.avatarDefault,
    paddingBlock: space["3"],
    paddingInline: { default: space["4"], [media.maxSm]: space["3"] },
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    borderRadius: radius.base,
    cornerShape: radius.shape,
    color: colors.mutedForeground,
  },
  words: { flexGrow: 1, flexBasis: "12rem", minWidth: 0 },
});

/** One quiet sentence for a part that has nothing in it, and its one action. */
export const EmptyLine = ({
  icon,
  children,
  action,
}: {
  icon: IconData;
  children: ReactNode;
  action?: ReactNode;
}) => (
  <div {...stylex.props(styles.line)}>
    <Icon icon={icon} />
    <span {...stylex.props(styles.words)}>
      <Text as="span" size="sm" color="muted">
        {children}
      </Text>
    </span>
    {action}
  </div>
);
