import type { LinkState } from "@grasp-os/shared/admin/onboarding-admin";
import { Progress } from "@grasp-os/ui/components/progress";
/**
 * The marks the Interviews section draws its counts with, ported from the
 * prototype (grasplabs/prototype `components/admin/admin-parts.tsx` and
 * `components/settings.tsx`): a panel with a title, bars told apart by a word, and a person as a dot. Where the
 * prototype sizes a bar with an inline style, a bar here is the UI's
 * progress bar, which is also announced as the share it is.
 */
import { cn } from "@grasp-os/ui/lib/utils";

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
