// DateRangePicker, now Date picker's range with presets (DatePicker `mode="range"` and `presets`):
// a thin wrapper for one step, so nothing breaks. It draws the same field, calendar and presets as
// before, even without presets (an internal flag only it passes), and reads its own words
// (`dateRangePicker`) as before. The codemod moves each use:
//
//   <DateRangePicker aria-label="Period" name="period" />
//   becomes <DatePicker mode="range" months={2} presets aria-label="Period" name="period" />
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 3: Date range picker stays a wrapper over Date picker's range until step 9 removes it (handover/audit/RELEASE.md §7). */
import { calendarWords } from "../calendar/words";
import type { CalendarWords } from "../calendar/words";
import type { DatePickerPreset, DatePickerProps } from "../date-picker";
import { DatePickerField } from "../date-picker/date-picker";
import type { DateFormatLabels } from "../date-picker/placeholder";
import { useWords, withGiven } from "../words/words";
import { dateRangePickerWords } from "./words";
import type { DateRangePickerWords } from "./words";

type RootProps = Omit<
  DatePickerProps,
  | "mode"
  | "value"
  | "defaultValue"
  | "onValueChange"
  | "months"
  | "presets"
  | "presetLabels"
  | "presetsLabel"
  | "words"
>;

/** @deprecated Use `DatePickerPreset`. */
export type DateRangePreset = DatePickerPreset;

/** @deprecated Use `DatePickerProps`, with `mode="range"` and `presets`. */
export interface DateRangePickerProps extends RootProps {
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
  /**
   * This instance's own words, over the catalogue's (GraspWords), key by key (`{ presets: "Quick ranges" }`). Any left out
   * are the catalogue's, else English. A flat text prop given beside it still wins until the
   * release's step 5.
   */
  words?: Partial<DateRangePickerWords & CalendarWords>;
}

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

/** The field's name by its new name, else its deprecated old one (the breaking release's step 1). */
const nameOf = (named: string | undefined, label: string | undefined) =>
  named ?? label ?? "";

/** @deprecated Use `DatePicker`, with `mode="range"`, `months={2}` and `presets`. */
export const DateRangePicker = ({
  label: labelDeprecated,
  "aria-label": named,
  onValueChange,
  presets,
  months = 2,
  presetLabels,
  presetsLabel,
  triggerLabel,
  previousLabel,
  nextLabel,
  words,
  ...rest
}: DateRangePickerProps) => {
  // Its own words (`dateRangePicker`), as before, handed on under Date picker's keys.
  const own = withGiven(
    useWords("dateRangePicker", dateRangePickerWords, words),
    { presets: presetsLabel, trigger: triggerLabel }
  );
  const calendar = withGiven(useWords("calendar", calendarWords, words), {
    previous: previousLabel,
    next: nextLabel,
  });
  return (
    <DatePickerField
      {...rest}
      // Its own look, with presets or without: the wider field, six weeks, a sheet on a phone.
      rangePicker
      aria-label={nameOf(named, labelDeprecated)}
      mode="range"
      months={months}
      presets={presets ?? true}
      presetLabels={
        presetLabels ?? [own.today, own.last7, own.last30, own.thisMonth]
      }
      onValueChange={
        onValueChange
          ? (next: unknown) => {
              onValueChange(toRange(next));
            }
          : undefined
      }
      triggerLabel={triggerLabel}
      words={{
        choose: own.trigger,
        presets: own.presets,
        previous: calendar.previous,
        next: calendar.next,
      }}
    />
  );
};
