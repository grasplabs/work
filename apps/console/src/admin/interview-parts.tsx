/**
 * The marks the Interviews section draws its counts with, ported from the
 * prototype (grasplabs/prototype `components/admin/admin-parts.tsx` and
 * `components/settings.tsx`): a panel with a title, a figure with a ring
 * for a share, bars told apart by a word, and people as dots. Where the
 * prototype sizes a bar with an inline style, a bar here is the UI's
 * progress bar, which is also announced as the share it is.
 */
import type {
  LinkState,
  PersonView,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import type { ReactNode } from "react";

/** A block of the section: its title, a line under it, something beside it, and what it holds. */
export const Panel = ({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) => (
  <section className="bg-card overflow-hidden rounded-xl border">
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-0.5">
        <h2 className="font-medium">{title}</h2>
        {description === undefined ? null : (
          <p className="text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
    {children}
  </section>
);

/** A line where a panel has nothing to show yet. */
export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="bg-card text-muted-foreground rounded-xl border px-5 py-4">
    {children}
  </p>
);

/** Where a share is kept between nothing and all of it. */
const shareOf = (value: number, of: number): number =>
  of > 0 ? Math.min(Math.max(value / of, 0), 1) : 0;

/** How far round the ring's circle is: 100, so its dark part is the percentage itself. */
const ringRadius = 15.9155;

/** So much of a whole as a small ring, dark on grey: for a number that is a share of something. */
const Ring = ({ value, of }: { value: number; of: number }) => {
  const share = shareOf(value, of);
  return (
    <span className="flex-none">
      <span className="sr-only">{`${Math.round(share * 100)}%`}</span>
      <svg aria-hidden className="size-5 -rotate-90" viewBox="0 0 36 36">
        <circle
          className="stroke-border"
          cx="18"
          cy="18"
          fill="none"
          r={ringRadius}
          strokeWidth="4"
        />
        {share > 0 ? (
          <circle
            className="stroke-foreground"
            cx="18"
            cy="18"
            fill="none"
            r={ringRadius}
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
 * number is a share of something. The ring stands beside the label, so
 * the number has the whole tile.
 */
export const Figure = ({
  label,
  value,
  sub,
  ring,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
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
          <Progress aria-label={row.label} max={most} value={row.value} />
          <span className="text-right tabular-nums">
            {row.shown ?? row.value}
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

const dotInk: Record<DotMark, string> = {
  talked: "bg-foreground",
  started: "bg-muted-foreground/60",
  not: "bg-border",
  none: "border-border border",
};

export const Dot = ({ mark }: { mark: DotMark }) => (
  <span
    aria-hidden
    className={cn("size-2 flex-none rounded-full", dotInk[mark])}
  />
);

const dotOrder: DotMark[] = ["talked", "started", "not", "none"];

/** A team as dots, one a person: who talked, who started, who has not, who has no link yet. */
export const PeopleDots = ({
  people,
  label,
}: {
  people: readonly PersonView[];
  label: string;
}) => (
  <span className="flex flex-wrap gap-1">
    <span className="sr-only">{label}</span>
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
