import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import { Maximize2Icon } from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { LoadingLines } from "../frame/page-states.tsx";
import { DashboardCard, DashboardCardHeader } from "./dashboard-card.tsx";

// A block of the dashboard's widget board, as the prototype draws one
// (`components/dashboard/widget-board.tsx`, `widget-parts.tsx`): every
// block as high as the next whatever is in it, its title with a button
// that opens it in full, and what doesn't fit fading out at its foot. In
// full, a dialog has the title and the whole of it.

/** One widget's block, and its full view when it has one. */
export const WidgetBlock = ({
  title,
  count,
  full,
  description,
  children,
}: {
  title: string;
  /** How many it holds, beside its title. */
  count?: number;
  /** Everything it shows, opened from the block; none when there is nothing more to see. */
  full?: ReactNode;
  /** What the full view says under its title; a quiet line for screen readers without it. */
  description?: string;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const id = useId();
  const [open, setOpen] = useState(false);
  const opens = t`Open ${title} in full`;
  return (
    <DashboardCard className="h-80" id={id}>
      <DashboardCardHeader
        actions={
          full === undefined ? undefined : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={opens}
                    onClick={() => {
                      setOpen(true);
                    }}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <Maximize2Icon />
              </TooltipTrigger>
              <TooltipContent>{opens}</TooltipContent>
            </Tooltip>
          )
        }
        count={count}
        id={id}
        title={title}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="@container flex h-full flex-col gap-4 px-4 pb-4">
          {children}
        </div>
        <span
          aria-hidden="true"
          className="from-card pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-linear-to-t to-transparent"
        />
      </div>
      {full === undefined ? null : (
        <Dialog onOpenChange={setOpen} open={open}>
          <DialogContent
            className="max-h-svh overflow-y-auto sm:max-w-5xl"
            closeLabel={t`Close`}
          >
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              {description === undefined ? (
                <DialogDescription className="sr-only">
                  <Trans>Everything this widget shows, in full.</Trans>
                </DialogDescription>
              ) : (
                <DialogDescription>{description}</DialogDescription>
              )}
            </DialogHeader>
            <div className="@container">{full}</div>
          </DialogContent>
        </Dialog>
      )}
    </DashboardCard>
  );
};

/** A widget's block while what it shows is read. */
export const WidgetLoading = ({ title }: { title: string }) => (
  <WidgetBlock title={title}>
    <LoadingLines />
  </WidgetBlock>
);
