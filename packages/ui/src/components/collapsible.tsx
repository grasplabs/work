// Collapsible: one panel that opens and closes under its trigger, in StyleX,
// built on UI SDK's Collapsible: a full-width trigger with a chevron at
// its end, and quiet words under it that open over 200ms.
//
//   <Collapsible>
//     <CollapsibleTrigger>Advanced settings</CollapsibleTrigger>
//     <CollapsibleContent>Only change these with the owner.</CollapsibleContent>
//   </Collapsible>
//
// The trigger is a button whose `aria-expanded` says whether the panel is open; Enter and Space open
// and close it. The panel stays readable by the browser's find in page while closed, and shows open
// without script. UI SDK names the root's and the trigger's data-slot; the panel's is set here.
// Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Collapsible as CollapsiblePrimitive,
  CollapsiblePanel,
  CollapsibleTrigger as CollapsibleTriggerPrimitive,
} from "@ui-sdk/react/collapsible";
import type { CollapsibleState } from "@ui-sdk/react/collapsible";
import { createContext, use } from "react";
import type { ReactNode } from "react";

import { ChevronDownIcon, Icon } from "../lib/icons";
import { disclosureStyles, focusRing, tapTarget } from "../lib/styles";
import { colors, font, media, shadow, size, space } from "../lib/tokens.stylex";
import { className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";

/** Every prop a Collapsible takes. */
export interface CollapsibleProps {
  /** Its CollapsibleTrigger, then its CollapsibleContent. With `asChild`, the one element drawn as it, holding them. */
  children: ReactNode;
  /**
   * Draws its one child element as the Collapsible, with its behaviour and none of its layout: for
   * a part that opens the same way inside a layout of its own (a row of a list).
   * @default false
   */
  asChild?: boolean;
  /** Whether it is open. Pass it with `onOpenChange` to control it. */
  open?: boolean;
  /**
   * Whether it starts open, when you do not control it.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs with the new state when the trigger is pressed. */
  onOpenChange?: (open: boolean) => void;
  /**
   * The trigger does nothing; it stays focusable.
   * @default false
   */
  disabled?: boolean;
  /**
   * `default` lies on the page; `outline` stands off it, as a quiet button.
   * @default "default"
   */
  variant?: "default" | "outline";
  /**
   * The trigger is only as wide as its words and its chevron, which then stands beside them: for
   * one quiet line among words. Without it the trigger runs the whole width, chevron at the end.
   * @default false
   */
  fitContent?: boolean;
  /** Where it sits and how wide it is. */
  style?: LayoutStyle;
}

/** Every prop a CollapsibleTrigger takes. */
export interface CollapsibleTriggerProps {
  /** The words on the trigger: what opens ("Advanced settings"). With `asChild`, the one element drawn as the trigger. */
  children: ReactNode;
  /**
   * Draws its one child element as the trigger, with the trigger's behaviour and none of its look
   * or chevron.
   * @default false
   */
  asChild?: boolean;
  /**
   * The size of its words, as Text's: `sm` among controls and dense rows; `default` or `lg` where
   * it stands in running words of that size, so a page keeps one body size.
   * @default "sm"
   */
  size?: "sm" | "default" | "lg";
  /**
   * The weight of its words, as Text's: `medium` as a control's; `normal` where it reads as a line
   * of the page's own words, its chevron alone saying that it opens.
   * @default "medium"
   */
  weight?: "normal" | "medium";
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

/** Every prop a CollapsibleContent takes. */
export interface CollapsibleContentProps {
  /** What the panel holds. With `asChild`, the one element drawn as the panel, holding it. */
  children: ReactNode;
  /**
   * Draws its one child element as the panel, with the panel's opening and none of its look (the
   * small quiet words, the room above and below): for a part whose content keeps its own type.
   * Give that element no padding of its own, which would show while it is closed.
   * @default false
   */
  asChild?: boolean;
  /** Layout only: where it sits and how much room it takes. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const OFF = ":is([data-disabled])";

const styles = stylex.create({
  root: {
    display: "grid",
    width: "100%",
    minWidth: 0,
    fontFamily: font.sans,
  },
  outline: {
    backgroundColor: {
      default: colors.control,
      ":hover": {
        default: null,
        [HOVER]: { default: colors.controlHover, [OFF]: colors.muted },
      },
      ":active": { default: colors.controlActive, [OFF]: colors.muted },
      [OFF]: colors.muted,
    },
    boxShadow: { default: shadow.sm, [OFF]: "none" },
  },
  // Only as wide as its words and chevron: at the start, the chevron a step after the words.
  // The trigger bleeds out of the root by its padding on each side, so its room is the root's
  // and that bleed: held to the root's width alone, a root as wide as its words (in a box that
  // shrinks to fit) left the trigger two paddings short, and its words wrapped.
  fit: {
    justifySelf: "start",
    maxWidth: `calc(100% + 2 * ${size.collapsiblePadding})`,
    columnGap: space["1"],
  },
  textDefault: { fontSize: font.textBase, lineHeight: font.textBaseLine },
  textLg: { fontSize: font.textLg, lineHeight: font.textLgLine },
  weightNormal: { fontWeight: font.weightNormal },
  fitWords: {
    flexGrow: 0,
  },
});

// The root's look, for its trigger: two plain values, so neither is a new object each render.
const VariantContext = createContext<"default" | "outline">("default");
const FitContentContext = createContext(false);

/** One panel that opens and closes under its trigger. */
export const Collapsible = ({
  children,
  asChild = false,
  open,
  defaultOpen,
  onOpenChange,
  disabled,
  variant = "default",
  fitContent = false,
  style,
}: CollapsibleProps) => (
  <VariantContext value={variant}>
    <FitContentContext value={fitContent}>
      <CollapsiblePrimitive
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        disabled={disabled}
        {...slotProps(asChild, children)}
        {...stylex.props(!asChild && styles.root, style)}
      />
    </FitContentContext>
  </VariantContext>
);

/** The button that opens and closes the panel: its words, and a chevron that turns. */
export const CollapsibleTrigger = ({
  children,
  asChild = false,
  size: textSize = "sm",
  weight = "medium",
  style,
}: CollapsibleTriggerProps) => {
  const variant = use(VariantContext);
  const fitContent = use(FitContentContext);
  if (asChild) {
    return (
      <CollapsibleTriggerPrimitive
        {...slotProps(asChild, children)}
        {...stylex.props(style)}
      />
    );
  }
  return (
    <CollapsibleTriggerPrimitive
      {...stylex.props(
        disclosureStyles.trigger,
        variant === "outline" ? styles.outline : disclosureStyles.ghost,
        fitContent && styles.fit,
        textSize === "default" && styles.textDefault,
        textSize === "lg" && styles.textLg,
        weight === "normal" && styles.weightNormal,
        style,
        focusRing
      )}
    >
      {(state: CollapsibleState) => (
        <>
          <span aria-hidden="true" {...stylex.props(tapTarget)} />
          <span
            {...stylex.props(
              disclosureStyles.words,
              fitContent && styles.fitWords
            )}
          >
            {children}
          </span>
          <span
            aria-hidden="true"
            {...stylex.props(
              disclosureStyles.chevron,
              state.open && disclosureStyles.chevronOpen
            )}
          >
            <Icon icon={ChevronDownIcon} />
          </span>
        </>
      )}
    </CollapsibleTriggerPrimitive>
  );
};

/** What opens under the trigger. The browser's find opens it when it holds the words found. */
export const CollapsibleContent = ({
  children,
  asChild = false,
  style,
}: CollapsibleContentProps) => {
  const slot = slotProps(asChild, children);
  return (
    // The class only: UI SDK writes the panel's measured height as its own inline style.
    // The slot is set on the element drawn: UI SDK keeps a part's own data-slot over a prop.
    // A head script may have shown or hidden it as the person left it before the page wakes
    // (Sidebar's `sidebarStateScript`), so waking does not report that `hidden` differs.
    <CollapsiblePanel
      render={
        slot.render ?? (
          <div data-slot="collapsible-content" suppressHydrationWarning />
        )
      }
      hiddenUntilFound
      className={className(
        disclosureStyles.panel,
        slot.render === undefined && disclosureStyles.quiet,
        style
      )}
    >
      {slot.render === undefined ? (
        <div {...stylex.props(disclosureStyles.body)}>{children}</div>
      ) : undefined}
    </CollapsiblePanel>
  );
};
