// DatePicker: a field to type a date in, or choose one from a calendar, from shadcn's date picker
// (a Popover holding its Calendar), rebuilt on UI SDK's DatePicker and made Grasp's: closed, it is
// Input (the field fill, its hairline, Button's heights and the corner) with a calendar button at
// its end; open, Grasp's Calendar in a popup with the popup tokens. Palermo has no date picker, so
// the look follows Grasp's Input, Select and Popover.
//
//   <DatePicker label="Due date" name="due" defaultValue="2026-11-20" />
//   <DatePicker label="Stay" mode="range" months={2} name="stay" />
//
// A typed date is read in the page's language and formatted once it is committed (Enter or
// leaving the field); the value is always an ISO date ("2026-11-20"). The form gets it under
// `name`. Escape closes the calendar and focus goes back to the field. Every value is a token.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  DatePicker as RootPrimitive,
  DatePickerContent as ContentPrimitive,
  DatePickerHint as HintPrimitive,
  DatePickerInput as InputPrimitive,
} from "@ui-sdk/react/date-picker";
import { useSyncExternalStore } from "react";
import type { ComponentProps } from "react";

import { CalendarMonths } from "../calendar/months";
import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { popup, px } from "../tokens/tokens.values";
import { datePlaceholder, defaultFormatLabels } from "./placeholder";
import type { DateFormatLabels } from "./placeholder";
import { datePickerStyles as styles } from "./styles";
import { DateTrigger } from "./trigger";

type RootProps = ComponentProps<typeof RootPrimitive>;

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
   * Whether the days of the months before and after show at the grid's edges, in a quieter colour.
   * Shown for one month; with two side by side the next month shows those days itself.
   * @default true for one month, false for more
   */
  showOutsideDays?: boolean;
}

/** The words for a range's two fields, when the page gives none. */
const defaultRangeLabels: [string, string] = ["start", "end"];

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

export const DatePicker = ({
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
  showOutsideDays,
  invalid = false,
  ...rest
}: DatePickerProps) => {
  const input = stylex.props(styles.input, focus.carrier);
  const start = stylex.props(styles.input, styles.rangeDate, focus.carrier);
  const end = stylex.props(
    styles.input,
    styles.rangeDate,
    styles.rangeEnd,
    focus.carrier
  );
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
      presentation="popover"
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
            state.readOnly === true && styles.readOnly,
            state.disabled === true && styles.disabled,
            (invalid || state.invalid === true) && styles.invalid,
            focus.fieldWithin
          )}
        />
      )}
    >
      {mode === "range" ? (
        <>
          <InputPrimitive
            aria-label={`${label}, ${rangeLabels[0]}`}
            aria-invalid={invalid || undefined}
            placeholder={placeholder}
            {...start}
          />
          <span aria-hidden="true" {...stylex.props(styles.between)}>
            –
          </span>
          <InputPrimitive
            end
            aria-label={`${label}, ${rangeLabels[1]}`}
            aria-invalid={invalid || undefined}
            placeholder={placeholder}
            {...end}
          />
        </>
      ) : (
        <InputPrimitive
          aria-label={label}
          aria-invalid={invalid || undefined}
          placeholder={placeholder}
          {...input}
        />
      )}
      <DateTrigger label={triggerLabel} size={size} />
      <HintPrimitive {...stylex.props(visuallyHidden)} />
      <ContentPrimitive
        align="start"
        alignOffset={-popup.dateFieldInset}
        sideOffset={popup.popoverGap}
        collisionPadding={popup.gutter}
        {...stylex.props(styles.popup)}
      >
        <div {...stylex.props(styles.inner)}>
          <CalendarMonths
            months={shown}
            previousLabel={previousLabel}
            nextLabel={nextLabel}
          />
        </div>
      </ContentPrimitive>
    </RootPrimitive>
  );
};
