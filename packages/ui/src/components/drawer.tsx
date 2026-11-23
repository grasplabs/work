// Drawer: a task in a panel that rises from the bottom of the window, in StyleX, built on UI
// SDK's Drawer: a raised panel with the one corner on its top, a handle to drag it by, a body that
// scrolls between the title and actions that stay put. A drag down, Escape or a press on the shade
// closes it; with `snapPoints` it rests at more than one height, and the handle steps through them.
//
//   <Drawer>
//     <DrawerTrigger asChild><Button>Set a reminder</Button></DrawerTrigger>
//     <DrawerContent>
//       <DrawerHeader>
//         <DrawerTitle>Set a reminder</DrawerTitle>
//         <DrawerDescription>We will send it to your inbox.</DrawerDescription>
//       </DrawerHeader>
//       <DrawerBody>…</DrawerBody>
//       <DrawerFooter>
//         <DrawerClose>Cancel</DrawerClose>
//         <Button size="sm" {...save.props}>Save</Button>
//       </DrawerFooter>
//     </DrawerContent>
//   </Drawer>
//
// UI SDK's Drawer moves the panel itself (the swipe, its spring, the rests): these styles never
// set its translate or the shade's opacity. The page behind is inert and does not scroll, Tab stays
// inside, and focus goes back to what opened it (hooks/use-return-focus for one opened by `open`).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  DrawerBackdrop as BackdropPrimitive,
  DrawerClose as ClosePrimitive,
  DrawerContent as ContentPrimitive,
  DrawerDescription as DescriptionPrimitive,
  Drawer as DrawerPrimitive,
  DrawerHandle as HandlePrimitive,
  DrawerTitle as TitlePrimitive,
  DrawerTrigger as TriggerPrimitive,
} from "@ui-sdk/react/drawer";
import type {
  DrawerDismissAttemptDetails,
  SnapPoint,
} from "@ui-sdk/react/drawer";
import { createContext, use } from "react";
import type { ComponentProps, ReactNode } from "react";

import { useReturnFocus } from "../hooks/use-return-focus";
import { useI18n } from "../lib/i18n";
import { keepBodyPut, layerStyles, useLayerBody } from "../lib/layer";
import {
  focusRing,
  focusRingInset,
  scrollbarHidden,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { layerFooterMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import type { ButtonSize, ButtonVariant } from "./button";
import { drawerMarker } from "./drawer.stylex";

type RootProps = ComponentProps<typeof DrawerPrimitive>;
type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;
type ContentPrimitiveProps = ComponentProps<typeof ContentPrimitive>;
type ClosePrimitiveProps = ComponentProps<typeof ClosePrimitive>;

// Whether the drawer has heights to rest at: then the panel takes its tallest height, so it has
// room to rise into, and the lower rests show part of it.
const SnapsContext = createContext(false);

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the types below, so they cannot drift from what the code accepts.

/** Every prop a Drawer takes: these, and the rest of UI SDK's Drawer. */
export interface DrawerProps extends Omit<
  RootProps,
  | "children"
  | "side"
  | "open"
  | "defaultOpen"
  | "onOpenChange"
  | "dismissible"
  | "onDismissAttempt"
  | "snapPoints"
> {
  /** The trigger and the content. */
  children: ReactNode;
  /**
   * Open now. Pass it with `onOpenChange` to open and close the drawer yourself. It may be mounted
   * only while open: focus still goes back to what opened it.
   */
  open?: boolean;
  /**
   * Open when the page loads, and focus moves into it.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Runs when the drawer wants to open or close; `details.reason` says why, a swipe included, and
   * `details.cancel()` keeps it as it is (while its action works).
   */
  onOpenChange?: RootProps["onOpenChange"];
  /**
   * Whether Escape, a press on the shade and a drag down close it. Pass `false` while a form has
   * unsaved changes, and ask in `onDismissAttempt`. DrawerClose still closes it.
   * @default true
   */
  dismissible?: boolean;
  /** Runs when a close was refused because it is not dismissible; a drag springs back. */
  onDismissAttempt?: (details: DrawerDismissAttemptDetails) => void;
  /**
   * Heights it can rest at, from the bottom: a fraction of the window, pixels, or `"content"`
   * for its own height. The handle steps through them. Leave it out for one height, its content's.
   */
  snapPoints?: SnapPoint[];
}

/** The root: holds the trigger and the content, and renders nothing of its own. Along the bottom. */
export const Drawer = ({ children, ...rest }: DrawerProps) => {
  const snaps = (rest.snapPoints?.length ?? 0) > 0;
  // Opened by `open` with no trigger: focus goes back to what had it (hooks/use-return-focus).
  useReturnFocus(rest.open);
  return (
    <SnapsContext.Provider value={snaps}>
      <DrawerPrimitive {...rest} side="bottom">
        {children}
      </DrawerPrimitive>
    </SnapsContext.Provider>
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

/** Every prop a DrawerTrigger takes: these, and the rest of UI SDK's DrawerTrigger. */
export interface DrawerTriggerProps
  extends
    Omit<TriggerPrimitiveProps, "render" | "children" | "className" | "style">,
    WrapperProps {}

/** The control that opens the drawer: `<DrawerTrigger asChild><Button>…</Button></DrawerTrigger>`. */
export const DrawerTrigger = ({
  asChild,
  children,
  style,
  ...rest
}: DrawerTriggerProps) => (
  <TriggerPrimitive
    {...rest}
    className={className(style)}
    {...slotProps(asChild, children)}
  />
);

// ---- The look ------------------------------------------------------------------------------------

const PHONE = media.maxSm;
const FORCED = media.forcedColors;

// The hairline above the actions at a lower rest, as the body's, and the fade above them.
const lineAbove = `inset 0 1px 0 ${colors.border}`;
const FADE = space["6"];

// At a lower rest of a drawer with heights: the actions are lifted over the body.
const lowerRest = ":is([data-snap-point]):not([data-expanded])";

const styles = stylex.create({
  // The shade over the page. UI SDK sets its opacity as the panel moves.
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: colors.dialogScrim,
  },

  // The panel (layerStyles' panel): the one corner on its top. As wide as the window up to
  // drawer-width, in the middle; as tall as its content up to drawer-height.
  panel: {
    position: "relative",
    marginInline: "auto",
    borderRadius: `${radius.xl} ${radius.xl} 0 0`,
    width: { default: `min(${sizes.drawerWidth}, 100%)`, [PHONE]: "100%" },
    height: "fit-content",
    maxHeight: `min(${sizes.drawerHeight}, var(--visual-viewport-height, 100dvh) - ${sizes.dialogGutter})`,
  },

  // A drawer with heights to rest at stands at its tallest; its rests show part of it. Its height
  // is the footer's measure for staying in view at a lower rest (footerRests).
  tall: {
    height: `min(${sizes.drawerHeight}, var(--visual-viewport-height, 100dvh) - ${sizes.dialogGutter})`,
    containerType: "size",
    // UI SDK's --drawer-progress (the part of the panel that shows) is registered not to inherit:
    // the panel hands it on, resolved, to the footer under it.
    "--drawer-shown": "var(--drawer-progress, 1)",
    // What of the lifted footer would stand above the panel as it nearly closes stays inside it.
    overflow: "clip",
  },

  // The handle at the top: UI SDK's, a press steps it to its next height and the arrow keys move
  // it. The bar inside is a plain line, the size of a fingertip's aim.
  handle: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    width: sizes.controlLg,
    height: { default: space["6"], [media.pointerCoarse]: sizes.controlLg },
    marginBlockStart: space["1"],
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    backgroundColor: "transparent",
    cursor: { default: "grab", ":active": "grabbing" },
    touchAction: "none",
  },
  bar: {
    display: "block",
    width: sizes.drawerHandleWidth,
    height: sizes.drawerHandleHeight,
    borderRadius: radius.full,
    backgroundColor: {
      default: colors.drawerHandleBg,
      [FORCED]: "CanvasText",
    },
  },

  // The title and the sentence under it, close under the handle.
  header: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    rowGap: space["2"],
    paddingBlockStart: space["2"],
    paddingInline: space["6"],
  },
  stack: {
    display: "grid",
    rowGap: space["4"],
  },

  // The actions: at the end of the line, the main one last. On a phone a Button in it takes an
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
    paddingBlockEnd: `max(${space["6"]}, env(safe-area-inset-bottom))`,
  },
  // In a drawer with heights to rest at, the actions stay in view at a lower rest: lifted by what
  // of the panel is below the window (UI SDK's --drawer-progress is the part that shows), on the
  // panel's own ground over the body, a hairline above them while the body runs on under them.
  // With no body to grow, the actions go to the panel's foot, where the lift above expects them;
  // under the description they would leave an empty band beneath them.
  footerRests: {
    position: "relative",
    zIndex: 1,
    marginBlockStart: {
      default: `calc(${space["6"]} - ${space["4"]})`,
      [stylex.when.ancestor(
        ':not(:has([data-slot="drawer-body"]))',
        drawerMarker
      )]: "auto",
    },
    paddingBlockStart: space["4"],
    backgroundColor: colors.card,
    transform: "translateY(calc((var(--drawer-shown, 1) - 1) * 100cqh))",
    boxShadow: {
      default: "none",
      [stylex.when.ancestor(lowerRest, drawerMarker)]: lineAbove,
    },
    // At a lower rest the body does not scroll (the actions are lifted over it), so its own fade
    // never shows and a row cut at the hairline would read as underlined. The fade stands just
    // above the actions instead, on their ground, while they are lifted.
    "::before": {
      content: {
        default: "none",
        [stylex.when.ancestor(lowerRest, drawerMarker)]: '""',
      },
      position: "absolute",
      insetInline: 0,
      insetBlockEnd: "100%",
      height: FADE,
      pointerEvents: "none",
      backgroundImage: `linear-gradient(to bottom, transparent, ${colors.card})`,
    },
  },
});

// ---- The parts -----------------------------------------------------------------------------------

/** Every prop a DrawerContent takes: these, and the rest of UI SDK's DrawerContent. */
export interface DrawerContentProps extends Omit<
  ContentPrimitiveProps,
  "children" | "className" | "style" | "render"
> {
  /** The header, the body and the footer, in that order. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/**
 * The panel, with the shade behind it and the handle at its top. With `snapPoints` the handle is a
 * button named by the I18nProvider's `drawer.handle` ("Resize"): a press steps the drawer to its
 * next height, and the arrow keys move it. With one height it only shows the panel can be dragged.
 */
export const DrawerContent = ({
  children,
  style,
  ...rest
}: DrawerContentProps) => {
  const { handle } = useI18n().drawer;
  const snaps = use(SnapsContext);
  return (
    <>
      <BackdropPrimitive
        render={<div data-slot="drawer-overlay" />}
        {...stylex.props(styles.overlay)}
      />
      <ContentPrimitive
        {...rest}
        {...stylex.props(
          drawerMarker,
          layerStyles.panel,
          styles.panel,
          snaps && styles.tall,
          style
        )}
      >
        {snaps ? (
          <HandlePrimitive
            aria-label={handle}
            {...stylex.props(styles.handle, focusRing)}
          >
            <span aria-hidden="true" {...stylex.props(styles.bar)} />
          </HandlePrimitive>
        ) : (
          // With one height there is nothing to step to: the handle only shows it can be dragged down.
          <div
            aria-hidden="true"
            data-slot="drawer-handle"
            {...stylex.props(styles.handle)}
          >
            <span {...stylex.props(styles.bar)} />
          </div>
        )}
        {children}
      </ContentPrimitive>
    </>
  );
};

/** What a drawer's own layout parts take. */
interface PartProps {
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a DrawerHeader takes. */
export interface DrawerHeaderProps extends PartProps {
  /** The title, and the description under it. */
  children: ReactNode;
}

/** The title and the description under it, close under the handle. */
export const DrawerHeader = ({ children, style }: DrawerHeaderProps) => (
  <div data-slot="drawer-header" {...stylex.props(styles.header, style)}>
    {children}
  </div>
);

/** Every prop a DrawerTitle takes. */
export interface DrawerTitleProps extends PartProps {
  /** What the drawer is for, in sentence case: it names it for a screen reader and an agent. */
  children: ReactNode;
  /**
   * Name the panel without drawing a title: the words stay for a screen reader, out of sight. For a
   * panel whose own content already heads it.
   * @default false
   */
  hidden?: boolean;
}

/** The title. It names the drawer. */
export const DrawerTitle = ({
  children,
  hidden = false,
  style,
}: DrawerTitleProps) => (
  <TitlePrimitive
    {...stylex.props(hidden ? visuallyHidden : layerStyles.title, style)}
  >
    {children}
  </TitlePrimitive>
);

/** Every prop a DrawerDescription takes. */
export interface DrawerDescriptionProps extends PartProps {
  /** One or two sentences on what happens, read with the title when it opens. */
  children: ReactNode;
}

/** The sentence under the title. It describes the drawer to a screen reader. */
export const DrawerDescription = ({
  children,
  style,
}: DrawerDescriptionProps) => (
  <DescriptionPrimitive {...stylex.props(layerStyles.description, style)}>
    {children}
  </DescriptionPrimitive>
);

/** Every prop a DrawerBody takes. */
export interface DrawerBodyProps extends PartProps {
  /** The task: fields, a list, words, one under another. */
  children: ReactNode;
}

/**
 * What the drawer is about: the one part that scrolls, so the title and the actions stay put. When
 * it holds more than it shows, it takes focus and is named by the title, so the keys can scroll it
 * too; when everything fits it is not a stop at all.
 */
export const DrawerBody = ({ children, style }: DrawerBodyProps) => {
  const body = useLayerBody("dialog", keepBodyPut);
  return (
    <div
      {...body}
      data-slot="drawer-body"
      {...stylex.props(
        layerStyles.body,
        scrollbarHidden,
        focusRingInset,
        style
      )}
    >
      <div {...stylex.props(styles.stack)}>{children}</div>
    </div>
  );
};

/** Every prop a DrawerFooter takes. */
export interface DrawerFooterProps extends PartProps {
  /** The actions, the main one last: Cancel, then Save. */
  children: ReactNode;
}

/** The actions, at the end of the line. At a lower rest they stay in view. */
export const DrawerFooter = ({ children, style }: DrawerFooterProps) => {
  const snaps = use(SnapsContext);
  return (
    <div
      data-slot="drawer-footer"
      {...stylex.props(
        layerFooterMarker,
        styles.footer,
        snaps && styles.footerRests,
        style
      )}
    >
      {children}
    </div>
  );
};

/** Every prop a DrawerClose takes: these, and the rest of UI SDK's DrawerClose. */
export interface DrawerCloseProps
  extends
    Omit<ClosePrimitiveProps, "render" | "children" | "className" | "style">,
    WrapperProps {
  /**
   * The look of the Button it draws, without `asChild`: `outline` for Cancel beside the main
   * action; `default` when closing is the step the drawer is for.
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
 * Closes the drawer, and focus goes back to what opened it. On its own it draws an outline Button
 * with its words (`<DrawerClose>Cancel</DrawerClose>`); with `asChild` it hands its behaviour to the
 * element inside.
 */
export const DrawerClose = ({
  asChild,
  children,
  variant = "outline",
  size = "sm",
  style,
  ...rest
}: DrawerCloseProps) =>
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
