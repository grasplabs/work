import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// The dashboard's blocks, as the prototype draws them
// (`components/dashboard/dashboard-card.tsx`, `inbox-kind.tsx`): a card
// with a header line, rows that go edge to edge under it, and a mark for
// what each row is about.

/** A block on the dashboard: a card whose rows run edge to edge, named by its heading. */
export const DashboardCard = ({
  id,
  children,
}: {
  /** The id of its heading, which names it. */
  id: string;
  children: ReactNode;
}) => (
  <section
    aria-labelledby={id}
    className="bg-card flex min-w-0 flex-col overflow-hidden rounded-xl border text-sm"
  >
    {children}
  </section>
);

/** A block's name, with how many it holds or a quiet note on the right. */
export const DashboardCardHeader = ({
  id,
  title,
  count,
  note,
}: {
  id: string;
  title: ReactNode;
  count?: number;
  note?: ReactNode;
}) => (
  <header className="flex h-12 flex-none items-center gap-2 px-4">
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
  </header>
);

/** A group of rows in a block, under its quiet title. */
export const DashboardGroup = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section aria-label={title}>
    <h3 className="bg-muted/50 text-muted-foreground border-t px-4 py-2 text-xs">
      {title}
    </h3>
    {children}
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
