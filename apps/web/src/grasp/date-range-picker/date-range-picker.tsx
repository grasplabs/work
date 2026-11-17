// DateRangePicker: a start and an end date, typed or chosen, with presets, after the date range
// pickers of current analytics products (Linear's and Vercel's: presets in a column at the
// calendar's start, two months beside them). On UI SDK's DatePicker in range mode, with Grasp's
// Date picker field (two dates and the calendar button) and Calendar's months.
//
//   <DateRangePicker label="Period" name="period" />
//   <DateRangePicker label="Stay" presets={false} min="2026-11-13" />
//
// A preset chooses its range and closes the calendar. The value is `[start, end]` as ISO dates.
// Every value is a token (src/tokens).
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
import { useEffect, useState } from "react";
import type { ComponentProps } from "react";

import { CalendarMonths } from "../calendar/months";
import {
  datePlaceholder,
  defaultFormatLabels,
} from "../date-picker/placeholder";
import type { DateFormatLabels } from "../date-picker/placeholder";
import { datePickerStyles as fieldStyles } from "../date-picker/styles";
import { DateTrigger } from "../date-picker/trigger";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, Tick } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { popup, px } from "../tokens/tokens.values";
import { useWords, withGiven } from "../words/words";
import { addDays, monthOf } from "./dates";
import { dateRangePickerWords } from "./words";

type RootProps = ComponentProps<typeof RootPrimitive>;

/** A range people choose often, by name. */
export interface DateRangePreset {
  /** Its name on the button ("Last 7 days"). */
  label: string;
  /** The range it chooses, as ISO dates. */
  value: [string, string];
}

/** Every prop a DateRangePicker takes: these, and the rest of UI SDK's DatePicker. */
export interface DateRangePickerProps extends Omit<
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
  /** The field's name for a screen reader, a voice command and an agent ("Period"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** The chosen range, `[start, end]` as ISO dates, or `null`. Pass it with `onValueChange` to hold it yourself. */
  value?: [string, string] | null;
  /** The range it starts with, and goes back to when its form resets. */
  defaultValue?: [string, string] | null;
  /** Runs once both ends are set, by typing, the calendar or a preset. */
  onValueChange?: (value: [string, string] | null) => void;
  /**
   * The ranges offered beside the calendar. Leave it out for Today, Last 7 days, Last 30 days
   * and This month, counted from today; `false` for none.
   */
  presets?: DateRangePreset[] | false;
  /**
   * How many months the calendar shows side by side; one on a phone, whatever this says.
   * @default 2
   */
  months?: number;
  /**
   * The height, the same as Input's and Button's: `sm` 32px, `md` 36px, `lg` 44px.
   * @default "md"
   */
  size?: "sm" | "md" | "lg";
  /** The name both ends are sent under, as ISO dates; or `startName` and `endName` for one each. */
  name?: string;
  /** Wrong, by a check of the page's own: Input's danger lift. */
  invalid?: boolean;
  /**
   * The words for the two fields, after `label`, in the page's language.
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
   * The name of the calendar button, in the page's language. Left out, UI SDK names it Choose
   * date, with the chosen range after it.
   */
  triggerLabel?: string;
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
   * The name of the calendar's Previous button.
   * @default "Previous month"
   */
  previousLabel?: string;
  /**
   * The name of the calendar's Next button.
   * @default "Next month"
   */
  nextLabel?: string;
}

const styles = stylex.create({
  // The field is wider than a date picker's: two dates.
  field: {
    maxWidth: grasp.dateRangeWidth,
  },
  // The presets beside the months; under them on a phone, the month centred under the presets.
  inner: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: { default: null, [media.belowPhone]: "center" },
    gap: grasp.space4,
  },
  // A fieldset, with the browser's own border, padding, margin and minimum width taken off. On a
  // phone the presets stand in two equal columns over the month, so none is left alone on a line
  // and the popup is as wide as its month, not the window.
  presets: {
    margin: 0,
    padding: 0,
    borderWidth: 0,
    minWidth: 0,
    display: { default: "flex", [media.belowPhone]: "grid" },
    flexDirection: "column",
    flexWrap: "wrap",
    gridTemplateColumns: {
      default: null,
      [media.belowPhone]: "repeat(2, minmax(0, 1fr))",
    },
    gap: grasp.space1,
    width: { default: grasp.dateRangePresets, [media.belowPhone]: "100%" },
    flexShrink: 0,
  },
  // A preset: a row the height of a small control, its words at the start, the tick at the end.
  preset: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    boxSizing: "border-box",
    minHeight: { default: grasp.controlSm, [media.coarse]: grasp.tap },
    margin: 0,
    paddingBlock: 0,
    paddingInline: grasp.space2,
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
    },
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    textAlign: "start",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  presetChosen: {
    backgroundColor: {
      default: grasp.treeFillChosen,
      ":hover": {
        default: grasp.treeFillChosen,
        [media.hover]: grasp.treeFillChosen,
      },
      [media.forced]: "Highlight",
    },
    color: { default: grasp.ink, [media.forced]: "HighlightText" },
  },
  presetWords: {
    flexGrow: 1,
    minWidth: 0,
  },
  calendar: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    minWidth: 0,
  },
});

/** The default presets, counted from `today`. */
const defaults = (
  today: string,
  labels: [string, string, string, string]
): DateRangePreset[] => [
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
  // A given today starts nothing, so nothing stops.
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
 * Today, read on the client: the presets count from it, so they wait for the page to start. It is
 * read again when the page comes back into view, so a page left open overnight moves on.
 */
const useToday = (given?: string, timeZone?: string) => {
  const [today, setToday] = useState<string | undefined>(given);
  useEffect(() => {
    const fixed = given !== undefined && given !== "";
    return fixed ? noCleanup : watchToday(timeZone, setToday);
  }, [given, timeZone]);
  return given ?? today;
};

/** The words for the two fields, when the page gives none. */
const defaultRangeLabels: [string, string] = ["start", "end"];

/** The default presets' names, when the page gives none. */

/** No presets. */
const none: DateRangePreset[] = [];

/** UI SDK's range value, read back as two ISO dates or none. */
const toRange = (next: unknown): [string, string] | null => {
  if (Array.isArray(next) && next.length === 2) {
    const start: unknown = next[0];
    const end: unknown = next[1];
    if (typeof start === "string" && typeof end === "string") {
      return [start, end];
    }
  }
  return null;
};

/** A sheet from the window's foot on a phone, a popup beside the field elsewhere. */
const presentationFor = (narrow: boolean): "sheet" | "popover" =>
  narrow ? "sheet" : "popover";

/** Whether the window is under the phone breakpoint, now and as it changes. */
const useNarrow = () => {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    // The phone breakpoint, as the tokens write it (px.phone, the media query's own width).
    const query = window.matchMedia(`(width < ${px.phone}px)`);
    const update = () => {
      setNarrow(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
    };
  }, []);
  return narrow;
};

/** Six weeks in every month when months stand side by side, unless the page says otherwise. */
const sixWeeks = (given: boolean | undefined, shown: number) =>
  given ?? shown > 1;

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

/** Two dates, typed or chosen on the calendar, with presets beside it. */
/** The field's name by its new name, else its deprecated old one (the breaking release's step 1). */
const nameOf = (named: string | undefined, label: string | undefined) =>
  named ?? label ?? "";

export const DateRangePicker = ({
  label: labelDeprecated,
  "aria-label": named,
  value,
  defaultValue,
  onValueChange,
  presets,
  months = 2,
  size = "md",
  invalid = false,
  rangeLabels = defaultRangeLabels,
  formatLabels = defaultFormatLabels,
  triggerLabel,
  presetLabels: presetLabelsGiven,
  presetsLabel: presetsLabelGiven,
  previousLabel,
  nextLabel,
  showOutsideDays,
  today: givenToday,
  ...rest
}: DateRangePickerProps) => {
  const {
    presets: presetsLabel,
    today: todayLabel,
    last7,
    last30,
    thisMonth,
  } = withGiven(useWords("dateRangePicker", dateRangePickerWords), {
    presets: presetsLabelGiven,
  });
  const presetLabels = presetLabelsGiven ?? [
    todayLabel,
    last7,
    last30,
    thisMonth,
  ];
  const label = nameOf(named, labelDeprecated);
  const today = useToday(givenToday, rest.timeZone);
  const offered =
    presets === false
      ? none
      : (presets ??
        (today !== undefined && today !== ""
          ? defaults(today, presetLabels)
          : none));
  const start = stylex.props(
    fieldStyles.input,
    fieldStyles.rangeDate,
    focus.carrier
  );
  const end = stylex.props(
    fieldStyles.input,
    fieldStyles.rangeDate,
    fieldStyles.rangeEnd,
    focus.carrier
  );
  const placeholder = datePlaceholder(rest.locale, formatLabels);
  // One month on a phone: two do not fit beside each other.
  const narrow = useNarrow();
  const shown = narrow ? 1 : months;
  return (
    <RootPrimitive
      {...rest}
      mode="range"
      today={givenToday}
      value={value}
      defaultValue={defaultValue}
      onValueChange={
        onValueChange
          ? (next: unknown) => {
              onValueChange(toRange(next));
            }
          : undefined
      }
      months={shown}
      // One month shows the days round it, as Date picker and Calendar do; months side by side
      // leave them to the neighbour. A phone shows one month.
      showOutsideDays={showOutsideDays ?? shown === 1}
      // Months side by side always draw six weeks, a short month's last row left empty, so the two
      // share one row grid and the popup keeps one height as it pages (A2-date-range-picker-01).
      fixedWeeks={sixWeeks(rest.fixedWeeks, shown)}
      // A sheet from the window's foot on a phone, where a month of six weeks with its presets does
      // not fit above or below the field (A3-choice-01, decided); a popup beside it elsewhere.
      presentation={presentationFor(narrow)}
      render={(
        props: Record<string, unknown>,
        state: { invalid?: boolean; readOnly?: boolean; disabled?: boolean }
      ) => (
        <div
          {...props}
          aria-invalid={invalid || undefined}
          {...stylex.props(
            fieldStyles.field,
            state.readOnly !== true &&
              state.disabled !== true &&
              fieldStyles.live,
            fieldStyles[size],
            styles.field,
            state.readOnly === true && fieldStyles.readOnly,
            state.disabled === true && fieldStyles.disabled,
            (invalid || state.invalid === true) && fieldStyles.invalid,
            focus.fieldWithin
          )}
        />
      )}
    >
      <InputPrimitive
        aria-label={`${label}, ${rangeLabels[0]}`}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        {...start}
      />
      <span aria-hidden="true" {...stylex.props(fieldStyles.between)}>
        –
      </span>
      <InputPrimitive
        end
        aria-label={`${label}, ${rangeLabels[1]}`}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        {...end}
      />
      <DateTrigger label={triggerLabel} size={size} />
      <HintPrimitive {...stylex.props(visuallyHidden)} />
      <ContentPrimitive
        align="start"
        alignOffset={-popup.dateFieldInset}
        sideOffset={popup.popoverGap}
        collisionPadding={popup.gutter}
        {...stylex.props(fieldStyles.popup)}
      >
        <div {...stylex.props(fieldStyles.inner, styles.inner)}>
          {offered.length > 0 && (
            <fieldset
              aria-label={presetsLabel}
              {...stylex.props(styles.presets)}
            >
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
          )}
          <div {...stylex.props(styles.calendar)}>
            <CalendarMonths
              months={shown}
              previousLabel={previousLabel}
              nextLabel={nextLabel}
            />
          </div>
        </div>
      </ContentPrimitive>
    </RootPrimitive>
  );
};
