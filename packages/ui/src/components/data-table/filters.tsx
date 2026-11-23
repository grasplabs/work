// DataTableFilters: one filter condition, built from a field, an operator and a value in one joined
// control. Each field says which operators it takes and what its value is: chosen from a list, a
// number, or words. The field and the operator open Select's list; a number or words are typed
// straight into the last segment. A Data table with `filterable` draws one from its columns.
//
//   <DataTableFilters fields={fields} condition={condition} onConditionChange={setCondition} />
//
// The caller owns the whole condition. Changing the field keeps the operator when the new field has
// it, and keeps the value only when both fields share a `compatibilityKey` and it still fits.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  SelectTrigger as TriggerPrimitive,
  SelectValue as ValuePrimitive,
} from "@ui-sdk/react/select";
import type { SelectValueState } from "@ui-sdk/react/select";
import { useState } from "react";
import type { KeyboardEvent } from "react";

import { useI18n } from "../../lib/i18n";
import { Icon } from "../../lib/icons";
import type { IconData } from "../../lib/icons";
import { focusCarrier, focusField } from "../../lib/styles";
import {
  colors,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../../lib/tokens.stylex";
import { className } from "../../lib/utils";
import { iconVars } from "../../lib/vars.stylex";
import { Select, SelectContent, SelectItem } from "../select";

/** One operator a field takes: "is", "is greater than". */
export interface DataTableFilterOperator {
  /** Names the operator in the condition. */
  id: string;
  /** Its words on the segment and in the list. */
  label: string;
}

/** One value to choose from, for a field whose value is chosen. */
export interface DataTableFilterOption {
  id: string;
  label: string;
  /** An icon before the words, from lib/icons. */
  icon?: IconData;
}

/** What a field's value is, and how it is entered. */
export type DataTableFilterValue =
  | {
      /** Chosen from a list. */
      type: "select";
      options: readonly DataTableFilterOption[];
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
export interface DataTableFilterField {
  id: string;
  label: string;
  /** An icon before the words, from lib/icons. */
  icon?: IconData;
  operators: readonly DataTableFilterOperator[];
  /** The operator chosen when this field is, if the last one does not carry over. */
  defaultOperatorId?: string;
  value: DataTableFilterValue;
}

/** The whole condition: each part is `null` until it is chosen. */
export interface DataTableFilterCondition {
  fieldId: string | null;
  operatorId: string | null;
  value: string | number | null;
}

/** Every prop a DataTableFilters takes. */
export interface DataTableFiltersProps {
  /** The fields to build on, with their operators and values. */
  fields: readonly DataTableFilterField[];
  /** The condition, which you keep in state. */
  condition: DataTableFilterCondition;
  /** Runs with the whole next condition after any segment changes. */
  onConditionChange: (condition: DataTableFilterCondition) => void;
  /**
   * Every segment out of use.
   * @default false
   */
  disabled?: boolean;
  /**
   * Its name, as one group.
   * @default the I18nProvider's `dataTable.filterName`: "Filter condition"
   */
  "aria-label"?: string;
}

export const noCondition: DataTableFilterCondition = {
  fieldId: null,
  operatorId: null,
  value: null,
};

const corner = `min(${radius.xl}, calc(${size.dataTableFilterSegment} / 2))`;

const styles = stylex.create({
  // The segments stand on the line's colour, 1px apart, so the gaps draw the dividers.
  group: {
    // Holds the lists' hidden form inputs, which are placed absolutely.
    position: "relative",
    display: "inline-flex",
    alignItems: "stretch",
    maxWidth: "100%",
    gap: size.dataTableFilterDivider,
    overflow: "hidden",
    borderRadius: corner,
    cornerShape: radius.shape,
    backgroundColor: {
      default: colors.border,
      [media.forcedColors]: "CanvasText",
    },
    boxShadow: shadow.sm,
    fontFamily: font.sans,
  },
  segment: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: space[1],
    boxSizing: "border-box",
    // A chosen field or operator keeps its words whole (a typed value gives way instead), and on a
    // touch screen every segment is at least 44px across, as tall as it is there.
    flexShrink: 0,
    justifyContent: "center",
    minWidth: { default: 0, [media.pointerCoarse]: size.tapTarget },
    height: {
      default: size.dataTableFilterSegment,
      [media.pointerCoarse]: size.tapTarget,
    },
    margin: 0,
    paddingBlock: 0,
    paddingInline: "6px",
    borderWidth: 0,
    backgroundColor: {
      default: colors.control,
      ":hover": { default: null, [media.hover]: colors.controlHover },
      ":is([aria-expanded=true])": colors.controlHover,
      // The part the keyboard is on: the ring goes round the whole control (focusField.group), and
      // this part takes the stronger fill, so it is plain which one.
      ":focus-visible": colors.controlActive,
      ":disabled": colors.muted,
    },
    color: { default: colors.foreground, ":disabled": colors.subtleForeground },
    fontFamily: "inherit",
    fontSize: font.textSm,
    lineHeight: "1.125rem",
    fontWeight: font.weightMedium,
    whiteSpace: "nowrap",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    touchAction: "manipulation",
  },
  // The outer corners follow the group's, so the focus ring keeps its shape there too.
  first: {
    borderStartStartRadius: corner,
    borderEndStartRadius: corner,
    cornerShape: radius.shape,
  },
  last: {
    borderStartEndRadius: corner,
    borderEndEndRadius: corner,
    cornerShape: radius.shape,
  },
  // An empty segment that is live says so: its words a step over muted; one out of use stays quiet.
  placeholder: { color: colors.bodyForeground },
  placeholderOff: { color: colors.subtleForeground },
  words: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  icon: { display: "inline-flex", flexShrink: 0 },
  // A typed value: an input that looks like the last segment, as wide as what it holds (6ch to
  // 16ch) where the browser can size a field to its content, else 12ch. The spin buttons go.
  input: {
    width: { default: "12ch", "@supports (field-sizing: content)": "auto" },
    fieldSizing: "content",
    minWidth: "4ch",
    maxWidth: "16ch",
    appearance: "textfield",
    "::-webkit-inner-spin-button": { appearance: "none", margin: 0 },
    "::-webkit-outer-spin-button": { appearance: "none", margin: 0 },
    flexShrink: 1,
    justifyContent: "start",
    cursor: "text",
    outline: "none",
    "::placeholder": { color: colors.mutedForeground },
  },
  inputOff: { "::placeholder": { color: colors.subtleForeground } },
  // Wrong: red words with a wavy line under them, which forced colours keep.
  invalid: {
    color: colors.destructive,
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textDecorationColor: {
      default: colors.destructive,
      [media.forcedColors]: "CanvasText",
    },
  },
});

const isValidNumber = (
  value: number,
  definition: Extract<DataTableFilterValue, { type: "number" }>
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
  if (definition.step === undefined) {
    return true;
  }
  // Steps count from min when there is one, from zero otherwise.
  const offset = (value - (definition.min ?? 0)) / definition.step;
  return Math.abs(offset - Math.round(offset)) <= 1e-9;
};

/** Whether a value fits a field's value definition. */
const fits = (
  value: string | number | null,
  definition: DataTableFilterValue
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
  items: readonly DataTableFilterOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
  name: string;
  disabled: boolean;
  position: "first" | "middle" | "last";
}) => {
  const chosen = items.find((item) => item.id === value);
  return (
    <Select
      items={items.map((item) => ({ value: item.id, label: item.label }))}
      value={value}
      onValueChange={onChange}
      disabled={disabled}
    >
      <TriggerPrimitive
        aria-label={name}
        render={
          <button
            type="button"
            {...stylex.props(
              styles.segment,
              position === "first" && styles.first,
              position === "last" && styles.last,
              focusCarrier
            )}
          />
        }
      >
        {chosen?.icon && (
          <span aria-hidden="true" {...stylex.props(styles.icon)}>
            <Icon icon={chosen.icon} />
          </span>
        )}
        <ValuePrimitive
          placeholder={placeholder}
          className={(state: SelectValueState) =>
            className(
              styles.words,
              state.placeholder &&
                (disabled ? styles.placeholderOff : styles.placeholder)
            )
          }
        />
      </TriggerPrimitive>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.id} value={item.id} label={item.label}>
            {item.icon && (
              <span aria-hidden="true" {...stylex.props(styles.icon)}>
                <Icon icon={item.icon} />
              </span>
            )}
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  definition: Extract<DataTableFilterValue, { type: "number" | "text" }>;
  value: string | number | null;
  onChange: (value: string | number | null) => void;
  placeholder: string;
  name: string;
  disabled: boolean;
}) => {
  const shown = value === null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  const [wrong, setWrong] = useState(false);
  // What the browser cannot read as a number ("1e", "-") shows as empty; it is marked, not cleared.
  const [unreadable, setUnreadable] = useState(false);
  // A new value from outside (another field, a reset) replaces the draft, in the same render.
  const [seen, setSeen] = useState(value);
  const reset = () => {
    setDraft(shown);
    setUnreadable(false);
    setWrong(false);
  };
  if (seen !== value) {
    setSeen(value);
    reset();
  }
  const number = definition.type === "number";

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
    // Wrong, it is kept as typed and marked, so it can be put right; the condition keeps its value.
    const next = Number(draft);
    const valid = isValidNumber(next, definition);
    setWrong(!valid);
    if (valid) {
      onChange(next);
    }
  };

  return (
    <input
      type={number ? "number" : "text"}
      inputMode={number ? "decimal" : undefined}
      aria-label={name}
      aria-invalid={wrong || undefined}
      placeholder={placeholder}
      value={draft}
      min={number ? definition.min : undefined}
      max={number ? definition.max : undefined}
      // Without a step the browser would count in ones and call 1.5 wrong; this field accepts it.
      step={number ? (definition.step ?? "any") : undefined}
      disabled={disabled}
      onChange={(event) => {
        setDraft(event.target.value);
        setUnreadable(event.target.validity.badInput);
      }}
      onBlur={commit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        // Enter keeps the value here and never sends a form around it; not while a word is composed.
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        }
        // Escape puts back what was there.
        if (event.key === "Escape" && draft !== shown) {
          event.preventDefault();
          reset();
        }
      }}
      {...stylex.props(
        styles.segment,
        styles.input,
        disabled && styles.inputOff,
        styles.last,
        wrong && styles.invalid,
        focusCarrier
      )}
    />
  );
};

// The operator a new field keeps: the current one when the field has it, else its default when it
// has that, else none.
const carriedOperator = (
  next: DataTableFilterField,
  current: string | null
): string | null => {
  const holds = (id: string | null | undefined) =>
    next.operators.some((operator) => operator.id === id);
  if (holds(current)) {
    return current;
  }
  return holds(next.defaultOperatorId)
    ? (next.defaultOperatorId ?? null)
    : null;
};

/** A filter condition built from a field, an operator and a value, as one joined control. */
export const DataTableFilters = ({
  fields,
  condition,
  onConditionChange,
  disabled = false,
  "aria-label": label,
}: DataTableFiltersProps) => {
  const { dataTable: words } = useI18n();
  const field = fields.find((entry) => entry.id === condition.fieldId);

  const chooseField = (id: string | null) => {
    const next = fields.find((entry) => entry.id === id);
    if (next === undefined) {
      onConditionChange(noCondition);
      return;
    }
    // The value carries over only between fields that share a key, and only when it still fits.
    const shared =
      field?.value.compatibilityKey !== undefined &&
      field.value.compatibilityKey === next.value.compatibilityKey;
    onConditionChange({
      fieldId: next.id,
      operatorId: carriedOperator(next, condition.operatorId),
      value:
        shared && fits(condition.value, next.value) ? condition.value : null,
    });
  };

  return (
    <div
      // A <fieldset> brings its own border, padding and legend layout; the segments read as one control.
      role="group"
      aria-label={label ?? words.filterName}
      data-slot="data-table-filters"
      {...stylex.props(styles.group, focusField.group)}
    >
      <Segment
        items={fields}
        value={condition.fieldId}
        onChange={chooseField}
        placeholder={words.filterField}
        name={words.filterSegments.field}
        disabled={disabled}
        position="first"
      />
      <Segment
        items={field?.operators ?? []}
        value={condition.operatorId}
        onChange={(operatorId) => {
          onConditionChange({ ...condition, operatorId });
        }}
        placeholder={words.filterOperator}
        name={words.filterSegments.operator}
        disabled={disabled || field === undefined}
        position="middle"
      />
      {field !== undefined && field.value.type !== "select" ? (
        <Typed
          key={field.id}
          definition={field.value}
          value={condition.value}
          onChange={(value) => {
            onConditionChange({ ...condition, value });
          }}
          placeholder={words.filterValue}
          name={words.filterSegments.value}
          disabled={disabled}
        />
      ) : (
        <Segment
          items={field?.value.type === "select" ? field.value.options : []}
          value={typeof condition.value === "string" ? condition.value : null}
          onChange={(value) => {
            onConditionChange({ ...condition, value });
          }}
          placeholder={words.filterValue}
          name={words.filterSegments.value}
          disabled={disabled || field === undefined}
          position="last"
        />
      )}
    </div>
  );
};

// ---- A Data table's filter, from its columns -----------------------------------------------------

/** How a column is filtered: words it holds, a figure it is at least or at most, or one of a few values. */
export type ColumnFilter = "text" | "number" | { options: readonly string[] };

/** The field a column gives the filter, with its operators in the reader's words. */
export const fieldFor = (
  id: string,
  label: string,
  kind: ColumnFilter,
  words: ReturnType<typeof useI18n>["dataTable"]
): DataTableFilterField => {
  if (kind === "number") {
    return {
      id,
      label,
      operators: [
        { id: "at-least", label: words.filterAtLeast },
        { id: "at-most", label: words.filterAtMost },
        { id: "is", label: words.filterIs },
      ],
      defaultOperatorId: "at-least",
      value: { type: "number" },
    };
  }
  if (typeof kind === "object") {
    return {
      id,
      label,
      operators: [
        { id: "is", label: words.filterIs },
        { id: "is-not", label: words.filterIsNot },
      ],
      defaultOperatorId: "is",
      value: {
        type: "select",
        options: kind.options.map((option) => ({ id: option, label: option })),
      },
    };
  }
  return {
    id,
    label,
    operators: [
      { id: "contains", label: words.filterContains },
      { id: "lacks", label: words.filterLacks },
    ],
    defaultOperatorId: "contains",
    value: { type: "text" },
  };
};

/** The condition says something: a field and a value are chosen. */
export const isSet = (condition: DataTableFilterCondition) =>
  condition.fieldId !== null &&
  condition.value !== null &&
  condition.value !== "";

/** A value as words: a string or a figure as it is, anything else none. */
export const asText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** Whether a value meets the condition. */
export const passes = (value: unknown, condition: DataTableFilterCondition) => {
  const wanted = condition.value;
  if (wanted === null || wanted === "") {
    return true;
  }
  const { operatorId } = condition;
  if (operatorId === "at-least") {
    return Number(value) >= Number(wanted);
  }
  if (operatorId === "at-most") {
    return Number(value) <= Number(wanted);
  }
  if (operatorId === "is" || operatorId === "is-not") {
    return (asText(value) === String(wanted)) === (operatorId === "is");
  }
  const holds = asText(value)
    .toLowerCase()
    .includes(String(wanted).toLowerCase());
  return operatorId === "lacks" ? !holds : holds;
};
