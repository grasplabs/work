import { cn } from "@grasp-os/ui/lib/utils";
import * as stylex from "@stylexjs/stylex";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ItemGroup } from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

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

// The dashboard's blocks, as the prototype draws them
// (`components/dashboard/dashboard-card.tsx`, `inbox-kind.tsx`): a card
// with a header line, rows that go edge to edge under it, and a mark for
// what each row is about.

/** A block on the dashboard: a card whose rows run edge to edge, named by its heading. */
export const DashboardCard = ({
  id,
  className,
  children,
}: {
  /** The id of its heading, which names it. */
  id: string;
  /** More of its look, such as a widget's fixed height. */
  className?: string;
  children: ReactNode;
}) => (
  <section
    aria-labelledby={id}
    className={cn(
      "bg-card flex min-w-0 flex-col overflow-hidden rounded-xl border text-sm",
      className
    )}
  >
    {children}
  </section>
);

/** A block's name, with how many it holds or a quiet note on the right, and its buttons after them. */
export const DashboardCardHeader = ({
  id,
  title,
  count,
  note,
  actions,
}: {
  id: string;
  title: ReactNode;
  count?: number;
  note?: ReactNode;
  actions?: ReactNode;
}) => (
  <header
    className={cn(
      "flex h-12 flex-none items-center gap-2",
      actions === undefined ? "px-4" : "pr-2 pl-4"
    )}
  >
    <h2 className="min-w-0 flex-1 truncate font-medium" id={id}>
      {title}
    </h2>
    {count === undefined ? null : (
      <span className="bg-muted rounded-full px-2 text-xs tabular-nums">
        {count}
      </span>
    )}
    {note === undefined ? null : (
      <span className="text-muted-foreground text-xs">{note}</span>
    )}
    {actions}
  </header>
);

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

/** What a row is about, as a square with its kind's icon. */
export const ItemMark = ({ icon: Icon }: { icon: LucideIcon }) => (
  <span
    aria-hidden="true"
    className="bg-card text-muted-foreground flex size-8 flex-none items-center justify-center rounded-md border"
  >
    <Icon className="size-4" />
  </span>
);
