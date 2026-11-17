// Select: choose one value from a list that opens below its control, from shadcn's
// (registry/bases/base/ui/select.tsx, on Base UI), converted from Tailwind to StyleX and rebuilt on
// UI SDK's Select, then made Grasp's: closed, it is an Input (the same fill, hairline, heights and
// corner), so a select and a field stand level in one form; open, it is a popup on the raised
// ground with the tokens Popover shares.
//
//   <Field>
//     <FieldLabel>Role</FieldLabel>
//     <Select items={["Viewer", "Editor", "Admin"]} placeholder="Choose a role" />
//   </Field>
//   <Select items={[{ value: "eu", label: "Europe" }, { value: "us", label: "United States" }]} />
//   <Select items={[...plans, { type: "separator" }, { type: "group", label: "Sales", items }]} />
//
// The items are data, so their labels are known before the list has ever opened: on the server,
// to an agent, and to typing on the closed control. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Select as SelectPrimitive,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectItemIndicator,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import type {
  ListData,
  ListItem,
  SelectItemState,
  SelectTriggerState,
  SelectValueChangeReason,
  SelectValueState,
} from "@ui-sdk/react/select";
import { useEffect, useRef } from "react";

import { focus } from "../focus/focus";
import { ChevronDown, Icon, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
// UI SDK places a popup in pixels: popup-gap and popup-gutter, as the generator writes them.
import { popup } from "../tokens/tokens.values";
import { selectPopupMarker } from "./select.stylex";

const SCROLLS = "@supports (animation-timeline: scroll())";

// The fade at the foot of a list that goes on: there while there is more below, gone at the end.
const more = stylex.keyframes({
  "0%, 94%": { opacity: 1 },
  "100%": { opacity: 0 },
});

// And at its head, once rows lie above (A3-choice-03): gone at the top.
const moreAbove = stylex.keyframes({
  "0%": { opacity: 0 },
  "6%, 100%": { opacity: 1 },
});

// A row the list's foot cuts dims as it comes in, and only that row: a row in view whole is never
// greyed (second look A2-select-01). A filter, so an option out of use keeps its own opacity.
const cut = stylex.keyframes({
  "0%": { filter: "opacity(0.2)" },
  "100%": { filter: "opacity(1)" },
});
// The same for a row the list's head cuts, as it goes out under it.
const cutAbove = stylex.keyframes({
  "0%": { filter: "opacity(1)" },
  "100%": { filter: "opacity(0.2)" },
});

export type SelectSize = "sm" | "md" | "lg";

/** How the closed control reads: a field's box, or words with a small chevron. */
export type SelectVariant = "field" | "text";

/** The items: plain strings, `{ value, label }`, groups `{ type: "group", label, items }` and separators `{ type: "separator" }`. */
export type SelectItems = ListData;

/** What a caller may style: where the select sits and how wide it is. Never its look or height. */
export type SelectLayoutStyle = LayoutStyle;

/** Every prop a Select takes. */
export interface SelectProps {
  /**
   * What can be chosen: strings (each is its own value and label), `{ value, label, disabled }`,
   * groups and separators. In the order they are read.
   */
  items: SelectItems;
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
  /** What it says while nothing is chosen: a verb and the thing ("Choose a role"). */
  placeholder?: string;
  /**
   * The height, the same as Input's and Button's: `sm` 32px, `md` 36px, `lg` 44px. On a touch
   * screen every size has a 44px target, and every item in the list is 44px tall.
   * @default "md"
   */
  size?: SelectSize;
  /**
   * How the closed control reads. `field` is a field's box, for a form. `text` is its words and a
   * small chevron with no box, at a ghost button's height and with its hover, for a choice inside a
   * sentence or a row ("Can use" beside a person in a share list). Same keys, list and items.
   * @default "field"
   */
  variant?: SelectVariant;
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
  /** Its name when no FieldLabel names it, as a screen reader and an agent say it ("Sort by"). */
  "aria-label"?: string;
  /** The `id` of a form it belongs to, when it stands outside that form. */
  form?: string;
  /** A hint for the browser's autofill, like `"country"`. */
  autoComplete?: string;
  /** The `id` of the control, for a Label outside a Field (`htmlFor`). */
  id?: string;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the select. */
  style?: SelectLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: SelectLayoutStyle;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;
const REDUCED = media.reduced;

const styles = stylex.create({
  // Closed: Input's box, words at the start and the chevron at the end.
  trigger: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    appearance: "none",
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.fieldFill,
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`,
      ":focus-visible": grasp.fieldFocus,
    },
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    // 16px on a phone or a touch screen (media.typing), as in an Input, so the two match in one form.
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
    textAlign: "start",
    cursor: "pointer",
    userSelect: "none",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    paddingInlineStart: grasp.space3,
    paddingInlineEnd: grasp.space2,
    // Focus is the edge itself (field-focus, as in Input) and focus.field (src/focus). A pointer
    // opens the list, so the edge lights for the keyboard only.
    transitionProperty: "box-shadow, background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  sm: {
    minHeight: grasp.controlSm,
    paddingBlock: `calc((${grasp.controlSm} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
  },
  md: {
    minHeight: grasp.controlMd,
    paddingBlock: `calc((${grasp.controlMd} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
  },
  // The chevron keeps one inset at every size, as the words do.
  lg: {
    minHeight: grasp.controlLg,
    paddingBlock: `calc((${grasp.controlLg} - ${grasp.textSmLine}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`,
  },
  // Can be opened: the hairline deepens under a pointer.
  live: {
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`,
      // Hover never covers the focus edge: the pointer often rests on a field while you type.
      ":hover:not(:focus-visible)": {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${grasp.fieldEdgeHover}, ${grasp.fieldLift}`,
      },
      ":focus-visible": grasp.fieldFocus,
    },
  },
  // Open: the hairline stays at its hover strength while the list is out.
  open: {
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdgeHover}, ${grasp.fieldLift}`,
  },
  // Settled, as Input's: the quieter read-only words, no lift. Disabled is the weaker look.
  readOnly: {
    backgroundColor: grasp.fieldFillRead,
    color: grasp.fieldInkRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}`,
      ":focus-visible": grasp.fieldFocus,
    },
    cursor: "default",
  },
  disabled: {
    opacity: grasp.dim,
    boxShadow: `inset 0 0 0 1px ${grasp.fieldEdge}`,
    cursor: "not-allowed",
  },
  invalid: {
    boxShadow: {
      default: grasp.fieldInvalid,
      ":focus-visible": grasp.fieldFocusInvalid,
    },
    // In forced colours the danger tint is dropped: a wrong field's edge turns dashed instead, the
    // same 1px, so it is no bigger than the fields beside it.
    borderStyle: { default: "solid", [FORCED]: "dashed" },
  },

  // A finger needs 44px: an invisible area inside the control reaches past its edges.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: 0,
  },
  targetSm: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlSm} - ${grasp.tap}) / 2)`,
    },
  },
  targetMd: {
    insetBlock: {
      default: 0,
      [COARSE]: `calc((${grasp.controlMd} - ${grasp.tap}) / 2)`,
    },
  },
  targetLg: { insetBlock: 0 },

  // Text: the words and a small chevron, no box: as wide as its words, a ghost button's hover and
  // press, and the ring of every control for the keyboard. A wrong one keeps its danger edge.
  text: {
    width: "auto",
    maxWidth: "100%",
    gap: grasp.space1,
    paddingInlineStart: grasp.space2,
    paddingInlineEnd: grasp.space1,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
    },
    boxShadow: "none",
  },
  // Open: the press's fill stays while the list is out, as a held ghost button's.
  textOpen: { backgroundColor: grasp.ghostFillPress },
  // Read-only or out of use: no fill under a pointer.
  textStill: { backgroundColor: "transparent" },

  // The chosen item's words, or the placeholder. A long label wraps; it is never cut off.
  value: {
    flexGrow: 1,
    minWidth: 0,
    overflowWrap: "anywhere",
    hyphens: "auto",
  },
  placeholder: {
    color: grasp.muted,
  },
  // The chevron turns over while the list is open.
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.muted,
    transitionProperty: "transform",
    // Turning back is as fast as the list leaving.
    transitionDuration: simply.leave,
    transitionTimingFunction: grasp.ease,
  },
  chevronOpen: {
    transform: "rotate(0.5turn)",
    transitionDuration: simply.popup,
  },

  // Open: the popup, as wide as its control at least, scrolling past popup-height or the room
  // the window has. It grows from its control and shrinks back into it, faster.
  content: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    boxSizing: "border-box",
    minWidth: "var(--anchor-width)",
    maxWidth: `min(${grasp.popupWidth}, var(--available-width))`,
    maxHeight: `min(${grasp.popupHeight}, var(--available-height))`,
    overflowY: "auto",
    overscrollBehavior: "contain",
    // What the list scrolls into view as it opens (the chosen row) stands whole inside its padding
    // and above the fade at its foot, never sliced by the popup's edge.
    scrollPaddingBlockStart: grasp.popupPadding,
    scrollPaddingBlockEnd: `calc(${grasp.popupPadding} + ${grasp.space8})`,
    margin: 0,
    padding: grasp.popupPadding,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.popupLift,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    outline: "none",
    transformOrigin: "var(--transform-origin)",
    opacity: {
      default: 1,
      ":is([data-starting-style], [data-ending-style])": 0,
    },
    transform: {
      default: "none",
      ":is([data-starting-style], [data-ending-style])": {
        default: `scale(${grasp.popupFromScale})`,
        [REDUCED]: "none",
      },
    },
    transitionProperty: "opacity, transform",
    // Under reduced motion it is simply there, and simply gone.
    transitionDuration: {
      default: simply.popup,
      ":is([data-ending-style])": simply.leave,
    },
    transitionTimingFunction: grasp.ease,
  },

  // A row while the list's foot or head cuts it: dimmed by how much of it is hidden, clear once
  // whole (the head too, A3-choice-03: the list opens at its choice, rows above unseen).
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
    insetBlockStart: `calc(-1 * ${grasp.popupPadding})`,
    height: grasp.popupPadding,
    marginBlockEnd: `calc(-1 * ${grasp.popupPadding})`,
    marginInline: `calc(-1 * ${grasp.popupPadding})`,
    backgroundImage: {
      default: `linear-gradient(to top, transparent, ${grasp.popupFill})`,
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
    insetBlockEnd: `calc(-1 * ${grasp.popupPadding})`,
    // Over the end padding only, so it never lies on a row in view whole; a row the foot cuts dims
    // itself (cut). The padding's band was 32px over the rows and greyed a whole last option
    // (second look A2-select-01).
    height: grasp.popupPadding,
    marginBlockStart: `calc(-1 * ${grasp.popupPadding})`,
    marginInline: `calc(-1 * ${grasp.popupPadding})`,
    // No end margin: one pulled the popup's end padding under the last row, so a list that fits
    // overflowed by that padding and its fade lay on the last live row (A2-select-01).
    backgroundImage: {
      default: `linear-gradient(to bottom, transparent, ${grasp.popupFill})`,
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
    gap: grasp.space2,
    minHeight: { default: grasp.controlMd, [COARSE]: grasp.tap },
    boxSizing: "border-box",
    paddingBlock: grasp.space2,
    paddingInline: `calc(${grasp.space3} - ${grasp.popupPadding})`,
    borderRadius: `min(calc(${grasp.corner} - ${grasp.popupPadding}), calc(${grasp.controlMd} / 2))`,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    cursor: "pointer",
    userSelect: "none",
    outline: "none",
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  // In forced colours a fill is dropped, so the highlight is the system's own there.
  itemHighlighted: {
    backgroundColor: {
      default: grasp.itemFillHighlight,
      [FORCED]: "Highlight",
    },
    color: { default: grasp.ink, [FORCED]: "HighlightText" },
  },
  // Out of use: half strength, no highlight. In forced colours, the system's unavailable text.
  itemDisabled: {
    opacity: grasp.dim,
    color: { default: grasp.ink, [FORCED]: "GrayText" },
    cursor: "not-allowed",
  },
  itemWords: {
    flexGrow: 1,
    minWidth: 0,
  },
  tick: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.ink,
  },
  // A group's name: small and quiet, above its items.
  groupLabel: {
    paddingInline: `calc(${grasp.space3} - ${grasp.popupPadding})`,
    paddingTop: grasp.space2,
    paddingBottom: grasp.space1,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  separator: {
    height: 1,
    marginBlock: grasp.space1,
    marginInline: `calc(${grasp.space3} - ${grasp.popupPadding})`,
    backgroundColor: { default: grasp.line, [FORCED]: "CanvasText" },
  },
});

/** The popup and its items, shared with parts that open the same list (Filter builder's segments). */
export const selectPopupStyles = styles;

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

const sizeStyles = { sm: styles.sm, md: styles.md, lg: styles.lg } as const;
const targetStyles = {
  sm: styles.targetSm,
  md: styles.targetMd,
  lg: styles.targetLg,
} as const;

/** A variant's own look over the field's, for the trigger's state, and its focus. */
const variantLook = (variant: SelectVariant, state: SelectTriggerState) =>
  variant === "text"
    ? [
        styles.text,
        state.open && styles.textOpen,
        (state.disabled || state.readOnly) && styles.textStill,
      ]
    : [];
const variantFocus = { field: focus.field, text: focus.ring } as const;

const isInvalid = (value: unknown) => value === true || value === "true";

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

const asItem = (entry: ListItem | string): ListItem =>
  typeof entry === "string" ? { value: entry, label: entry } : entry;

const Option = ({ item }: { item: ListItem }) => (
  <SelectItem
    value={item.value}
    disabled={item.disabled}
    className={(state: SelectItemState) =>
      className(
        styles.item,
        styles.cut,
        state.highlighted && styles.itemHighlighted,
        state.disabled && styles.itemDisabled
      )
    }
  >
    <span {...stylex.props(styles.itemWords)}>{item.label}</span>
    <SelectItemIndicator {...stylex.props(styles.tick)}>
      <Icon icon={Tick} />
    </SelectItemIndicator>
  </SelectItem>
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
      return (
        <SelectSeparator
          key={`separator-${index}`}
          {...stylex.props(styles.separator)}
        />
      );
    }
    if (
      typeof entry !== "string" &&
      "type" in entry &&
      entry.type === "group"
    ) {
      return (
        <SelectGroup key={`group-${index}`}>
          {entry.label !== undefined && entry.label !== "" && (
            <SelectGroupLabel {...stylex.props(styles.groupLabel, styles.cut)}>
              {entry.label}
            </SelectGroupLabel>
          )}
          {entry.items.map((inner) => {
            const item = asItem(inner);
            return <Option key={item.value} item={item} />;
          })}
        </SelectGroup>
      );
    }
    const item = asItem(entry);
    return <Option key={item.value} item={item} />;
  });

export const Select = ({
  items,
  size = "md",
  variant = "field",
  style: styleProp,
  layout,
  "aria-label": ariaLabel,
  id,
  ...options
}: SelectProps) => {
  // In development, say so when nothing names it: no Field label, no aria-label.
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const control = trigger.current;
    if (!(import.meta.env?.DEV && control)) {
      return;
    }
    const named =
      Boolean(control.getAttribute("aria-label")?.trim()) ||
      Boolean(control.getAttribute("aria-labelledby")) ||
      (control.labels?.length ?? 0) > 0;
    if (!named) {
      console.error(
        "Select: nothing names it. Put it in a Field with a FieldLabel, or give it an aria-label."
      );
    }
  }, []);

  return (
    // Read-only shows its value and does not open (its promise above): the list it would show is
    // all choices that cannot be chosen.
    <SelectPrimitive
      items={items}
      {...options}
      {...(options.readOnly === true ? { open: false } : {})}
    >
      <SelectTrigger
        ref={trigger}
        id={id}
        aria-label={ariaLabel}
        render={(props: Record<string, unknown>, state: SelectTriggerState) => (
          <button
            type="button"
            {...props}
            {...stylex.props(
              styles.trigger,
              sizeStyles[size],
              !(state.disabled || state.readOnly) && styles.live,
              state.open && styles.open,
              state.readOnly && styles.readOnly,
              state.disabled && styles.disabled,
              variantLook(variant, state),
              isInvalid(props["aria-invalid"]) && styles.invalid,
              variantFocus[variant],
              layout ?? styleProp
            )}
          />
        )}
      >
        {(state: SelectTriggerState) => (
          <>
            <span
              aria-hidden="true"
              {...stylex.props(styles.target, targetStyles[size])}
            />
            <SelectValue
              className={(value: SelectValueState) =>
                className(styles.value, value.placeholder && styles.placeholder)
              }
            />
            <span
              aria-hidden="true"
              {...stylex.props(
                styles.chevron,
                state.open && styles.chevronOpen
              )}
            >
              <Icon icon={ChevronDown} />
            </span>
          </>
        )}
      </SelectTrigger>
      <SelectContent
        ref={centreChosen}
        sideOffset={popup.gap}
        collisionPadding={popup.gutter}
        {...stylex.props(selectPopupMarker, styles.content, scroll.bar)}
      >
        <span aria-hidden="true" {...stylex.props(styles.moreAbove)} />
        <Options items={items} />
        <span aria-hidden="true" {...stylex.props(styles.more)} />
      </SelectContent>
    </SelectPrimitive>
  );
};
