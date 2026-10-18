/**
 * Small marks the admin's pages draw what the model counts with, ported
 * from the prototype (grasplabs/prototype `components/admin/admin-parts.tsx`).
 */
import { STAGES } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgKnowledge,
  Stage,
  StageStatus,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import { Fragment } from "react";
import type { ReactNode } from "react";

/** One number and what it counts. */
export const Tile = ({ value, label }: { value: ReactNode; label: string }) => (
  <div className="bg-card flex flex-col gap-0.5 px-5 py-4">
    <span className="text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
    <span className="text-muted-foreground">{label}</span>
  </div>
);

const segment: Record<StageStatus, string> = {
  done: "bg-foreground",
  now: "bg-foreground/45",
  waits: "bg-status-attention",
  later: "bg-border",
};

/** The steps of an onboarding as a short bar: done, in hand, waiting on someone, not yet. */
export const StageBar = ({
  stages,
  label,
}: {
  stages: Record<Stage, StageStatus>;
  label: string;
}) => (
  <span className="flex w-28 gap-0.5">
    <span className="sr-only">{label}</span>
    {STAGES.map((stage) => (
      <span
        aria-hidden
        className={cn("h-1 flex-1 rounded-full", segment[stages[stage]])}
        key={stage}
      />
    ))}
  </span>
);

/** Where the rounding of a share of the dots may land just under a whole one. */
const dotSlack = 1e-9;

/**
 * How much Grasp knows about an organization, in dots: dark for what is
 * in, filling from the left, with a mark at the share where Grasp opens.
 * Dark up to the mark is ready.
 */
export const KnowledgeDots = ({
  knowledge,
  count,
  label,
}: {
  knowledge: Pick<OrgKnowledge, "percent" | "threshold">;
  count: number;
  label: string;
}) => {
  const filled = Math.floor((knowledge.percent / 100) * count + dotSlack);
  const gate = Math.round((knowledge.threshold / 100) * count);
  return (
    <span className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, at) => (
        <Fragment key={at}>
          {at === gate ? (
            <span
              aria-hidden
              className="bg-foreground mx-0.5 block h-3.5 w-px flex-none"
            />
          ) : null}
          <span
            aria-hidden
            className={cn(
              "size-1.5 flex-none rounded-full",
              at < filled ? "bg-foreground" : "bg-border"
            )}
          />
        </Fragment>
      ))}
    </span>
  );
};

/**
 * So much of a whole as a small ring, dark on grey: for a number that is
 * a share of something. The circle is 100 around, so the dark part is the
 * percentage itself.
 */
export const Ring = ({
  value,
  of,
  label,
}: {
  value: number;
  of: number;
  label: string;
}) => {
  const share = of > 0 ? Math.min(Math.max(value / of, 0), 1) : 0;
  return (
    <span className="flex-none">
      <span className="sr-only">{label}</span>
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
 * number is a share of something. The ring stands beside the label, so
 * the number has the whole tile, however narrow. Tiles in one row start
 * at the same height, so their labels and numbers line up.
 */
export const Figure = ({
  label,
  value,
  sub,
  ring,
  attention = false,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  ring?: { value: number; of: number };
  attention?: boolean;
  /** Where it stands in its grid. */
  className?: string;
}) => (
  <div
    className={cn(
      "bg-card grid grid-cols-[minmax(0,1fr)_auto] content-start gap-x-2 gap-y-0.5 px-4 py-4 sm:px-5",
      className
    )}
  >
    <span className="text-muted-foreground flex min-h-5 items-center text-xs">
      {label}
    </span>
    {ring && ring.of > 0 ? (
      <Ring
        label={`${Math.round(Math.min(Math.max(ring.value / ring.of, 0), 1) * 100)}%`}
        of={ring.of}
        value={ring.value}
      />
    ) : null}
    <span className="col-span-2 row-start-2 text-2xl leading-tight font-medium text-balance wrap-break-word hyphens-auto tabular-nums">
      {value}
    </span>
    {sub === undefined ? null : (
      <span
        className={cn(
          "col-span-2 row-start-3 text-xs",
          attention ? "text-status-attention" : "text-muted-foreground"
        )}
      >
        {sub}
      </span>
    )}
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
