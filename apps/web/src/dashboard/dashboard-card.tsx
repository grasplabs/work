import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { ItemGroup } from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// The dashboard's groups of rows, as the prototype draws them
// (`components/dashboard/dashboard-card.tsx`): rows under a quiet title.

const styles = stylex.create({
  group: {
    paddingInline: grasp.space3,
    paddingBlockEnd: grasp.space3,
  },
  groupTitle: {
    paddingInline: grasp.space2,
    paddingBlock: grasp.space2,
  },
});

/** A group of rows in a block, under its quiet title (Grasp UI's ItemGroup). */
export const DashboardGroup = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section aria-label={title} {...stylex.props(styles.group)}>
    <div {...stylex.props(styles.groupTitle)}>
      <Text element="span" size="xs" tone="muted">
        {title}
      </Text>
    </div>
    <ItemGroup aria-label={title} separated>
      {children}
    </ItemGroup>
  </section>
);
