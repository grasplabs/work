import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { DatePicker } from "@grasp-os/ui/components/date-picker";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { addYears, datePattern } from "@ui-sdk/react/date";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";

import { formatList } from "../format.ts";
import { TopError } from "../frame/top-error.tsx";
import { dateLocale } from "./date-locale.ts";
import { dayChoices } from "./send-plan.ts";
import type { SendChoice } from "./send-plan.ts";

const styles = stylex.create({
  stack: { display: "grid", gap: space[5] },
  // The quick days and the day and hour, on one row while there is room; the day and hour go on
  // a row of their own together, never one without the other.
  when: {
    display: "flex",
    flexWrap: "wrap",
    minWidth: 0,
    alignItems: "center",
    gap: space[3],
  },
  quick: { display: "flex", flexWrap: "wrap", gap: space[2] },
  // The day typed, "at" and the hour beside it.
  // On a narrow phone "at" and the hour go under the day, together.
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
  // What a part of the card is about, small and quiet over it.
  label: {
    color: colors.mutedForeground,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // A set of choices with none of a fieldset's own frame.
  set: { margin: 0, padding: 0, borderWidth: 0, minWidth: 0 },
  legend: { padding: 0, marginBlockEnd: space[2] },
  part: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: space[2],
    justifyItems: "start",
  },
  // The teams, each a tick and its name, side by side and on as many rows as they need.
  teams: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: space[5],
    rowGap: space[1],
  },
  // What happens next: the card's foot, under a hairline.
  summary: {
    paddingBlockStart: space[4],
    borderBlockStartWidth: 1,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
});

// When the links go out, and to whom (prototype
// `components/onboarding/send-plan.tsx`): set by the one person who sends
// them, on one calm card under its own title, so it stands as a part of the
// step as clear as the message over it. A day, from the three asked for most (the chosen
// one filled, so it reads at a glance) or any other, and an hour, on one
// row; then the teams as ticks, all of them unless one is taken out; then
// what happens next, in one line on the card's foot. For the teams taken
// out: a later day and hour, or nothing yet, so a first group can go this
// week and the rest when they are ready. Leads get theirs at that moment;
// everyone else once their lead has talked.

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

export const SendPlanForm = ({
  today,
  teams,
  choice,
  onChange,
  onWrong,
  summary,
}: {
  /** What happens next, as the plan stands: the card's last line. */
  summary: ReactNode;
  today: string;
  teams: SendTeam[];
  choice: SendChoice;
  onChange: (choice: SendChoice) => void;
  /** Hears whether a day field holds typed text that is no day that can be planned: the first one's, or the later one's. */
  onWrong: (field: "first" | "later", wrong: boolean) => void;
}) => {
  const { t } = useLingui();
  const timeField = useId();
  const laterField = useId();
  const offered = dayChoices(today);
  const names = {
    tomorrow: t`Tomorrow`,
    after: t`The day after`,
    week: t`Next week`,
  };
  const held = teams.filter((team) => choice.held.includes(team.id));
  const leftOut = formatList(held.map((team) => team.name));
  const heldCount = held.length;
  const at = t({
    message: "at",
    context: "at an hour of the day: on Tuesday at 9:00",
  });
  return (
    <Card asChild>
      <section>
        <CardHeader>
          <CardTitle level={2}>{t`When the links go out`}</CardTitle>
        </CardHeader>
        <CardContent>
          <div {...stylex.props(styles.stack)}>
            <div {...stylex.props(styles.when)}>
              <fieldset
                aria-label={t`The day I start`}
                {...stylex.props(styles.set, styles.quick)}
              >
                {offered.map((each) => {
                  const on = each.day === choice.day;
                  return (
                    <Button
                      aria-pressed={on}
                      key={each.id}
                      onClick={() => {
                        onChange({ ...choice, day: each.day });
                      }}
                      size="sm"
                      variant={on ? "default" : "outline"}
                    >
                      {names[each.id]}
                    </Button>
                  );
                })}
              </fieldset>
              <span {...stylex.props(styles.dayHour)}>
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
                <span {...stylex.props(styles.atHour)}>
                  <label htmlFor={timeField} {...stylex.props(styles.at)}>
                    <Text as="span">{at}</Text>
                  </label>
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
                </span>
              </span>
            </div>
            {teams.length > 1 ? (
              <fieldset {...stylex.props(styles.set, styles.part)}>
                <legend {...stylex.props(styles.label, styles.legend)}>
                  {t`Teams that get links`}
                </legend>
                <div {...stylex.props(styles.teams)}>
                  {teams.map((team) => (
                    <Field key={team.id} orientation="horizontal">
                      <Checkbox
                        checked={!choice.held.includes(team.id)}
                        onCheckedChange={(checked) => {
                          const on = checked === true;
                          onChange({
                            ...choice,
                            held: on
                              ? choice.held.filter((id) => id !== team.id)
                              : [...choice.held, team.id],
                          });
                        }}
                      />
                      <FieldLabel>{team.name}</FieldLabel>
                    </Field>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {heldCount > 0 ? (
              <div {...stylex.props(styles.part)}>
                <span id={laterField} {...stylex.props(styles.label)}>
                  {plural(heldCount, {
                    one: `When ${leftOut} gets links`,
                    other: `When ${leftOut} get links`,
                  })}
                </span>
                <div {...stylex.props(styles.when)}>
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
              </div>
            ) : null}
            <div {...stylex.props(styles.summary)}>{summary}</div>
          </div>
        </CardContent>
      </section>
    </Card>
  );
};
