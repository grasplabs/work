import { Badge } from "@grasp-os/ui/components/badge";
import { Heading } from "@grasp-os/ui/components/heading";
import { IconTile } from "@grasp-os/ui/components/icon-tile";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import {
  CalendarIcon,
  ClockIcon,
  Icon,
  MessageCircleIcon,
} from "@grasp-os/ui/lib/icons";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

import { AgentFigure } from "../figure/agent-figure.tsx";
import { lookFromName } from "../figure/look.ts";
import { dayName, frequencies, timeName } from "../schedule.ts";
import type { Schedule } from "../schedule.ts";
import { ChoiceCards } from "./choice-cards.tsx";
import type { StepProps } from "./model.ts";
import { Question } from "./question.tsx";
import { useSetupWords } from "./words.ts";

// First, as two cards to press (Ruben, 21 November: "just visualize it"),
// whether it waits to be asked or also works on a schedule; each shows
// what it means: being asked in a chat, or the next times it works.
//
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
const daysOfWeek = [0, 1, 2, 3, 4, 5, 6] as const;

const styles = stylex.create({
  // The sentence and its nested parts.
  sentence: { display: "grid", gap: space["3"] },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
  },
  // The parts under how often, on a tree line from it.
  nested: {
    display: "grid",
    gap: space["3"],
    marginInlineStart: space["3"],
    paddingInlineStart: space["4"],
    borderInlineStartWidth: size.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
  },
  // What it means for the person, under the schedule.
  preview: { display: "grid", gap: space["4"] },
  part: { display: "grid", gap: space["2"] },
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
  const asked = schedule.frequency === "asked";
  const { locale } = i18n;
  const set = (next: Partial<Schedule>) => {
    change({ schedule: { ...schedule, ...next } });
  };
  const start = weekStart(locale);
  const week = daysOfWeek.map((offset) => (start + offset) % 7);
  const time = timeName(locale, schedule.time);
  const { dayOfMonth } = schedule;
  // The controls say when it works; only a week with no day picked needs words.
  const noDays = schedule.frequency === "weekly" && schedule.days.size === 0;
  const runs = nextRuns(schedule, new Date());
  const dated = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return (
    <Question title={t`When should ${name} work?`}>
      <ChoiceCards
        cards={[
          {
            value: "asked",
            title: t`When someone asks`,
            description: t`It answers in a chat, whenever it is asked.`,
            media: (
              <IconTile
                icon={MessageCircleIcon}
                variant={asked ? "gradient" : "default"}
              />
            ),
          },
          {
            value: "scheduled",
            title: t`On a schedule`,
            description: t`It also works on its own, at the times you set.`,
            media: (
              <IconTile
                icon={ClockIcon}
                variant={asked ? "default" : "gradient"}
              />
            ),
          },
        ]}
        label={t`When it works`}
        onValueChange={(chosen) => {
          if (chosen === "asked") {
            set({ frequency: "asked" });
          } else if (asked) {
            set({ frequency: "weekly" });
          }
        }}
        value={asked ? "asked" : "scheduled"}
      />
      {asked ? null : (
        <div {...stylex.props(styles.sentence)}>
          <div {...stylex.props(styles.row)}>
            <Select
              items={frequencies
                .filter((frequency) => frequency !== "asked")
                .map((frequency) => ({
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
              <SelectTrigger
                aria-label={t`How often`}
                size="sm"
                variant="ghost"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          </div>
          {schedule.frequency === "asked" ? null : (
            <div {...stylex.props(styles.nested)}>
              {schedule.frequency === "weekly" ? (
                <div {...stylex.props(styles.row)}>
                  <Text color="muted">{t`On`}</Text>
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
                      <ToggleGroupItem
                        aria-label={dayName(locale, day, "long")}
                        key={day}
                        value={String(day)}
                      >
                        {dayName(locale, day, "short")}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              ) : null}
              {schedule.frequency === "monthly" ? (
                <div {...stylex.props(styles.row)}>
                  <Text color="muted">{t`On day`}</Text>
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
                      variant="ghost"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                </div>
              ) : null}
              <div {...stylex.props(styles.row)}>
                <Text color="muted">{t`At`}</Text>
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
                  <SelectTrigger aria-label={t`Time`} size="sm" variant="ghost">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
                <Text color="muted" size="sm">
                  {t`in the company's time zone`}
                </Text>
              </div>
            </div>
          )}
        </div>
      )}
      {asked ? (
        <div {...stylex.props(styles.preview)}>
          <Item variant="outline">
            <ItemMedia>
              <AgentFigure look={lookFromName(name)} size="sm" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t`Ask ${name} in any chat`}</ItemTitle>
              <ItemDescription>
                {t`Pick ${name} in the chat's box, and it answers there.`}
              </ItemDescription>
            </ItemContent>
          </Item>
        </div>
      ) : (
        <div {...stylex.props(styles.preview)}>
          <span {...stylex.props(styles.part)}>
            {noDays ? <Text>{t`Pick at least one day.`}</Text> : null}
            <Text color="muted" size="sm">
              {t`It asks you before it sends or changes anything.`}
            </Text>
          </span>
          {runs.length === 0 ? null : (
            <span {...stylex.props(styles.part)}>
              <Heading level={2} size="2xs">
                {t`Next times`}
              </Heading>
              <ItemGroup>
                {runs.map((run, index) => (
                  <Fragment key={run.toISOString()}>
                    {index === 0 ? null : <ItemSeparator />}
                    <Item size="sm">
                      <ItemMedia>
                        <Icon icon={CalendarIcon} />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{dated.format(run)}</ItemTitle>
                      </ItemContent>
                      <ItemActions>
                        <Text color="muted" size="sm">
                          {time}
                        </Text>
                      </ItemActions>
                    </Item>
                  </Fragment>
                ))}
              </ItemGroup>
            </span>
          )}
          <span {...stylex.props(styles.part)}>
            <Heading level={2} size="2xs">
              {t`What you get each time`}
            </Heading>
            <Item variant="outline">
              <ItemMedia>
                <AgentFigure look={lookFromName(name)} size="sm" />
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
                <Badge variant="info">{t`New`}</Badge>
              </ItemActions>
            </Item>
          </span>
        </div>
      )}
    </Question>
  );
};
