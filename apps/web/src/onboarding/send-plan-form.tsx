import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { DatePicker } from "@grasp-os/ui/components/date-picker";
import { Field } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Separator } from "@grasp-os/ui/components/separator";
import { Switch } from "@grasp-os/ui/components/switch";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { colors, size, space } from "@grasp-os/ui/lib/tokens.stylex";
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
  stack: { display: "grid", gap: space[6] },
  // The sentence, and "Change" a little apart on its baseline, so it reads as the action.
  all: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space[4],
  },
  part: { display: "grid", gap: space[4], justifyItems: "start" },
  // The day typed, the hour beside it; the day's hint or why it can't be hangs below it.
  when: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: space[3],
  },
  day: { width: "12rem" },
  hour: { width: "8rem" },
  // "at" and the hour stay together on one line.
  hourWith: { display: "flex", alignItems: "center", gap: space[3] },
  at: { display: "flex" },
  rows: { margin: 0, padding: 0, listStyle: "none" },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[4],
    paddingBlock: space[3],
    borderBlockStartWidth: { default: size.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
});

// When the links go out, and to whom (prototype
// `components/onboarding/send-plan.tsx`): set by the one person who sends
// them. A day, from the three asked for most or any other, and an hour;
// then the teams, all of them unless one is taken out. For the teams taken
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
  const teamsField = useId();
  const offered = dayChoices(today);
  const names = {
    tomorrow: t`Tomorrow`,
    after: t`The day after`,
    week: t`Next week`,
  };
  const picked = offered.find((each) => each.day === choice.day)?.id ?? "other";
  const held = teams.filter((team) => choice.held.includes(team.id));
  const leftOut = formatList(held.map((team) => team.name));
  const heldCount = held.length;
  const count = teams.length;
  // Every team as the leads step left it: one line, until the admin wants to change which.
  const [choosing, setChoosing] = useState(false);
  const listed = choosing || heldCount > 0;
  const at = t({
    message: "at",
    context: "at an hour of the day: on Tuesday at 9:00",
  });
  return (
    <Card padding="lg">
      <div {...stylex.props(styles.stack)}>
        <div {...stylex.props(styles.part)}>
          <ToggleGroup
            aria-label={t`The day I start`}
            onValueChange={(value: unknown[]) => {
              const day = offered.find((each) => each.id === value[0])?.day;
              if (day !== undefined) {
                onChange({ ...choice, day });
              }
            }}
            value={[picked]}
          >
            {offered.map((each) => (
              <ToggleGroupItem key={each.id} value={each.id}>
                {names[each.id]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div {...stylex.props(styles.when)}>
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
            <span {...stylex.props(styles.hourWith)}>
              <label htmlFor={timeField} {...stylex.props(styles.at)}>
                <Text as="span">{at}</Text>
              </label>
              <Input
                id={timeField}
                onValueChange={(time) => {
                  onChange({ ...choice, time });
                }}
                style={styles.hour}
                type="time"
                value={choice.time}
              />
            </span>
          </div>
        </div>
        <Separator />
        {listed ? (
          <>
            <div id={teamsField}>
              <Text>{t`These teams get links. Switch one off to send its links later.`}</Text>
            </div>
            <ul aria-labelledby={teamsField} {...stylex.props(styles.rows)}>
              {teams.map((team) => {
                const inIt = !choice.held.includes(team.id);
                const { name } = team;
                return (
                  <li key={team.id} {...stylex.props(styles.row)}>
                    <Text>{name}</Text>
                    <Switch
                      aria-label={t`${name} gets links`}
                      checked={inIt}
                      onCheckedChange={(on: boolean) => {
                        onChange({
                          ...choice,
                          held: on
                            ? choice.held.filter((id) => id !== team.id)
                            : [...choice.held, team.id],
                        });
                      }}
                    />
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <div {...stylex.props(styles.all)}>
            <Text>
              {plural(count, {
                one: "Your one team gets links.",
                other: "All # teams get links.",
              })}
            </Text>
            <Button
              onClick={() => {
                setChoosing(true);
              }}
              size="lg"
              variant="link"
            >
              {t({ message: "Change", context: "change which teams" })}
            </Button>
          </div>
        )}
        {held.length > 0 ? (
          <>
            <Separator />
            <div {...stylex.props(styles.part)}>
              <div id={laterField}>
                <Text>
                  {plural(heldCount, {
                    one: `The team you left out: ${leftOut}.`,
                    other: `The # teams you left out: ${leftOut}.`,
                  })}
                </Text>
              </div>
              <ToggleGroup
                aria-labelledby={laterField}
                onValueChange={(value: unknown[]) => {
                  if (value[0] === "open") {
                    onChange({ ...choice, heldDay: null });
                  }
                  if (value[0] === "day") {
                    onChange({
                      ...choice,
                      heldDay: choice.heldDay ?? offered[2]?.day ?? choice.day,
                    });
                  }
                }}
                value={[choice.heldDay === null ? "open" : "day"]}
              >
                <ToggleGroupItem value="open">{t`Not planned yet`}</ToggleGroupItem>
                <ToggleGroupItem value="day">{t`On a later day`}</ToggleGroupItem>
              </ToggleGroup>
              {choice.heldDay === null ? null : (
                <div {...stylex.props(styles.when)}>
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
                  <span {...stylex.props(styles.hourWith)}>
                    <span {...stylex.props(styles.at)}>
                      <Text as="span">{at}</Text>
                    </span>
                    <Input
                      aria-label={t`The hour the other teams get their links`}
                      onValueChange={(heldTime) => {
                        onChange({ ...choice, heldTime });
                      }}
                      style={styles.hour}
                      type="time"
                      value={choice.heldTime}
                    />
                  </span>
                </div>
              )}
            </div>
          </>
        ) : null}
        <Separator />
        {summary}
      </div>
    </Card>
  );
};
