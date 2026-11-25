// Tags input: several values typed into one field, each a secondary Badge, on UI SDK's Combobox
// with several values (Ark's and Chakra's TagsInput, by name). Enter or a comma adds what was typed;
// pasted words split on commas and new lines; Backspace in the empty field first goes to the last tag, and a
// second Backspace takes it away; the arrow keys move between the tags. A value already there, or
// one past `max`, is refused, and the field says why, to a screen reader too. Suggestions, when
// given, open the Combobox's list as you type.
//
//   <Field name="labels">
//     <FieldLabel>Labels</FieldLabel>
//     <TagsInput defaultValue={["Design"]} suggestions={["Design", "Research", "Sales"]} />
//   </Field>
//
// Inside a Field it is named, described, out of use and wrong with the Field; in a form it sends
// each value under its name. The tags wrap onto more lines inside the field box (lib/styles'
// inputStyles heights and corners); it never runs past its column.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxContent,
  ComboboxInput,
  ComboboxValue,
} from "@ui-sdk/react/combobox";
import type {
  ComboboxChipState,
  ComboboxValueState,
} from "@ui-sdk/react/combobox";
import { useId, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";

import { useI18n } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import {
  focusField,
  focusRing,
  inputStyles,
  listStyles,
  scrollbarHidden,
  visuallyHidden,
} from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
// UI SDK places a popup in pixels: popup-gap and popup-gutter, as the generator writes them.
import { popup } from "../lib/tokens.values";
import type { LayoutStyle } from "../lib/utils";
import { listMarker } from "../lib/vars.stylex";
import { Badge } from "./badge";
import { ComboboxEmpty, ComboboxOptions } from "./combobox";
import type { InputSize } from "./input";

/** The words a TagsInput says, so the product can say them in its own language. */
export type TagsInputLabels = I18nCatalog["tagsInput"];

/** Every prop a TagsInput takes. */
export interface TagsInputProps {
  /** The values, in order. Pass it with `onValueChange` to control them. */
  value?: string[];
  /** The values it starts with, when you do not control them. A form reset returns here. */
  defaultValue?: string[];
  /** Runs with every value after one is added or taken away. */
  onValueChange?: (value: string[]) => void;
  /** Values to choose from as you type. Anything else typed is added as it is. */
  suggestions?: readonly string[];
  /** A hint while it is empty: what to type ("Add a label"). */
  placeholder?: string;
  /**
   * The height of one line: `sm` 32px, `default` 36px, `lg` 44px, as Input's. More tags add lines.
   * @default "default"
   */
  size?: InputSize;
  /** The most values it takes. One more is refused, and the field says why. */
  max?: number;
  /**
   * Checks a value: `true` when it is right; `false`, or the words that say why ("not an email
   * address"), when it is wrong. A wrong value is kept, so the person can see and correct it: its
   * tag gets a destructive edge, and a screen reader hears, after its words, the words returned, or
   * `labels.invalid` for `false`. Say what is wrong under the field, as any field does.
   */
  validate?: (value: string) => boolean | string;
  /** The name each value is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /** Out of use: not focusable, not sent, half strength. Inside a Field, the Field's serves. @default false */
  disabled?: boolean;
  /** Its name when no FieldLabel names it. */
  "aria-label"?: string;
  /**
   * What it says, any of it replaced for this one field: why a value is refused, and what the
   * suggestions say when none matches what was typed. The rest comes from the I18nProvider
   * (`tagsInput`).
   */
  labels?: Partial<TagsInputLabels>;
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const TYPING = media.maxSmOrCoarse;
const OFF = ":has(input:disabled)";
const WRONG = ":has(input[aria-invalid=true])";

const styles = stylex.create({
  root: {
    display: "grid",
    rowGap: space[1],
    minWidth: 0,
    fontFamily: font.sans,
  },
  // The field box: its edge, fill and focus are drawn on the box, so the tags and the typing share
  // one field. Heights and corners are the field box's (inputStyles); the padding centres a tag.
  box: {
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[1],
    // Each tag's × reaches the middle of the gap to its neighbours, beside it and on the next line.
    "--tap-room-inline": `calc(${space[1]} / 2)`,
    "--tap-room-block": `calc(${space[1]} / 2)`,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    paddingInline: space[2],
    // In forced colours a real edge; a wrong field's turns dashed, the same 1px, as the destructive
    // tint is dropped there.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: {
      default: "solid",
      [FORCED]: { default: "solid", [WRONG]: "dashed" },
    },
    borderColor: "currentColor",
    backgroundColor: colors.inputBg,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`,
      ":hover:not(:focus-within)": {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${colors.inputBorderHover}, ${shadow.inputShadow}`,
      },
      ":focus-within": sizes.inputFocus,
      [WRONG]: {
        default: sizes.inputInvalid,
        ":focus-within": sizes.inputFocusInvalid,
      },
      [OFF]: `inset 0 0 0 1px ${colors.input}`,
    },
    opacity: { default: 1, [OFF]: sizes.opacityDisabled },
    cursor: { default: "text", [OFF]: "not-allowed" },
    transitionProperty: "box-shadow",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // One line's height (inputStyles), with the padding that centres a tag in it.
  sm: {
    paddingBlock: `calc((${sizes.controlSm} - ${sizes.badgeLabelHeight}) / 2)`,
  },
  default: {
    paddingBlock: `calc((${sizes.controlDefault} - ${sizes.badgeLabelHeight}) / 2)`,
  },
  lg: {
    paddingBlock: `calc((${sizes.controlLg} - ${sizes.badgeLabelHeight}) / 2)`,
  },
  // A finger needs 44px: on a touch screen an invisible area makes up a small field's height.
  target: {
    position: "absolute",
    insetInline: 0,
    insetBlock: {
      default: 0,
      [COARSE]: `min(0px, calc((100% - ${sizes.tapTarget}) / 2))`,
    },
  },
  // A tag's own place: focusable by the arrow keys, with the ring round its pill.
  chip: {
    display: "inline-flex",
    maxWidth: "100%",
    minWidth: 0,
    borderRadius: radius.full,
  },
  // A wrong value: a destructive edge round its pill; in forced colours, where the tint is dropped,
  // a dashed edge in the text colour. It stands after focusRing, so the keyboard's ring replaces it.
  chipWrong: {
    outline: {
      default: `1px solid ${colors.destructive}`,
      [FORCED]: "1px dashed CanvasText",
      ":focus-visible": {
        default: `${sizes.ringWidth} solid ${colors.ring}`,
        [FORCED]: `calc(2 * ${sizes.lineStrong}) solid Highlight`,
      },
    },
    outlineOffset: {
      default: "-1px",
      ":focus-visible": {
        default: sizes.ringOffset,
        [FORCED]: sizes.ringOffsetMark,
      },
    },
  },
  // The draft is as wide as its words (field-sizing), so once it no longer fits after the last tag
  // it takes a row of its own, never cut in the gap that is left. Where field-sizing is not known
  // (Firefox), it keeps 8ch and scrolls.
  input: {
    position: "relative",
    flexGrow: 1,
    flexBasis: "auto",
    fieldSizing: "content",
    minWidth: "8ch",
    maxWidth: "100%",
    height: sizes.badgeLabelHeight,
    margin: 0,
    paddingBlock: 0,
    paddingInline: space[1],
    appearance: "none",
    borderWidth: 0,
    backgroundColor: "transparent",
    outline: "none",
    color: colors.foreground,
    caretColor: colors.foreground,
    fontFamily: "inherit",
    fontSize: { default: font.textSm, [TYPING]: sizes.inputTextTouch },
    lineHeight: font.textSmLine,
    cursor: { default: "text", ":disabled": "not-allowed" },
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    // A hint too long for the field ends in an ellipsis, never mid-word.
    "::placeholder": {
      color: colors.mutedForeground,
      opacity: 1,
      textOverflow: "ellipsis",
    },
  },
  // The list under the field is at least as wide as the field.
  suggestions: { minWidth: "var(--anchor-width)" },
  // Why a value was refused, under the field, said to a screen reader too. Saying nothing, it stays
  // in the page for screen readers but out of the grid: no row, no gap, so the field's description
  // stands as close as any field's.
  error: {
    margin: 0,
    position: { default: "static", ":empty": "absolute" },
    width: { default: "auto", ":empty": 1 },
    height: { default: "auto", ":empty": 1 },
    overflow: { default: "visible", ":empty": "hidden" },
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.destructive,
  },
});

const sizeStyles = {
  sm: inputStyles.sm,
  default: inputStyles.default,
  lg: inputStyles.lg,
} as const;
const padStyles = {
  sm: styles.sm,
  default: styles.default,
  lg: styles.lg,
} as const;

const same = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
const pieces = (text: string) =>
  text
    .split(/[,\n\r]+/u)
    .map((piece) => piece.trim())
    .filter(Boolean);

// One empty list for every TagsInput, so the default never changes between renders.
const noTags: string[] = [];

// What a screen reader hears after a wrong value: the words `validate` gave, the default for
// `false`, nothing for a value that is right.
const wrongWords = (
  verdict: boolean | string | undefined,
  fallback: string
): string => {
  if (typeof verdict === "string") {
    return verdict;
  }
  return verdict === false ? fallback : "";
};

/** A value refused, and why: already there, or one too many. */
interface Refusal {
  kind: "duplicate" | "full";
  word: string;
}

/** The refusal's words while it still holds, else none. */
const refusalNow = (
  refused: Refusal | null,
  values: readonly string[],
  max: number | undefined,
  words: TagsInputLabels
): string => {
  if (refused === null) {
    return "";
  }
  if (refused.kind === "duplicate") {
    return values.some((existing) => same(existing, refused.word))
      ? words.duplicate(refused.word)
      : "";
  }
  return max !== undefined && values.length >= max ? words.full(max) : "";
};

// The Combobox's chosen values, as the words they are: every value here is a string.
const chosenWords = (chosen: unknown): string[] =>
  Array.isArray(chosen)
    ? chosen.filter((word): word is string => typeof word === "string")
    : [];

// Where the keyboard goes once a tag is taken away by its button: the next tag's remove button,
// else the one before, else the field. Each tag stands in its own chip, so Badge's own rule (its
// neighbours in the same row) finds none here: they are looked up across the whole field.
const afterRemoving = (
  field: HTMLElement | null,
  at: number
): HTMLElement | null => {
  if (field === null) {
    return null;
  }
  const buttons = [
    ...field.querySelectorAll<HTMLElement>("[data-slot=badge-remove]"),
  ];
  return (
    buttons[at + 1] ??
    buttons[at - 1] ??
    field.querySelector<HTMLElement>("input")
  );
};

/** Several values typed into one field, each shown as a secondary Badge. */
export const TagsInput = ({
  value,
  defaultValue = noTags,
  onValueChange,
  suggestions,
  placeholder,
  size = "default",
  max,
  validate,
  name,
  disabled,
  "aria-label": ariaLabel,
  labels,
  style,
}: TagsInputProps) => {
  const [own, setOwn] = useState(defaultValue);
  // What it says: the I18nProvider's, with this field's own `labels` over them.
  const words: TagsInputLabels = {
    ...useI18n().tagsInput,
    ...labels,
  };
  const values = value ?? own;
  const [query, setQuery] = useState("");
  // Why the last value was refused: what it was about, so the words go once that no longer holds.
  const [refused, setRefused] = useState<Refusal | null>(null);
  // Said only while it is still true: a duplicate while its word is in the field, "full" while the
  // field is full. Sent, cleared or reset from outside, the words go with what they spoke of.
  const refusal = refusalNow(refused, values, max, words);
  const refusalId = useId();
  // Each wrong tag is described by its own words: ids by place, as a value may hold a space.
  const wrongId = useId();

  const commit = (next: string[]) => {
    if (value === undefined) {
      setOwn(next);
    }
    onValueChange?.(next);
  };

  // Adds new words in order, refusing one already there (whatever its capitals) or one too many.
  const add = (added: string[]) => {
    const next = [...values];
    let reason: Refusal | null = null;
    for (const word of added) {
      if (next.some((existing) => same(existing, word))) {
        reason = { kind: "duplicate", word };
      } else if (max !== undefined && next.length >= max) {
        reason = { kind: "full", word };
      } else {
        next.push(word);
      }
    }
    setRefused(reason);
    if (next.length !== values.length) {
      commit(next);
    }
  };

  // The Combobox adds a typed word on Enter, and a suggestion when chosen: checked the same way. A
  // form reset brings the values it started with back.
  const change = (next: string[], details: ChangeDetails) => {
    if (next.length > values.length && details.reason !== "reset") {
      details.cancel();
      add(
        next
          .filter((word) => !values.includes(word))
          .map((word) => word.trim())
          .filter(Boolean)
      );
      return;
    }
    setRefused(null);
    commit(next);
  };

  // The suggestions as the list takes them: a list of its own, as the product's may be read-only.
  const options = suggestions === undefined ? [] : [...suggestions];
  const root = useRef<HTMLDivElement>(null);
  // The suggestions open under the whole field, as wide as it, not under the few letters typed.
  const [field, setField] = useState<HTMLDivElement | null>(null);
  const remove = (word: string) => {
    setRefused(null);
    const target = afterRemoving(root.current, values.indexOf(word));
    commit(values.filter((each) => each !== word));
    requestAnimationFrame(() => {
      if (target?.isConnected === true) {
        target.focus();
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const input = event.currentTarget;
    const typed = query.trim();
    // Backspace in the empty field goes to the last tag first, so a person hears which one a second
    // Backspace takes away (the tag's own key, UI SDK's chip).
    if (
      event.key === "Backspace" &&
      input.value === "" &&
      input.selectionStart === 0 &&
      values.length > 0
    ) {
      event.preventDefault();
      [
        ...(root.current?.querySelectorAll<HTMLElement>(
          "[data-slot=combobox-chip]"
        ) ?? []),
      ]
        .at(-1)
        ?.focus();
      return;
    }
    // Enter on a word that is already a tag, capitals and all: the Combobox sees no change in that,
    // so it would clear the field and say nothing. Refused here, with the reason.
    if (
      event.key === "Enter" &&
      typed !== "" &&
      values.some((existing) => same(existing, typed))
    ) {
      event.preventDefault();
      add([typed]);
      setQuery("");
      return;
    }
    // A comma adds what was typed, as Enter does.
    if (event.key === ",") {
      event.preventDefault();
      if (typed !== "") {
        add([typed]);
      }
      setQuery("");
    }
  };
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[,\n\r]/u.test(text)) {
      return;
    }
    event.preventDefault();
    add(pieces(`${query}${text}`));
    setQuery("");
  };

  return (
    <div
      ref={root}
      data-slot="tags-input"
      {...stylex.props(styles.root, style)}
    >
      <Combobox<string, true>
        multiple
        allowCustomValue
        items={options.length > 0 ? options : undefined}
        value={values}
        defaultValue={defaultValue}
        onValueChange={change}
        query={query}
        onQueryChange={(next: string) => {
          setQuery(next);
        }}
        name={name}
        disabled={disabled}
        itemToLabel={(word: string) => word}
      >
        <ComboboxChips
          ref={setField}
          {...stylex.props(
            styles.box,
            sizeStyles[size],
            padStyles[size],
            focusField.within
          )}
        >
          <span aria-hidden="true" {...stylex.props(styles.target)} />
          <ComboboxValue>
            {(state: ComboboxValueState) =>
              chosenWords(state.value).map((word, index) => {
                const wrong = wrongWords(validate?.(word), words.invalid);
                const why = `${wrongId}-${String(index)}`;
                return (
                  <ComboboxChip
                    key={word}
                    value={word}
                    aria-describedby={wrong === "" ? undefined : why}
                    data-invalid={wrong === "" ? undefined : ""}
                    {...stylex.props(
                      styles.chip,
                      focusRing,
                      wrong !== "" && styles.chipWrong
                    )}
                  >
                    {/* Out of use, by its own prop or its Field's, a tag cannot be taken away. */}
                    {(chip: ComboboxChipState) => (
                      <>
                        <Badge
                          variant="secondary"
                          onRemove={
                            chip.disabled
                              ? undefined
                              : () => {
                                  remove(word);
                                }
                          }
                        >
                          {word}
                        </Badge>
                        {wrong === "" ? null : (
                          <span id={why} {...stylex.props(visuallyHidden)}>
                            , {wrong}
                          </span>
                        )}
                      </>
                    )}
                  </ComboboxChip>
                );
              })
            }
          </ComboboxValue>
          <ComboboxInput
            aria-label={ariaLabel}
            aria-describedby={refusal === "" ? undefined : refusalId}
            placeholder={values.length === 0 ? placeholder : undefined}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            {...stylex.props(styles.input)}
          />
        </ComboboxChips>
        {options.length > 0 ? (
          <ComboboxContent
            anchor={field ?? undefined}
            sideOffset={popup.gap}
            collisionPadding={popup.gutter}
            {...stylex.props(
              listMarker,
              listStyles.popup,
              styles.suggestions,
              scrollbarHidden
            )}
          >
            <ComboboxOptions items={options}>
              <ComboboxEmpty>{words.empty}</ComboboxEmpty>
            </ComboboxOptions>
          </ComboboxContent>
        ) : null}
      </Combobox>
      <p
        id={refusalId}
        // Not every screen reader treats <output> as a live region; role="status" is.
        role="status"
        data-slot="tags-input-error"
        {...stylex.props(styles.error)}
      >
        {refusal}
      </p>
    </div>
  );
};
