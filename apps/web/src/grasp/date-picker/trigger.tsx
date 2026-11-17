// The calendar button at the end of a date field, shared by DatePicker and DateRangePicker. UI SDK
// names it Choose date with the chosen date after it; Button draws its own icon and name, so the
// primitive's children are left out.
"use client";

import { DatePickerTrigger as TriggerPrimitive } from "@ui-sdk/react/date-picker";

import { Button } from "../button";
import { CalendarIcon } from "../icons";

/** UI SDK's trigger props without its children: Button draws its own content. */
const withoutChildren = (
  props: Record<string, unknown>
): Record<string, unknown> => {
  const rest = { ...props };
  delete rest.children;
  return rest;
};

/** The name UI SDK gives the button, else the page's own, else the English default. */
const nameOf = (
  props: Record<string, unknown>,
  given: string | undefined,
  fallback: string
): string => {
  const named = props["aria-label"];
  if (typeof named === "string") {
    return named;
  }
  return given ?? fallback;
};

/** The button's size for each field size: 2px from the field's edge at sm and md, 4px at lg. */
const buttonSize = { sm: "xs", md: "sm", lg: "md" } as const;

export interface DateTriggerProps {
  /** The button's name, in the page's language. Left out, UI SDK's name is kept. */
  label?: string;
  /**
   * The name used when neither UI SDK nor `label` gives one.
   * @default "Choose date"
   */
  fallbackLabel?: string;
  /**
   * The field's size; the button is the next size down, so it stands as far in at every size.
   * @default "md"
   */
  size?: "sm" | "md" | "lg";
}

/** The calendar button of a date field. */
export const DateTrigger = ({
  label,
  fallbackLabel = "Choose date",
  size = "md",
}: DateTriggerProps) => (
  <TriggerPrimitive
    aria-label={label}
    render={(props: Record<string, unknown>) => (
      <Button
        {...withoutChildren(props)}
        variant="ghost"
        size={buttonSize[size]}
        icon={CalendarIcon}
        aria-label={nameOf(props, label, fallbackLabel)}
      />
    )}
  />
);
