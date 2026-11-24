// DatePicker: a field to type a date in, or choose one from a calendar,
// built on UI SDK's DatePicker: closed, it is Input's field box
// (the fill, the hairline, Button's heights and the corner) with a calendar button at its end; open,
// Calendar's months in a popup. `mode="range"` takes a start and an end, a field for each (two
// months suit it), and `presets` puts the ranges people choose often in a column beside the months,
// after the date range pickers of analytics products.
//
//   <DatePicker aria-label="Due date" name="due" defaultValue="2026-11-20" />
//   <DatePicker aria-label="Trip" mode="range" numberOfMonths={2} name="trip" />
//   <Field name="due">
//     <FieldLabel>Due date</FieldLabel>
//     <DatePicker required />
//     <FieldError match="valueMissing">Choose a due date.</FieldError>
//   </Field>
//
// A typed date is read in the page's language when it is committed (Enter or leaving the field)
// and then written out in it; text that is no date, or a date that cannot be chosen, stays, marked
// wrong, and keeps its form from being sent. The value is always an ISO date ("2026-11-20"), and the
// form gets it under `name`; a form reset brings back `defaultValue`. In a Field, the label, the
// description and the error belong to the field. Choosing a day (a range's second) or a preset
// closes the calendar; Escape closes it too, and focus goes back to where it was.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  addDays,
  datePattern,
  formatDate,
  formatDateRange,
  startOfMonth,
  todayDate,
} from "@ui-sdk/react/date";
import {
  DatePicker as RootPrimitive,
  DatePickerContent as ContentPrimitive,
  DatePickerHint as HintPrimitive,
  DatePickerInput as InputPrimitive,
  DatePickerPreset as PresetPrimitive,
  DatePickerTrigger as TriggerPrimitive,
} from "@ui-sdk/react/date-picker";
import type {
  DatePickerPresetState,
  DatePickerState,
} from "@ui-sdk/react/date-picker";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ComponentProps } from "react";

import { useI18n, useLocale } from "../lib/i18n";
import { CalendarIcon, CheckIcon, Icon } from "../lib/icons";
import { transformOriginFromTrigger } from "../lib/layer";
import {
  focusCarrier,
  focusField,
  focusRing,
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
  size,
  space,
} from "../lib/tokens.stylex";
import { popup, px } from "../lib/tokens.values";
import { isInvalid } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars } from "../lib/vars.stylex";
import { Button } from "./button";
import { CalendarMonths } from "./calendar";

type RootProps = ComponentProps<typeof RootPrimitive>;

/** A range people choose often, by name, offered beside a range's calendar. */
export interface DatePickerPreset {
  /** Its name on the button ("Last 7 days"). */
  label: string;
  /** The range it chooses, as ISO dates. */
  value: [string, string];
}

type Value = string | [string, string] | null;

/** Every prop a DatePicker takes: these, and the rest of UI SDK's DatePicker. */
export interface DatePickerProps extends Omit<
  RootProps,
  | "children"
  | "render"
  | "className"
  | "style"
  | "mode"
  | "value"
  | "defaultValue"
  | "onValueChange"
  | "months"
  | "presentation"
> {
  /** The field's name for a screen reader, a voice command and an agent ("Due date"). Inside a Field, its FieldLabel serves. */
  "aria-label"?: string;
  /**
   * One date, or a range: a start and an end, a field for each.
   * @default "single"
   */
  mode?: "single" | "range";
  /** The chosen date as an ISO date, `[start, end]` for a range, or `null`. Pass it with `onValueChange` to hold it yourself. */
  value?: Value;
  /** The date it starts with, and goes back to when its form resets. */
  defaultValue?: Value;
  /** Runs when a date is chosen or a typed one committed; a range once both its ends are, or a preset is pressed. */
  onValueChange?: (value: Value) => void;
  /**
   * How many months the calendar shows side by side. Two suit a range. A phone shows one: two do
   * not fit beside each other.
   * @default 1
   */
  numberOfMonths?: number;
  /**
   * The height, the same as Input's and Button's: `sm` 32px, `default` 36px, `lg` 44px.
   * @default "default"
   */
  size?: "sm" | "default" | "lg";
  /**
   * The calendar button's whole name, in the page's language, in place of the I18nProvider's
   * (`datePicker.select`) and the date after it.
   */
  triggerLabel?: string;
  /**
   * For a range: the ranges offered in a column beside the months. `true` for Today, Last 7 days,
   * Last 30 days and This month, counted from today (`today`, else the browser's, in `timeZone`),
   * named by the I18nProvider; your own as a list. The one matching the range shows as chosen.
   * @default false
   */
  presets?: DatePickerPreset[] | boolean;
  /** The name the date is sent under, as an ISO date. A range sends both ends under it. Inside a Field, the Field's `name` serves. */
  name?: string;
  /** For a range: the name its start is sent under, in place of `name`. */
  startName?: string;
  /** For a range: the name its end is sent under, in place of `name`. */
  endName?: string;
  /** A date must be given before its form is sent. Inside a Field, its label shows the required mark. @default false */
  required?: boolean;
  /**
   * Wrong, by a check of the page's own: the destructive edge, on its date fields. A typed date
   * that is no date, or cannot be chosen, marks it by itself.
   */
  "aria-invalid"?: boolean | "true" | "false";
  /**
   * Whether the days of the months before and after show at the grid's edges, in a quieter colour.
   * @default true for one month, false for more
   */
  showOutsideDays?: boolean;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

const PHONE = media.maxSm;
const FORCED = media.forcedColors;
const COARSE = media.pointerCoarse;
const HOVER = media.hover;
const TYPING = media.maxSmOrCoarse;
const SIZES = "@supports (field-sizing: content)";
// Focus in its words, from the keys or a press: the field's edge shows it, as Input's does.
const TYPED_IN = ":has(input:focus-visible)";
const edge = `inset 0 0 0 1px ${colors.input}, ${shadow.inputShadow}`;

const styles = stylex.create({
  // The field: Input's fill, hairline and lift, its focus edge while its words have focus.
  field: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space[1],
    boxSizing: "border-box",
    width: "100%",
    maxWidth: size.popupWidth,
    paddingInlineStart: space.datePickerFieldPadding,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "currentColor",
    cornerShape: radius.shape,
    backgroundColor: colors.inputBg,
    boxShadow: edge,
    transitionProperty: "box-shadow, background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // Open for typing: the hairline deepens under a pointer and takes the focus edge while its words
  // have focus. Not while it is read only or disabled.
  live: {
    boxShadow: {
      default: edge,
      ":hover:not(:has(input:focus-visible))": {
        default: null,
        [HOVER]: `inset 0 0 0 1px ${colors.inputBorderHover}, ${shadow.inputShadow}`,
      },
      [TYPED_IN]: size.inputFocus,
    },
  },
  // Input's heights and corners; on a touch screen every size is a fingertip's target. The calendar
  // button, a size below the field's, stands as far from the field's end as from its top and bottom.
  sm: {
    minHeight: { default: size.controlSm, [COARSE]: size.tapTarget },
    borderRadius: `min(${radius.xl}, calc(${size.controlSm} / 2))`,
    paddingInlineEnd: {
      default: `calc((${size.controlSm} - ${size.controlXs}) / 2)`,
      [COARSE]: `calc((${size.tapTarget} - ${size.controlXs}) / 2)`,
    },
  },
  default: {
    minHeight: { default: size.controlDefault, [COARSE]: size.tapTarget },
    borderRadius: `min(${radius.xl}, calc(${size.controlDefault} / 2))`,
    paddingInlineEnd: {
      default: `calc((${size.controlDefault} - ${size.controlSm}) / 2)`,
      [COARSE]: `calc((${size.tapTarget} - ${size.controlSm}) / 2)`,
    },
  },
  lg: {
    minHeight: size.controlLg,
    borderRadius: `min(${radius.xl}, calc(${size.controlLg} / 2))`,
    paddingInlineEnd: `calc((${size.controlLg} - ${size.controlDefault}) / 2)`,
  },
  // A typed date that is no date, or one that cannot be chosen: Input's destructive edge.
  invalid: {
    boxShadow: {
      default: size.inputInvalid,
      [TYPED_IN]: size.inputFocusInvalid,
    },
    // In forced colours the tint is dropped: a wrong field's edge turns dashed instead, the same 1px.
    borderStyle: { default: "solid", [FORCED]: "dashed" },
  },
  // A range with presets names two dates, so its field is wider. On a phone the dates are 16px and
  // two must fit a narrow field whole: the start's inset is a step less there.
  rangeField: {
    maxWidth: size.datePickerRangeWidth,
    paddingInlineStart: {
      default: space.datePickerFieldPadding,
      [TYPING]: space[2],
    },
  },
  // Settled, as Input's; disabled is the weaker look.
  readOnly: {
    backgroundColor: colors.inputBgRead,
    boxShadow: {
      default: `inset 0 0 0 1px ${colors.input}`,
      [TYPED_IN]: size.inputFocusRead,
    },
  },
  disabled: { opacity: size.opacityDisabled, cursor: "not-allowed" },
  // The words typed, with no box of their own: the field is the box. As tall as the field, so a
  // press anywhere on it puts the caret in the words.
  input: {
    alignSelf: "stretch",
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    appearance: "none",
    backgroundColor: "transparent",
    color: {
      default: colors.foreground,
      ":read-only:not(:disabled)": colors.inputForegroundRead,
    },
    caretColor: colors.foreground,
    fontFamily: font.sans,
    fontSize: { default: font.textSm, [TYPING]: size.inputTextTouch },
    lineHeight: font.textSmLine,
    fontVariantNumeric: "tabular-nums",
    cursor: { default: "text", ":disabled": "not-allowed" },
    // The field draws focus round all its parts (focusField.within); the words draw none.
    outline: "none",
    "::selection": {
      backgroundColor: colors.inputSelection,
      color: colors.foreground,
    },
    "::placeholder": { color: colors.mutedForeground, opacity: 1 },
  },
  // A range's two dates, each as wide as its words (or its placeholder), so the range reads as one
  // phrase; the end also takes the room after it, so a press there reaches it. Neither grows past
  // half the field. Where a browser cannot size a field to its words, the two share the room.
  rangeDate: {
    fieldSizing: "content",
    flexGrow: { default: 1, [SIZES]: 0 },
    flexBasis: { default: 0, [SIZES]: "auto" },
    flexShrink: 1,
    maxWidth: "50%",
    textOverflow: "ellipsis",
  },
  rangeEnd: { flexGrow: 1, maxWidth: "none" },
  // Between a range's two dates: the field's gap and as much again on each side; on a phone only
  // the field's gap, so both dates fit whole.
  between: {
    flexShrink: 0,
    marginInline: { default: space[1], [TYPING]: 0 },
    color: colors.mutedForeground,
  },
  // The panel: a popup's surface (lib/styles), as wide as its months and never wider than the
  // window less its gutters, with Popover's padding. As a sheet (a range with presets on a phone),
  // the window's width.
  content: {
    width: { default: "max-content", ":is([data-presentation=sheet])": "100%" },
    maxWidth: {
      default: `min(100vw - 2 * ${space.popupGutter}, var(--available-width, 100vw))`,
      ":is([data-presentation=sheet])": "none",
    },
    padding: space.popoverPadding,
    scrollPaddingBlock: space.popoverPadding,
  },
  inner: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
  },
  // The presets beside the months; over them on a phone, the month centred under the presets.
  innerPresets: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: { default: null, [PHONE]: "center" },
    gap: space[4],
  },
  calendar: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    minWidth: 0,
  },
  // A fieldset, with the browser's own border, padding, margin and minimum width taken off. On a
  // phone the presets stand in two equal columns over the month.
  presets: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    minWidth: 0,
    display: { default: "flex", [PHONE]: "grid" },
    flexDirection: "column",
    gridTemplateColumns: {
      default: null,
      [PHONE]: "repeat(2, minmax(0, 1fr))",
    },
    gap: space[1],
    width: { default: size.datePickerRangePresets, [PHONE]: "100%" },
    flexShrink: 0,
  },
  // A preset: a row the height of a small control, its words at the start, the tick at the end.
  preset: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: space[2],
    boxSizing: "border-box",
    minHeight: {
      default: size.controlSm,
      [COARSE]: size.tapTarget,
    },
    margin: 0,
    paddingBlock: 0,
    paddingInline: space[2],
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: `min(${radius.xl}, calc(${size.controlSm} / 2))`,
    cornerShape: radius.shape,
    backgroundColor: {
      default: "transparent",
      ":hover:not(:disabled)": { default: null, [HOVER]: colors.accent },
    },
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    textAlign: "start",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    opacity: { default: 1, ":disabled": size.opacityDisabled },
    WebkitTapHighlightColor: "transparent",
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // The chosen preset takes the chosen fill and a tick.
  presetChosen: {
    backgroundColor: {
      default: colors.treeViewBgSelected,
      ":hover": colors.treeViewBgSelected,
      [FORCED]: "Highlight",
    },
    color: { default: colors.foreground, [FORCED]: "HighlightText" },
  },
  presetWords: { flexGrow: 1, minWidth: 0 },
});

const sizeStyles = {
  sm: styles.sm,
  default: styles.default,
  lg: styles.lg,
} as const;

/** The calendar button, a size below the field's, so it stands as far in at every size. */
const triggerSizes = {
  sm: "icon-xs",
  default: "icon-sm",
  lg: "icon",
} as const;

/** The default presets, counted from `today`. */
const defaultPresets = (
  today: string,
  labels: [string, string, string, string]
): DatePickerPreset[] => [
  { label: labels[0], value: [today, today] },
  { label: labels[1], value: [addDays(today, -6), today] },
  { label: labels[2], value: [addDays(today, -29), today] },
  // From the first of the month to today: a range that runs past today is refused by a `max` of today.
  { label: labels[3], value: [startOfMonth(today), today] },
];

/** Nothing to undo. */
const noCleanup = () => {
  // A given today, or no default presets, starts nothing, so nothing stops.
};

/** Reads today now and each time the page comes back into view; the result stops it. */
const watchToday = (
  timeZone: string | undefined,
  setToday: (today: string) => void
) => {
  const read = () => {
    setToday(todayDate(timeZone));
  };
  read();
  document.addEventListener("visibilitychange", read);
  return () => {
    document.removeEventListener("visibilitychange", read);
  };
};

/**
 * Today, read on the client when the default presets need it: they count from it, so they wait
 * for the page to start. Read again when the page comes back into view, so a page left open
 * overnight moves on.
 */
const useToday = (wanted: boolean, given?: string, timeZone?: string) => {
  const [today, setToday] = useState<string | undefined>(given);
  useEffect(() => {
    const fixed = given !== undefined && given !== "";
    return fixed || !wanted ? noCleanup : watchToday(timeZone, setToday);
  }, [wanted, given, timeZone]);
  return given ?? today;
};

// The phone breakpoint, read where it can be: on the server there is no window, and the picker
// draws for a wide one.
const NARROW = `(width < ${px.sm}px)`;
const watchPhone = (change: () => void) => {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", change);
  return () => {
    query.removeEventListener("change", change);
  };
};
const onPhone = () => window.matchMedia(NARROW).matches;
const notOnPhone = () => false;

// The page's language, as UI SDK's DatePicker reads it: the `lang` of the page, read once the page
// has started; on the server, and while the page starts, US English, so both draw the same words.
const SERVER_LOCALE = "en-US";
const noWatch = () => () => {
  // The page's language is read once; nothing to stop.
};
const readLang = () => {
  const lang = document.documentElement.closest("[lang]")?.getAttribute("lang");
  return lang === null || lang === undefined || lang === "" ? undefined : lang;
};
const serverLang = () => SERVER_LOCALE;

// A date written out, with its weekday, as the calendar button's name says it.
const long: Intl.DateTimeFormatOptions = {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
};

/**
 * The format to type a date in, as an empty field's placeholder: the locale's order, separators and
 * letters for day, month and year (UI SDK's pattern, its letters from Intl), quiet in lower case
 * ("mm/dd/yyyy", "dd-mm-jjjj" in Dutch).
 */
const placeholderOf = (locale: string) =>
  datePattern(locale).placeholder.toLocaleLowerCase(locale);

/** The chosen date as the calendar button says it, or "" for none. */
const saidOf = (value: Value, locale: string): string => {
  if (value === null || value === "") {
    return "";
  }
  return Array.isArray(value)
    ? formatDateRange(value[0], value[1], locale, long)
    : formatDate(value, locale, long);
};

/** A value the picker hands back, as DatePicker holds it. */
const valueFrom = (next: unknown): Value | undefined => {
  if (typeof next === "string" || next === null) {
    return next;
  }
  if (
    Array.isArray(next) &&
    typeof next[0] === "string" &&
    typeof next[1] === "string"
  ) {
    return [next[0], next[1]];
  }
  return undefined;
};

/** The presets offered: none, the defaults once today is known, or the page's own. */
const useOffered = (
  range: boolean,
  presets: DatePickerPreset[] | boolean,
  given: string | undefined,
  timeZone: string | undefined
): DatePickerPreset[] => {
  const words = useI18n().datePicker;
  const today = useToday(range && presets === true, given, timeZone);
  if (!range || presets === false) {
    return [];
  }
  if (presets !== true) {
    return presets;
  }
  return today === undefined || today === ""
    ? []
    : defaultPresets(today, [
        words.today,
        words.last7,
        words.last30,
        words.thisMonth,
      ]);
};

/** The presets' column, named as a group: the one matching the range is pressed. */
const Presets = ({ offered }: { offered: DatePickerPreset[] }) => {
  const words = useI18n().datePicker;
  return (
    <fieldset aria-label={words.presets} {...stylex.props(styles.presets)}>
      {offered.map((preset) => (
        <PresetPrimitive
          key={`${preset.value[0]}/${preset.value[1]}`}
          value={preset.value}
          render={(
            props: Record<string, unknown>,
            state: DatePickerPresetState
          ) => (
            <button
              type="button"
              {...props}
              {...stylex.props(
                styles.preset,
                state.selected && styles.presetChosen,
                focusRing
              )}
            >
              <span {...stylex.props(styles.presetWords)}>{preset.label}</span>
              {state.selected && <Icon icon={CheckIcon} />}
            </button>
          )}
        />
      ))}
    </fieldset>
  );
};

/** The field's words: one date, or a range's start and end with a dash between. */
const Dates = ({
  range,
  label,
  placeholder,
  invalid,
}: {
  range: boolean;
  label: string | undefined;
  placeholder: string;
  invalid: boolean;
}) => {
  const words = useI18n().datePicker;
  const wrong = invalid || undefined;
  if (!range) {
    return (
      <InputPrimitive
        aria-label={label}
        aria-invalid={wrong}
        placeholder={placeholder}
        {...stylex.props(styles.input, focusCarrier)}
      />
    );
  }
  const field = label ?? words.rangeTrigger;
  return (
    <>
      <InputPrimitive
        aria-label={words.rangeStart(field)}
        aria-invalid={wrong}
        placeholder={placeholder}
        {...stylex.props(styles.input, styles.rangeDate, focusCarrier)}
      />
      <span aria-hidden="true" {...stylex.props(styles.between)}>
        –
      </span>
      <InputPrimitive
        end
        aria-label={words.rangeEnd(field)}
        aria-invalid={wrong}
        placeholder={placeholder}
        {...stylex.props(
          styles.input,
          styles.rangeDate,
          styles.rangeEnd,
          focusCarrier
        )}
      />
    </>
  );
};

/** The language dates are read and written in: the picker's, the I18nProvider's, else the page's. */
const usePickerLocale = (given: string | undefined): string => {
  const provided = useLocale();
  const page = useSyncExternalStore(noWatch, readLang, serverLang);
  return given ?? provided ?? page ?? SERVER_LOCALE;
};

/** The field box's look, from the picker's state. */
const fieldLook = (
  state: DatePickerState,
  {
    scale,
    wide,
    invalid,
    style,
  }: {
    scale: "sm" | "default" | "lg";
    wide: boolean;
    invalid: boolean;
    style: LayoutStyle | undefined;
  }
) =>
  stylex.props(
    styles.field,
    !state.readOnly && !state.disabled && styles.live,
    sizeStyles[scale],
    wide && styles.rangeField,
    state.readOnly && styles.readOnly,
    state.disabled && styles.disabled,
    (invalid || state.invalid) && styles.invalid,
    focusField.within,
    style
  );

/** A field to type a date in, or a range, with a calendar to choose from. */
export const DatePicker = ({
  "aria-label": ariaLabel,
  mode = "single",
  value: given,
  defaultValue = null,
  onValueChange,
  numberOfMonths = 1,
  size: scale = "default",
  triggerLabel,
  presets = false,
  "aria-invalid": ariaInvalid,
  showOutsideDays,
  style,
  locale: localeGiven,
  ...rest
}: DatePickerProps) => {
  const words = useI18n().datePicker;
  const invalid = isInvalid(ariaInvalid);
  const locale = usePickerLocale(localeGiven);
  const range = mode === "range";
  // The value as the picker holds it, for the calendar button's name.
  const [held, setHeld] = useState<Value>(defaultValue);
  const value = given === undefined ? held : given;
  const offered = useOffered(range, presets, rest.today, rest.timeZone);
  const withPresets = offered.length > 0;
  // One month on a phone: two do not fit beside each other, and stacked they ran past the window.
  const narrow = useSyncExternalStore(watchPhone, onPhone, notOnPhone);
  const months = narrow ? 1 : numberOfMonths;
  const said = saidOf(value, locale);
  const choose = range ? words.rangeTrigger : words.select;
  const named =
    triggerLabel ?? (said === "" ? choose : words.triggerWith(choose, said));
  return (
    <RootPrimitive
      {...rest}
      locale={locale}
      mode={mode}
      value={given}
      defaultValue={defaultValue}
      onValueChange={(next: unknown) => {
        const chosen = valueFrom(next);
        if (chosen !== undefined) {
          setHeld(chosen);
          onValueChange?.(chosen);
        }
      }}
      months={months}
      // One month shows the days round it; months side by side leave them to the next month.
      showOutsideDays={showOutsideDays ?? months === 1}
      // With presets, months side by side always draw six weeks, so the popup keeps one height as
      // it pages.
      fixedWeeks={rest.fixedWeeks ?? (withPresets && months > 1)}
      // A range with presets on a phone: a sheet from the window's foot, where a month and its
      // presets do not fit above or below the field.
      presentation={withPresets && narrow ? "sheet" : "popover"}
      render={(props: Record<string, unknown>, state: DatePickerState) => (
        <div
          {...props}
          data-slot="date-picker"
          {...fieldLook(state, { scale, wide: withPresets, invalid, style })}
        />
      )}
    >
      <Dates
        range={range}
        label={ariaLabel}
        placeholder={placeholderOf(locale)}
        invalid={invalid}
      />
      <TriggerPrimitive
        aria-label={named}
        render={({
          children: _children,
          ...props
        }: Record<string, unknown>) => (
          <Button
            {...props}
            data-slot="date-picker-trigger"
            variant="ghost"
            size={triggerSizes[scale]}
            aria-label={named}
          >
            <Icon icon={CalendarIcon} />
          </Button>
        )}
      />
      <HintPrimitive {...stylex.props(visuallyHidden)} />
      <ContentPrimitive
        ref={transformOriginFromTrigger}
        align="start"
        alignOffset={-popup.datePickerFieldPadding}
        sideOffset={popup.popoverGap}
        collisionPadding={popup.gutter}
        aria-label={choose}
        {...stylex.props(listStyles.popup, styles.content, scrollbarHidden)}
      >
        <div
          data-slot="date-picker-content"
          {...stylex.props(styles.inner, withPresets && styles.innerPresets)}
        >
          {withPresets && <Presets offered={offered} />}
          <div {...stylex.props(styles.calendar)}>
            <CalendarMonths numberOfMonths={months} />
          </div>
        </div>
      </ContentPrimitive>
    </RootPrimitive>
  );
};
