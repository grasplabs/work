// Filter builder: one filter condition, built from a field, an operator and a value in one joined
// control, as Palermo's. Each field says which operators it takes and what its value is: chosen from
// a list, a number, or words. The field and operator open the same list as Select; a number or
// words are typed straight into the last segment.
//
//   <FilterBuilder fields={fields} condition={condition} onConditionChange={setCondition} />
//
// The caller owns the whole condition. Changing the field keeps the operator when the new field has
// it, and keeps the value only when both fields share a `compatibilityKey` and it still fits. Every
// value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Select as SelectPrimitive,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import type {
  SelectItemState,
  SelectTriggerState,
  SelectValueState,
} from "@ui-sdk/react/select";
import { useState } from "react";
import type { KeyboardEvent } from "react";

import { focus } from "../focus/focus";
import { Icon, Tick } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { selectPopupStyles as list } from "../select/select";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup } from "../tokens/tokens.values";

/** One operator a field takes: "is", "is greater than". */
export interface FilterOperator {
  /** Names the operator in the condition. */
  id: string;
  /** Its words on the segment and in the list. */
  label: string;
}

/** One value to choose from, for a field whose value is chosen. */
export interface FilterOption {
  id: string;
  label: string;
  /** An icon before the words, from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
}

/** What a field's value is, and how it is entered. */
export type FilterValue =
  | {
      /** Chosen from a list. */
      type: "select";
      options: readonly FilterOption[];
      /** Fields that share a key keep the value when one changes to the other. */
      compatibilityKey?: string;
    }
  | {
      /** A number, typed. It is kept when Enter is pressed or the segment is left. */
      type: "number";
      min?: number;
      max?: number;
      step?: number;
      compatibilityKey?: string;
    }
  | {
      /** Words, typed. Emptied, the value clears unless `allowEmpty`. */
      type: "text";
      allowEmpty?: boolean;
      compatibilityKey?: string;
    };

/** One field a filter can be built on. */
export interface FilterField {
  id: string;
  label: string;
  /** An icon before the words, from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  operators: readonly FilterOperator[];
  /** The operator chosen when this field is, if the last one does not carry over. */
  defaultOperatorId?: string;
  value: FilterValue;
}

/** The whole condition: each part is `null` until it is chosen. */
export interface FilterCondition {
  fieldId: string | null;
  operatorId: string | null;
  value: string | number | null;
}

/** Every prop a FilterBuilder takes. */
export interface FilterBuilderProps {
  /** The fields to build on, with their operators and values. */
  fields: readonly FilterField[];
  /** The condition, which you keep in state. */
  condition: FilterCondition;
  /** Runs with the whole next condition after any segment changes. */
  onConditionChange: (condition: FilterCondition) => void;
  /**
   * What the first part says before a field is chosen.
   * @default "Field"
   */
  fieldPlaceholder?: string;
  /**
   * What the middle part says before an operator is chosen.
   * @default "Operator"
   */
  operatorPlaceholder?: string;
  /**
   * What the last part says before a value is given.
   * @default "Value"
   */
  valuePlaceholder?: string;
  /**
   * Every segment out of use.
   * @default false
   */
  disabled?: boolean;
  /**
   * Its name, as one group.
   * @default "Filter condition"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * Each segment's name for a screen reader, in the page's language.
   * @default { field: "Filter field", operator: "Filter operator", value: "Filter value" }
   */
  segmentLabels?: { field: string; operator: string; value: string };
}

const FORCED = media.forced;
const COARSE = media.coarse;

const styles = stylex.create({
  // The segments stand on the line's colour, 1px apart, so the gaps draw the dividers.
  group: {
    // Holds the lists' hidden form inputs, which are placed absolutely.
    position: "relative",
    display: "inline-flex",
    alignItems: "stretch",
    maxWidth: "100%",
    gap: grasp.filterDivider,
    overflow: "hidden",
    borderRadius: `min(${grasp.corner}, calc(${grasp.filterSegment} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: { default: grasp.line, [FORCED]: "CanvasText" },
    boxShadow: grasp.liftLow,
    fontFamily: grasp.fontSans,
  },
  segment: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    boxSizing: "border-box",
    // A chosen field or operator keeps its words whole (a typed value gives way instead), and on a
    // touch screen every segment is at least 44px across, as tall as it is there.
    flexShrink: 0,
    justifyContent: "center",
    minWidth: { default: 0, [COARSE]: grasp.tap },
    height: { default: grasp.filterSegment, [COARSE]: grasp.tap },
    margin: 0,
    paddingBlock: 0,
    paddingInline: "6px",
    borderWidth: 0,
    backgroundColor: {
      default: grasp.quietFill,
      ":hover": { default: null, [media.hover]: grasp.quietFillHover },
      ":is([aria-expanded=true])": grasp.quietFillHover,
      // The part the keyboard is on: the ring goes round the whole control (focus.fieldGroup), and
      // this part takes the stronger fill, so it is plain which one.
      ":focus-visible": grasp.quietFillPress,
      ":disabled": grasp.soft,
    },
    color: { default: grasp.ink, ":disabled": grasp.quiet },
    fontFamily: "inherit",
    fontSize: grasp.textSm,
    lineHeight: "1.125rem",
    fontWeight: grasp.weightMedium,
    whiteSpace: "nowrap",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    touchAction: "manipulation",
  },
  // An empty segment that is live says so: its words a step over muted, so it stands out from the
  // quiet ones still out of use.
  placeholder: {
    color: grasp.text,
  },
  // A segment out of use says so in its words too: as quiet as its fill, never the live muted.
  placeholderOff: {
    color: grasp.quiet,
  },
  inputOff: {
    "::placeholder": { color: grasp.quiet },
  },
  // The chosen field's icon takes its segment's colour, so it greys with the words.
  chosenIcon: {
    display: "inline-flex",
    flexShrink: 0,
  },
  words: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  // A typed value: an input that looks like the last segment.
  // As wide as what it holds, from 6ch up to 16ch, where the browser can size a field to its
  // content; else 12ch. A short value no longer trails a wide empty fill.
  // The browser's spin buttons are hidden: they took 15px at the end even unseen, and 6ch at least
  // left "1000" 9px from its divider and 22px from the end (third look A3-text-03). Now a value
  // has the segment's own 6px on each side.
  input: {
    width: { default: "12ch", "@supports (field-sizing: content)": "auto" },
    fieldSizing: "content",
    minWidth: "4ch",
    appearance: "textfield",
    "::-webkit-inner-spin-button": { appearance: "none", margin: 0 },
    "::-webkit-outer-spin-button": { appearance: "none", margin: 0 },
    maxWidth: "16ch",
    flexShrink: 1,
    justifyContent: "start",
    cursor: "text",
    outline: "none",
    "::placeholder": { color: grasp.muted },
  },
  // The outer corners follow the group's, so the focus ring keeps its shape there too. Start and end
  // follow the reading direction.
  first: {
    borderStartStartRadius: `min(${grasp.corner}, calc(${grasp.filterSegment} / 2))`,
    borderEndStartRadius: `min(${grasp.corner}, calc(${grasp.filterSegment} / 2))`,
    cornerShape: grasp.cornerShape,
  },
  middle: {},
  last: {
    borderStartEndRadius: `min(${grasp.corner}, calc(${grasp.filterSegment} / 2))`,
    borderEndEndRadius: `min(${grasp.corner}, calc(${grasp.filterSegment} / 2))`,
    cornerShape: grasp.cornerShape,
  },
  // Wrong: red words with a wavy line under them, which forced colours keep.
  invalid: {
    color: grasp.danger,
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textDecorationColor: { default: grasp.danger, [FORCED]: "CanvasText" },
  },
  // In a list, every row keeps a column for the tick at its end, the tick's own width, so the tick
  // on the chosen row never lands where a longer row's words end (third look A3-text-06).
  tickRoom: {
    flexShrink: 0,
    width: grasp.iconSm,
  },
  // In a list, the icon sits before the words.
  optionIcon: {
    display: "inline-flex",
    flexShrink: 0,
  },
});

const corners = {
  first: styles.first,
  middle: styles.middle,
  last: styles.last,
} as const;

const className = (...parts: (stylex.StyleXStyles | false | undefined)[]) =>
  stylex.props(...parts).className;

const isValidNumber = (
  value: number,
  definition: Extract<FilterValue, { type: "number" }>
) => {
  if (!Number.isFinite(value)) {
    return false;
  }
  if (definition.min !== undefined && value < definition.min) {
    return false;
  }
  if (definition.max !== undefined && value > definition.max) {
    return false;
  }
  if (definition.step !== undefined) {
    // Steps count from min when there is one, from zero otherwise.
    const offset = (value - (definition.min ?? 0)) / definition.step;
    if (Math.abs(offset - Math.round(offset)) > 1e-9) {
      return false;
    }
  }
  return true;
};

/** Whether a value fits a field's value definition. */
const fits = (
  value: string | number | null,
  definition: FilterValue
): boolean => {
  if (value === null) {
    return true;
  }
  if (definition.type === "select") {
    return definition.options.some((option) => option.id === value);
  }
  if (definition.type === "text") {
    return typeof value === "string";
  }
  return typeof value === "number" && isValidNumber(value, definition);
};

/** One segment that opens a list: the field, the operator, or a chosen value. */
const Segment = ({
  items,
  value,
  onChange,
  placeholder,
  name,
  disabled,
  position,
}: {
  items: readonly FilterOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  name: string;
  disabled?: boolean;
  position: "first" | "middle" | "last";
}) => {
  const chosen = items.find((item) => item.id === value);
  return (
    <SelectPrimitive
      items={items.map((item) => ({ value: item.id, label: item.label }))}
      value={value}
      onValueChange={(next: string | null) => {
        onChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={name}
        data-position={position}
        render={(props: Record<string, unknown>, state: SelectTriggerState) => (
          <button
            type="button"
            {...props}
            {...stylex.props(styles.segment, corners[position], focus.carrier)}
            data-open={state.open || undefined}
          />
        )}
      >
        {chosen?.icon && (
          <span aria-hidden="true" {...stylex.props(styles.chosenIcon)}>
            <Icon icon={chosen.icon} />
          </span>
        )}
        <SelectValue
          placeholder={placeholder}
          className={(state: SelectValueState) =>
            className(
              styles.words,
              state.placeholder &&
                (disabled === true ? styles.placeholderOff : styles.placeholder)
            )
          }
        />
      </SelectTrigger>
      <SelectContent
        sideOffset={popup.gap}
        collisionPadding={popup.gutter}
        {...stylex.props(list.content)}
      >
        {items.map((item) => (
          <SelectItem
            key={item.id}
            value={item.id}
            className={(state: SelectItemState) =>
              className(list.item, state.highlighted && list.itemHighlighted)
            }
          >
            {item.icon && (
              <span aria-hidden="true" {...stylex.props(styles.optionIcon)}>
                <Icon icon={item.icon} />
              </span>
            )}
            <span {...stylex.props(list.itemWords)}>{item.label}</span>
            {item.id === value ? (
              <SelectItemIndicator {...stylex.props(list.tick)}>
                <Icon icon={Tick} />
              </SelectItemIndicator>
            ) : (
              <span aria-hidden="true" {...stylex.props(styles.tickRoom)} />
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectPrimitive>
  );
};

/** The last segment for a typed value: it keeps a draft and commits on Enter or when left. */
const Typed = ({
  definition,
  value,
  onChange,
  placeholder,
  name,
  disabled,
}: {
  definition: Extract<FilterValue, { type: "number" | "text" }>;
  value: string | number | null;
  onChange: (value: string | number | null) => void;
  placeholder: string;
  name: string;
  disabled?: boolean;
}) => {
  const shown = value === null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const [wrong, setWrong] = useState(false);
  // What the browser cannot read as a number ("1e", "-") shows as empty; it is marked, not cleared.
  const [unreadable, setUnreadable] = useState(false);
  // A new value from outside (another field, a reset) replaces the draft, in the same render.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(shown);
    setUnreadable(false);
    setWrong(false);
  }

  const commit = () => {
    if (unreadable) {
      setWrong(true);
      return;
    }
    // Nothing changed: leaving the segment, or Enter then leaving, changes nothing.
    if (draft === shown) {
      setWrong(false);
      return;
    }
    if (definition.type === "text") {
      onChange(draft === "" && definition.allowEmpty !== true ? null : draft);
      return;
    }
    if (draft.trim() === "") {
      setWrong(false);
      onChange(null);
      return;
    }
    const number = Number(draft);
    if (!isValidNumber(number, definition)) {
      // Kept as typed and marked, so it can be put right; the condition keeps its last value.
      setWrong(true);
      return;
    }
    setWrong(false);
    onChange(number);
  };

  return (
    <input
      type={definition.type === "number" ? "number" : "text"}
      inputMode={definition.type === "number" ? "decimal" : undefined}
      aria-label={name}
      aria-invalid={wrong || undefined}
      placeholder={placeholder}
      value={draft}
      min={definition.type === "number" ? definition.min : undefined}
      max={definition.type === "number" ? definition.max : undefined}
      // Without a step the browser would count in ones and call 1.5 wrong; this field accepts it.
      step={
        definition.type === "number" ? (definition.step ?? "any") : undefined
      }
      disabled={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        setUnreadable(event.target.validity.badInput);
      }}
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        // Enter keeps the number here and never sends a form around it; not while a word is composed.
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        }
        // Escape puts back what was there.
        if (event.key === "Escape" && draft !== shown) {
          event.preventDefault();
          setDraft(shown);
          setUnreadable(false);
          setWrong(false);
        }
      }}
      {...stylex.props(
        styles.segment,
        styles.input,
        disabled === true && styles.inputOff,
        corners.last,
        wrong && styles.invalid,
        focus.carrier
      )}
    />
  );
};

// One object for every FilterBuilder, so the default never changes between renders.
const englishSegmentLabels = {
  field: "Filter field",
  operator: "Filter operator",
  value: "Filter value",
};

// The operator a new field keeps: the current one when the field has it, else its default when
// it has that, else none.
const carriedOperator = (
  next: FilterField,
  current: string | null
): string | null => {
  if (next.operators.some((operator) => operator.id === current)) {
    return current;
  }
  const fallback = next.defaultOperatorId;
  if (
    fallback !== undefined &&
    next.operators.some((operator) => operator.id === fallback)
  ) {
    return fallback;
  }
  return null;
};

export const FilterBuilder = ({
  fields,
  condition,
  onConditionChange,
  fieldPlaceholder = "Field",
  operatorPlaceholder = "Operator",
  valuePlaceholder = "Value",
  disabled = false,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "Filter condition",
  segmentLabels = englishSegmentLabels,
}: FilterBuilderProps) => {
  const field = fields.find((entry) => entry.id === condition.fieldId);
  const operators = field?.operators ?? [];

  const chooseField = (id: string | null) => {
    const next = fields.find((entry) => entry.id === id);
    if (!next) {
      onConditionChange({ fieldId: null, operatorId: null, value: null });
      return;
    }
    // The operator carries over when the new field has it; otherwise its default, or none.
    const operatorId = carriedOperator(next, condition.operatorId);
    // The value carries over only between fields that share a key, and only when it still fits.
    const shared =
      field?.value.compatibilityKey !== undefined &&
      field.value.compatibilityKey === next.value.compatibilityKey;
    const value =
      shared && fits(condition.value, next.value) ? condition.value : null;
    onConditionChange({ fieldId: next.id, operatorId, value });
  };

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <fieldset> brings its own border, padding and legend layout; the three segments read as one control
      role="group"
      aria-label={label}
      data-slot="filter-builder"
      {...stylex.props(styles.group, focus.fieldGroup)}
    >
      <Segment
        items={fields.map((entry) => ({
          id: entry.id,
          label: entry.label,
          icon: entry.icon,
        }))}
        value={condition.fieldId}
        onChange={chooseField}
        placeholder={fieldPlaceholder}
        name={segmentLabels.field}
        disabled={disabled}
        position="first"
      />
      <Segment
        items={operators}
        value={condition.operatorId}
        onChange={(operatorId) => {
          onConditionChange({ ...condition, operatorId });
        }}
        placeholder={operatorPlaceholder}
        name={segmentLabels.operator}
        disabled={disabled || !field}
        position="middle"
      />
      {field && field.value.type !== "select" ? (
        <Typed
          key={field.id}
          definition={field.value}
          value={condition.value}
          onChange={(value) => {
            onConditionChange({ ...condition, value });
          }}
          placeholder={valuePlaceholder}
          name={segmentLabels.value}
          disabled={disabled}
        />
      ) : (
        <Segment
          items={field?.value.type === "select" ? field.value.options : []}
          value={typeof condition.value === "string" ? condition.value : null}
          onChange={(value) => {
            onConditionChange({ ...condition, value });
          }}
          placeholder={valuePlaceholder}
          name={segmentLabels.value}
          disabled={disabled || !field}
          position="last"
        />
      )}
    </div>
  );
};
