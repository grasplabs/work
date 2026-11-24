// Dialog: a focused task over the page,
// in StyleX, built on UI SDK's Dialog: a raised panel with the one
// corner over a shade, a title that names it, a body that scrolls between the title and actions
// that stay put, and a close button in its corner. Under 640px it is a sheet along the bottom of
// the window.
//
//   <Dialog>
//     <DialogTrigger asChild><Button>Rename project</Button></DialogTrigger>
//     <DialogContent>
//       <DialogHeader>
//         <DialogTitle>Rename project</DialogTitle>
//         <DialogDescription>Everyone in the workspace sees the new name.</DialogDescription>
//       </DialogHeader>
//       <DialogBody>…</DialogBody>
//       <DialogFooter>
//         <DialogClose>Cancel</DialogClose>
//         <Button {...rename.props}>Rename</Button>
//       </DialogFooter>
//     </DialogContent>
//   </Dialog>
//
// The page behind is inert and does not scroll while it is open, Tab stays inside, Escape and a
// press on the shade close it, and focus goes back to what opened it: UI SDK's Dialog, and
// hooks/use-return-focus for one opened by `open` with no trigger. An agent opens it by its
// trigger's name and presses its buttons by theirs.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  DialogBackdrop as BackdropPrimitive,
  Dialog as DialogPrimitive,
  DialogClose as ClosePrimitive,
  DialogContent as ContentPrimitive,
  DialogDescription as DescriptionPrimitive,
  DialogTitle as TitlePrimitive,
  DialogTrigger as TriggerPrimitive,
} from "@ui-sdk/react/dialog";
import type {
  DialogDismissAttemptDetails,
  DialogOpenChangeDetails,
} from "@ui-sdk/react/dialog";
import { mergeProps } from "@ui-sdk/react/primitive";
import type { ComponentProps, ReactNode } from "react";

import { useReturnFocus } from "../hooks/use-return-focus";
import { useI18n } from "../lib/i18n";
import { Icon, XIcon } from "../lib/icons";
import { layerStyles, useLayerBody, watchPanel } from "../lib/layer";
import { focusRingInset, scrollbarHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { layerFooterMarker, motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonSize, ButtonVariant } from "./button";
import { panelMarker } from "./dialog.stylex";

type RootProps = ComponentProps<typeof DialogPrimitive>;
type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;
type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;
type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a Dialog takes: these, and the rest of UI SDK's Dialog. */
export interface DialogProps extends Omit<
  RootProps,
  "children" | "presentation"
> {
  /** The trigger and the content. */
  children: ReactNode;
  /**
   * Open now. Pass it with `onOpenChange` to open and close the dialog yourself. It may be mounted
   * only while open: focus still goes back to what opened it.
   */
  open?: boolean;
  /**
   * Open when the page loads, and focus moves into it.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Runs when the dialog wants to open or close; `details.reason` says why, and `details.cancel()`
   * keeps it as it is (while its action works).
   */
  onOpenChange?: (open: boolean, details: DialogOpenChangeDetails) => void;
  /**
   * Whether Escape and a press on the shade close it. Pass `false` while a form has unsaved
   * changes, or while its action works, and ask in `onDismissAttempt`. The close button and
   * DialogClose still close it.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when Escape or a press on the shade was refused, because it is not dismissible. */
  onDismissAttempt?: (details: DialogDismissAttemptDetails) => void;
}

/** The root: holds the trigger and the content, and renders nothing of its own. */
export const Dialog = ({ children, ...rest }: DialogProps) => {
  // Opened by `open` with no trigger: focus goes back to what had it (hooks/use-return-focus).
  useReturnFocus(rest.open);
  return <DialogPrimitive {...rest}>{children}</DialogPrimitive>;
};

/** What a plain wrapper part takes: `asChild`, its children and a layout. */
interface WrapperProps {
  /**
   * Draw the one element given as the child (a Button) as this part, with the part's behaviour;
   * it keeps its own look and name.
   * @default false
   */
  asChild?: boolean;
  /** The element, with `asChild`; else the words. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DialogTrigger takes: these, and the rest of UI SDK's DialogTrigger. */
export interface DialogTriggerProps
  extends
    Omit<TriggerPrimitiveProps, "render" | "children" | "className" | "style">,
    WrapperProps {}

/**
 * The control that opens the dialog: `<DialogTrigger asChild><Button>…</Button></DialogTrigger>`.
 * For an icon-only one, wrap the Button in a Tooltip for its words.
 */
export const DialogTrigger = ({
  asChild,
  children,
  style,
  ...rest
}: DialogTriggerProps) => (
  <TriggerPrimitive
    {...rest}
    className={className(style)}
    {...slotProps(asChild, children)}
  />
);

// ---- The look ------------------------------------------------------------------------------------

const PHONE = media.maxSm;

// Where a dialog stands while it opens and as it closes: a little lower and smaller, and clear.
// On a phone it is a sheet below the window instead. lib/layer's watchPanel sets --dialog-shift
// to 0 when it grows from its trigger, where a rise would fight the origin.
const away = `translateY(var(--dialog-shift, ${sizes.dialogFromShift})) scale(${sizes.dialogFromScale})`;
const below = "translateY(100%)";
// Arriving, it starts from the browser's own @starting-style, so the fade begins in the first frame
// it is drawn; UI SDK's data-starting-style comes off a frame later, which would hold the panel
// clear for that frame and the next. Leaving, UI SDK's data-ending-style.
const leaving = ":is([data-ending-style])";
const arriving = "@starting-style";

const look = stylex.create({
  // The shade over the page. It follows the panel in and out.
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: colors.dialogScrim,
    opacity: { default: 1, [arriving]: 0, [leaving]: 0 },
    transitionProperty: "opacity",
    transitionDuration: {
      default: motionVars.ui,
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },

  // The panel (layerStyles' panel): the one corner, a sheet's on a phone, and nothing out of it.
  panel: {
    overflow: "hidden",
    borderRadius: {
      default: radius.xl,
      [PHONE]: `${radius.xl} ${radius.xl} 0 0`,
    },
  },

  // Over the page: in the middle of the window, clear of its edges by the gutter. On a phone, a
  // sheet along the bottom as wide as the window, over the keyboard when one is up.
  placed: {
    position: "fixed",
    insetInline: 0,
    insetBlockStart: { default: 0, [PHONE]: "auto" },
    insetBlockEnd: { default: 0, [PHONE]: "var(--keyboard-inset, 0px)" },
    marginBlock: { default: "auto", [PHONE]: 0 },
    marginInline: { default: "auto", [PHONE]: 0 },
    width: {
      default: `min(${sizes.dialogWidth}, 100% - 2 * ${sizes.dialogGutter})`,
      [PHONE]: "100%",
    },
    maxWidth: "none",
    height: "fit-content",
    maxHeight: {
      default: `calc(var(--visual-viewport-height, 100dvh) - 2 * ${sizes.dialogGutter})`,
      [PHONE]: `calc(var(--visual-viewport-height, 100dvh) - ${sizes.dialogGutter})`,
    },
  },

  // A full dialog: a chart or a table opened in full, dialog-width-full wide, never closer than the
  // gutter to the window's edges. On a phone, the same sheet as any dialog.
  full: {
    width: {
      default: `min(${sizes.dialogWidthFull}, 100% - 2 * ${sizes.dialogGutter})`,
      [PHONE]: "100%",
    },
  },

  // In and out: from a little lower and smaller, or from below the window on a phone. Leaving is
  // faster than arriving. With reduced motion it is there and gone at once.
  motion: {
    opacity: {
      default: 1,
      [arriving]: { default: 0, [PHONE]: 1 },
      [leaving]: { default: 0, [PHONE]: 1 },
    },
    transform: {
      default: "none",
      [arriving]: { default: away, [PHONE]: below },
      [leaving]: { default: away, [PHONE]: below },
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motionVars.ui,
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },

  // The title and the sentence under it, at the top of the panel. The title leaves room at its end
  // for the close button.
  header: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    rowGap: space["4"],
    paddingBlockStart: space["6"],
    paddingInline: space["6"],
  },

  // The title (layerStyles' title), with its own tracking, so a host page's heading rules never
  // reach it, and room at its end for the close button.
  title: {
    letterSpacing: font.trackingUi,
    paddingInlineEnd: sizes.controlSm,
  },

  // A body that holds fields: one under another.
  stack: {
    display: "grid",
    rowGap: space["5"],
  },

  // The actions, at the end of the line, the main one last. On a phone a Button in it takes an
  // equal share of the line (button.tsx reads layerFooterMarker), so each is a wide target under the
  // thumb. Clear of a phone's home bar.
  footer: {
    flexShrink: 0,
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: space["2"],
    marginBlockStart: space["6"],
    paddingInline: space["6"],
    paddingBlockEnd: {
      default: space["6"],
      [PHONE]: `max(${space["6"]}, env(safe-area-inset-bottom))`,
    },
  },

  // The close button, level with the title's first line, its cross on the content's edge.
  close: {
    position: "absolute",
    insetBlockStart: `calc(${space["6"]} + (${font.textBaseLine} - ${sizes.controlSm}) / 2)`,
    insetInlineEnd: `calc(${space["6"]} - ${space["2"]})`,
    display: "flex",
  },
});

/** The dialog's look, for the panels built like it: Alert dialog's and Command's. */
export const dialogStyles = {
  ...look,
  panel: [layerStyles.panel, look.panel],
  title: [layerStyles.title, look.title],
  description: layerStyles.description,
  body: layerStyles.body,
};

const styles = dialogStyles;

// ---- The parts -----------------------------------------------------------------------------------

/** Every prop a DialogContent takes: these, and the rest of UI SDK's DialogContent. */
export interface DialogContentProps extends Omit<
  ContentPrimitiveProps,
  "children" | "className" | "style" | "render"
> {
  /** The header, the body and the footer, in that order. */
  children: ReactNode;
  /**
   * How wide it is: `default` for a form or a short task, `full` for a chart or a table opened in
   * full. Never wider than the window less its gutters; on a phone, the sheet along the bottom
   * either way.
   * @default "default"
   */
  size?: "default" | "full";
  /**
   * The close button in its corner, named by the I18nProvider's `dialog.close`. Leave it on unless
   * the footer has a way out of its own and nothing would be lost.
   * @default true
   */
  showCloseButton?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/**
 * The panel, with the shade behind it and the close button in its corner. Over the page in the
 * middle of the window, `dialog-width` wide or `dialog-width-full` when full; a sheet along the
 * bottom under 640px. It grows from the trigger that opened it.
 */
export const DialogContent = ({
  children,
  size = "default",
  showCloseButton = true,
  style,
  ...rest
}: DialogContentProps) => {
  const { close } = useI18n().dialog;
  return (
    <>
      <BackdropPrimitive
        render={<div data-slot="dialog-overlay" />}
        {...stylex.props(styles.overlay)}
      />
      <ContentPrimitive
        {...mergeProps(rest, { ref: watchPanel })}
        {...stylex.props(
          panelMarker,
          styles.panel,
          styles.placed,
          size === "full" && styles.full,
          styles.motion,
          style
        )}
      >
        {children}
        {showCloseButton && (
          <span {...stylex.props(styles.close)}>
            <ClosePrimitive
              render={
                <Button variant="ghost" size="icon-sm" aria-label={close}>
                  <Icon icon={XIcon} />
                </Button>
              }
            />
          </span>
        )}
      </ContentPrimitive>
    </>
  );
};

/** What a dialog's own layout parts take. */
interface PartProps {
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DialogHeader takes. */
export interface DialogHeaderProps extends PartProps {
  /** The title, and the description under it. */
  children: ReactNode;
}

/** The title and the description under it, at the top of the panel. */
export const DialogHeader = ({ children, style }: DialogHeaderProps) => (
  <div data-slot="dialog-header" {...stylex.props(styles.header, style)}>
    {children}
  </div>
);

/** Every prop a DialogTitle takes. */
export interface DialogTitleProps extends PartProps {
  /** What the dialog is for, in sentence case: it names the dialog for a screen reader and an agent. */
  children: ReactNode;
}

/** The title. It names the dialog. */
export const DialogTitle = ({ children, style }: DialogTitleProps) => (
  <TitlePrimitive {...stylex.props(styles.title, style)}>
    {children}
  </TitlePrimitive>
);

/** Every prop a DialogDescription takes. */
export interface DialogDescriptionProps extends PartProps {
  /** One or two sentences on what happens, read with the title when the dialog opens. */
  children: ReactNode;
}

/** The sentence under the title. It describes the dialog to a screen reader. */
export const DialogDescription = ({
  children,
  style,
}: DialogDescriptionProps) => (
  <DescriptionPrimitive {...stylex.props(styles.description, style)}>
    {children}
  </DescriptionPrimitive>
);

/** Every prop a DialogBody takes. */
export interface DialogBodyProps extends PartProps {
  /** The task: fields, a list, words, one under another. */
  children: ReactNode;
}

/**
 * What the dialog is about: the one part that scrolls, so the title and the actions stay put. When
 * it holds more than it shows, it takes focus and is named by the dialog's title, so the keys can
 * scroll it too (WCAG 2.1.1); when everything fits it is not a stop at all.
 */
export const DialogBody = ({ children, style }: DialogBodyProps) => {
  const body = useLayerBody("dialog");
  return (
    <div
      {...body}
      data-slot="dialog-body"
      {...stylex.props(styles.body, scrollbarHidden, focusRingInset, style)}
    >
      <div {...stylex.props(styles.stack)}>{children}</div>
    </div>
  );
};

/** Every prop a DialogFooter takes. */
export interface DialogFooterProps extends PartProps {
  /** The actions, the main one last: Cancel, then Rename. */
  children: ReactNode;
}

/**
 * The actions, at the end of the line. A Button directly in it that names no size is small, as
 * DialogClose is, so its actions stand one height. On a phone every Button in it takes an equal
 * part of its width.
 */
export const DialogFooter = ({ children, style }: DialogFooterProps) => (
  // The marker a Button reads to take its share of the line on a phone.
  <div
    data-slot="dialog-footer"
    {...stylex.props(layerFooterMarker, styles.footer, style)}
  >
    {children}
  </div>
);

/** Every prop a DialogClose takes: these, and the rest of UI SDK's DialogClose. */
export interface DialogCloseProps
  extends
    Omit<ClosePrimitiveProps, "render" | "children" | "className" | "style">,
    WrapperProps {
  /**
   * The look of the Button it draws, without `asChild`: `outline` for Cancel beside the main
   * action; `default` when closing is the step the dialog is for.
   * @default "outline"
   */
  variant?: ButtonVariant;
  /**
   * The height of the Button it draws, without `asChild`: a footer's actions are small.
   * @default "sm"
   */
  size?: Exclude<ButtonSize, `icon${string}`>;
}

/**
 * Closes the dialog, and focus goes back to what opened it. On its own it draws an outline Button
 * with its words (`<DialogClose>Cancel</DialogClose>`); with `asChild` it hands its behaviour to
 * the element inside (`<DialogClose asChild><Button variant="destructive">…</Button></DialogClose>`).
 */
export const DialogClose = ({
  asChild,
  children,
  variant = "outline",
  size = "sm",
  style,
  ...rest
}: DialogCloseProps) =>
  asChild === true ? (
    <ClosePrimitive
      {...rest}
      className={className(style)}
      {...slotProps(asChild, children)}
    />
  ) : (
    <ClosePrimitive
      {...rest}
      render={
        <Button variant={variant} size={size} style={style}>
          {children}
        </Button>
      }
    />
  );
