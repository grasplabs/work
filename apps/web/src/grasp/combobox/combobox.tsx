// Combobox: type to find one value in a list, from shadcn's (registry/bases/base/ui/combobox.tsx,
// on Base UI), converted from Tailwind to StyleX and rebuilt on UI SDK's Combobox, then made
// Grasp's: closed, it is an Input (the same fill, hairline, heights and corner) with a chevron at
// the end; open, it is the popup Select shares, and the letters that matched are a step heavier.
//
//   <Field>
//     <FieldLabel>Country</FieldLabel>
//     <Combobox items={countries} placeholder="Search countries" />
//   </Field>
//   <Combobox items={[{ type: "group", label: "Europe", items }]} empty="No city has that name" />
//
// The items are data, so filtering, the keyboard and an agent know every one, and the chosen
// label is known on the server. The value is always an item's; the text is only a search. Every
// value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Combobox as ComboboxPrimitive,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxItemText,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@ui-sdk/react/combobox";
import type {
  ComboboxInputState,
  ComboboxItemState,
  ComboboxItemTextState,
  ComboboxTriggerState,
  ComboboxValueChangeReason,
  ListData,
  ListItem,
} from "@ui-sdk/react/combobox";
import { useEffect, useRef } from "react";

import { focus } from "../focus/focus";
import { ChevronDown, Icon, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import {
  inputStyles,
  isInvalid,
  sizeStyles,
  targetStyles,
} from "../input/input";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
// UI SDK places a popup in pixels: popup-gap and popup-gutter, as the generator writes them.
import { popup } from "../tokens/tokens.values";
import { useWords, withGiven } from "../words/words";
import { listStyles } from "./list.styles";
import { listMarker } from "./list.stylex";
import { comboboxNotices, comboboxWords } from "./words";

export type ComboboxSize = "sm" | "md" | "lg";

/**
 * The items: plain strings, `{ value, label, keywords, disabled }`, groups
 * `{ type: "group", label, items }` and separators `{ type: "separator" }`.
 */
export type ComboboxItems = ListData;

/** What a caller may style: where the combobox sits and how wide it is. Never its look or height. */
export type ComboboxLayoutStyle = LayoutStyle;

/** Every prop a Combobox takes. */
export interface ComboboxProps {
  /**
   * What can be chosen: strings (each is its own value and label), `{ value, label, keywords,
   * disabled }`, groups and separators. `keywords` are other words that find an item ("Holland").
   */
  items: ComboboxItems;
  /** The value chosen at first. A form reset returns here. Leave it out to start with nothing. */
  defaultValue?: string | null;
  /** The value, when you keep it in state. `null` is nothing chosen. Pair it with `onValueChange`. */
  value?: string | null;
  /**
   * Called with the new value and why it changed: a choice in the list, emptied text, a form reset,
   * or code and agents. `details.source` is `"agent"` when an agent chose, and `details.cancel()`
   * keeps the value as it was.
   */
  onValueChange?: (
    value: string | null,
    details: ChangeDetails<ComboboxValueChangeReason>
  ) => void;
  /** What it says while it is empty: a verb and the thing ("Search countries"). */
  placeholder?: string;
  /**
   * What the list says when nothing matches the words typed.
   * @default "No results"
   */
  empty?: string;
  /** The name of the button that opens the list. @default "Show the choices" */
  triggerLabel?: string;
  /**
   * The height, the same as Input's and Button's: `sm` 32px, `md` 36px, `lg` 44px. On a touch
   * screen every size has a 44px target, and every item in the list is 44px tall.
   * @default "md"
   */
  size?: ComboboxSize;
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
   * Out of use: not focusable, not sent, half strength. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** Its name when no FieldLabel names it, as a screen reader and an agent say it ("Country"). */
  "aria-label"?: string;
  /** The `id` of a form it belongs to, when it stands outside that form. */
  form?: string;
  /** The `id` of the input, for a Label outside a Field (`htmlFor`). */
  id?: string;
  /** @deprecated Use `layout`. */
  style?: ComboboxLayoutStyle;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the combobox. */
  layout?: ComboboxLayoutStyle;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const COARSE = media.coarse;

const styles = stylex.create({
  // An option reads as Select's does: the field's 14px on a 36px row, regular weight (A2-combobox-02).
  option: {
    fontWeight: grasp.weightRegular,
  },
  // The words stop before the chevron.
  // A field is one line already; a value too long for it ends in an ellipsis at rest (a browser
  // shows the ellipsis only while the field is not being typed in), not clipped mid-letter.
  inputEnd: {
    paddingInlineEnd: `calc(${grasp.space2} + ${grasp.iconSm} + ${grasp.space2})`,
    textOverflow: "ellipsis",
  },
  // The chevron at the end opens the list for a pointer. The keyboard opens it from the input, so
  // the chevron stays out of the Tab order.
  trigger: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: 0,
    insetInlineEnd: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    // One inset at every size, as Select's chevron and the words keep (A3-choice-07: lg stood 4px in).
    width: `calc(${grasp.space2} * 2 + ${grasp.iconSm})`,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: {
      default: grasp.muted,
      ":hover": { default: null, [HOVER]: grasp.ink },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    // Out of the Tab order: the field is where the keyboard is, and shows it.
    outline: "none",
    transitionProperty: "color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // On a touch screen the chevron's press area is 44px tall and wide, unseen.
  triggerTarget: {
    position: "absolute",
    insetBlock: {
      default: 0,
      [COARSE]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
    insetInline: {
      default: 0,
      [COARSE]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
    },
  },
  triggerOff: {
    cursor: "default",
    pointerEvents: "none",
  },
  // The chevron turns over while the list is open; back as fast as the list leaves.
  chevron: {
    display: "inline-flex",
    transitionProperty: "transform",
    transitionDuration: simply.leave,
    transitionTimingFunction: grasp.ease,
  },
  chevronOpen: {
    transform: "rotate(0.5turn)",
    transitionDuration: simply.popup,
  },
  // Open, the list is at least as wide as the control.
  content: {
    minWidth: "var(--anchor-width)",
  },
});

const className = (...parts: (stylex.StyleXStyles | false)[]) =>
  stylex.props(...parts).className;

const asItem = (entry: ListItem | string): ListItem =>
  typeof entry === "string" ? { value: entry, label: entry } : entry;

/** Every value in the items, groups included. */
const valuesOf = (items: ComboboxItems): Set<string> => {
  const values = new Set<string>();
  for (const entry of items) {
    if (typeof entry === "string") {
      values.add(entry);
    } else if ("type" in entry && entry.type === "group") {
      for (const inner of entry.items) {
        values.add(asItem(inner).value);
      }
    } else if (!("type" in entry && entry.type === "separator")) {
      values.add(entry.value);
    }
  }
  return values;
};

/** An item's words, with the letters the typed words matched a step heavier. */
const Words = () => (
  <ComboboxItemText {...stylex.props(listStyles.itemWords)}>
    {(state: ComboboxItemTextState) =>
      state.segments.map((segment, index) =>
        segment.match ? (
          // A match has no id of its own; its place in the label is its key.
          <mark key={index} {...stylex.props(listStyles.mark)}>
            {segment.text}
          </mark>
        ) : (
          segment.text
        )
      )
    }
  </ComboboxItemText>
);

const Option = ({ item }: { item: ListItem }) => (
  <ComboboxItem
    value={item.value}
    label={item.label}
    keywords={item.keywords}
    disabled={item.disabled}
    className={(state: ComboboxItemState) =>
      className(
        listStyles.item,
        listStyles.menuItem,
        styles.option,
        listStyles.cut,
        state.highlighted && listStyles.itemHighlighted,
        state.disabled && listStyles.itemDisabled
      )
    }
  >
    <Words />
    <ComboboxItemIndicator {...stylex.props(listStyles.tick)}>
      <Icon icon={Tick} />
    </ComboboxItemIndicator>
  </ComboboxItem>
);

/** The items that match, as parts: items, groups with their names, separators. */
const Options = ({ items }: { items: ListData<unknown> }) =>
  // SAFETY: the list hands back the items the combobox was given, which are ComboboxItems.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  (items as ComboboxItems).map((entry, index) => {
    if (
      typeof entry !== "string" &&
      "type" in entry &&
      entry.type === "separator"
    ) {
      // A separator has no value; its place in the list is its key.
      return (
        <ComboboxSeparator
          key={`separator-${index}`}
          {...stylex.props(listStyles.separator)}
        />
      );
    }
    if (
      typeof entry !== "string" &&
      "type" in entry &&
      entry.type === "group"
    ) {
      return (
        <ComboboxGroup key={`group-${entry.label ?? index}`}>
          {entry.label !== undefined && entry.label !== "" && (
            <ComboboxGroupLabel
              {...stylex.props(listStyles.groupLabel, listStyles.cut)}
            >
              {entry.label}
            </ComboboxGroupLabel>
          )}
          {entry.items.map((inner) => {
            const item = asItem(inner);
            return <Option key={item.value} item={item} />;
          })}
        </ComboboxGroup>
      );
    }
    const item = asItem(entry);
    return <Option key={item.value} item={item} />;
  });

export const Combobox = ({
  items,
  size = "md",
  empty: emptyGiven,
  triggerLabel: triggerLabelGiven,
  placeholder,
  style: styleProp,
  layout,
  "aria-label": ariaLabel,
  id,
  onValueChange,
  ...options
}: ComboboxProps) => {
  const { empty, trigger: triggerLabel } = withGiven(
    useWords("combobox", comboboxWords),
    { empty: emptyGiven, trigger: triggerLabelGiven }
  );
  // The value is always an item's: a value from outside the list (an agent's, or code's) is refused,
  // so whoever set it hears that it failed.
  const known = valuesOf(items);
  const change = (
    next: string | null,
    details: ChangeDetails<ComboboxValueChangeReason>
  ) => {
    if (next !== null && !known.has(next)) {
      details.cancel();
      // An agent hears why, in words.
      if (details.source === "agent") {
        throw new Error(comboboxNotices.notChoice(next));
      }
      return;
    }
    onValueChange?.(next, details);
  };
  // In development, say so when nothing names it: no Field label, no aria-label.
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const control = input.current;
    if (!(import.meta.env?.DEV && control)) {
      return;
    }
    const named =
      Boolean(control.getAttribute("aria-label")?.trim()) ||
      Boolean(control.getAttribute("aria-labelledby")) ||
      (control.labels?.length ?? 0) > 0;
    if (!named) {
      console.error(
        "Combobox: nothing names it. Put it in a Field with a FieldLabel, or give it an aria-label."
      );
    }
  }, []);

  // A starting value from outside the list is a mistake in the code: say so in development.
  useEffect(() => {
    if (!import.meta.env?.DEV) {
      return;
    }
    for (const start of [options.value, options.defaultValue]) {
      if (start !== null && start !== undefined && !known.has(start)) {
        console.error(comboboxNotices.notItem(start));
      }
    }
  }, [known, options.value, options.defaultValue]);

  return (
    <ComboboxPrimitive
      items={items}
      autoHighlight="always"
      {...options}
      onValueChange={change}
    >
      {/* The group that holds the field and its touch target, as Input's InputGroup does. */}
      <div
        data-slot="input-group"
        {...stylex.props(inputStyles.box, layout ?? styleProp)}
      >
        <span
          aria-hidden="true"
          {...stylex.props(inputStyles.target, targetStyles[size])}
        />
        <ComboboxInput
          ref={input}
          id={id}
          aria-label={ariaLabel}
          placeholder={placeholder}
          render={(
            props: Record<string, unknown>,
            state: ComboboxInputState
          ) => (
            <input
              {...props}
              {...stylex.props(
                inputStyles.input,
                sizeStyles[size],
                styles.inputEnd,
                !(state.disabled || state.readOnly) && inputStyles.live,
                state.readOnly && inputStyles.readOnly,
                state.disabled && inputStyles.disabled,
                isInvalid(props["aria-invalid"]) && inputStyles.invalid,
                focus.field
              )}
            />
          )}
        />
        <ComboboxTrigger
          aria-label={triggerLabel}
          className={(state: ComboboxTriggerState) =>
            className(
              styles.trigger,
              (state.disabled || state.readOnly) && styles.triggerOff
            )
          }
        >
          {(state: ComboboxTriggerState) => (
            <>
              <span
                aria-hidden="true"
                {...stylex.props(styles.triggerTarget)}
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
        </ComboboxTrigger>
      </div>
      <ComboboxContent
        sideOffset={popup.gap}
        collisionPadding={popup.gutter}
        {...stylex.props(
          listMarker,
          listStyles.popup,
          styles.content,
          scroll.bar
        )}
      >
        <ComboboxEmpty {...stylex.props(listStyles.empty)}>
          {empty}
        </ComboboxEmpty>
        <ComboboxList>
          {(state: { items: ListData<unknown> }) => (
            <Options items={state.items} />
          )}
        </ComboboxList>
        <span aria-hidden="true" {...stylex.props(listStyles.more)} />
      </ComboboxContent>
    </ComboboxPrimitive>
  );
};
