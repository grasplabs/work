import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createContext, use, useState } from "react";
import type { ReactNode } from "react";

import { LoadingLines } from "../frame/page-states.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Expand } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import type { SectionCardProps } from "../grasp/section-card/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A block of the dashboard's widget board: every block as high as the next
// whatever is in it (a Section card filling its cell), its title with its
// buttons, and what doesn't fit fading out at its foot. A block that has
// more opens in full, in the full-width dialog with the title and the
// whole of it. On the board, the buttons that take a block off stand
// beside its title too, and the block is moved by its title row, the
// Section card's handle (`WidgetControls`).

/** The title row as a drag handle, as a Section card takes it. */
type BlockHandle = NonNullable<SectionCardProps["handle"]>;

/** What the board puts beside a block's title, before its own button: the way to take it off, and its title row as the way to move it (widget-board.tsx). */
export interface WidgetFrame {
  actions: ReactNode;
  /** The block's title row, by which it is dragged or moved with the keys. */
  handle?: BlockHandle;
}

export const WidgetControls = createContext<WidgetFrame | null>(null);

/** Whether a widget is shown in full, so a part shows everything it has. */
export const WidgetFull = createContext(false);

/** Whether the widget is shown in full, so a part shows everything it has. */
export const useFull = (): boolean => use(WidgetFull);

const styles = stylex.create({
  // As high as the block, so a chart can take the room its parts leave; a
  // list is as long as it is and fades out at the foot.
  parts: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    height: "100%",
    containerType: "inline-size",
  },
  close: { gap: grasp.space3 },
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
    aria-label={label}
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
  handle,
  close = false,
  children,
}: {
  title: string;
  actions?: ReactNode;
  handle?: BlockHandle;
  close?: boolean;
  children?: ReactNode;
}) => (
  <SectionCard
    actions={actions}
    aria-label={title}
    density="compact"
    fill
    handle={handle}
    title={title}
  >
    <div {...stylex.props(styles.parts, close && styles.close)}>{children}</div>
  </SectionCard>
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
        handle={frame?.handle}
        title={title}
      >
        {children}
      </WidgetShell>
      {full === undefined ? null : (
        <Dialog onOpenChange={setOpen} open={open} size="full">
          <DialogContent closeLabel={t`Close`}>
            <DialogTitle>{title}</DialogTitle>
            {description === undefined ? null : (
              <DialogDescription>{description}</DialogDescription>
            )}
            <DialogBody>
              <WidgetFull value>
                <div {...stylex.props(styles.full)}>{full}</div>
              </WidgetFull>
            </DialogBody>
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
