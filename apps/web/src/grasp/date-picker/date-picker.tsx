"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  DatePicker as RootPrimitive,
  DatePickerContent as ContentPrimitive,
  DatePickerHint as HintPrimitive,
  DatePickerInput as InputPrimitive,
  DatePickerPreset as PresetPrimitive,
} from "@ui-sdk/react/date-picker";
import type { DatePickerPresetState } from "@ui-sdk/react/date-picker";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ComponentProps } from "react";

import { CalendarMonths } from "../calendar/months";
import type { CalendarWords } from "../calendar/words";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, Tick } from "../icons";
import { originFromTrigger } from "../motion/origin";
import { popup, px } from "../tokens/tokens.values";
import { useWords, withGiven } from "../words/words";
import { addDays, monthOf } from "./dates";
import { datePlaceholder, defaultFormatLabels } from "./placeholder";
import type { DateFormatLabels } from "./placeholder";
import { datePickerStyles as styles } from "./styles";
import { DateTrigger } from "./trigger";
import { datePickerWords } from "./words";
import type { DatePickerWords } from "./words";

type RootProps = ComponentProps<typeof RootPrimitive>;

/** A range people choose often, by name, offered beside a range's calendar. */
export interface DatePickerPreset {
  /** Its name on the button ("Last 7 days"). */
  label: string;
  /** The range it chooses, as ISO dates. */
  value: [string, string];
}

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
  /** The field's name for a screen reader, a voice command and an agent ("Due date"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * One date, or a range with a field for its start and one for its end.
   * @default "single"
   */
  mode?: "single" | "range";
  /** The chosen date as an ISO date, `[start, end]` for a range, or `null`. Pass it with `onValueChange` to hold it yourself. */
  value?: RootProps["value"];
  /** The date it starts with, and goes back to when its form resets. */
  defaultValue?: RootProps["defaultValue"];
  /** Runs when a date is chosen or a typed one committed; a range once both ends are set. */
  onValueChange?: RootProps["onValueChange"];
  /**
   * How many months the calendar shows side by side. Two suit a range. A phone shows one: two
   * do not fit beside each other.
   * @default 1
   */
  months?: number;
  /**
   * The height, the same as Input's and Button's: `sm` 32px, `md` 36px, `lg` 44px.
   * @default "md"
   */
  size?: "sm" | "md" | "lg";
  /** The name the date is sent under, as an ISO date. A range sends both ends under it. */
  name?: string;
  /** A date must be given before the form is sent. */
  required?: boolean;
  /** Wrong, by a check of the page's own: Input's danger lift. A typed date that is not one, or cannot be chosen, marks it by itself. */
  invalid?: boolean;
  /** The earliest date that can be chosen or typed, as an ISO date. */
  min?: string;
  /** The latest date that can be chosen or typed, as an ISO date. */
  max?: string;
  /** Dates that cannot be chosen, as Calendar's `unavailable`: struck through in the calendar. */
  unavailable?: RootProps["unavailable"];
  /**
   * The name of the calendar button, in the page's language. Left out, UI SDK names it Choose
   * date, with the chosen date after it.
   */
  triggerLabel?: string;
  /**
   * The name of the calendar's Previous button, in the page's language.
   * @default "Previous month"
   */
  previousLabel?: string;
  /**
   * The name of the calendar's Next button, in the page's language.
   * @default "Next month"
   */
  nextLabel?: string;
  /**
   * The words for a range's two fields, after `label`, in the page's language.
   * @default ["start", "end"]
   */
  rangeLabels?: [string, string];
  /**
   * The words for a date's day, month and year in an empty field's placeholder, in the page's
   * language; the locale gives their order and separators ("mm/dd/yyyy").
   * @default ["dd", "mm", "yyyy"]
   */
  formatLabels?: DateFormatLabels;
  /**
   * For a range: the ranges offered in a column at the calendar's start. `true` for Today, Last 7
   * days, Last 30 days and This month, counted from today (`today`, else the browser's, in
   * `timeZone`); your own as a list. The one matching the range shows as chosen.
   * @default false
   */
  presets?: DatePickerPreset[] | boolean;
  /**
   * The names of the default presets, in the page's language.
   * @default ["Today", "Last 7 days", "Last 30 days", "This month"]
   */
  presetLabels?: [string, string, string, string];
  /**
   * The name of the presets' group, in the page's language.
   * @default "Presets"
   */
  presetsLabel?: string;
  /**
   * Whether the days of the months before and after show at the grid's edges, in a quieter colour.
   * Shown for one month; with two side by side the next month shows those days itself.
   * @default true for one month, false for more
   */
  showOutsideDays?: boolean;
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ choose: "Pick the due date" }`): its own
   * (`datePicker`) and its calendar's (`calendar`: previous, next). Any left out are the catalogue's,
   * else English. A flat text prop given beside it still wins until the release's step 5.
   */
  words?: Partial<DatePickerWords & CalendarWords>;
}

/** The words for a range's two fields, when the page gives none. */
const defaultRangeLabels: [string, string] = ["start", "end"];

/** No presets. */
const noPresets: DatePickerPreset[] = [];

/** The default presets, counted from `today`. */
const defaultPresets = (
  today: string,
  labels: [string, string, string, string]
): DatePickerPreset[] => [
  { label: labels[0], value: [today, today] },
  { label: labels[1], value: [addDays(today, -6), today] },
  { label: labels[2], value: [addDays(today, -29), today] },
  // From the first of the month to today: a range that runs past today is refused by a `max` of today.
  { label: labels[3], value: [monthOf(today)[0], today] },
];

/** Today in `timeZone` (the browser's when it is left out), as the calendar reads it. */
const todayIn = (timeZone?: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());

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
    setToday(todayIn(timeZone));
  };
  read();
  document.addEventListener("visibilitychange", read);
  return () => {
    document.removeEventListener("visibilitychange", read);
  };
};

/**
 * Today, read on the client when the default presets need it: they count from it, so they wait
 * for the page to start. It is read again when the page comes back into view, so a page left open
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

/** The presets offered: none, the defaults once today is known, or the page's own. */
const offeredPresets = (
  presets: DatePickerPreset[] | boolean,
  today: string | undefined,
  labels: [string, string, string, string]
) => {
  if (presets === false) {
    return noPresets;
  }
  if (presets === true) {
    return today !== undefined && today !== ""
      ? defaultPresets(today, labels)
      : noPresets;
  }
  return presets;
};

/** Six weeks in every month when a picker range's months stand side by side, unless the page says otherwise. */
const sixWeeks = (given: boolean | undefined, picker: boolean, shown: number) =>
  given ?? (picker && shown > 1 ? true : undefined);

/** A sheet from the window's foot for a picker range on a phone, a popup beside the field elsewhere. */
const presentationFor = (
  picker: boolean,
  narrow: boolean
): "sheet" | "popover" => (picker && narrow ? "sheet" : "popover");

/**
 * A preset's button: start-aligned, as a list's rows are. The chosen one takes the chosen fill (a
 * Tree's chosen row) and a tick: a quiet white pill hardly showed on the popup's own white
 * (A2-date-range-picker-02).
 */
const PresetButton = ({
  props,
  chosen,
  label,
}: {
  props: Record<string, unknown>;
  chosen: boolean;
  label: string;
}) => (
  <button
    type="button"
    {...props}
    {...stylex.props(styles.preset, chosen && styles.presetChosen, focus.ring)}
  >
    <span {...stylex.props(styles.presetWords)}>{label}</span>
    {chosen && <Icon icon={Tick} />}
  </button>
);

/** The presets' column, named as a group; nothing when there are none. */
const Presets = ({
  offered,
  label,
}: {
  offered: DatePickerPreset[];
  label: string;
}) =>
  offered.length > 0 && (
    <fieldset aria-label={label} {...stylex.props(styles.presets)}>
      {offered.map((preset) => (
        <PresetPrimitive
          key={`${preset.value[0]}/${preset.value[1]}`}
          value={preset.value}
          render={(
            props: Record<string, unknown>,
            state: DatePickerPresetState
          ) => (
            <PresetButton
              props={props}
              chosen={state.selected}
              label={preset.label}
            />
          )}
        />
      ))}
    </fieldset>
  );

/** A field to type a date in, with a calendar to choose one from. */
// The phone breakpoint, as the tokens write it (px.phone, the media query's own width), read where
// it can be: on the server there is no window, and the picker draws for a wide one.
const PHONE = `(width < ${px.phone}px)`;
const watchPhone = (change: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", change);
  return () => {
    query.removeEventListener("change", change);
  };
};
const onPhone = () => window.matchMedia(PHONE).matches;
const notOnPhone = () => false;

/** The field's words: one date, or a range's start and end with a dash between. */
const Dates = ({
  range,
  label,
  rangeLabels,
  invalid,
  placeholder,
}: {
  range: boolean;
  label: string;
  rangeLabels: [string, string];
  invalid: boolean;
  placeholder: string;
}) => {
  const wrong = invalid || undefined;
  if (!range) {
    return (
      <InputPrimitive
        aria-label={label}
        aria-invalid={wrong}
        placeholder={placeholder}
        {...stylex.props(styles.input, focus.carrier)}
      />
    );
  }
  return (
    <>
      <InputPrimitive
        aria-label={`${label}, ${rangeLabels[0]}`}
        aria-invalid={wrong}
        placeholder={placeholder}
        {...stylex.props(styles.input, styles.rangeDate, focus.carrier)}
      />
      <span aria-hidden="true" {...stylex.props(styles.between)}>
        –
      </span>
      <InputPrimitive
        end
        aria-label={`${label}, ${rangeLabels[1]}`}
        aria-invalid={wrong}
        placeholder={placeholder}
        {...stylex.props(
          styles.input,
          styles.rangeDate,
          styles.rangeEnd,
          focus.carrier
        )}
      />
    </>
  );
};

interface CalendarBodyProps {
  picker: boolean;
  offered: DatePickerPreset[];
  presetsLabel: string;
  months: number;
  previousLabel: string | undefined;
  nextLabel: string | undefined;
  words: DatePickerProps["words"];
}

/** What the popup holds: the months, and with Date range picker's look the presets beside them. */
const CalendarBody = ({
  picker,
  offered,
  presetsLabel,
  months,
  previousLabel,
  nextLabel,
  words,
}: CalendarBodyProps) =>
  picker ? (
    <div {...stylex.props(styles.inner, styles.rangeInner)}>
      <Presets offered={offered} label={presetsLabel} />
      <div {...stylex.props(styles.calendar)}>
        <CalendarMonths
          months={months}
          previousLabel={previousLabel}
          nextLabel={nextLabel}
          words={words}
        />
      </div>
    </div>
  ) : (
    <div {...stylex.props(styles.inner)}>
      <CalendarMonths
        months={months}
        previousLabel={previousLabel}
        nextLabel={nextLabel}
        words={words}
      />
    </div>
  );

/**
 * What only Date range picker's wrapper passes (not a prop of DatePicker's): draw a range as Date
 * range picker did, with presets or without.
 */
interface DatePickerFieldProps extends DatePickerProps {
  rangePicker?: boolean;
}

/** The picker itself; DatePicker below is its public face. */
export const DatePickerField = ({
  rangePicker = false,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  mode = "single",
  months = 1,
  size = "md",
  triggerLabel,
  previousLabel,
  nextLabel,
  rangeLabels = defaultRangeLabels,
  formatLabels = defaultFormatLabels,
  presets = false,
  presetLabels: presetLabelsGiven,
  presetsLabel: presetsLabelGiven,
  showOutsideDays,
  invalid = false,
  words,
  ...rest
}: DatePickerFieldProps) => {
  const range = mode === "range";
  // Date range picker's look: a range with presets, or the wrapper's own range.
  const picker = range && (rangePicker || presets !== false);
  const {
    presets: presetsLabel,
    today: todayLabel,
    last7,
    last30,
    thisMonth,
  } = withGiven(useWords("datePicker", datePickerWords, words), {
    presets: presetsLabelGiven,
  });
  const today = useToday(range && presets === true, rest.today, rest.timeZone);
  const offered = range
    ? offeredPresets(
        presets,
        today,
        presetLabelsGiven ?? [todayLabel, last7, last30, thisMonth]
      )
    : noPresets;
  const placeholder = datePlaceholder(rest.locale, formatLabels);
  // One month on a phone: two do not fit beside each other, and stacked they ran past the window.
  const narrow = useSyncExternalStore(watchPhone, onPhone, notOnPhone);
  const shown = narrow ? 1 : months;
  // One month shows the days round it; months side by side leave them to the next month.
  const outside = showOutsideDays ?? shown === 1;
  return (
    <RootPrimitive
      {...rest}
      mode={mode}
      months={shown}
      showOutsideDays={outside}
      // A picker range's months side by side always draw six weeks, a short month's last row left empty, so
      // the two share one row grid and the popup keeps one height as it pages (A2-date-range-picker-01).
      fixedWeeks={sixWeeks(rest.fixedWeeks, picker, shown)}
      presentation={presentationFor(picker, narrow)}
      render={(
        props: Record<string, unknown>,
        state: { invalid?: boolean; readOnly?: boolean; disabled?: boolean }
      ) => (
        <div
          {...props}
          aria-invalid={invalid || undefined}
          {...stylex.props(
            styles.field,
            state.readOnly !== true && state.disabled !== true && styles.live,
            styles[size],
            picker && styles.rangeField,
            state.readOnly === true && styles.readOnly,
            state.disabled === true && styles.disabled,
            (invalid || state.invalid === true) && styles.invalid,
            focus.fieldWithin
          )}
        />
      )}
    >
      <Dates
        range={range}
        label={label}
        rangeLabels={rangeLabels}
        invalid={invalid}
        placeholder={placeholder}
      />
      <DateTrigger label={triggerLabel} size={size} words={words} />
      <HintPrimitive {...stylex.props(visuallyHidden)} />
      <ContentPrimitive
        align="start"
        alignOffset={-popup.dateFieldInset}
        sideOffset={popup.popoverGap}
        collisionPadding={popup.gutter}
        ref={originFromTrigger}
        {...stylex.props(styles.popup)}
      >
        <CalendarBody
          picker={picker}
          offered={offered}
          presetsLabel={presetsLabel}
          months={shown}
          previousLabel={previousLabel}
          nextLabel={nextLabel}
          words={words}
        />
      </ContentPrimitive>
    </RootPrimitive>
  );
};

/** A field to type a date in, or a range, with a calendar to choose from. */
export const DatePicker = (props: DatePickerProps) => (
  <DatePickerField {...props} />
);
