// Sheet: a task or details in a panel along a side of the window,
// in StyleX, built on UI SDK's
// Drawer: a raised panel the window's height, floating a little off its edges, a head with its
// title and a close button, a body that scrolls, and actions at its foot. Escape, a press on the
// shade or a drag towards its side closes it.
//
//   <Sheet>
//     <SheetTrigger asChild><Button variant="outline">Edit profile</Button></SheetTrigger>
//     <SheetContent side="end">
//       <SheetHeader>
//         <SheetTitle>Edit profile</SheetTitle>
//         <SheetDescription>Your name and role, as the team sees them.</SheetDescription>
//       </SheetHeader>
//       <SheetBody>…</SheetBody>
//       <SheetFooter>
//         <SheetClose>Cancel</SheetClose>
//         <Button {...save.props}>Save</Button>
//       </SheetFooter>
//     </SheetContent>
//   </Sheet>
//
// UI SDK's Drawer moves the panel as it is dragged and springs it back; the sheet slides it in from
// its side and back out. The page behind is inert and does not scroll, Tab stays inside, and focus
// goes back to what opened it (hooks/use-return-focus for one opened by `open`). Its body, its
// description and its footer wear Dialog's look (dialog.tsx's `dialogStyles`), so the layers are
// one family.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  DrawerBackdrop as BackdropPrimitive,
  DrawerClose as ClosePrimitive,
  DrawerContent as ContentPrimitive,
  DrawerDescription as DescriptionPrimitive,
  Drawer as RootPrimitive,
  DrawerTitle as TitlePrimitive,
  DrawerTrigger as TriggerPrimitive,
} from "@ui-sdk/react/drawer";
import type { DrawerDismissAttemptDetails } from "@ui-sdk/react/drawer";
import { createContext, use, useLayoutEffect, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import { useReturnFocus } from "../hooks/use-return-focus";
import { useI18n } from "../lib/i18n";
import { Icon, XIcon } from "../lib/icons";
import { keepBodyPut, shadeProps, useLayerBody } from "../lib/layer";
import {
  focusRingInset,
  scrollbarHidden,
  tapRows,
  watchRows,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { layerFooterMarker, motionVars } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonSize, ButtonVariant } from "./button";
import { dialogStyles } from "./dialog";
import { panelMarker } from "./dialog.stylex";

type RootProps = ComponentProps<typeof RootPrimitive>;
type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;
type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;
type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;

/** The side a sheet stands along. Both follow the reading direction. */
type Side = "start" | "end";

// The side lives on UI SDK's root, which moves the panel; SheetContent names it,
// and hands it up.
const SideContext = createContext<(side: Side) => void>(() => {
  // Outside a Sheet there is no root to tell.
});

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a Sheet takes: these, and the rest of UI SDK's Drawer. */
export interface SheetProps extends Omit<
  RootProps,
  | "children"
  | "side"
  | "open"
  | "defaultOpen"
  | "onOpenChange"
  | "dismissible"
  | "onDismissAttempt"
  | "snapPoints"
  | "snapPoint"
  | "defaultSnapPoint"
  | "onSnapPointChange"
> {
  /** The trigger and the content. */
  children: ReactNode;
  /**
   * Open now. Pass it with `onOpenChange` to open and close the sheet yourself. It may be mounted
   * only while open: focus still goes back to what opened it.
   */
  open?: boolean;
  /**
   * Open when the page loads, and focus moves into it.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Runs when the sheet wants to open or close; `details.reason` says why, a swipe included, and
   * `details.cancel()` keeps it as it is (while its action works).
   */
  onOpenChange?: RootProps["onOpenChange"];
  /**
   * Whether Escape, a press on the shade and a drag towards its side close it. Pass `false` while a
   * form has unsaved changes, and ask in `onDismissAttempt`. The close button and SheetClose still
   * close it.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when a close was refused because it is not dismissible; a drag springs back. */
  onDismissAttempt?: (details: DrawerDismissAttemptDetails) => void;
}

/** The root: holds the trigger and the content, and renders nothing of its own. */
export const Sheet = ({ children, ...rest }: SheetProps) => {
  const [side, setSide] = useState<Side>("end");
  // Opened by `open` with no trigger: focus goes back to what had it (hooks/use-return-focus).
  useReturnFocus(rest.open);
  return (
    <SideContext value={setSide}>
      <RootPrimitive {...rest} side={side}>
        {children}
      </RootPrimitive>
    </SideContext>
  );
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

/**
 * UI SDK names a Drawer's parts `drawer-*`, over a `data-slot` given as a prop; the element it
 * draws keeps its own. So a part that draws its own element names it there. With `asChild` the
 * element is the caller's, and keeps UI SDK's name.
 */
const slotted = (
  slot: string,
  asChild: boolean | undefined,
  children: ReactNode
) =>
  asChild === true
    ? slotProps(asChild, children)
    : {
        render: (
          <button type="button" data-slot={slot}>
            {children}
          </button>
        ),
      };

/** Every prop a SheetTrigger takes: these, and the rest of UI SDK's DrawerTrigger. */
export interface SheetTriggerProps
  extends
    Omit<TriggerPrimitiveProps, "render" | "children" | "className" | "style">,
    WrapperProps {}

/** The control that opens the sheet: `<SheetTrigger asChild><Button>…</Button></SheetTrigger>`. */
export const SheetTrigger = ({
  asChild,
  children,
  style,
  ...rest
}: SheetTriggerProps) => (
  <TriggerPrimitive
    {...rest}
    className={className(style)}
    {...slotted("sheet-trigger", asChild, children)}
  />
);

// ---- The look ------------------------------------------------------------------------------------

const right = ':is([data-side="right"])';
const left = ':is([data-side="left"])';
const moving = ":is([data-starting-style], [data-ending-style])";
const INSET = sizes.sheetPadding;

// A sheet's own look; what it shares with a Dialog (the panel's ground and type, the description,
// the body, the footer) comes from dialogStyles.
const styles = stylex.create({
  // The panel: the window's height, sheet-width wide, a little off the window's edges with every
  // corner rounded, the same inset on a phone from both sides as from the top and foot.
  panel: {
    position: "relative",
    width: `min(${sizes.sheetWidth}, 100% - 2 * ${INSET})`,
    height: `calc(100% - 2 * ${INSET})`,
    marginBlock: INSET,
    marginInline: INSET,
    // Holding a sidebar (on a narrow window), the page card's corner, as the original's frame drew
    // its menu.
    borderRadius: {
      default: radius.xl,
      ":has(> [data-slot=sidebar])": radius.md,
    },
    cornerShape: radius.shape,
    // It slides in from its side and back out to it (UI SDK marks the first and last frame), in
    // the library's open time; with reduced motion it is there and gone at once.
    translate: {
      default: null,
      [`${right}${moving}`]: `calc(100% + ${INSET}) 0`,
      [`${left}${moving}`]: `calc(-100% - ${INSET}) 0`,
    },
    transitionProperty: "translate",
    transitionDuration: motionVars.open,
    transitionTimingFunction: duration.ease,
  },
  // A layout of its own beside the page, and a chart or a table opened in full. Never closer than
  // the inset to the window's edges, so on a phone either is the whole sheet.
  lg: { width: `min(${sizes.sheetWidthWide}, 100% - 2 * ${INSET})` },
  full: { width: `min(${sizes.sheetWidthFull}, 100% - 2 * ${INSET})` },

  header: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
  },
  // The title heads the sheet: a row of its own in the interface's small type, the close button at
  // its end and a hairline under it. Its words start on the content's one edge.
  title: {
    boxSizing: "border-box",
    minHeight: sizes.sheetHeadHeight,
    margin: 0,
    paddingBlock: `calc((${sizes.sheetHeadHeight} - ${font.textSmLine}) / 2)`,
    paddingInlineStart: space["6"],
    paddingInlineEnd: `calc(${space["4"]} + ${sizes.controlSm})`,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
    overflowWrap: "anywhere",
    hyphens: "manual",
    textWrap: "balance",
    boxShadow: `inset 0 calc(-1 * ${sizes.hairline}) 0 ${colors.border}`,
  },
  // Under the head, the description opens the content.
  description: {
    marginBlockStart: space["6"],
    paddingInline: space["6"],
  },
  stack: {
    display: "grid",
    rowGap: space["4"],
  },
  // The actions stand at its foot, however little is above them.
  footer: {
    marginBlockStart: "auto",
    paddingBlockStart: space["6"],
    paddingBlockEnd: `max(${space["6"]}, env(safe-area-inset-bottom))`,
  },
  // The close button, at the end of the head.
  close: {
    position: "absolute",
    insetBlockStart: `calc((${sizes.sheetHeadHeight} - ${sizes.controlSm}) / 2)`,
    insetInlineEnd: `calc((${sizes.sheetHeadHeight} - ${sizes.controlSm}) / 2)`,
    display: "flex",
    // Drawn in the corner, away from the parts it follows in the page: its touch target reaches
    // the full 44px towards them (tapTarget).
    "--tap-room-inline": sizes.tapTarget,
  },
});

// ---- The parts -----------------------------------------------------------------------------------

/** Every prop a SheetContent takes: these, and the rest of UI SDK's DrawerContent. */
export interface SheetContentProps extends Omit<
  ContentPrimitiveProps,
  "children" | "className" | "style" | "render"
> {
  /** The header, the body and the footer, in that order. */
  children: ReactNode;
  /**
   * The side it stands along: `end` (the right in English) for a task or details, `start` for a
   * list of places to go. Both follow the reading direction.
   * @default "end"
   */
  side?: Side;
  /**
   * How wide it is: `default` for a form or details, `lg` for a layout of its own, `full` for a
   * chart or a table opened in full. Never closer than its inset to the window's edges.
   * @default "default"
   */
  size?: "default" | "lg" | "full";
  /**
   * The close button at the end of its head, named by the I18nProvider's `sheet.close`. Leave it
   * off only where the content puts a SheetClose of its own.
   * @default true
   */
  showCloseButton?: boolean;
  /**
   * Its name, for a screen reader and an agent, when it shows no SheetTitle: a sheet whose own
   * content heads it (a picture, a sidebar). With a SheetTitle, the title names it.
   */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** The panel, with the shade behind it and the close button at the end of its head. */
export const SheetContent = ({
  children,
  side = "end",
  size = "default",
  showCloseButton = true,
  style,
  ...rest
}: SheetContentProps) => {
  const { close } = useI18n().sheet;
  const setSide = use(SideContext);
  useLayoutEffect(() => {
    setSide(side);
  }, [setSide, side]);
  return (
    <>
      <BackdropPrimitive {...shadeProps("sheet-overlay")} />
      {/* The panel keeps UI SDK's own slot, drawer-content: named otherwise through its render
          element, UI SDK's focus trap no longer holds Tab inside it. */}
      <ContentPrimitive
        {...rest}
        {...stylex.props(
          panelMarker,
          dialogStyles.panel,
          styles.panel,
          size === "lg" && styles.lg,
          size === "full" && styles.full,
          style
        )}
      >
        {children}
        {showCloseButton && (
          <span {...stylex.props(styles.close)}>
            <ClosePrimitive
              render={
                <Button
                  data-slot="sheet-close"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={close}
                >
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

/** What a sheet's own layout parts take. */
interface PartProps {
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a SheetHeader takes. */
export interface SheetHeaderProps extends PartProps {
  /** The title, and the description under it. */
  children: ReactNode;
}

/** The title and the description under it, at the top of the panel. */
export const SheetHeader = ({ children, style }: SheetHeaderProps) => (
  <div data-slot="sheet-header" {...stylex.props(styles.header, style)}>
    {children}
  </div>
);

/** Every prop a SheetTitle takes. */
export interface SheetTitleProps extends PartProps {
  /** What the sheet is for, in sentence case: it names it for a screen reader and an agent. */
  children: ReactNode;
}

/** The title: the sheet's head, and its name. */
export const SheetTitle = ({ children, style }: SheetTitleProps) => (
  <TitlePrimitive
    render={<h2 data-slot="sheet-title">{children}</h2>}
    {...stylex.props(styles.title, style)}
  />
);

/** Every prop a SheetDescription takes. */
export interface SheetDescriptionProps extends PartProps {
  /** One or two sentences on what it holds, read with the title when it opens. */
  children: ReactNode;
}

/** The sentence under the head. It describes the sheet to a screen reader. */
export const SheetDescription = ({
  children,
  style,
}: SheetDescriptionProps) => (
  <DescriptionPrimitive
    render={<p data-slot="sheet-description" />}
    {...stylex.props(dialogStyles.description, styles.description, style)}
  >
    {children}
  </DescriptionPrimitive>
);

/** Every prop a SheetBody takes. */
export interface SheetBodyProps extends PartProps {
  /** The task or the details: fields, a list, words, one under another. */
  children: ReactNode;
}

/**
 * What the sheet is about: the one part that scrolls, so the head and the actions stay put. When
 * it holds more than it shows, it takes focus and is named by the title, so the keys can scroll it
 * too; when everything fits it is not a stop at all.
 */
export const SheetBody = ({ children, style }: SheetBodyProps) => {
  const body = useLayerBody("dialog", keepBodyPut);
  return (
    <div
      {...body}
      data-slot="sheet-body"
      {...stylex.props(
        dialogStyles.body,
        scrollbarHidden,
        focusRingInset,
        style
      )}
    >
      <div {...stylex.props(styles.stack)}>{children}</div>
    </div>
  );
};

/** Every prop a SheetFooter takes. */
export interface SheetFooterProps extends PartProps {
  /** The actions, the main one last: Cancel, then Save. */
  children: ReactNode;
}

/**
 * The actions, at the end of the line, at the sheet's foot. A Button directly in it that names no
 * size is small, as SheetClose is, so its actions stand one height. On a phone every Button in it
 * takes an equal part of its width.
 */
export const SheetFooter = ({ children, style }: SheetFooterProps) => (
  <div
    ref={watchRows}
    data-slot="sheet-footer"
    {...stylex.props(
      layerFooterMarker,
      dialogStyles.footer,
      tapRows,
      styles.footer,
      style
    )}
  >
    {children}
  </div>
);

/** Every prop a SheetClose takes: these, and the rest of UI SDK's DrawerClose. */
export interface SheetCloseProps
  extends
    Omit<ClosePrimitiveProps, "render" | "children" | "className" | "style">,
    WrapperProps {
  /**
   * The look of the Button it draws, without `asChild`: `outline` for Cancel beside the main
   * action; `default` when closing is the step the sheet is for.
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
 * Closes the sheet, and focus goes back to what opened it. On its own it draws an outline Button
 * with its words (`<SheetClose>Cancel</SheetClose>`); with `asChild` it hands its behaviour to the
 * element inside.
 */
export const SheetClose = ({
  asChild,
  children,
  variant = "outline",
  size = "sm",
  style,
  ...rest
}: SheetCloseProps) =>
  asChild === true ? (
    <ClosePrimitive
      {...rest}
      className={className(style)}
      {...slotted("sheet-close", asChild, children)}
    />
  ) : (
    <ClosePrimitive
      {...rest}
      render={
        <Button
          data-slot="sheet-close"
          variant={variant}
          size={size}
          style={style}
        >
          {children}
        </Button>
      }
    />
  );
