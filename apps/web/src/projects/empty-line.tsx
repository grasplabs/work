import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { Icon } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";

// A part of a project with nothing in it yet: one sentence on a dashed
// line, and the one thing to do about it at its end for whoever may.
// Composed in work: Damsko has no line this light yet (DAMS-4's `Empty
// line` gap candidate).

const styles = stylex.create({
  line: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    minHeight: grasp.avatarMd,
    paddingBlock: grasp.space3,
    paddingInline: { default: grasp.space4, [media.belowPhone]: grasp.space3 },
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: grasp.line,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    color: grasp.muted,
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
      <Text element="span" size="sm" tone="muted">
        {children}
      </Text>
    </span>
    {action}
  </div>
);
