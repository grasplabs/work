// Alert dialog: one question before a grave step that cannot be undone, such as deleting a
// workspace, in StyleX, built on UI SDK's AlertDialog (role="alertdialog"). It wears Dialog's look
// (dialog.tsx's `dialogStyles`), so the two are one family: the raised panel, the shade, the motion
// and the sheet along the bottom under 640px.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <AlertDialog>
//     <AlertDialogTrigger asChild><Button variant="destructive">Delete workspace</Button></AlertDialogTrigger>
//     <AlertDialogContent>
//       <AlertDialogHeader>
//         <AlertDialogTitle>Delete Northwind?</AlertDialogTitle>
//         <AlertDialogDescription>Its 12 projects and 340 files are deleted for everyone.</AlertDialogDescription>
//       </AlertDialogHeader>
//       <AlertDialogFooter>
//         <AlertDialogCancel>Keep it</AlertDialogCancel>
//         <AlertDialogAction variant="destructive" value="confirm">Delete</AlertDialogAction>
//       </AlertDialogFooter>
//     </AlertDialogContent>
//   </AlertDialog>
//
// A press on the shade does nothing and there is no close button: the safe answer or Escape is the
// way out. Focus starts on the safe answer, stays inside, and goes back to what opened it (UI SDK's
// AlertDialog, and hooks/use-return-focus for one opened by `open` with no trigger). Work that runs
// before it closes is a Button in the footer whose press returns a Promise, as in a Dialog.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  AlertDialogBackdrop as BackdropPrimitive,
  AlertDialogClose as ClosePrimitive,
  AlertDialogContent as ContentPrimitive,
  AlertDialogDescription as DescriptionPrimitive,
  AlertDialog as RootPrimitive,
  AlertDialogTitle as TitlePrimitive,
  AlertDialogTrigger as TriggerPrimitive,
} from "@ui-sdk/react/alert-dialog";
import type { AlertDialogOpenChangeReason } from "@ui-sdk/react/alert-dialog";
import type {
  DialogDismissAttemptDetails,
  DialogOpenChangeDetails,
} from "@ui-sdk/react/dialog";
import { mergeProps } from "@ui-sdk/react/primitive";
import { useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { useReturnFocus } from "../hooks/use-return-focus";
import { useI18n } from "../lib/i18n";
import { watchBody, watchPanel } from "../lib/layer";
import { focusRingInset, scrollbarHidden } from "../lib/styles";
import { space } from "../lib/tokens.stylex";
import { className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { layerFooterMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonSize, ButtonVariant } from "./button";
import { dialogStyles } from "./dialog";
import { panelMarker } from "./dialog.stylex";

type RootProps = ComponentProps<typeof RootPrimitive>;
type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;
type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;
type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop an AlertDialog takes: these, and the rest of UI SDK's AlertDialog. */
export interface AlertDialogProps extends Omit<RootProps, "children"> {
  /** The trigger and the content. */
  children: ReactNode;
  /**
   * Open now. Pass it with `onOpenChange` to open and close it yourself. It may be mounted only
   * while open: focus still goes back to what opened it.
   */
  open?: boolean;
  /**
   * Open when the page loads, with focus on the safe answer.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Runs when it wants to open or close. `details.reason` says why, `details.returnValue` is the
   * `value` of the answer that closed it, and `details.cancel()` keeps it open (while its work runs).
   */
  onOpenChange?: (
    open: boolean,
    details: DialogOpenChangeDetails<AlertDialogOpenChangeReason>
  ) => void;
  /**
   * Whether Escape cancels it. A press on the shade never does.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when Escape or a press on the shade was refused. */
  onDismissAttempt?: (details: DialogDismissAttemptDetails) => void;
}

/** The root: holds the trigger and the content, and renders nothing of its own. */
export const AlertDialog = ({ children, ...rest }: AlertDialogProps) => {
  // Opened by `open` with no trigger: focus goes back to what had it (hooks/use-return-focus).
  useReturnFocus(rest.open);
  return <RootPrimitive {...rest}>{children}</RootPrimitive>;
};

/** Every prop an AlertDialogTrigger takes: these, and the rest of UI SDK's AlertDialogTrigger. */
export interface AlertDialogTriggerProps extends Omit<
  TriggerPrimitiveProps,
  "render" | "children" | "className" | "style"
> {
  /**
   * Draw the one element given as the child (a Button) as the trigger, with the trigger's
   * behaviour; it keeps its own look and name.
   * @default false
   */
  asChild?: boolean;
  /** The element, with `asChild`; else the words. Name the step it asks about ("Delete workspace"). */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/**
 * The control that opens the alert dialog:
 * `<AlertDialogTrigger asChild><Button variant="destructive">…</Button></AlertDialogTrigger>`.
 * Opening it is harmless, so it never asks an agent for a yes; the action does.
 */
export const AlertDialogTrigger = ({
  asChild,
  children,
  style,
  ...rest
}: AlertDialogTriggerProps) => (
  <TriggerPrimitive
    {...rest}
    className={className(style)}
    {...slotProps(asChild, children)}
  />
);

// ---- The look ------------------------------------------------------------------------------------

// What an alert dialog wears beyond Dialog's own look, which its parts take first.
const styles = stylex.create({
  // The header holds the description, the part that scrolls: it may shrink, so the title and the
  // answers stay in view while the description scrolls between them.
  header: {
    flexShrink: 1,
    minHeight: 0,
  },
  // No close button in the corner, so the title runs to the content's edge.
  title: {
    paddingInlineEnd: 0,
  },
  // The description is Dialog's body: its hairlines, its fade and its focus. In the header it keeps
  // the header's gap under the title less the room it keeps for its focus ring, and runs to the
  // panel's sides, so its hairlines do.
  scroller: {
    flexGrow: 0,
    marginBlockStart: `calc(-1 * ${space["2"]})`,
    marginInline: `calc(-1 * ${space["6"]})`,
  },
});

// ---- The parts -----------------------------------------------------------------------------------

/** Every prop an AlertDialogContent takes: these, and the rest of UI SDK's AlertDialogContent. */
export interface AlertDialogContentProps extends Omit<
  ContentPrimitiveProps,
  "children" | "className" | "style" | "render"
> {
  /** The header, then the footer. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** The safe answer: AlertDialogCancel, else the footer's first answer. */
const CANCEL = '[data-slot="alert-dialog-cancel"]';
const FIRST_ANSWER = '[data-slot="alert-dialog-footer"] button';

/**
 * The panel, with the shade behind it. In the middle of the window; a sheet along the bottom under
 * 640px. Focus starts on the safe answer (AlertDialogCancel, else the footer's first), even when a
 * long description above it takes focus too.
 */
export const AlertDialogContent = ({
  children,
  style,
  ...rest
}: AlertDialogContentProps) => {
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const hold = (element: HTMLElement | null) => {
    setPanel(element);
    return watchPanel(element);
  };
  const safe = () =>
    panel?.querySelector<HTMLElement>(CANCEL) ??
    panel?.querySelector<HTMLElement>(FIRST_ANSWER) ??
    undefined;
  return (
    <>
      <BackdropPrimitive
        render={<div data-slot="alert-dialog-overlay" />}
        {...stylex.props(dialogStyles.overlay)}
      />
      <ContentPrimitive
        initialFocus={safe}
        {...mergeProps(rest, { ref: hold })}
        {...stylex.props(
          panelMarker,
          dialogStyles.panel,
          dialogStyles.placed,
          dialogStyles.motion,
          style
        )}
      >
        {children}
      </ContentPrimitive>
    </>
  );
};

/** What an alert dialog's own layout parts take. */
interface PartProps {
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop an AlertDialogHeader takes. */
export interface AlertDialogHeaderProps extends PartProps {
  /** The title, and the description under it. */
  children: ReactNode;
}

/** The question and what is lost, at the top of the panel. */
export const AlertDialogHeader = ({
  children,
  style,
}: AlertDialogHeaderProps) => (
  <div
    data-slot="alert-dialog-header"
    {...stylex.props(dialogStyles.header, styles.header, style)}
  >
    {children}
  </div>
);

/** Every prop an AlertDialogTitle takes. */
export interface AlertDialogTitleProps extends PartProps {
  /** The one question, naming the thing: "Delete Northwind?". It names the alert dialog. */
  children: ReactNode;
}

/** The question. It names the alert dialog. */
export const AlertDialogTitle = ({
  children,
  style,
}: AlertDialogTitleProps) => (
  <TitlePrimitive {...stylex.props(dialogStyles.title, styles.title, style)}>
    {children}
  </TitlePrimitive>
);

/** Every prop an AlertDialogDescription takes. */
export interface AlertDialogDescriptionProps extends PartProps {
  /**
   * What is lost, said plainly: "Its 12 projects and 340 files are deleted for everyone." Read
   * with the title when it opens. One paragraph: words and inline marks, no lists or blocks.
   */
  children: ReactNode;
}

/**
 * What is lost. It describes the alert dialog, and it is the one part that scrolls: when it holds
 * more than the window, it takes focus as a region named by the title, so the keys can scroll it
 * too (WCAG 2.1.1).
 */
export const AlertDialogDescription = ({
  children,
  style,
}: AlertDialogDescriptionProps) => {
  const [scrolls, setScrolls] = useState(false);
  const [title, setTitle] = useState<string>();
  const watch = (element: HTMLDivElement | null) =>
    element === null
      ? undefined
      : watchBody(element, "alertdialog", setTitle, setScrolls);
  return (
    <div
      ref={watch}
      data-slot="alert-dialog-description"
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "region" : undefined}
      aria-labelledby={scrolls ? title : undefined}
      {...stylex.props(
        dialogStyles.body,
        styles.scroller,
        scrollbarHidden,
        focusRingInset,
        style
      )}
    >
      <DescriptionPrimitive {...stylex.props(dialogStyles.description)}>
        {children}
      </DescriptionPrimitive>
    </div>
  );
};

/** Every prop an AlertDialogFooter takes. */
export interface AlertDialogFooterProps extends PartProps {
  /** The safe answer (AlertDialogCancel), then the one action. The safe answer comes first. */
  children: ReactNode;
}

/** The answers, at the end of the line. On a phone they share its width. */
export const AlertDialogFooter = ({
  children,
  style,
}: AlertDialogFooterProps) => (
  <div
    data-slot="alert-dialog-footer"
    {...stylex.props(layerFooterMarker, dialogStyles.footer, style)}
  >
    {children}
  </div>
);

/** What both answers take: the Button they draw, and the rest of UI SDK's AlertDialogClose. */
interface AnswerProps extends Omit<
  ClosePrimitiveProps,
  "render" | "children" | "className" | "style"
> {
  /** The look of the Button. */
  variant?: ButtonVariant;
  /**
   * The Button's height: a footer's answers are small.
   * @default "sm"
   */
  size?: Exclude<ButtonSize, `icon${string}`>;
  /** What the answer does, said to the person an agent must ask first ("Deletes the workspace"). */
  agentConfirm?: string;
  /** What `onOpenChange` hears as `details.returnValue` when this answer closes it ("confirm"). */
  value?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop an AlertDialogAction takes. */
export interface AlertDialogActionProps extends AnswerProps {
  /**
   * The Button's look: `default` for a grave step that deletes nothing, `destructive` when it
   * deletes.
   * @default "default"
   */
  variant?: ButtonVariant;
  /**
   * The action's verb ("Delete"). Keep it apart from the trigger's words, so an agent asked to
   * press one never finds the other.
   */
  children: ReactNode;
}

/**
 * The one action: closes the alert dialog with its `value`. An agent's press on it waits for the
 * person's yes, in `agentConfirm`'s words, else its own.
 */
export const AlertDialogAction = ({
  children,
  variant = "default",
  size = "sm",
  agentConfirm,
  style,
  ...rest
}: AlertDialogActionProps) => {
  // The action is the grave step, so an agent asks first whatever its look; a destructive Button
  // asks in its own words already.
  const asks =
    variant === "destructive" || typeof children !== "string"
      ? undefined
      : children;
  return (
    <ClosePrimitive
      {...rest}
      render={
        <Button
          data-slot="alert-dialog-action"
          variant={variant}
          size={size}
          agentConfirm={agentConfirm ?? asks}
          style={style}
        >
          {children}
        </Button>
      }
    />
  );
};

/** Every prop an AlertDialogCancel takes. */
export interface AlertDialogCancelProps extends AnswerProps {
  /**
   * The Button's look: `outline`, the way out beside the action.
   * @default "outline"
   */
  variant?: ButtonVariant;
  /**
   * Words of its own: what stays ("Keep it", "Not yet"). Left out, the I18nProvider's
   * `alertDialog.cancel` ("Cancel").
   */
  children?: ReactNode;
}

/**
 * The safe answer: closes the alert dialog and does nothing else. Put it first in the footer, so
 * focus starts on it.
 */
export const AlertDialogCancel = ({
  children,
  variant = "outline",
  size = "sm",
  agentConfirm,
  style,
  ...rest
}: AlertDialogCancelProps) => {
  const { cancel } = useI18n().alertDialog;
  return (
    <ClosePrimitive
      {...rest}
      render={
        <Button
          data-slot="alert-dialog-cancel"
          variant={variant}
          size={size}
          agentConfirm={agentConfirm}
          style={style}
        >
          {children ?? cancel}
        </Button>
      }
    />
  );
};
