// The kit's dialog for a widget opened in full: it shows a chart or a table
// up to 1024px wide, where Grasp UI's Dialog is one fixed width (30rem) and
// its widest Sheet 37.5rem.
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createContext, use, useRef, useState } from "react";
import type { ReactNode } from "react";

import { LoadingLines } from "../frame/page-states.tsx";
import { Button } from "../grasp/button/index.ts";
import { Expand } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A block of the dashboard's widget board: every block as high as the next
// whatever is in it, its title with its buttons, and what doesn't fit
// fading out at its foot. A block that has more opens in full, in a wide
// dialog with the title and the whole of it. The block's own
// frame waits on Grasp UI's SectionCard taking the height it is given
// (filling a grid cell, clipping and fading what doesn't fit). On the board, the
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

const styles = stylex.create({
  full: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space5,
    containerType: "inline-size",
  },
});

/** A block's button: an icon, named for a screen reader and a voice. */
export const BlockButton = ({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: IconData;
  onClick: () => void;
}) => (
  <Button
    icon={icon}
    label={label}
    onClick={onClick}
    size="xs"
    variant="ghost"
  />
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
  /** What the full view says under its title; nothing without it, its title names it. */
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
        icon={Expand}
        label={opens}
        onClick={() => {
          setOpen(true);
        }}
      />
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
              {description === undefined ? null : (
                <DialogDescription>{description}</DialogDescription>
              )}
            </DialogHeader>
            <WidgetFull value>
              <div {...stylex.props(styles.full)}>{full}</div>
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
