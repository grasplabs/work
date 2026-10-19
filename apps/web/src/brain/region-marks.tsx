import { cn } from "@grasp-os/ui/lib/utils";
import { Plural } from "@lingui/react/macro";

import type { AtlasRegion } from "./brain-atlas.ts";

// The marks of the brain's dots, as in the prototype (grasplabs/prototype,
// packages/grasp: components/knowledge/region-marks.tsx).

/** The mark a dot of the brain has, drawn the same in the legend and in every list: filled where something is known, hollow where it is still waiting, the attention colour where a question is open. */
export const Mark = ({ state }: { state: "known" | "waiting" | "open" }) => (
  <span
    className={cn(
      "size-2 flex-none rounded-full",
      state === "known" && "bg-foreground",
      state === "waiting" && "border-muted-foreground border",
      state === "open" && "bg-status-attention"
    )}
  />
);

/** What a region holds, one line per mark: what is known, what is still waiting, and how many questions are open. Only the lines there is something to say on. */
export const RegionMarks = ({
  region,
  className,
}: {
  region: AtlasRegion;
  className?: string;
}) => {
  const open = region.open.length;
  return (
    <ul className={cn("flex flex-col gap-0.5 text-xs", className)}>
      <li className="flex items-center gap-1.5">
        <Mark state="known" />
        {region.facts.join(" · ")}
      </li>
      {region.waitingLabel === undefined ? null : (
        <li className="text-muted-foreground flex items-center gap-1.5">
          <Mark state="waiting" />
          {region.waitingLabel}
        </li>
      )}
      {open > 0 ? (
        <li className="text-muted-foreground flex items-center gap-1.5">
          <Mark state="open" />
          <Plural one="# open question" other="# open questions" value={open} />
        </li>
      ) : null}
    </ul>
  );
};
