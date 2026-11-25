// Combobox: type to find one value in a list, in StyleX on UI SDK's Combobox: closed, it is an
// Input (the same fill, hairline, heights and corner) with a chevron at the end; open, it is the
// list popup Select shares, and the letters that matched are drawn in the text colour. An item can
// carry `media` (an avatar, a logo) and a `description` line under its words, as a person does; the
// chosen item's media stands at the field's start, and the field's own `media` while there is none.
// With `multiple` it takes several values, each a chip in the field (its media, its words, a button
// that takes it away), with no chevron.
//
//   <Field>
//     <FieldLabel>Country</FieldLabel>
//     <Combobox items={countries} placeholder="Search countries" />
//   </Field>
//   <Combobox items={[{ type: "group", label: "Europe", items }]}>
//     <ComboboxEmpty>No city has that name</ComboboxEmpty>
//   </Combobox>
//   <Combobox multiple items={people} placeholder="Add people" />
//   <Combobox
//     media={<Icon icon={UsersIcon} />}
//     items={[{ value: "amara", label: "Amara Okafor", description: "Operations", media: <Avatar … /> }]}
//   />
//
// The items are data, so filtering, the keyboard and an agent know every one, and the chosen
// label is known on the server. The value is always an item's; the text is only a search.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Combobox as ComboboxPrimitive,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty as EmptyPrimitive,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem as ItemPrimitive,
  ComboboxItemIcon,
  ComboboxItemIndicator,
  ComboboxItemText,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@ui-sdk/react/combobox";
import type {
  ComboboxInputState,
  ComboboxItemState,
  ComboboxItemTextState,
  ComboboxQueryChangeReason,
  ComboboxTriggerState,
  ComboboxValueChangeReason,
  ComboboxValueState,
  ListAnnouncement,
  ListData,
  ListItem,
} from "@ui-sdk/react/combobox";
import { isValidElement, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import { CheckIcon, ChevronDownIcon, Icon, XIcon } from "../lib/icons";
import { pressedJustNow, transformOriginFrom } from "../lib/layer";
import {
  focusField,
  inputStyles,
  listStyles,
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
import { className, isDevelopment, isInvalid, warnUnnamed } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, listMarker, motionVars } from "../lib/vars.stylex";
import { Avatar } from "./avatar";
import type { AvatarProps } from "./avatar";

/** The control's height: Input's and Button's. */
export type ComboboxSize = "sm" | "default" | "lg";

/** One item that can be chosen. */
export interface ComboboxItem {
  /** What the form sends and `onValueChange` hears: unique and lasting ("nl", a person's id). */
  value: string;
  /** Its words, in the list and in the field once chosen. Typing finds them. */
  label: string;
  /** Other words that find it ("Holland"). */
  keywords?: string[];
  /** Cannot be chosen: the keyboard skips it. */
  disabled?: boolean;
  /**
   * What stands before its words: an Avatar (`size="xs"`, `decorative`), a logo, an icon. A screen
   * reader skips it, as the words beside it say what it is.
   */
  media?: ReactNode;
  /**
   * A quieter line under its words: a person's role or email. Typing finds it too, and a screen
   * reader hears it after the words, not run into them.
   */
  description?: string;
}

/**
 * The items: plain strings, ComboboxItems, groups `{ type: "group", label, items }` and separators
 * `{ type: "separator" }`.
 */
export type ComboboxItems = ListData<string, ComboboxItem>;

// Every prop is documented once, here; the props on the docs page are read from ComboboxProps.

/** What a Combobox takes whether it holds one value or several. */
interface ComboboxBase {
  /**
   * What can be chosen: strings (each is its own value and label), `{ value, label, keywords,
   * disabled, media, description }`, groups and separators. `keywords` are other words that find an
   * item ("Holland").
   */
  items: ComboboxItems;
  /** A ComboboxEmpty, for the words the list says when nothing matches. Without one, the catalogue's. */
  children?: ReactNode;
  /** What it says while it is empty: a verb and the thing ("Search countries"). */
  placeholder?: string;
  /**
   * The height, the same as Input's and Button's: `sm` 32px, `default` 36px, `lg` 44px. On a touch
   * screen every size has a 44px target, and every item in the list is 44px tall.
   * @default "default"
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
  /** Marked wrong, as a Field with an error marks it: the destructive edge. */
  "aria-invalid"?: boolean | "true" | "false";
  /** Its name when no FieldLabel names it, as a screen reader and an agent say it ("Country"). */
  "aria-label"?: string;
  /** The `id` of a form it belongs to, when it stands outside that form. */
  form?: string;
  /** The `id` of the input, for a Label outside a Field (`htmlFor`). */
  id?: string;
  /** Layout only: margins, alignment and width. Colours, heights and corners belong to the combobox. */
  style?: LayoutStyle;
}

/**
 * One value: the field shows it, with a chevron at its end that opens the list.
 * @when one value
 */
interface ComboboxSingle extends ComboboxBase {
  /**
   * Several values, each a chip in the field (the chosen item's media, its words, a button that
   * takes it away), with no chevron: the list opens as you type or press the arrow keys. A chosen
   * item stays in the list, ticked; choosing it again takes it away.
   * @default false
   */
  multiple?: false;
  /**
   * What stands at the field's start while nothing is chosen, or the chosen item has no `media`: a
   * quiet icon. One value only. A chosen item's own `media` always stands there, with or without this, and steps
   * aside while the words typed are a search. Give it when the items have media, so the words keep
   * their place as a choice is made and cleared.
   */
  media?: ReactNode;
  /**
   * The name of the button at the field's end that opens the list, for a screen reader, a voice
   * command and an agent, when the catalogue's ("Show the choices") does not say what the list
   * holds ("Show the apps and workflows"). One value only: with several there is no such button.
   */
  triggerLabel?: string;
  /**
   * The value chosen at first, `null` for nothing; several, a list. A form reset returns here.
   * Leave it out to start with nothing.
   */
  defaultValue?: string | null;
  /**
   * The value, when you keep it in state: `null` is nothing chosen; several, a list. Pair it with
   * `onValueChange`.
   */
  value?: string | null;
  /**
   * Called with the new value (several: the list) and why it changed: a choice in the list, emptied
   * text, a form reset, or code and agents. `details.source` is `"agent"` when an agent chose, and
   * `details.cancel()` keeps the value as it was.
   */
  onValueChange?: (
    value: string | null,
    details: ChangeDetails<ComboboxValueChangeReason>
  ) => void;
}

/**
 * Several values, each a chip in the field.
 * @when several values
 */
interface ComboboxMultiple extends ComboboxBase {
  multiple: true;
  defaultValue?: string[];
  value?: string[];
  onValueChange?: (
    value: string[],
    details: ChangeDetails<ComboboxValueChangeReason>
  ) => void;
}

/** Every prop a Combobox takes. */
export type ComboboxProps = ComboboxSingle | ComboboxMultiple;

/** Every prop a ComboboxEmpty takes. */
export interface ComboboxEmptyProps {
  /**
   * What the list says when nothing matches the words typed ("No city has that name").
   * @default "No results"
   */
  children?: ReactNode;
}

/** Every prop a ComboboxOptions takes. */
export interface ComboboxOptionsProps {
  /** The items the field was given: what each shows beside its words (media, a description). */
  items: ComboboxItems;
  /** A ComboboxEmpty, for the words the list says when nothing matches. Without one, the catalogue's. */
  children?: ReactNode;
}

// ---- The look --------------------------------------------------------------------------------------

const HOVER = media.hover;
const FORCED = media.forcedColors;
// Focus from the keys, never after a press (lib/styles marks a pointer's focus).
const KEYBOARD = ":focus-visible:not([data-focus-pointer])";
// Where the words can be painted through a gradient, a long value fades at its end (below).
// Not in Firefox: it passes the test, but a form control's words are not clipped there, so the
// gradient filled the whole box and every value drew as a dark bar. There a long value is cut by
// the box's edge as it scrolls.
const CLIP_TEXT =
  "@supports (background-clip: text) and (not (-moz-appearance: none))";
const FADE_END = `linear-gradient(to right, currentColor calc(100% - ${space[5]}), transparent), linear-gradient(transparent, transparent)`;
const FADE_END_RTL = `linear-gradient(to left, currentColor calc(100% - ${space[5]}), transparent), linear-gradient(transparent, transparent)`;

const styles = stylex.create({
  // The box holds the input, its touch target and the chevron. It is as wide as its column. The
  // chevron stands on the input's end: its touch target stops at its own edge towards it.
  box: {
    "--tap-room-inline": "0px",
    position: "relative",
    display: "flex",
    alignItems: "stretch",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    maxWidth: "100%",
  },
  // The input: Input's own look (the same fill, hairline, words and fade of a long value).
  input: {
    // Above its touch target, so a press on the words puts the caret where it lands.
    position: "relative",
    flexGrow: 1,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    appearance: "none",
    // No border: the edge is a hairline drawn inside, which adds no size. In forced colours the
    // shadow is dropped, so a real one appears there.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    backgroundColor: colors.inputBg,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`,
      ":focus-visible": size.inputFocus,
    },
    color: colors.foreground,
    caretColor: colors.foreground,
    fontFamily: font.sans,
    // 16px on a phone or a touch screen (media.maxSmOrCoarse), or Safari zooms the page in when the field takes focus.
    fontSize: {
      default: font.textSm,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
    letterSpacing: "normal",
    textAlign: "start",
    // A placeholder too long for the field ends in an ellipsis, never mid-word: Chromium reads the
    // input's own text-overflow for its placeholder, so it is set while the placeholder shows.
    // A typed value fades instead (below).
    textOverflow: { default: "clip", ":placeholder-shown": "ellipsis" },
    paddingInline: space[3],
    // A value longer than the field fades out at its end, as Tabs and Code block do, never a cut
    // through a letter. The words are painted through a gradient (clipped to the text) that ends in
    // transparent over the last space-5 of the content box; a short value never reaches it. While
    // the field has focus the words are plain ink, so the caret's end of the value always shows.
    // The second, empty layer keeps the field's fill on its whole box.
    // Input draws it only while the value is longer than the field (fits, below).
    WebkitTextFillColor: {
      default: null,
      [CLIP_TEXT]: {
        default: "transparent",
        ":focus": "currentColor",
        [FORCED]: "currentColor",
      },
    },
    // In forced colours the background is dropped, so the words keep their own colour there.
    backgroundImage: {
      default: null,
      [CLIP_TEXT]: { default: FADE_END, ":dir(rtl)": FADE_END_RTL },
    },
    backgroundOrigin: {
      default: null,
      [CLIP_TEXT]: "content-box, padding-box",
    },
    backgroundClip: { default: null, [CLIP_TEXT]: "text, padding-box" },
    // One tile: words past the content box (in the end padding) take no paint, so stay unseen.
    backgroundRepeat: { default: null, [CLIP_TEXT]: "no-repeat" },
    // Focus is the edge itself (field-focus, in live and invalid below: a step darker and a faint
    // halo, no ring), with focusField (lib/styles) for forced colours.
    transitionProperty: "box-shadow, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
    // One look for clearing a field in the library: Input group's own clear button
    // (InputGroupClear). A search field here shows no cross of the browser's; Escape still
    // empties it where the browser does that.
    // display: none, not appearance: none: WebKit draws its own cross with appearance none too.
    "::-webkit-search-cancel-button": { display: "none" },
    // A time field in one look in every engine: Chromium's clock button goes (Firefox and Safari
    // draw none on a computer); its parts sit on the field's own line.
    "::-webkit-calendar-picker-indicator": { display: "none" },
    "::-webkit-datetime-edit": { padding: 0 },
    // Selected words in our own tone (field-selection), never the browser's blue.
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    "::placeholder": {
      color: colors.mutedForeground,
      // Its own colour, not the transparent fill the value's fade sets on the input.
      WebkitTextFillColor: colors.mutedForeground,
      opacity: 1,
      // A hint too long for the field ends in an ellipsis, never mid-word.
      textOverflow: "ellipsis",
    },
  },
  // Can be read and copied, not changed: Input's settled look, its words a step quieter.
  readOnly: {
    backgroundColor: colors.inputBgRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}`,
      [KEYBOARD]: size.inputFocusRead,
    },
    color: colors.inputForegroundRead,
    caretColor: "transparent",
    cursor: "default",
  },
  // An option reads as Select's does: the field's 14px on a 36px row, regular weight.
  option: {
    fontWeight: font.weightNormal,
  },
  // With media at its start (the element before it), the words begin after it.
  inputStart: {
    paddingInlineStart: {
      default: space[3],
      [stylex.when.siblingBefore(":not(:empty)")]:
        `calc(${space[3]} + ${size.avatarXs} + ${space[2]})`,
    },
  },
  // The field's media: the chosen item's, or the quiet icon, as wide as an xs Avatar. A press on it
  // lands on the field under it; out of use, it is at half strength with the field.
  start: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: 0,
    insetInlineStart: space[3],
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: size.avatarXs,
    color: colors.mutedForeground,
    opacity: {
      default: 1,
      [stylex.when.siblingAfter(":disabled")]: size.opacityDisabled,
    },
    pointerEvents: "none",
  },
  // An item with a description: the list's own row, its words over the quieter line.
  described: { paddingBlock: space[1] },
  media: { display: "flex", flexShrink: 0 },
  words: { display: "grid", minWidth: 0, flexGrow: 1 },
  description: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    // In forced colours it takes the highlighted row's own colour.
    color: { default: colors.mutedForeground, [FORCED]: "inherit" },
    overflowWrap: "anywhere",
  },
  // The words stop before the chevron. A field is one line already; a value too long for it ends
  // in an ellipsis at rest (a browser shows the ellipsis only while the field is not being typed
  // in), not clipped mid-letter.
  inputEnd: {
    paddingInlineEnd: `calc(${space[2]} + ${size.iconSm} + ${space[2]})`,
    textOverflow: "ellipsis",
  },
  // The chevron at the end opens the list for a pointer. The keyboard opens it from the input, so
  // the chevron stays out of the Tab order.
  trigger: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "absolute",
    zIndex: 1,
    insetBlock: 0,
    insetInlineEnd: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    // One inset at every size, as Select's chevron and the words keep.
    width: `calc(${space[2]} * 2 + ${size.iconSm})`,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
    // Out of the Tab order: the field is where the keyboard is, and shows it.
    outline: "none",
    transitionProperty: "color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  triggerOff: {
    cursor: "default",
    pointerEvents: "none",
  },
  // The chevron turns over while the list is open; back as fast as the list leaves.
  chevron: {
    display: "inline-flex",
    transitionProperty: "transform",
    transitionDuration: motionVars.leave,
    transitionTimingFunction: duration.ease,
  },
  chevronOpen: {
    transform: "rotate(0.5turn)",
    transitionDuration: motionVars.popup,
  },
  // Open, the list is at least as wide as the control.
  content: {
    minWidth: "var(--anchor-width)",
  },
  // Several values: the chips and the typing in one box with the field's own fill, edge and focus,
  // the system's corner, growing a line as the chips wrap. No chevron: the list opens as you type.
  chips: {
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[1],
    // Each chip's × reaches the middle of the gap to its neighbours, beside it and on the next line.
    "--tap-room-inline": `calc(${space[1]} / 2)`,
    "--tap-room-block": `calc(${space[1]} / 2)`,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    paddingInline: space[1],
    // In forced colours a real edge, as the field's.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.inputBg,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`,
      ":focus-within": size.inputFocus,
      ":has(input[aria-invalid=true])": {
        default: size.inputInvalid,
        ":focus-within": size.inputFocusInvalid,
      },
      ":has(input:disabled)": `inset 0 0 0 1px ${colors.input}`,
    },
    opacity: { default: 1, ":has(input:disabled)": size.opacityDisabled },
    cursor: { default: "text", ":has(input:disabled)": "not-allowed" },
    transitionProperty: "box-shadow",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // One line's height at each size, a chip centred in it.
  chipsSm: {
    minHeight: size.controlSm,
    paddingBlock: `calc((${size.controlSm} - ${size.controlXs}) / 2)`,
  },
  chipsDefault: {
    minHeight: size.controlDefault,
    paddingBlock: `calc((${size.controlDefault} - ${size.controlXs}) / 2)`,
  },
  chipsLg: {
    minHeight: size.controlLg,
    paddingBlock: `calc((${size.controlLg} - ${size.controlXs}) / 2)`,
  },
  // The typing after the chips: a chip's height, on the box's fill.
  chipsInput: {
    flexGrow: 1,
    flexBasis: "8rem",
    minWidth: 0,
    height: size.controlXs,
    margin: 0,
    paddingBlock: 0,
    paddingInline: space[2],
    appearance: "none",
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.foreground,
    caretColor: colors.foreground,
    fontFamily: font.sans,
    fontSize: {
      default: font.textSm,
      [media.maxSmOrCoarse]: size.inputTextTouch,
    },
    lineHeight: font.textSmLine,
    cursor: { default: "text", ":disabled": "not-allowed" },
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    "::placeholder": {
      color: colors.mutedForeground,
      opacity: 1,
      textOverflow: "ellipsis",
    },
  },
  // A chosen value: a pill (the plain full radius, never the squircle) with the item's media, its
  // words and the button that takes it away; the arrow keys reach it, with the ring round it.
  chip: {
    [iconVars.size]: size.badgeIcon,
    display: "inline-flex",
    alignItems: "center",
    gap: space[1],
    maxWidth: "100%",
    minWidth: 0,
    height: size.controlXs,
    boxSizing: "border-box",
    paddingInlineStart: space[1],
    borderRadius: radius.full,
    cornerShape: "round",
    backgroundColor: colors.muted,
    boxShadow: size.borderStrong,
    color: colors.foreground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    outline: {
      default: "none",
      [FORCED]: "1px solid CanvasText",
      ":focus-visible": `${size.ringWidth} solid ${colors.ring}`,
    },
  },
  // The item's media in a chip: a face as large as the words' line, an icon at a badge's size.
  chipMedia: {
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: size.avatar2xs,
    height: size.avatar2xs,
    color: colors.mutedForeground,
  },
  chipWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipRemove: {
    position: "relative",
    display: "inline-flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: size.controlXs,
    height: size.controlXs,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.circle,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
    },
    color: colors.mutedForeground,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    touchAction: "manipulation",
  },
});

const chipsSizeStyles = {
  sm: styles.chipsSm,
  default: styles.chipsDefault,
  lg: styles.chipsLg,
} as const;

const sizeStyles = {
  sm: inputStyles.sm,
  default: inputStyles.default,
  lg: inputStyles.lg,
} as const;
const asItem = (entry: ComboboxItem | string): ComboboxItem =>
  typeof entry === "string" ? { value: entry, label: entry } : entry;

/** Every item by its value, groups included. */
const byValueOf = (items: ComboboxItems): Map<string, ComboboxItem> => {
  const found = new Map<string, ComboboxItem>();
  for (const entry of items) {
    if (typeof entry !== "string" && "type" in entry) {
      for (const inner of entry.type === "group" ? entry.items : []) {
        found.set(asItem(inner).value, asItem(inner));
      }
    } else {
      found.set(asItem(entry).value, asItem(entry));
    }
  }
  return found;
};

const isDescribed = (
  item: ComboboxItem
): item is ComboboxItem & { description: string } =>
  item.description !== undefined && item.description !== "";

/** An item as the list searches it: its description is found too. What it shows stays with the combobox. */
const searched = (entry: ComboboxItem | string): ListItem | string =>
  typeof entry === "string"
    ? entry
    : {
        value: entry.value,
        label: entry.label,
        keywords: isDescribed(entry)
          ? [...(entry.keywords ?? []), entry.description]
          : entry.keywords,
        disabled: entry.disabled,
      };

/** The items as the list searches them. */
const searchedItems = (items: ComboboxItems): ListData =>
  items.map((entry) => {
    if (typeof entry !== "string" && "type" in entry) {
      return entry.type === "group"
        ? { ...entry, items: entry.items.map(searched) }
        : entry;
    }
    return searched(entry);
  });

/** An item's words, with the letters the typed words matched in the text colour. */
const Words = () => (
  <ComboboxItemText {...stylex.props(listStyles.itemText)}>
    {(state: ComboboxItemTextState) =>
      state.segments.map((segment, index) =>
        segment.match ? (
          // A match has no id of its own; its place in the label is its key.
          <mark key={index} {...stylex.props(listStyles.match)}>
            {segment.text}
          </mark>
        ) : (
          segment.text
        )
      )
    }
  </ComboboxItemText>
);

/** One item: its media, its words (over its description), the tick when chosen. */
const Option = ({ item, shown }: { item: ListItem; shown: ComboboxItem }) => {
  const lineId = useId();
  const described = isDescribed(shown);
  return (
    <ItemPrimitive
      value={item.value}
      label={item.label}
      keywords={item.keywords}
      disabled={item.disabled}
      // Named by its words; its description is read after them, not run into them.
      aria-label={described ? item.label : undefined}
      aria-describedby={described ? lineId : undefined}
      className={(state: ComboboxItemState) =>
        className(
          listStyles.item,
          !described && listStyles.menuItem,
          // An option reads as Select's does; one with a description keeps the list's own row.
          described ? styles.described : styles.option,
          listStyles.cut,
          state.highlighted && listStyles.itemHighlighted,
          state.disabled && listStyles.itemDisabled
        )
      }
    >
      {shown.media !== undefined && (
        <ComboboxItemIcon {...stylex.props(styles.media)}>
          {shown.media}
        </ComboboxItemIcon>
      )}
      {described ? (
        <span {...stylex.props(styles.words)}>
          <Words />
          <span id={lineId} {...stylex.props(styles.description)}>
            {shown.description}
          </span>
        </span>
      ) : (
        <Words />
      )}
      <ComboboxItemIndicator {...stylex.props(listStyles.check)}>
        <Icon icon={CheckIcon} />
      </ComboboxItemIndicator>
    </ItemPrimitive>
  );
};

/** The items that match, as parts: items, groups with their names, separators. */
const Options = ({
  items,
  byValue,
}: {
  items: ListData<unknown>;
  byValue: Map<string, ComboboxItem>;
}) => {
  const option = (entry: ListItem | string) => {
    const item = asItem(entry);
    return (
      <Option
        key={item.value}
        item={item}
        shown={byValue.get(item.value) ?? item}
      />
    );
  };
  // SAFETY: the list hands back the items the combobox gave it, which are ListData of strings.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return (items as ListData).map((entry, index) => {
    if (typeof entry === "string" || !("type" in entry)) {
      return option(entry);
    }
    if (entry.type === "separator") {
      // A separator has no value; its place in the list is its key.
      return (
        <ComboboxSeparator
          key={`separator-${index}`}
          {...stylex.props(listStyles.separator)}
        />
      );
    }
    return (
      <ComboboxGroup key={`group-${entry.label ?? index}`}>
        {entry.label !== undefined && entry.label !== "" && (
          <ComboboxGroupLabel
            {...stylex.props(listStyles.groupLabel, listStyles.cut)}
          >
            {entry.label}
          </ComboboxGroupLabel>
        )}
        {entry.items.map(option)}
      </ComboboxGroup>
    );
  });
};

/** What the list says when nothing matches the words typed. */
export const ComboboxEmpty = ({ children }: ComboboxEmptyProps) => {
  const words = useI18n();
  return (
    <EmptyPrimitive {...stylex.props(listStyles.empty)}>
      {children ?? words.combobox.empty}
    </EmptyPrimitive>
  );
};

/**
 * What the popup of a field on UI SDK's Combobox holds: the words when nothing matches, the items
 * that match, and the fade over a long list's end. Combobox draws its own with it, and TagsInput
 * its suggestions, so the two lists are one.
 */
export const ComboboxOptions = ({ items, children }: ComboboxOptionsProps) => {
  const byValue = byValueOf(items);
  return (
    <>
      {children ?? <ComboboxEmpty />}
      <ComboboxList>
        {(state: { items: ListData<unknown> }) => (
          <Options items={state.items} byValue={byValue} />
        )}
      </ComboboxList>
      <span aria-hidden="true" {...stylex.props(listStyles.more)} />
    </>
  );
};

/** A chosen item's media in a chip: an Avatar drawn at the chip's line (2xs), anything else as given. */
const chipMediaOf = (given: ReactNode): ReactNode =>
  isValidElement<AvatarProps>(given) && given.type === Avatar ? (
    <Avatar {...given.props} size="2xs" />
  ) : (
    given
  );

/** The values given as data, whether one or several. */
const valuesOf = (value: string | readonly string[] | null | undefined) => {
  if (value === null || value === undefined) {
    return [];
  }
  return typeof value === "string" ? [value] : value;
};

/** The chosen values, each a chip: its media, its words, the button that takes it away. */
const Chips = ({
  values,
  byValue,
}: {
  values: unknown;
  byValue: Map<string, ComboboxItem>;
}) => {
  const words = useI18n();
  const chosen = Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
  return chosen.map((value) => {
    const item = byValue.get(value);
    const label = item?.label ?? value;
    return (
      <ComboboxChip
        key={value}
        value={value}
        aria-label={label}
        {...stylex.props(styles.chip)}
      >
        {item?.media === undefined ? null : (
          <span aria-hidden="true" {...stylex.props(styles.chipMedia)}>
            {chipMediaOf(item.media)}
          </span>
        )}
        <span {...stylex.props(styles.chipWords)}>{label}</span>
        <ComboboxChipRemove
          aria-label={words.combobox.remove(label)}
          {...stylex.props(styles.chipRemove)}
        >
          <span aria-hidden="true" {...stylex.props(tapTarget)} />
          <Icon icon={XIcon} />
        </ComboboxChipRemove>
      </ComboboxChip>
    );
  });
};

/** What the list says as it changes, in the catalogue's words: how many match, or what was taken away. */
const announcementOf =
  (words: I18nCatalog["combobox"]) =>
  (change: ListAnnouncement): string => {
    if (change.type === "removed") {
      return words.removed(change.label);
    }
    if (change.loading) {
      return words.loading;
    }
    return change.count === 0 ? words.empty : words.results(change.count);
  };

/** Type to find one value in a list, or several with `multiple`. */
export const Combobox = ({
  items,
  children,
  size: scale = "default",
  placeholder,
  style,
  "aria-label": ariaLabel,
  "aria-invalid": ariaInvalid,
  id,
  ...options
}: ComboboxProps) => {
  const words = useI18n();
  // Opened by a press on the chevron at the field's end, the list grows from that button; opened by
  // typing (or the keys), from the field it lines up with (the rule: from the trigger).
  const chevron = useRef<HTMLButtonElement>(null);
  const pressedAt = useRef(0);
  const fromChevron = transformOriginFrom(() =>
    pressedJustNow(pressedAt.current) ? chevron.current : null
  );
  // Several values: the chips' box, the field the list hangs under (the typing in it is narrower).
  const [chipsBox, setChipsBox] = useState<HTMLDivElement | null>(null);
  // The value is always an item's: a value from outside the list (an agent's, or code's) is refused,
  // so whoever set it hears that it failed.
  const byValue = byValueOf(items);
  // What was typed, while it is typed: with words that are a search, not the chosen item's own, its
  // media steps aside for the quiet one, so a picture never claims the words are its item's.
  const [typed, setTyped] = useState("");
  const refused = (
    next: string | readonly string[] | null,
    details: ChangeDetails<ComboboxValueChangeReason>
  ) => {
    const stranger = valuesOf(next).find((value) => !byValue.has(value));
    if (stranger === undefined) {
      return false;
    }
    details.cancel();
    // An agent hears why, in words.
    if (details.source === "agent") {
      throw new Error(words.combobox.notChoice(stranger));
    }
    return true;
  };
  // In development, say so when nothing names it: no Field label, no aria-label.
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    warnUnnamed("Combobox", input.current);
  }, []);

  // A starting value from outside the list is a mistake in the code: say so in development.
  // Keyed on the items, not on `byValue`: that is a new Map at every render.
  useEffect(() => {
    if (!isDevelopment) {
      return;
    }
    const listed = byValueOf(items);
    for (const start of [
      ...valuesOf(options.value),
      ...valuesOf(options.defaultValue),
    ]) {
      if (!listed.has(start)) {
        console.error(`Combobox: ${start} is not one of its items.`);
      }
    }
  }, [items, options.value, options.defaultValue]);

  const onQueryChange = (
    query: string,
    details: ChangeDetails<ComboboxQueryChangeReason>
  ) => {
    setTyped(details.reason === "input-change" ? query : "");
  };
  const listPopup = (
    <ComboboxContent
      ref={fromChevron}
      anchor={options.multiple === true ? (chipsBox ?? undefined) : undefined}
      sideOffset={popup.gap}
      collisionPadding={popup.gutter}
      {...stylex.props(
        listMarker,
        listStyles.popup,
        styles.content,
        scrollbarHidden
      )}
    >
      <ComboboxOptions items={items}>{children}</ComboboxOptions>
    </ComboboxContent>
  );

  if (options.multiple === true) {
    const { multiple, onValueChange, ...rest } = options;
    return (
      <ComboboxPrimitive<string, true>
        items={searchedItems(items)}
        autoHighlight="always"
        announcement={announcementOf(words.combobox)}
        {...rest}
        multiple={multiple}
        itemToLabel={(value: string) => byValue.get(value)?.label ?? value}
        onValueChange={(
          next: string[],
          details: ChangeDetails<ComboboxValueChangeReason>
        ) => {
          if (!refused(next, details)) {
            onValueChange?.(next, details);
          }
        }}
        onQueryChange={onQueryChange}
      >
        <ComboboxChips
          ref={setChipsBox}
          data-slot="combobox-chips"
          {...stylex.props(
            styles.chips,
            chipsSizeStyles[scale],
            focusField.within,
            style
          )}
        >
          {/* The typing after the chips; it says what to do only while nothing is chosen. */}
          <ComboboxValue>
            {(state: ComboboxValueState): ReactNode => (
              <>
                <Chips values={state.value} byValue={byValue} />
                <ComboboxInput
                  ref={input}
                  id={id}
                  aria-label={ariaLabel}
                  aria-invalid={ariaInvalid}
                  placeholder={
                    Array.isArray(state.value) && state.value.length > 0
                      ? undefined
                      : placeholder
                  }
                  {...stylex.props(styles.chipsInput)}
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        {listPopup}
      </ComboboxPrimitive>
    );
  }

  const {
    multiple: _one,
    onValueChange,
    media: resting,
    triggerLabel,
    ...rest
  } = options;
  return (
    <ComboboxPrimitive
      items={searchedItems(items)}
      autoHighlight="always"
      announcement={announcementOf(words.combobox)}
      {...rest}
      onValueChange={(
        next: string | null,
        details: ChangeDetails<ComboboxValueChangeReason>
      ) => {
        if (!refused(next, details)) {
          onValueChange?.(next, details);
        }
      }}
      onQueryChange={onQueryChange}
    >
      {/* The box that holds the field, its touch target and the chevron. */}
      <div data-slot="combobox" {...stylex.props(styles.box, style)}>
        <span aria-hidden="true" {...stylex.props(tapTarget)} />
        {/* Before the input, so the input's words begin after it while it is there. */}
        <ComboboxValue>
          {(state: ComboboxValueState): ReactNode => {
            const chosen =
              typeof state.value === "string"
                ? byValue.get(state.value)?.media
                : undefined;
            const shown =
              typed !== "" && typed !== state.label
                ? resting
                : (chosen ?? resting);
            return shown === undefined ? null : (
              <span
                aria-hidden="true"
                {...stylex.props(stylex.defaultMarker(), styles.start)}
              >
                {shown}
              </span>
            );
          }}
        </ComboboxValue>
        <ComboboxInput
          ref={input}
          id={id}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          placeholder={placeholder}
          render={(
            props: Record<string, unknown>,
            state: ComboboxInputState
          ) => (
            <input
              {...props}
              {...stylex.props(
                stylex.defaultMarker(),
                styles.input,
                sizeStyles[scale],
                styles.inputStart,
                styles.inputEnd,
                !(state.disabled || state.readOnly) && inputStyles.enabled,
                state.readOnly && styles.readOnly,
                state.disabled && inputStyles.disabled,
                isInvalid(props["aria-invalid"]) && inputStyles.invalid,
                focusField.default
              )}
            />
          )}
        />
        <ComboboxTrigger
          ref={chevron}
          onPointerDown={(event) => {
            pressedAt.current =
              Date.now() - (performance.now() - event.timeStamp);
          }}
          aria-label={triggerLabel ?? words.combobox.trigger}
          className={(state: ComboboxTriggerState) =>
            className(
              styles.trigger,
              (state.disabled || state.readOnly) && styles.triggerOff
            )
          }
        >
          {(state: ComboboxTriggerState) => (
            <>
              <span aria-hidden="true" {...stylex.props(tapTarget)} />
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.chevron,
                  state.open && styles.chevronOpen
                )}
              >
                <Icon icon={ChevronDownIcon} />
              </span>
            </>
          )}
        </ComboboxTrigger>
      </div>
      {listPopup}
    </ComboboxPrimitive>
  );
};
