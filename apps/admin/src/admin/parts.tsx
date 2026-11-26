import { Progress } from "@grasp-os/app-kit/components/progress";
/**
 * Small marks the admin's pages draw what the model counts with, ported
 * from the prototype (grasplabs/prototype `components/admin/admin-parts.tsx`).
 */
import { Stat } from "@grasp-os/app-kit/components/stat";
import { cn } from "@grasp-os/app-kit/lib/utils";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The mark of what needs someone: a small amber dot before the words,
 * which stay in the text's own colour. Amber marks a thing; a sentence
 * set in it is hard to read.
 */
export const AttentionDot = () => (
  <span
    aria-hidden
    className="bg-status-attention size-1.5 flex-none -translate-y-px rounded-full"
  />
);

/** What needs someone, in words: the amber dot, then the words in the text's colour. */
export const Attention = ({
  children,
  className,
}: {
  children: ReactNode;
  /** Where it stands in its layout. */
  className?: string;
}) => (
  <span className={cn("flex items-baseline gap-1.5", className)}>
    <AttentionDot />
    <span className="min-w-0">{children}</span>
  </span>
);

/** Something that is in place: a check and a word, in the colour of agreed. */
export const Done = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground flex items-center gap-1.5">
    <CheckIcon aria-hidden className="text-status-agreed size-4 flex-none" />
    {children}
  </span>
);

/**
 * One number: what it counts over it, and a line under it. The one tile
 * every page shows a figure in. Its three lines stand on the rows of the
 * grid it is in (a subgrid), so across a row of tiles the labels, the
 * numbers and the lines under them line up, however a label wraps.
 */
export const Figure = ({
  label,
  value,
  sub,
  attention = false,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  attention?: boolean;
  /** Where it stands in its grid. */
  className?: string;
}) => (
  <div
    className={cn(
      "bg-card row-span-3 grid grid-rows-subgrid gap-y-1 px-4 py-4 sm:px-5",
      className
    )}
  >
    <span className="text-muted-foreground self-end text-xs">{label}</span>
    <span className="wrap-break-word hyphens-auto">
      <Stat>{value}</Stat>
    </span>
    <span
      className={cn(
        "text-xs",
        attention ? "text-foreground" : "text-muted-foreground"
      )}
    >
      {attention && sub !== undefined ? (
        <span className="flex items-baseline gap-1.5">
          <AttentionDot />
          <span>{sub}</span>
        </span>
      ) : (
        sub
      )}
    </span>
  </div>
);

/**
 * A few things counted, as rows: what each is, a bar as long as its share
 * of the most, and the number. The words take the room they need and the
 * bars start in one line; where the room is short the words are cut,
 * never the bars.
 */
export const BarList = ({
  rows,
  label,
}: {
  rows: { id: string; label: ReactNode; value: number; shown?: string }[];
  label: string;
}) => {
  const most = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul
      aria-label={label}
      className="grid grid-cols-[minmax(0,max-content)_minmax(5rem,1fr)_minmax(1.5rem,auto)] gap-x-3 gap-y-2.5"
    >
      {rows.map((row) => (
        <li
          className="col-span-3 grid grid-cols-subgrid items-center"
          key={row.id}
        >
          <span className="text-muted-foreground truncate">{row.label}</span>
          <Progress aria-hidden value={(row.value / most) * 100} />
          <span className="text-right tabular-nums">
            {row.shown ?? row.value}
          </span>
        </li>
      ))}
    </ul>
  );
};
