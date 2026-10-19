import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { Plural, Trans } from "@lingui/react/macro";
import { FileTextIcon } from "lucide-react";

import type { NextReport } from "./programme.ts";

// The weekly report as one bar across the dashboard, as the prototype's
// (`components/dashboard/report-bar.tsx`): in how many days the next
// report is ready, or that the one on the week that closed is, shaded as
// far as the week has come. Its one button exports the report as it
// stands today.

/**
 * The shade's width for each of the week's days passed, 0 to 7: whole
 * classes, so Tailwind finds them, and no inline style, which the
 * Content Security Policy refuses.
 */
const shadeWidths = [
  "w-0",
  "w-1/7",
  "w-2/7",
  "w-3/7",
  "w-4/7",
  "w-5/7",
  "w-6/7",
  "w-full",
] as const;

export const ReportBar = ({
  next,
  onExport,
}: {
  next: NextReport;
  onExport: () => void;
}) => {
  const { inDays, week } = next;
  return (
    <div className="bg-muted/50 relative flex min-w-0 items-center gap-3 overflow-hidden rounded-xl py-1.5 pr-1.5 pl-4 text-sm">
      <span
        aria-hidden="true"
        className={cn(
          "bg-foreground/10 absolute inset-y-0 left-0",
          shadeWidths[next.through] ?? "w-0"
        )}
      />
      <FileTextIcon
        aria-hidden="true"
        className="text-muted-foreground relative size-4 flex-none"
      />
      <p className="relative min-w-0 flex-1 text-pretty">
        {inDays === 0 ? (
          <Trans>Your report on week {week} is ready</Trans>
        ) : (
          <Plural
            one="Your next report is ready tomorrow"
            other="Your next report is ready in # days"
            value={inDays}
          />
        )}
      </p>
      <Button
        className="relative flex-none"
        onClick={onExport}
        size="sm"
        variant="ghost"
      >
        <Trans>Export report</Trans>
      </Button>
    </div>
  );
};
