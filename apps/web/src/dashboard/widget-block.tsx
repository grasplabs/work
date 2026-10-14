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
import { cn } from "@grasp-os/ui/lib/utils";
import { Trans, useLingui } from "@lingui/react/macro";
import { Maximize2Icon } from "lucide-react";
import { createContext, use, useRef, useState } from "react";
import type { ReactNode } from "react";

import { LoadingLines } from "../frame/page-states.tsx";

// A block of the dashboard's widget board, as the prototype draws one
// (`components/dashboard/widget-parts.tsx`: `WidgetShell`, `WidgetCard`;
// `widget-board.tsx`: the dialog): every block as high as the next
// whatever is in it, its title with its buttons, and what doesn't fit
// fading out at its foot. A block that has more opens in full, in a
// dialog that has the title and the whole of it. On the board, the
// buttons that move a block and take it off stand beside its title too,
// and the block is taken by its title to move it (`WidgetControls`).

/** What the board puts beside a block's title, before its own button: the way to move it and take it off (widget-board.tsx). */
export interface WidgetFrame {
  actions: ReactNode;
  /** The block can be dragged to another place by its title, which shows it. */
  movable: boolean;
}

export const WidgetControls = createContext<WidgetFrame | null>(null);

/** Whether a widget is shown in full, so a part shows everything it has. */
export const WidgetFull = createContext(false);

/** Whether the widget is shown in full, so a part shows everything it has. */
export const useFull = (): boolean => use(WidgetFull);

/** A block's button, named in its tooltip. */
export const BlockButton = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          aria-label={label}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        />
      }
    >
      {children}
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

/**
 * A block's frame: its title with its buttons, then its parts. `close` is
 * for a widget put together from parts, which stand a little closer than
 * the pieces of a summary do.
 */
export const WidgetShell = ({
  title,
  actions,
  movable = false,
  close = false,
  children,
}: {
  title: string;
  actions?: ReactNode;
  movable?: boolean;
  close?: boolean;
  children?: ReactNode;
}) => (
  <section
    aria-label={title}
    className="bg-card flex h-full min-w-0 flex-col overflow-hidden rounded-xl border text-sm"
  >
    {/* A block is taken by its title to move it: the pointer says so there. */}
    <header
      className={cn(
        "flex h-11 flex-none items-center gap-1 pr-1.5 pl-4",
        movable && "cursor-grab select-none"
      )}
    >
      <h2 className="min-w-0 flex-1 truncate font-medium">{title}</h2>
      {actions}
    </header>
    <div
      className="relative min-h-0 flex-1 overflow-hidden transition-opacity duration-300"
      data-widget-body
    >
      {/* As high as the block, so a chart can take the room its parts leave; a list is as long as it is and fades out at the foot. */}
      <div
        className={cn(
          "@container flex h-full flex-col px-4 pb-4",
          close ? "gap-3" : "gap-4"
        )}
      >
        {children}
      </div>
      <span
        aria-hidden="true"
        className="from-card pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-linear-to-t to-transparent"
      />
    </div>
  </section>
);

/** One widget's block, and its full view when it has one. */
export const WidgetBlock = ({
  title,
  full,
  description,
  children,
}: {
  title: string;
  /** Everything it shows, opened from the block; none when there is nothing more to see. */
  full?: ReactNode;
  /** What the full view says under its title; a quiet line for screen readers without it. */
  description?: string;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const frame = use(WidgetControls);
  const opens = t`Open in full`;
  const fullButton =
    full === undefined ? null : (
      <BlockButton
        label={opens}
        onClick={() => {
          setOpen(true);
        }}
      >
        <Maximize2Icon />
      </BlockButton>
    );
  return (
    <>
      <WidgetShell
        actions={
          <>
            {frame?.actions}
            {fullButton}
          </>
        }
        movable={frame?.movable}
        title={title}
      >
        {children}
      </WidgetShell>
      {full === undefined ? null : (
        <Dialog onOpenChange={setOpen} open={open}>
          {/* It opens with the keys on its title, not on the first button somewhere in it: a wide picture is then not moved sideways to that button. */}
          <DialogContent
            className="max-h-svh overflow-y-auto sm:max-w-5xl"
            closeLabel={t`Close`}
            initialFocus={heading}
          >
            <DialogHeader>
              <DialogTitle ref={heading} tabIndex={-1}>
                {title}
              </DialogTitle>
              {description === undefined ? (
                <DialogDescription className="sr-only">
                  <Trans>
                    The whole widget: every line, and what its colours mean.
                  </Trans>
                </DialogDescription>
              ) : (
                <DialogDescription>{description}</DialogDescription>
              )}
            </DialogHeader>
            <WidgetFull value>
              <div className="@container flex flex-col gap-5">{full}</div>
            </WidgetFull>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};

/** A widget's block while what it shows is read. */
export const WidgetLoading = ({ title }: { title: string }) => (
  <WidgetBlock title={title}>
    <LoadingLines />
  </WidgetBlock>
);
