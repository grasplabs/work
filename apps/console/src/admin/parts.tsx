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
  const mark = (
    <span
      aria-hidden
      className="bg-foreground mx-0.5 block h-3.5 w-px flex-none"
    />
  );
  return (
    <span className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, at) => (
        <Fragment key={at}>
          {at === gate ? mark : null}
          <span
            aria-hidden
            className={cn(
              "size-1.5 flex-none rounded-full",
              at < filled ? "bg-foreground" : "bg-border"
            )}
          />
        </Fragment>
      ))}
      {/* Where Grasp opens only once every dot is filled, the mark stands after the last. */}
      {gate >= count ? mark : null}
    </span>
  );
};
