import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import { i18n } from "@lingui/core";
import type { ReactNode } from "react";

import { formatPercent } from "../format.ts";

// Small marks the onboarding area draws numbers with, as in the
// prototype's admin (`components/admin/admin-parts.tsx`): a figure with
// what it counts, a ring for a share, and a few things counted as bars.

/** An average, to one place, as the page's language writes it: "4.5", "4,5". */
export const formatDecimal = (value: number): string =>
  new Intl.NumberFormat(i18n.locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);

/** A large count in short, as the page's language writes it: "1.2M", "1,2 Mio.". */
export const formatCompact = (value: number): string =>
  new Intl.NumberFormat(i18n.locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);

/** A share from nothing to all of it. */
const shareOf = (value: number, of: number): number =>
  of > 0 ? Math.min(Math.max(value / of, 0), 1) : 0;

/**
 * So much of a whole as a small ring, dark on grey. The circle is 100
 * around, so the dark part is the percentage itself.
 */
const Ring = ({ value, of }: { value: number; of: number }) => {
  const share = shareOf(value, of);
  return (
    <span className="flex-none">
      <span className="sr-only">{formatPercent(share)}</span>
      <svg aria-hidden className="size-5 -rotate-90" viewBox="0 0 36 36">
        <circle
          className="stroke-border"
          cx="18"
          cy="18"
          fill="none"
          r="15.9155"
          strokeWidth="4"
        />
        {share > 0 ? (
          <circle
            className="stroke-foreground"
            cx="18"
            cy="18"
            fill="none"
            r="15.9155"
            strokeDasharray={`${share * 100} 100`}
            strokeLinecap="round"
            strokeWidth="4"
          />
        ) : null}
      </svg>
    </span>
  );
};

/**
 * One number with what it counts, a line under it, and a ring where the
 * number is a share of something. Figures in one row start at the same
 * height, so their labels and numbers line up.
 */
export const Figure = ({
  label,
  value,
  sub,
  ring,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  ring?: { value: number; of: number };
}) => (
  <div className="bg-card grid grid-cols-[minmax(0,1fr)_auto] content-start gap-x-2 gap-y-0.5 px-4 py-4 sm:px-5">
    <span className="text-muted-foreground flex min-h-5 items-center text-xs">
      {label}
    </span>
    {ring !== undefined && ring.of > 0 ? (
      <Ring of={ring.of} value={ring.value} />
    ) : null}
    <span className="col-span-2 row-start-2 text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
    {sub === undefined ? null : (
      <span className="text-muted-foreground col-span-2 row-start-3 text-xs">
        {sub}
      </span>
    )}
  </div>
);

/**
 * A few things counted, as rows: what each is, a bar as long as its share
 * of the most, and the number. The words take the room they need and the
 * bars start in one line.
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
          <Progress aria-hidden value={shareOf(row.value, most) * 100} />
          <span className="text-right tabular-nums">
            {row.shown ?? row.value}
          </span>
        </li>
      ))}
    </ul>
  );
};

/** Figures side by side, a hairline between them. */
export const Figures = ({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) => (
  <section
    aria-label={label}
    className="bg-card overflow-hidden rounded-xl border text-sm"
  >
    <div className={cn("bg-border grid grid-cols-2 gap-px", className)}>
      {children}
    </div>
  </section>
);
