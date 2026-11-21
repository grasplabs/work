import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatList } from "../../format.ts";
import { AgentMark } from "../../grasp/agent-mark/index.ts";
import { Badge } from "../../grasp/badge/index.ts";
import { Heading } from "../../grasp/heading/index.ts";
import { CalendarIcon } from "../../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../grasp/item/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../../grasp/select/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../../grasp/toggle/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { frequencies } from "./model.ts";
import type { Frequency, Schedule, StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// When it works on its own (Ruben, 19 Nov 2026, after Linear's schedule):
// the schedule reads as a sentence, its parts nested under it on a tree
// line: how often, then at what time, on which days (a toggle a day, in
// the week's own order) or on which day of the month. Under it, what that
// means for the person: the next few times it works, and what lands for
// them each time, as the item it will be, with one plain line on what it
// does and that it asks before it sends anything.

/** How many coming runs the preview lists. */
const runsShown = 3;
/** How far ahead it looks for them, in days: a month's run is always found. */
const daysAhead = 62;
/** The times offered, every half hour of the day. */
const halfHours = Array.from({ length: 48 }, (_, at) => {
  const hour = String(Math.floor(at / 2)).padStart(2, "0");
  const minute = at % 2 === 0 ? "00" : "30";
  return `${hour}:${minute}`;
});
/** The days of the month offered: 1 to 28, so every month has the day. */
const monthDays = Array.from({ length: 28 }, (_, at) => at + 1);
/** A Sunday, from which each weekday's name is read. */
const aSunday = new Date(2026, 10, 15);
const daysOfWeek = [0, 1, 2, 3, 4, 5, 6] as const;

const styles = stylex.create({
  // The sentence and its nested parts.
  sentence: { display: "grid", gap: grasp.space3 },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  // The parts under how often, on a tree line from it.
  nested: {
    display: "grid",
    gap: grasp.space3,
    marginInlineStart: grasp.space3,
    paddingInlineStart: grasp.space4,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  // What it means for the person, under the schedule.
  preview: { display: "grid", gap: grasp.space4 },
  part: { display: "grid", gap: grasp.space2 },
});

/** The weekday a locale starts its week on, 0 for Sunday; Monday where it doesn't say. */
const weekStart = (locale: string): number => {
  // SAFETY: both members are optional and read with `?.`: a browser whose
  // Intl.Locale has neither gives undefined, and Monday is taken.
  const said = new Intl.Locale(locale) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  const first = said.getWeekInfo?.().firstDay ?? said.weekInfo?.firstDay ?? 1;
  // Intl counts Monday 1 to Sunday 7; cron and Date count Sunday 0.
  return first % 7;
};

/** The day `day` (0 Sunday) is named, short or long. */
const dayName = (locale: string, day: number, width: "short" | "long") =>
  new Intl.DateTimeFormat(locale, { weekday: width }).format(
    new Date(aSunday.getFullYear(), aSunday.getMonth(), aSunday.getDate() + day)
  );

/** A time such as `09:00` as the page's language writes it. */
const timeName = (locale: string, time: string) => {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(
    new Date(2026, 0, 1, hour, minute)
  );
};

/** Whether the schedule runs on `date`'s day. */
const runsOn = (schedule: Schedule, date: Date): boolean => {
  if (schedule.frequency === "daily") {
    return true;
  }
  if (schedule.frequency === "weekly") {
    return schedule.days.has(date.getDay());
  }
  return (
    schedule.frequency === "monthly" && date.getDate() === schedule.dayOfMonth
  );
};

/** The next times the schedule runs, from now. */
const nextRuns = (schedule: Schedule, now: Date): Date[] => {
  const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
  const runs: Date[] = [];
  for (
    let ahead = 0;
    ahead < daysAhead && runs.length < runsShown;
    ahead += 1
  ) {
    const at = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + ahead,
      hour,
      minute
    );
    if (at > now && runsOn(schedule, at)) {
      runs.push(at);
    }
  }
  return runs;
};

/** When it works on its own, and what that means for the person. */
export const ScheduleStep = ({ setup, change, name }: StepProps) => {
  const { t, i18n } = useLingui();
  const { frequencyNames } = useSetupWords();
  const { schedule } = setup;
  const { locale } = i18n;
  const set = (next: Partial<Schedule>) => {
    change({ schedule: { ...schedule, ...next } });
  };
  const start = weekStart(locale);
  const week = daysOfWeek.map((offset) => (start + offset) % 7);
  const time = timeName(locale, schedule.time);
  const { dayOfMonth } = schedule;
  const chosenDays = formatList(
    week
      .filter((day) => schedule.days.has(day))
      .map((day) => dayName(locale, day, "long"))
  );
  const when: Record<Exclude<Frequency, "asked">, string> = {
    daily: t`Every day at ${time}, ${name} works on its own and sends you what it found.`,
    weekly:
      schedule.days.size === 0
        ? t`Pick at least one day.`
        : t`Every ${chosenDays} at ${time}, ${name} works on its own and sends you what it found.`,
    monthly: t`On day ${dayOfMonth} of every month at ${time}, ${name} works on its own and sends you what it found.`,
  };
  const runs = nextRuns(schedule, new Date());
  const dated = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return (
    <Question title={t`When should ${name} work?`}>
      <div {...stylex.props(styles.sentence)}>
        <div {...stylex.props(styles.row)}>
          <Select
            items={frequencies.map((frequency) => ({
              value: frequency,
              label: frequencyNames[frequency],
            }))}
            onValueChange={(value) => {
              const frequency = frequencies.find((each) => each === value);
              if (frequency !== undefined) {
                set({ frequency });
              }
            }}
            value={schedule.frequency}
          >
            <SelectTrigger aria-label={t`How often`} size="sm" variant="text">
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
        </div>
        {schedule.frequency === "asked" ? null : (
          <div {...stylex.props(styles.nested)}>
            {schedule.frequency === "weekly" ? (
              <div {...stylex.props(styles.row)}>
                <Text tone="muted">{t`On`}</Text>
                <ToggleGroup
                  aria-label={t`Days`}
                  multiple
                  // Level with the 32px selects in the same sentence.
                  size="sm"
                  onValueChange={(values) => {
                    set({ days: new Set(values.map(Number)) });
                  }}
                  value={[...schedule.days].map(String)}
                >
                  {week.map((day) => (
                    <Toggle
                      aria-label={dayName(locale, day, "long")}
                      key={day}
                      value={String(day)}
                    >
                      {dayName(locale, day, "short")}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
            ) : null}
            {schedule.frequency === "monthly" ? (
              <div {...stylex.props(styles.row)}>
                <Text tone="muted">{t`On day`}</Text>
                <Select
                  items={monthDays.map((day) => ({
                    value: String(day),
                    label: String(day),
                  }))}
                  onValueChange={(value) => {
                    if (value !== null) {
                      set({ dayOfMonth: Number(value) });
                    }
                  }}
                  value={String(dayOfMonth)}
                >
                  <SelectTrigger
                    aria-label={t`Day of the month`}
                    size="sm"
                    variant="text"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
              </div>
            ) : null}
            <div {...stylex.props(styles.row)}>
              <Text tone="muted">{t`At`}</Text>
              <Select
                items={halfHours.map((each) => ({
                  value: each,
                  label: timeName(locale, each),
                }))}
                onValueChange={(value) => {
                  if (value !== null) {
                    set({ time: value });
                  }
                }}
                value={schedule.time}
              >
                <SelectTrigger aria-label={t`Time`} size="sm" variant="text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
              <Text size="sm" tone="muted">
                {t`in the company's time zone`}
              </Text>
            </div>
          </div>
        )}
      </div>
      {schedule.frequency === "asked" ? (
        <div {...stylex.props(styles.preview)}>
          <Text tone="muted">
            {t`${name} only works when someone asks it something in a chat.`}
          </Text>
        </div>
      ) : (
        <div {...stylex.props(styles.preview)}>
          <span {...stylex.props(styles.part)}>
            <Text>{when[schedule.frequency]}</Text>
            <Text size="sm" tone="muted">
              {t`It asks you before it sends or changes anything.`}
            </Text>
          </span>
          {runs.length === 0 ? null : (
            <span {...stylex.props(styles.part)}>
              <Heading level={2} size="ui-sm">
                {t`Next times`}
              </Heading>
              <ItemGroup separated>
                {runs.map((run) => (
                  <Item key={run.toISOString()} size="sm">
                    <ItemMedia icon={CalendarIcon} iconLook="inline" />
                    <ItemContent>
                      <ItemTitle>{dated.format(run)}</ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <Text size="sm" tone="muted">
                        {time}
                      </Text>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            </span>
          )}
          <span {...stylex.props(styles.part)}>
            <Heading level={2} size="ui-sm">
              {t`What you get each time`}
            </Heading>
            <Item variant="outline">
              <ItemMedia>
                <AgentMark name={name} size="md" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t`${name} has something for you`}</ItemTitle>
                <ItemDescription>
                  {setup.job.trim() === ""
                    ? t`What it found, and what it suggests.`
                    : setup.job}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge tone="info">{t`New`}</Badge>
              </ItemActions>
            </Item>
          </span>
        </div>
      )}
    </Question>
  );
};
