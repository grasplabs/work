import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Switch } from "@grasp-os/ui/components/switch";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

import { dayName, scheduleHours, scheduleSummary } from "./pulse.ts";
import type { WeekSchedule } from "./pulse.ts";

// When Pulse may report, as in the prototype (`components/week-schedule.tsx`).

const clock = (hour: number): string => `${hour}:00`;
const fromItems = Array.from({ length: 24 }, (_item, hour) => ({
  value: String(hour),
  label: clock(hour),
}));
const toItems = Array.from({ length: 24 }, (_item, index) => ({
  value: String(index + 1),
  label: clock(index + 1),
}));

/** The hours a day switched on gets: office hours. */
const officeFrom = 8;
const officeTo = 18;

/** A day's hours as one stretch: from its first hour on to the end of its last. */
const stretch = (
  hours: readonly boolean[]
): { from: number; to: number } | null => {
  const first = hours.indexOf(true);
  if (first === -1) {
    return null;
  }
  return { from: first, to: hours.lastIndexOf(true) + 1 };
};

const day = (from: number, to: number): boolean[] =>
  Array.from({ length: 24 }, (_item, hour) => hour >= from && hour < to);

const HourSelect = ({
  label,
  value,
  items,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  items: { value: string; label: string }[];
  disabled: boolean;
  onChange: (hour: number) => void;
}) => (
  <Select
    disabled={disabled}
    items={items}
    value={String(value)}
    onValueChange={(next) => {
      if (typeof next === "string") {
        onChange(Number(next));
      }
    }}
  >
    <SelectTrigger aria-label={label} className="w-24">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectGroup>
    </SelectContent>
  </Select>
);

/**
 * When Pulse may report, per day: switch a day on or off, and pick from which hour to which.
 * Each change is saved at once; without `onChange` it can't be changed.
 */
export const WeekHours = ({
  value,
  onChange,
}: {
  value: WeekSchedule;
  onChange?: (schedule: WeekSchedule) => void;
}) => {
  const { t } = useLingui();
  const disabled = onChange === undefined;
  const setDay = (index: number, hours: boolean[]): void => {
    onChange?.(value.map((each, at) => (at === index ? hours : each)));
  };
  const hoursOn = scheduleHours(value);
  const summary = scheduleSummary(value);
  const days = value.map((_hours, index) => dayName(index));

  return (
    <div className="flex flex-col">
      {days.map((name, index) => {
        const range = stretch(value[index] ?? []);
        return (
          // On a phone the hours go under the day and its switch: beside them they ran off the edge.
          <div
            className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-t px-5 py-2"
            key={name}
          >
            <label className="w-24" htmlFor={`pulse-day-${index}`}>
              {name}
            </label>
            <Switch
              checked={range !== null}
              disabled={disabled}
              id={`pulse-day-${index}`}
              onCheckedChange={(on) => {
                setDay(index, on ? day(officeFrom, officeTo) : day(0, 0));
              }}
            />
            {range === null ? (
              <span className="text-muted-foreground">
                <Trans context="a day without Pulse hours">Off</Trans>
              </span>
            ) : (
              <div className="flex items-center gap-2">
                <HourSelect
                  disabled={disabled}
                  items={fromItems}
                  label={t({
                    message: `${name} from`,
                    comment: "The first hour Pulse may report on a day",
                  })}
                  value={range.from}
                  onChange={(from) => {
                    setDay(index, day(from, Math.max(range.to, from + 1)));
                  }}
                />
                <span className="text-muted-foreground">
                  <Trans context="between two hours">to</Trans>
                </span>
                <HourSelect
                  disabled={disabled}
                  items={toItems}
                  label={t({
                    message: `${name} until`,
                    comment: "The last hour Pulse may report on a day",
                  })}
                  value={range.to}
                  onChange={(to) => {
                    setDay(index, day(Math.min(range.from, to - 1), to));
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
      <p className="text-muted-foreground border-t px-5 py-3">
        {hoursOn === 0
          ? t`Pulse never reports.`
          : t`${plural(hoursOn, { one: `On # hour a week: ${summary}.`, other: `On # hours a week: ${summary}.` })}`}
      </p>
    </div>
  );
};
