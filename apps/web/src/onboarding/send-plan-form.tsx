import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { DatePicker } from "@grasp-os/ui/components/date-picker";
import { Field } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { CheckIcon, Icon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { addYears, datePattern } from "@ui-sdk/react/date";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";

import { formatList } from "../format.ts";
import { TopError } from "../frame/top-error.tsx";
import { dateLocale } from "./date-locale.ts";
import { dayChoices, workingDaysAfter } from "./send-plan.ts";
import type { SendChoice } from "./send-plan.ts";

const styles = stylex.create({
  // What is set, each on a row with its name on the start edge; on a phone the name over it.
  rows: {
    display: "grid",
    gridTemplateColumns: {
      default: "4.5rem minmax(0, 1fr)",
      [media.maxSm]: "minmax(0, 1fr)",
    },
    columnGap: space[4],
    rowGap: { default: space[5], [media.maxSm]: space[2] },
    alignItems: "center",
  },
  // The name of a row, small and quiet.
  label: {
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    marginBlockStart: { default: 0, [media.maxSm]: space[3] },
  },
  dayPart: { display: "grid", gap: space[3], minWidth: 0 },
  // The next working days as tiles, a little calendar, and another day after them.
  strip: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(6, minmax(0, 1fr))",
      [media.maxSm]: "repeat(3, minmax(0, 1fr))",
    },
    gap: space[2],
  },
  tile: {
    display: "grid",
    justifyItems: "center",
    alignContent: "center",
    gap: 2,
    minHeight: "4.5rem",
    paddingBlock: space[2],
    paddingInline: space[1],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.mutedForeground },
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    color: colors.foreground,
    fontFamily: font.sans,
    cursor: "pointer",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineOffset: 2,
    outlineColor: colors.ring,
    transitionProperty: "background-color, border-color, color",
    transitionDuration: "150ms",
  },
  tileOn: {
    borderColor: { default: colors.primary, ":hover": colors.primary },
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
  },
  tileOther: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    textAlign: "center",
  },
  tileSmall: {
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    opacity: 0.7,
  },
  tileDay: {
    fontSize: font.textLg,
    lineHeight: 1.1,
    fontWeight: font.weightSemibold,
    fontVariantNumeric: "tabular-nums",
  },
  // The day typed, "at" and the hour beside it; on a narrow phone "at" and the hour go under the day.
  dayHour: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
  },
  atHour: { display: "flex", alignItems: "center", gap: space[2] },
  day: { width: "11rem" },
  hour: { width: "7rem" },
  at: { display: "flex" },
  // The teams as pills, each with its tick: on, it gets links on the day; off, it waits.
  pills: { display: "flex", flexWrap: "wrap", gap: space[2] },
  pill: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
    paddingBlock: space[1],
    paddingInlineStart: space[2],
    paddingInlineEnd: space[3],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":hover": colors.mutedForeground },
    borderRadius: radius.full,
    backgroundColor: colors.card,
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    cursor: "pointer",
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: 2,
    outlineOffset: 2,
    outlineColor: colors.ring,
    transitionProperty: "background-color, border-color, color",
    transitionDuration: "150ms",
  },
  pillOn: {
    borderColor: { default: colors.primary, ":hover": colors.primary },
    color: colors.foreground,
  },
  // The tick's round: empty while off, filled while on.
  tick: {
    display: "grid",
    placeItems: "center",
    width: "1.125rem",
    height: "1.125rem",
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    color: "transparent",
  },
  tickIcon: { width: "0.75rem", height: "0.75rem" },
  tickOn: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
  },
  // A set of choices with none of a fieldset's own frame.
  set: { margin: 0, padding: 0, borderWidth: 0, minWidth: 0 },
  later: { display: "grid", gap: space[3], justifyItems: "start", minWidth: 0 },
});

// When the links go out, and to whom (prototype
// `components/onboarding/send-plan.tsx`): set by the one person who sends
// them, on one card under its own title, a part of the step as clear as
// the message over it. Each thing set on a row with its name at the start:
// the day, as tiles for today and the next working days, a little calendar, with
// another day after them; the hour; the teams, as pills with their tick,
// all of them unless one is taken out. For the teams taken out: a later
// day and hour, or nothing yet, so a first group can go this week and the
// rest when they are ready. What happens next on the card's foot. Leads
// get theirs at that moment; everyone else once their lead has talked.

/** A team as the choice lists it. */
interface SendTeam {
  id: string;
  name: string;
  people: number;
}

const isoMonths = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "6 Oct", or "6 Oct 2027" in a year other than `thisYear`: an ISO day in the page's language. */
const formatDay = (iso: string, locale: string, thisYear: number): string => {
  const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);
  const withYear = year !== thisYear;
  if (locale === "en") {
    const date = `${day} ${isoMonths[month - 1] ?? ""}`;
    return withYear ? `${date} ${year}` : date;
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, day));
};

/** The year of an ISO day. */
const yearOf = (iso: string): number => Number(iso.slice(0, 4));

const leadingZero = /^0/u;

/** A choice in a sentence, as the screen says it, `today` being today: "on 6 Oct at 9:00", "on 4 Jan 2027 at 9:00". */
export const useSendWords = (
  today: string
): ((day: string, time: string) => string) => {
  const { t, i18n } = useLingui();
  return (day, time) => {
    const date = formatDay(day, i18n.locale, yearOf(today));
    const hour = time.replace(leadingZero, "");
    return t`on ${date} at ${hour}`;
  };
};

/** The locale this person types a date in: the page's language in their browser's region (date-locale.ts). */
const useDateLocale = (): string => {
  const { i18n } = useLingui();
  return dateLocale(
    i18n.locale,
    typeof navigator === "undefined" ? [] : navigator.languages
  );
};

/** How far ahead a plan can be: further is a slip of the keys ("2062" for "2026"). */
const yearsAhead = 2;

/** Where Damsko's DatePicker marks typed text it can't take, a day that is none or comes too early or too late. */
const unreadable = '[data-slot="date-picker"][data-invalid]';

/**
 * A day, typed in this person's own date order or chosen in the calendar,
 * with the form to type it in under it; while what is typed is no day that
 * can be planned, why, said as it shows, and `onWrong` hears it, so the
 * plan is not sent with the day before it.
 */
const DayField = ({
  label,
  min,
  value,
  today,
  onDay,
  onWrong,
}: {
  label: string;
  /** The first day that can be planned; the last is two years from today. */
  min: string;
  value: string;
  today: string;
  onDay: (day: string) => void;
  onWrong: (wrong: boolean) => void;
}) => {
  const { t, i18n } = useLingui();
  const locale = useDateLocale();
  // The picker's own example, the last day of this year, so typed as shown it is read as that day.
  const { example } = datePattern(locale);
  const max = addYears(today, yearsAhead);
  const earliest = formatDay(min, i18n.locale, yearOf(today));
  const latest = formatDay(max, i18n.locale, yearOf(today));
  const box = useRef<HTMLDivElement>(null);
  const [wrong, setWrong] = useState(false);
  const forget = useEffectEvent(() => {
    onWrong(false);
  });
  // At once: the press that left the field lands on a plan that waits.
  const tell = useEffectEvent((now: boolean) => {
    flushSync(() => {
      setWrong(now);
      onWrong(now);
    });
  });
  // The picker keeps typed text it can't take, marked, and the day before it; it says so only by its
  // mark, until Damsko's DatePicker tells a page itself. Gone, as when the later teams are not
  // planned after all, the field holds nothing up.
  useEffect(() => {
    const at = box.current;
    const watch = new MutationObserver(() => {
      tell(at?.querySelector(unreadable) !== null);
    });
    if (at !== null) {
      watch.observe(at, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-invalid"],
      });
    }
    return () => {
      watch.disconnect();
      // Gone, it holds nothing up. Not at once: React is mid-commit here, where flushSync can't run.
      forget();
    };
  }, []);
  return (
    <div ref={box} {...stylex.props(styles.day)}>
      <Field data-invalid={wrong}>
        <DatePicker
          aria-label={label}
          locale={locale}
          max={max}
          min={min}
          onValueChange={(day) => {
            if (typeof day === "string" && day !== "") {
              onDay(day);
            }
          }}
          size="sm"
          value={value}
        />
        {/* Said in the bar at the top, as every error in the setup is; the field keeps its mark. */}
        <TopError>
          {wrong
            ? t`I can’t plan that day. Type one like ${example}, from ${earliest} to ${latest}.`
            : null}
        </TopError>
      </Field>
    </div>
  );
};

/** An ISO day as a Date at its noon, in UTC. */
const dateOf = (day: string) => new Date(`${day}T12:00:00Z`);

/** How many working days the strip offers, from the next one. */
const stripLength = 5;

export const SendPlanForm = ({
  today,
  teams,
  choice,
  onChange,
  onWrong,
  summary,
}: {
  /** What happens next, as the plan stands: the card's foot. */
  summary: ReactNode;
  today: string;
  teams: SendTeam[];
  choice: SendChoice;
  onChange: (choice: SendChoice) => void;
  /** Hears whether a day field holds typed text that is no day that can be planned: the first one's, or the later one's. */
  onWrong: (field: "first" | "later", wrong: boolean) => void;
}) => {
  const { t, i18n } = useLingui();
  const timeField = useId();
  const laterField = useId();
  const dayLabel = useId();
  const teamsLabel = useId();
  // Today first, as a plan can start today; then the next working days.
  const strip = [today, ...workingDaysAfter(today, stripLength - 1)];
  const inStrip = strip.includes(choice.day);
  // Another day asked for, or one set before that the strip has no tile for: the day field shows.
  const [picking, setPicking] = useState(!inStrip);
  const other = picking || !inStrip;
  const offered = dayChoices(today);
  const held = teams.filter((team) => choice.held.includes(team.id));
  const leftOut = formatList(held.map((team) => team.name));
  const heldCount = held.length;
  const at = t({
    message: "at",
    context: "at an hour of the day: on Tuesday at 9:00",
  });
  const weekday = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "short",
    timeZone: "UTC",
  });
  const month = new Intl.DateTimeFormat(i18n.locale, {
    month: "short",
    timeZone: "UTC",
  });
  // A tile's name, read out whole: "Monday 30 November".
  const whole = new Intl.DateTimeFormat(i18n.locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  return (
    <Card asChild>
      <section>
        <CardHeader>
          <CardTitle level={2}>{t`When the links go out`}</CardTitle>
        </CardHeader>
        <CardContent>
          <div {...stylex.props(styles.rows)}>
            <span id={dayLabel} {...stylex.props(styles.label)}>
              {t({ message: "Day", context: "the day the links go out" })}
            </span>
            <div {...stylex.props(styles.dayPart)}>
              <fieldset
                aria-labelledby={dayLabel}
                {...stylex.props(styles.set, styles.strip)}
              >
                {strip.map((day) => {
                  const on = !other && day === choice.day;
                  const date = dateOf(day);
                  return (
                    <button
                      aria-label={whole.format(date)}
                      aria-pressed={on}
                      key={day}
                      onClick={() => {
                        setPicking(false);
                        onChange({ ...choice, day });
                      }}
                      type="button"
                      {...stylex.props(styles.tile, on && styles.tileOn)}
                    >
                      <span {...stylex.props(styles.tileSmall)}>
                        {day === today
                          ? t({ message: "Today", context: "a day tile" })
                          : weekday.format(date)}
                      </span>
                      <span {...stylex.props(styles.tileDay)}>
                        {date.getUTCDate()}
                      </span>
                      <span {...stylex.props(styles.tileSmall)}>
                        {month.format(date)}
                      </span>
                    </button>
                  );
                })}
                <button
                  aria-pressed={other}
                  onClick={() => {
                    // The field shows, from the day set so far.
                    setPicking(true);
                  }}
                  type="button"
                  {...stylex.props(
                    styles.tile,
                    styles.tileOther,
                    other && styles.tileOn
                  )}
                >
                  {t`Other day`}
                </button>
              </fieldset>
              {other ? (
                <DayField
                  label={t`Another day`}
                  min={today}
                  onDay={(day) => {
                    onChange({ ...choice, day });
                  }}
                  onWrong={(wrong) => {
                    onWrong("first", wrong);
                  }}
                  today={today}
                  value={choice.day}
                />
              ) : null}
            </div>
            <label htmlFor={timeField} {...stylex.props(styles.label)}>
              {t({ message: "Time", context: "the hour the links go out" })}
            </label>
            <div>
              <Input
                id={timeField}
                onValueChange={(time) => {
                  onChange({ ...choice, time });
                }}
                size="sm"
                style={styles.hour}
                type="time"
                value={choice.time}
              />
            </div>
            {teams.length > 1 ? (
              <>
                <span id={teamsLabel} {...stylex.props(styles.label)}>
                  {t({ message: "Teams", context: "the teams that get links" })}
                </span>
                <fieldset
                  aria-labelledby={teamsLabel}
                  {...stylex.props(styles.set, styles.pills)}
                >
                  {teams.map((team) => {
                    const on = !choice.held.includes(team.id);
                    return (
                      <button
                        aria-pressed={on}
                        key={team.id}
                        onClick={() => {
                          onChange({
                            ...choice,
                            held: on
                              ? [...choice.held, team.id]
                              : choice.held.filter((id) => id !== team.id),
                          });
                        }}
                        type="button"
                        {...stylex.props(styles.pill, on && styles.pillOn)}
                      >
                        <span
                          {...stylex.props(styles.tick, on && styles.tickOn)}
                        >
                          <Icon icon={CheckIcon} style={styles.tickIcon} />
                        </span>
                        {team.name}
                      </button>
                    );
                  })}
                </fieldset>
              </>
            ) : null}
            {heldCount > 0 ? (
              <>
                <span id={laterField} {...stylex.props(styles.label)}>
                  {leftOut}
                </span>
                <div {...stylex.props(styles.later)}>
                  <ToggleGroup
                    aria-labelledby={laterField}
                    onValueChange={(value: unknown[]) => {
                      if (value[0] === "open") {
                        onChange({ ...choice, heldDay: null });
                      }
                      if (value[0] === "day") {
                        onChange({
                          ...choice,
                          heldDay:
                            choice.heldDay ?? offered[2]?.day ?? choice.day,
                        });
                      }
                    }}
                    size="sm"
                    value={[choice.heldDay === null ? "open" : "day"]}
                  >
                    <ToggleGroupItem value="open">{t`Not planned yet`}</ToggleGroupItem>
                    <ToggleGroupItem value="day">{t`On a later day`}</ToggleGroupItem>
                  </ToggleGroup>
                  {choice.heldDay === null ? null : (
                    <span {...stylex.props(styles.dayHour)}>
                      <DayField
                        label={t`The day the other teams get their links`}
                        min={choice.day}
                        onDay={(heldDay) => {
                          onChange({ ...choice, heldDay });
                        }}
                        onWrong={(wrong) => {
                          onWrong("later", wrong);
                        }}
                        today={today}
                        value={choice.heldDay}
                      />
                      <span {...stylex.props(styles.atHour)}>
                        <span {...stylex.props(styles.at)}>
                          <Text as="span">{at}</Text>
                        </span>
                        <Input
                          aria-label={t`The hour the other teams get their links`}
                          onValueChange={(heldTime) => {
                            onChange({ ...choice, heldTime });
                          }}
                          size="sm"
                          style={styles.hour}
                          type="time"
                          value={choice.heldTime}
                        />
                      </span>
                    </span>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </CardContent>
        <CardFooter>{summary}</CardFooter>
      </section>
    </Card>
  );
};
