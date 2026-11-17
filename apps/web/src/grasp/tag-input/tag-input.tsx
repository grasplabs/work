// Tag input: several values typed into one field, each a Tag, on UI SDK's Combobox with several
// values. Enter or a comma adds what was typed; pasted words split on commas and new lines;
// Backspace in the empty field takes the last tag; the arrow keys move between the tags. A value
// already there is refused, and the field says why. Suggestions, when given, open the Combobox's
// list as you type.
//
//   <Field name="labels">
//     <FieldLabel>Labels</FieldLabel>
//     <TagInput defaultValue={["Design"]} suggestions={["Design", "Research", "Sales"]} />
//   </Field>
//
// The tags wrap onto more lines inside the field; it never runs past its column. Every value is a
// token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxValue,
} from "@ui-sdk/react/combobox";
import type {
  ComboboxItemState,
  ComboboxValueState,
} from "@ui-sdk/react/combobox";
import { useId, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent } from "react";

import { listStyles as list } from "../combobox/list.styles";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, Tick } from "../icons";
import type { InputSize } from "../input/input";
import type { LayoutStyle } from "../layout/layout";
import { Tag } from "../tag/tag";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";

/** What a caller may style: where it sits and how wide it is. */
export type TagInputLayoutStyle = LayoutStyle;

/** Every prop a TagInput takes. */
export interface TagInputProps {
  /** The values, in order. Pass it with `onValueChange` to control them. */
  value?: string[];
  /** The values it starts with, when you do not control them. */
  defaultValue?: string[];
  /** Runs with every value after one is added or taken away. */
  onValueChange?: (value: string[]) => void;
  /** Values to choose from as you type. Anything else typed is added as it is. */
  suggestions?: readonly string[];
  /** A hint while it is empty: what to type ("Add a label"). */
  placeholder?: string;
  /**
   * The height of one line: `sm` 32px, `md` 36px, `lg` 44px, as Input's. More tags add lines.
   * @default "md"
   */
  size?: InputSize;
  /** The most values it takes. */
  max?: number;
  /**
   * Marks a value that is wrong, such as an address that is not one: its tag gets a danger edge,
   * and a screen reader hears, after its words, the words returned ("not an email address"), or
   * `messages.invalid` for `true`. The value is kept, so the person can see it and correct it; say
   * what is wrong under the field, as any field does.
   */
  invalid?: (value: string) => boolean | string;
  /** The name each value is sent under in a form. Inside a Field, the Field's `name` serves. */
  name?: string;
  /** Out of use. @default false */
  disabled?: boolean;
  /** Its name when no FieldLabel names it. */
  "aria-label"?: string;
  /**
   * What it says, in the page's language, any of it replaced: why a value is refused, and what the
   * suggestions say when none matches what was typed.
   * @default { duplicate: (value) => `"${value}" is already added.`, full: (max) => `Up to ${max}.`, empty: "Press Enter to add it.", invalid: "not valid" }
   */
  messages?: Partial<TagInputMessages>;
  /** @deprecated Use `layout`. */
  style?: TagInputLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: TagInputLayoutStyle;
}

const HOVER = media.hover;
const FORCED = media.forced;
const OFF = ":has(input:disabled)";
const WRONG = ":has(input[aria-invalid=true])";

const styles = stylex.create({
  // The list under the field is at least as wide as the field.
  suggestions: { minWidth: "var(--anchor-width)" },
  root: {
    display: "grid",
    rowGap: grasp.space1,
    minWidth: 0,
    fontFamily: grasp.fontSans,
  },
  // The field: its edge and focus on the box, so the tags and the typing share one field.
  box: {
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    paddingInline: grasp.space2,
    // In forced colours a real edge; a wrong field's turns dashed, the same 1px, as the danger tint
    // is dropped there.
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: {
      default: "solid",
      [FORCED]: { default: "solid", [WRONG]: "dashed" },
    },
    borderColor: "currentColor",
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.fieldFill,
    boxShadow: {
      default: `inset 0 0 0 1px ${grasp.fieldEdge}, ${grasp.fieldLift}`,
      ":hover:not(:focus-within)": {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${grasp.fieldEdgeHover}, ${grasp.fieldLift}`,
      },
      ":focus-within": grasp.fieldFocus,
      [WRONG]: {
        default: grasp.fieldInvalid,
        ":focus-within": grasp.fieldFocusInvalid,
      },
      [OFF]: `inset 0 0 0 1px ${grasp.fieldEdge}`,
    },
    // Focus, the ring for the keyboard and a real outline in forced colours: focus.fieldWithin.
    opacity: { default: 1, [OFF]: grasp.dim },
    cursor: "text",
    transitionProperty: "box-shadow",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  // One line's height, and the padding that centres a tag in it; more tags add lines.
  sm: {
    minHeight: grasp.controlSm,
    paddingBlock: `calc((${grasp.controlSm} - ${grasp.tagHeight}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
  },
  md: {
    minHeight: grasp.controlMd,
    paddingBlock: `calc((${grasp.controlMd} - ${grasp.tagHeight}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
  },
  lg: {
    minHeight: grasp.controlLg,
    paddingBlock: `calc((${grasp.controlLg} - ${grasp.tagHeight}) / 2)`,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlLg} / 2))`,
  },
  // A tag's own place: focusable by the arrow keys, with the ring round its pill.
  chip: {
    display: "inline-flex",
    maxWidth: "100%",
    minWidth: 0,
    borderRadius: grasp.cornerPill,
  },
  // A wrong value: a danger edge round its pill, over the tag's own; in forced colours, where the
  // tint is dropped, a dashed edge in the text colour. Keyboard focus draws its ring over it.
  // It stands after focus.ring, so it carries the ring too: the keyboard's ring replaces the edge.
  chipWrong: {
    outline: {
      default: `1px solid ${grasp.danger}`,
      [FORCED]: "1px dashed CanvasText",
      ":focus-visible": {
        default: `${grasp.ringWidth} solid ${grasp.ring}`,
        [FORCED]: `calc(2 * ${grasp.ringWidth}) solid Highlight`,
      },
    },
    outlineOffset: {
      default: "-1px",
      ":focus-visible": {
        default: grasp.ringOffset,
        [FORCED]: grasp.ringOffsetMark,
      },
    },
  },
  // The draft is as wide as its words (field-sizing), so once it no longer fits after the last tag
  // it takes a row of its own, never cut in the gap that is left. Where field-sizing is not known
  // (Firefox), it keeps 8ch and scrolls as before.
  input: {
    flexGrow: 1,
    flexBasis: "auto",
    fieldSizing: "content",
    minWidth: "8ch",
    maxWidth: "100%",
    height: grasp.tagHeight,
    margin: 0,
    paddingBlock: 0,
    paddingInline: grasp.space1,
    appearance: "none",
    borderWidth: 0,
    backgroundColor: "transparent",
    outline: "none",
    color: grasp.ink,
    caretColor: grasp.ink,
    fontFamily: "inherit",
    fontSize: { default: grasp.textSm, [media.typing]: grasp.fieldTextTouch },
    lineHeight: grasp.textSmLine,
    "::selection": { backgroundColor: grasp.fieldSelection, color: grasp.ink },
    // A hint too long for the field ends in an ellipsis, never mid-word.
    "::placeholder": {
      color: grasp.muted,
      opacity: 1,
      textOverflow: "ellipsis",
    },
  },
  // Why a value was refused, under the field, said to a screen reader too.
  // Saying nothing, it stays in the page for screen readers but out of the grid: no row, no gap,
  // so the field's description stands as close as any field's.
  refusal: {
    margin: 0,
    position: { default: "static", ":empty": "absolute" },
    width: { default: "auto", ":empty": 1 },
    height: { default: "auto", ":empty": 1 },
    overflow: { default: "visible", ":empty": "hidden" },
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.danger,
  },
});

const same = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
const pieces = (text: string) =>
  text
    .split(/[,\n\r]+/u)
    .map((piece) => piece.trim())
    .filter(Boolean);

/** The words a TagInput says, so the product can say them in its own language. */
export interface TagInputMessages {
  /** Why a value already there is refused. */
  duplicate: (value: string) => string;
  /** Why one more is refused, from the most it takes. */
  full: (max: number) => string;
  /** What the suggestions say when none matches what was typed. */
  empty: string;
  /** Said after a tag that `invalid` marks with `true`, to a screen reader only. */
  invalid: string;
}

/** What it says, in English: replace any of it through `messages`. */
const englishMessages: TagInputMessages = {
  duplicate: (word) => `"${word}" is already added.`,
  full: (most) => `Up to ${most}.`,
  empty: "Press Enter to add it.",
  invalid: "not valid",
};

// One empty list for every TagInput, so the default never changes between renders.
const noTags: string[] = [];

// What a screen reader hears after a wrong value: the words `invalid` gave, the default for `true`,
// nothing for a value that is right.
const wrongWords = (
  verdict: boolean | string | undefined,
  fallback: string
): string => {
  if (typeof verdict === "string") {
    return verdict;
  }
  return verdict === true ? fallback : "";
};

// The Combobox's chosen values, as the words they are: every value here is a string.
const chosenWords = (chosen: unknown): string[] =>
  Array.isArray(chosen)
    ? chosen.filter((word): word is string => typeof word === "string")
    : [];

// Where the keyboard goes once a tag is taken away: the next tag's remove button, else the one
// before, else the field. Each tag stands in its own chip, so Tag's own rule (its neighbours in the
// same row) finds none here: they are looked up across the whole field.
const afterRemoving = (
  field: HTMLElement | null,
  at: number
): HTMLElement | null => {
  if (field === null) {
    return null;
  }
  const buttons = [...field.querySelectorAll<HTMLElement>("[data-tag-remove]")];
  return (
    buttons[at + 1] ??
    buttons[at - 1] ??
    field.querySelector<HTMLElement>("input")
  );
};

export const TagInput = ({
  value,
  defaultValue = noTags,
  onValueChange,
  suggestions,
  placeholder,
  size = "md",
  max,
  invalid,
  name,
  disabled,
  "aria-label": ariaLabel,
  messages: givenMessages,
  style: styleProp,
  layout,
}: TagInputProps) => {
  const [own, setOwn] = useState(defaultValue);
  const messages = { ...englishMessages, ...givenMessages };
  const values = value ?? own;
  const [query, setQuery] = useState("");
  const [refusal, setRefusal] = useState("");
  const refusalId = useId();

  const commit = (next: string[]) => {
    if (value === undefined) {
      setOwn(next);
    }
    onValueChange?.(next);
  };

  // Adds new words in order, refusing one already there (whatever its capitals) or one too many.
  const add = (words: string[]) => {
    const next = [...values];
    let reason = "";
    for (const word of words) {
      if (next.some((existing) => same(existing, word))) {
        reason = messages.duplicate(word);
      } else if (max !== undefined && next.length >= max) {
        reason = messages.full(max);
      } else {
        next.push(word);
      }
    }
    setRefusal(reason);
    if (next.length !== values.length) {
      commit(next);
    }
  };

  // The Combobox adds a typed word on Enter, and a suggestion when chosen: checked the same way.
  const change = (next: string[], details: ChangeDetails) => {
    if (next.length > values.length) {
      details.cancel();
      add(
        next
          .filter((word) => !values.includes(word))
          .map((word) => word.trim())
          .filter(Boolean)
      );
      return;
    }
    setRefusal("");
    commit(next);
  };

  const root = useRef<HTMLDivElement>(null);
  // The suggestions open under the whole field, as wide as it, not under the few letters typed.
  const [field, setField] = useState<HTMLDivElement | null>(null);
  const remove = (word: string) => {
    setRefusal("");
    const target = afterRemoving(root.current, values.indexOf(word));
    commit(values.filter((each) => each !== word));
    requestAnimationFrame(() => {
      if (target?.isConnected === true) {
        target.focus();
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter on a word that is already a tag, capitals and all: the Combobox sees no change in
    // that, so it would clear the field and say nothing. Refused here, with the reason.
    const typed = query.trim();
    if (
      event.key === "Enter" &&
      !event.nativeEvent.isComposing &&
      typed !== "" &&
      values.some((existing) => same(existing, typed))
    ) {
      event.preventDefault();
      add([typed]);
      setQuery("");
      return;
    }
    // A comma adds what was typed, as Enter does.
    if (event.key === "," && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (query.trim()) {
        add([query.trim()]);
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
      data-slot="tag-input"
      {...stylex.props(styles.root, layout ?? styleProp)}
    >
      <Combobox<string, true>
        multiple
        allowCustomValue
        value={values}
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
          {...stylex.props(styles.box, styles[size], focus.fieldWithin)}
        >
          <ComboboxValue>
            {(state: ComboboxValueState) =>
              chosenWords(state.value).map((word) => {
                const wrong = wrongWords(invalid?.(word), messages.invalid);
                return (
                  <ComboboxChip
                    key={word}
                    value={word}
                    data-invalid={wrong === "" ? undefined : ""}
                    {...stylex.props(
                      styles.chip,
                      focus.ring,
                      wrong !== "" && styles.chipWrong
                    )}
                  >
                    <Tag
                      onRemove={
                        disabled === true
                          ? undefined
                          : () => {
                              remove(word);
                            }
                      }
                    >
                      {word}
                      {wrong === "" ? null : (
                        <span {...stylex.props(visuallyHidden)}>, {wrong}</span>
                      )}
                    </Tag>
                  </ComboboxChip>
                );
              })
            }
          </ComboboxValue>
          <ComboboxInput
            aria-label={ariaLabel}
            aria-describedby={refusal ? refusalId : undefined}
            placeholder={values.length === 0 ? placeholder : undefined}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            {...stylex.props(styles.input)}
          />
        </ComboboxChips>
        {suggestions && suggestions.length > 0 ? (
          <ComboboxContent
            anchor={field ?? undefined}
            sideOffset={popup.gap}
            collisionPadding={popup.gutter}
            {...stylex.props(list.popup, styles.suggestions)}
          >
            <ComboboxEmpty {...stylex.props(list.empty)}>
              {messages.empty}
            </ComboboxEmpty>
            <ComboboxList>
              {suggestions.map((word) => (
                <ComboboxItem
                  key={word}
                  value={word}
                  label={word}
                  className={(state: ComboboxItemState) =>
                    stylex.props(
                      list.item,
                      state.highlighted && list.itemHighlighted
                    ).className
                  }
                >
                  <span {...stylex.props(list.itemWords)}>{word}</span>
                  <ComboboxItemIndicator {...stylex.props(list.tick)}>
                    <Icon icon={Tick} />
                  </ComboboxItemIndicator>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        ) : null}
      </Combobox>
      <p
        id={refusalId}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- not every screen reader treats <output> as a live region; role="status" is
        role="status"
        data-slot="tag-input-refusal"
        {...stylex.props(styles.refusal)}
      >
        {refusal}
      </p>
    </div>
  );
};
