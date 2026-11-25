// Select: choose one value from a list that opens below its control,
// in StyleX, built on UI SDK's
// Select: closed, it is an Input (the same fill, hairline, heights and corner), so a select and a
// field stand level in one form; open, it is a popup on the raised ground.
//
//   <Field>
//     <FieldLabel>Role</FieldLabel>
//     <Select items={["Viewer", "Editor", "Admin"]}>
//       <SelectTrigger><SelectValue placeholder="Choose a role" /></SelectTrigger>
//       <SelectContent />
//     </Select>
//   </Field>
//
// A SelectContent with no children draws the root's `items`; with children, it holds SelectItem,
// SelectGroup, SelectLabel and SelectSeparator. The items as data are known before the list has
// ever opened: on the server, to an agent, and to typing on the closed control.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Select as SelectPrimitive,
  SelectContent as ContentPrimitive,
  SelectGroup as GroupPrimitive,
  SelectGroupLabel,
  SelectItem as ItemPrimitive,
  SelectItemIndicator,
  SelectSeparator as SeparatorPrimitive,
  SelectTrigger as TriggerPrimitive,
  SelectValue as ValuePrimitive,
} from "@ui-sdk/react/select";
import type {
  ListData,
  ListItem,
  SelectItemState,
  SelectTriggerState,
  SelectValueChangeReason,
  SelectValueState,
} from "@ui-sdk/react/select";
import { createContext, use, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { CheckIcon, ChevronDownIcon, Icon } from "../lib/icons";
import {
  focusField,
  focusRing,
  hyphenate,
  inputStyles,
  scrollbarHidden,
  tapTarget,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
// UI SDK places a popup in pixels: popup-gap and popup-gutter, as the generator writes them.
import { popup } from "../lib/tokens.values";
import { className, isInvalid, warnUnnamed } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { selectPopupMarker } from "./select.stylex";

const SCROLLS = "@supports (animation-timeline: scroll())";

// The fade at the foot of a list that goes on: there while there is more below, gone at the end.
const more = stylex.keyframes({
  "0%, 94%": { opacity: 1 },
  "100%": { opacity: 0 },
});

// And at its head, once rows lie above: gone at the top.
const moreAbove = stylex.keyframes({
  "0%": { opacity: 0 },
  "6%, 100%": { opacity: 1 },
});

// A row the list's foot cuts dims as it comes in, and only that row: a row in view whole is never
// greyed. A filter, so an option out of use keeps its own opacity.
const cut = stylex.keyframes({
  "0%": { filter: "opacity(0.2)" },
  "100%": { filter: "opacity(1)" },
});
// The same for a row the list's head cuts, as it goes out under it.
const cutAbove = stylex.keyframes({
  "0%": { filter: "opacity(1)" },
  "100%": { filter: "opacity(0.2)" },
});

/** The closed control's height: Input's and Button's. */
export type SelectSize = "sm" | "default" | "lg";

/** How the closed control reads: a field's box, or words with a small chevron. */
export type SelectVariant = "default" | "ghost";

/**
 * The items: plain strings, `{ value, label }` (with an optional `description`, a quiet line under
 * the item's words in the list), groups `{ type: "group", label, items }` and separators
 * `{ type: "separator" }`.
 */
export type SelectItems = ListData;

// Every prop is documented once, here; the props on the docs page are read from these interfaces.

/** Every prop a Select takes. */
export interface SelectProps {
  /** The parts: a SelectTrigger with its SelectValue, and a SelectContent. */
  children: ReactNode;
  /**
   * What can be chosen, as data: strings (each is its own value and label), `{ value, label,
   * disabled }`, groups and separators. A SelectContent with no children draws them. With hand-written
   * SelectItems, still pass them: the trigger then knows a value's words before the list has opened.
   */
  items?: SelectItems;
  /** The value chosen at first. A form reset returns here. Leave it out to start with nothing. */
  defaultValue?: string | null;
  /** The value, when you keep it in state. `null` is nothing chosen. Pair it with `onValueChange`. */
  value?: string | null;
  /**
   * Called with the new value and why it changed: a choice in the list, typing on the closed
   * control, a form reset, or code and agents. `details.source` is `"agent"` when an agent chose,
   * and `details.cancel()` keeps the value as it was.
   */
  onValueChange?: (
    value: string | null,
    details: ChangeDetails<SelectValueChangeReason>
  ) => void;
  /** The name the value is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /**
   * Needs a value before the form is sent. Inside a Field, its label shows the required mark.
   * @default false
   */
  required?: boolean;
  /**
   * Shows its value and is sent with the form, but does not open. Drawn on a quieter fill.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Out of use: not focusable, not sent, half strength. Say why near it. Prefer `readOnly` for a
   * value someone may still want to see.
   * @default false
   */
  disabled?: boolean;
  /** The `id` of a form it belongs to, when it stands outside that form. */
  form?: string;
  /** A hint for the browser's autofill, like `"country"`. */
  autoComplete?: string;
}

/** Every prop a SelectTrigger takes: the closed control. */
export interface SelectTriggerProps {
  /** What it shows: a SelectValue. The chevron is drawn for you. */
  children?: ReactNode;
  /**
   * The height, the same as Input's and Button's: `sm` 32px, `default` 36px, `lg` 44px. On a touch
   * screen every size has a 44px target, and every item in the list is 44px tall.
   * @default "default"
   */
  size?: SelectSize;
  /**
   * How the closed control reads. `default` is a field's box, for a form. `ghost` is its words and
   * a small chevron with no box, at a ghost button's height and with its hover, for a choice inside
   * a sentence or a row ("Can use" beside a person in a share list). Same keys, list and items.
   * @default "default"
   */
  variant?: SelectVariant;
  /** Its name when no FieldLabel names it, as a screen reader and an agent say it ("Sort by"). */
  "aria-label"?: string;
  /** The `id` of the control, for a Label outside a Field (`htmlFor`). */
  id?: string;
  /** The `id` of the words that describe it, when no FieldDescription does. */
  "aria-describedby"?: string;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the select. */
  style?: LayoutStyle;
  /**
   * Squeezed, the chosen value stays on one line and ends in an ellipsis; the list shows it whole.
   * Without it, a long value wraps.
   * @default false
   */
  truncate?: boolean;
}

/** Every prop a SelectValue takes: the chosen value's words, or the placeholder. */
export interface SelectValueProps {
  /** What it says while nothing is chosen: a verb and the thing ("Choose a role"). */
  placeholder?: string;
}

/** Every prop a SelectContent takes: the list that opens below the trigger. */
export interface SelectContentProps {
  /** SelectItem, SelectGroup, SelectLabel and SelectSeparator. Leave it out to draw the root's `items`. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a SelectItem takes: one choice in the list. */
export interface SelectItemProps {
  /** What the value becomes when this item is chosen. */
  value: string;
  /** Its words, as the list shows them. */
  children?: ReactNode;
  /** The words the trigger shows and typing finds, when `children` is not plain text. */
  label?: string;
  /**
   * One quiet line under its words in the list, saying what choosing it means. The trigger shows
   * the words alone.
   */
  description?: string;
  /**
   * Cannot be chosen: the keyboard and the pointer skip it.
   * @default false
   */
  disabled?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a SelectGroup takes: a run of items under one SelectLabel. */
export interface SelectGroupProps {
  /** A SelectLabel, then its SelectItems. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a SelectLabel takes: a group's name, small and quiet, above its items. */
export interface SelectLabelProps {
  /** The group's name ("Europe"). */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a SelectSeparator takes. */
export interface SelectSeparatorProps {
  /** Layout only. */
  style?: LayoutStyle;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const REDUCED = media.reducedMotion;

const styles = stylex.create({
  // Closed: Input's box (inputStyles.control, with its words at a field's size: a trigger takes no
  // typing, but beside an Input it reads as one of a row of fields), words at the start and the
  // chevron at the end.
  trigger: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: space[2],
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`,
      ":focus-visible": size.inputFocus,
    },
    cursor: "pointer",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    paddingInlineStart: space[3],
    paddingInlineEnd: space[2],
    // Focus is the edge itself (field-focus, as in Input: a step darker and a faint halo, no ring),
    // with focusField (lib/styles) for forced colours.
  },
  // Open: the hairline stays at its hover strength while the list is out.
  open: {
    boxShadow: `inset 0 0 0 1px ${colors.inputBorderHover}, ${shadow.inputShadow}`,
  },
  // Settled, as Input's: the quieter read-only words, no lift. Disabled is the weaker look.
  readOnly: {
    backgroundColor: colors.inputBgRead,
    color: colors.inputForegroundRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}`,
      ":focus-visible": size.inputFocusRead,
    },
    cursor: "default",
  },

  // Ghost: the words and a small chevron, no box: as wide as its words, a ghost button's hover and
  // press, and the ring of every control for the keyboard. A wrong one keeps its danger edge.
  ghost: {
    width: "auto",
    maxWidth: "100%",
    gap: space[1],
    paddingInlineStart: space[2],
    paddingInlineEnd: space[1],
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
      ":active": colors.accentActive,
    },
    boxShadow: "none",
  },
  // Open: the press's fill stays while the list is out, as a held ghost button's.
  ghostOpen: { backgroundColor: colors.accentActive },
  // Read-only or out of use: no fill under a pointer.
  ghostStill: { backgroundColor: "transparent" },

  // The chosen item's words, or the placeholder. A long label wraps; it is never cut off.
  value: {
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  // truncate: one line, ending in an ellipsis; never hyphenated or broken inside a word.
  valueCut: {
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflowWrap: "normal",
    hyphens: "manual",
  },
  placeholder: {
    color: colors.mutedForeground,
  },
  // The chevron turns over while the list is open.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.mutedForeground,
    transitionProperty: "transform",
    // Turning back is as fast as the list leaving.
    transitionDuration: motionVars.leave,
    transitionTimingFunction: duration.ease,
  },
  chevronOpen: {
    transform: "rotate(0.5turn)",
    transitionDuration: motionVars.popup,
  },

  // Open: the popup, as wide as its control at least, scrolling past popup-height or the room
  // the window has. It grows from its control and shrinks back into it, faster.
  content: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    boxSizing: "border-box",
    minWidth: "var(--anchor-width)",
    maxWidth: `min(${size.popupWidth}, var(--available-width))`,
    maxHeight: `min(${size.popupHeight}, var(--available-height))`,
    overflowY: "auto",
    overscrollBehavior: "contain",
    // What the list scrolls into view as it opens (the chosen row) stands whole inside its padding
    // and above the fade at its foot, never sliced by the popup's edge.
    scrollPaddingBlockStart: space.popupPadding,
    scrollPaddingBlockEnd: `calc(${space.popupPadding} + ${space[8]})`,
    margin: 0,
    padding: space.popupPadding,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.popover,
    boxShadow: shadow.popupShadow,
    color: colors.foreground,
    fontFamily: font.sans,
    // A panel that opens inside its trigger's parent (it is not portalled) would take that parent's
    // text: an end-aligned table cell would line its words up on the right. It sets its own, and
    // keeps only the direction, which follows the page.
    textAlign: "start",
    whiteSpace: "normal",
    fontWeight: "normal",
    fontStyle: "normal",
    textTransform: "none",
    letterSpacing: "normal",
    wordSpacing: "normal",
    textIndent: 0,
    fontSize: {
      default: font.textSm,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textSmLine,
    outline: "none",
    transformOrigin: "var(--transform-origin)",
    opacity: {
      default: 1,
      ":is([data-starting-style], [data-ending-style])": 0,
    },
    transform: {
      default: "none",
      ":is([data-starting-style], [data-ending-style])": {
        default: `scale(${size.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: "opacity, transform",
    // Under reduced motion it is simply there, and simply gone.
    transitionDuration: {
      default: motionVars.popup,
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },

  // A row while the list's foot or head cuts it: dimmed by how much of it is hidden, clear once
  // whole (the head too: the list opens at its choice, rows above unseen).
  cut: {
    animationName: {
      default: null,
      [SCROLLS]: {
        default: `${cut}, ${cutAbove}`,
        [stylex.when.ancestor("[data-ending-style]", selectPopupMarker)]:
          "none",
        [stylex.when.ancestor("[data-closed]", selectPopupMarker)]: "none",
      },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "none" },
    animationTimeline: {
      default: null,
      [SCROLLS]: "view(block 0px), view(block 0px)",
    },
    animationRange: {
      default: null,
      [SCROLLS]: "entry 0% entry 100%, exit 0% exit 100%",
    },
  },
  // At the list's head, over its start padding, while rows lie above: the foot's fade, turned.
  moreAbove: {
    display: "block",
    position: "sticky",
    zIndex: 1,
    insetBlockStart: `calc(-1 * ${space.popupPadding})`,
    height: space.popupPadding,
    marginBlockEnd: `calc(-1 * ${space.popupPadding})`,
    marginInline: `calc(-1 * ${space.popupPadding})`,
    backgroundImage: {
      default: `linear-gradient(to top, transparent, ${colors.popover})`,
      [FORCED]: "none",
    },
    opacity: 0,
    pointerEvents: "none",
    animationName: {
      default: null,
      [SCROLLS]: {
        default: moreAbove,
        [stylex.when.ancestor("[data-ending-style]", selectPopupMarker)]:
          "none",
        [stylex.when.ancestor("[data-closed]", selectPopupMarker)]: "none",
      },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "both" },
    animationTimeline: { default: null, [SCROLLS]: "scroll(nearest)" },
  },

  // A list that goes on says so: a fade at its foot, over the last rows, while there is more below
  // (the list's own scroll drives it; a list that fits draws none). Placed after the items, it takes
  // no room. Never while the popup leaves: a scroll-driven animation does not end, and the close
  // waits for its animations to end.
  more: {
    display: "block",
    position: "sticky",
    insetBlockEnd: `calc(-1 * ${space.popupPadding})`,
    // Over the end padding only, so it never lies on a row in view whole; a row the foot cuts dims
    // itself (cut). A band over the rows would grey a whole last option.
    height: space.popupPadding,
    marginBlockStart: `calc(-1 * ${space.popupPadding})`,
    marginInline: `calc(-1 * ${space.popupPadding})`,
    // No end margin: one pulled the popup's end padding under the last row, so a list that fits
    // overflowed by that padding and its fade lay on the last live row.
    backgroundImage: {
      default: `linear-gradient(to bottom, transparent, ${colors.popover})`,
      [FORCED]: "none",
    },
    opacity: 0,
    pointerEvents: "none",
    animationName: {
      default: null,
      [SCROLLS]: {
        default: more,
        [stylex.when.ancestor("[data-ending-style]", selectPopupMarker)]:
          "none",
        [stylex.when.ancestor("[data-closed]", selectPopupMarker)]: "none",
      },
    },
    animationDuration: { default: null, [SCROLLS]: "auto" },
    animationTimingFunction: { default: null, [SCROLLS]: "linear" },
    animationFillMode: { default: null, [SCROLLS]: "both" },
    animationTimeline: { default: null, [SCROLLS]: "scroll(nearest)" },
  },

  // An item: its words, and the tick at the end when it is the chosen one. Its corner nests inside
  // the popup's, capped at half its height. Its words start where the control's value does: the
  // popup's padding and the item's together are the control's own (as in Combobox). A word breaks
  // only where it may, never hyphenated.
  item: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    minHeight: { default: size.controlDefault, [COARSE]: size.tapTarget },
    boxSizing: "border-box",
    paddingBlock: space[2],
    paddingInline: `calc(${space[3]} - ${space.popupPadding})`,
    borderRadius: `min(${radius.lg}, calc(${size.controlDefault} / 2))`,
    cornerShape: radius.shape,
    color: colors.foreground,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  // In forced colours a fill is dropped, so the highlight is the system's own there, drawn by the
  // item itself: left to the browser, a backplate in the page's colour hides its words.
  itemHighlighted: {
    forcedColorAdjust: { default: null, [FORCED]: "none" },
    backgroundColor: {
      default: colors.accentHighlight,
      [FORCED]: "Highlight",
    },
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
  },
  // Out of use: half strength, no highlight. In forced colours, the system's unavailable text.
  itemDisabled: {
    opacity: size.opacityDisabled,
    color: { default: colors.foreground, [FORCED]: "GrayText" },
    cursor: "not-allowed",
  },
  itemWords: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  // An item's line under its words: what choosing it means, quiet, and allowed to wrap.
  itemDescription: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    // In forced colours it takes its row's colour, the highlighted row's too.
    color: { default: colors.mutedForeground, [FORCED]: "inherit" },
    whiteSpace: "normal",
  },
  tick: {
    display: "inline-flex",
    flexShrink: 0,
    // In forced colours it takes its row's colour, the highlighted row's too.
    color: { default: colors.foreground, [FORCED]: "inherit" },
  },
  // A group's name: small and quiet, above its items.
  groupLabel: {
    paddingInline: `calc(${space[3]} - ${space.popupPadding})`,
    paddingTop: space[2],
    paddingBottom: space[1],
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
  },
  separator: {
    height: 1,
    marginBlock: space[1],
    marginInline: `calc(${space[3]} - ${space.popupPadding})`,
    backgroundColor: { default: colors.border, [FORCED]: "CanvasText" },
  },
});

// As the list opens, the chosen row stands in its middle, whole and clear of the fade at its foot:
// the list's own scroll is set, so the page never moves. A frame on, once the rows are laid out.
const centreChosen = (list: HTMLDivElement | null) => {
  const frame = requestAnimationFrame(() => {
    if (list === null) {
      return;
    }
    const row = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (row === null) {
      return;
    }
    const offset =
      row.getBoundingClientRect().top -
      list.getBoundingClientRect().top +
      list.scrollTop;
    list.scrollTop = Math.max(
      0,
      offset - (list.clientHeight - row.offsetHeight) / 2
    );
  });
  return () => {
    cancelAnimationFrame(frame);
  };
};

const sizeStyles = {
  sm: inputStyles.sm,
  default: inputStyles.default,
  lg: inputStyles.lg,
} as const;
/** A variant's own look over the field's, for the trigger's state, and its focus. */
const variantLook = (variant: SelectVariant, state: SelectTriggerState) =>
  variant === "ghost"
    ? [
        styles.ghost,
        state.open && styles.ghostOpen,
        (state.disabled || state.readOnly) && styles.ghostStill,
      ]
    : [];
const variantFocus = { default: focusField.default, ghost: focusRing } as const;

/** An item's quiet line, when the data gives one (`{ value, label, description }`). */
const descriptionOf = (item: ListItem) =>
  "description" in item && typeof item.description === "string"
    ? item.description
    : undefined;

const asItem = (entry: ListItem | string): ListItem =>
  typeof entry === "string" ? { value: entry, label: entry } : entry;

// The root's `items`, for a SelectContent with no children of its own.
const ItemsContext = createContext<SelectItems | undefined>(undefined);
// Whether the trigger keeps its value on one line, for the SelectValue inside it.
const Truncated = createContext(false);

/** The closed control: a field's box (or words, for `variant="ghost"`) with the chevron at its end. */
export const SelectTrigger = ({
  children,
  size: scale = "default",
  variant = "default",
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  id,
  style,
  truncate = false,
}: SelectTriggerProps) => {
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    warnUnnamed("Select", trigger.current);
  }, []);

  return (
    <TriggerPrimitive
      ref={trigger}
      id={id}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      render={(props: Record<string, unknown>, state: SelectTriggerState) => (
        <button
          type="button"
          {...props}
          // Without truncate a long value wraps by design, so a second line is no fault.
          data-may-wrap={truncate ? undefined : ""}
          {...stylex.props(
            inputStyles.control,
            styles.trigger,
            sizeStyles[scale],
            !(state.disabled || state.readOnly) && inputStyles.enabled,
            state.open && styles.open,
            state.readOnly && styles.readOnly,
            state.disabled && inputStyles.disabled,
            variantLook(variant, state),
            isInvalid(props["aria-invalid"]) && inputStyles.invalid,
            variantFocus[variant],
            style
          )}
        />
      )}
    >
      {(state: SelectTriggerState) => (
        <>
          <span aria-hidden="true" {...stylex.props(tapTarget)} />
          <Truncated value={truncate}>{children}</Truncated>
          <span
            aria-hidden="true"
            {...stylex.props(styles.chevron, state.open && styles.chevronOpen)}
          >
            <Icon icon={ChevronDownIcon} />
          </span>
        </>
      )}
    </TriggerPrimitive>
  );
};

/** The chosen value's words, or the placeholder while nothing is chosen. */
export const SelectValue = ({ placeholder }: SelectValueProps) => {
  const truncate = use(Truncated);
  return (
    <ValuePrimitive
      placeholder={placeholder}
      className={(value: SelectValueState) =>
        className(
          styles.value,
          hyphenate,
          truncate && styles.valueCut,
          value.placeholder && styles.placeholder
        )
      }
    />
  );
};

/** One choice: its words, and the tick at the end when it is the chosen one. */
export const SelectItem = ({
  value,
  children,
  label,
  description,
  disabled,
  style,
}: SelectItemProps) => (
  <ItemPrimitive
    value={value}
    // With a line under it, the trigger and typing take the words alone, not the line too.
    label={
      label ??
      (description !== undefined && typeof children === "string"
        ? children
        : undefined)
    }
    disabled={disabled}
    className={(state: SelectItemState) =>
      className(
        styles.item,
        styles.cut,
        state.highlighted && styles.itemHighlighted,
        state.disabled && styles.itemDisabled,
        style
      )
    }
  >
    <span {...stylex.props(styles.itemWords)}>
      {children}
      {description !== undefined && description !== "" && (
        <span {...stylex.props(styles.itemDescription)}>{description}</span>
      )}
    </span>
    <SelectItemIndicator {...stylex.props(styles.tick)}>
      <Icon icon={CheckIcon} />
    </SelectItemIndicator>
  </ItemPrimitive>
);

/** A run of items, named by the SelectLabel at its head. */
export const SelectGroup = ({ children, style }: SelectGroupProps) => (
  <GroupPrimitive {...stylex.props(style)}>{children}</GroupPrimitive>
);

/** A group's name: small and quiet, above its items. */
export const SelectLabel = ({ children, style }: SelectLabelProps) => (
  <SelectGroupLabel {...stylex.props(styles.groupLabel, styles.cut, style)}>
    {children}
  </SelectGroupLabel>
);

/** A line that sets the items after it apart. */
export const SelectSeparator = ({ style }: SelectSeparatorProps) => (
  <SeparatorPrimitive {...stylex.props(styles.separator, style)} />
);

/** The items as parts, in the order they are given: items, groups with their names, separators. */
const Options = ({ items }: { items: SelectItems }) =>
  items.map((entry, index) => {
    if (
      typeof entry !== "string" &&
      "type" in entry &&
      entry.type === "separator"
    ) {
      // A separator has no value; its place in the list is its key.
      return <SelectSeparator key={`separator-${index}`} />;
    }
    if (
      typeof entry !== "string" &&
      "type" in entry &&
      entry.type === "group"
    ) {
      return (
        <SelectGroup key={`group-${index}`}>
          {entry.label !== undefined && entry.label !== "" && (
            <SelectLabel>{entry.label}</SelectLabel>
          )}
          {entry.items.map((inner) => {
            const item = asItem(inner);
            return (
              <SelectItem
                key={item.value}
                value={item.value}
                description={descriptionOf(item)}
                disabled={item.disabled}
              >
                {item.label}
              </SelectItem>
            );
          })}
        </SelectGroup>
      );
    }
    const item = asItem(entry);
    return (
      <SelectItem
        key={item.value}
        value={item.value}
        description={descriptionOf(item)}
        disabled={item.disabled}
      >
        {item.label}
      </SelectItem>
    );
  });

/** The list that opens below the trigger, on the raised ground. With no children, it draws the root's `items`. */
export const SelectContent = ({ children, style }: SelectContentProps) => {
  const items = use(ItemsContext);
  return (
    <ContentPrimitive
      ref={centreChosen}
      sideOffset={popup.gap}
      collisionPadding={popup.gutter}
      {...stylex.props(
        selectPopupMarker,
        styles.content,
        scrollbarHidden,
        style
      )}
    >
      <span aria-hidden="true" {...stylex.props(styles.moreAbove)} />
      {children ?? (items === undefined ? null : <Options items={items} />)}
      <span aria-hidden="true" {...stylex.props(styles.more)} />
    </ContentPrimitive>
  );
};

/** Choose one value from a list. Holds the value; its parts draw the control and the list. */
export const Select = ({ children, items, ...options }: SelectProps) => (
  // Read-only shows its value and does not open: the list it would show is all choices that
  // cannot be chosen.
  <SelectPrimitive
    items={items}
    {...options}
    {...(options.readOnly === true ? { open: false } : {})}
  >
    <ItemsContext value={items}>{children}</ItemsContext>
  </SelectPrimitive>
);
