import { Progress } from "@grasp-os/ui/components/progress";
import type { ReactNode } from "react";

/** A share from nothing to all of it. */
const shareOf = (value: number, of: number): number =>
  of > 0 ? Math.min(Math.max(value / of, 0), 1) : 0;

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
