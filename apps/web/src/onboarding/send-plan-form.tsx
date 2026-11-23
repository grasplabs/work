import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { DatePicker } from "@grasp-os/ui/components/date-picker";
import {
  Field,
  FieldDescription,
  FieldError,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Text } from "@grasp-os/ui/components/text";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { ChevronDownIcon, Icon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { Plural, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { formatList } from "../format.ts";
import { dateLocale } from "./date-locale.ts";
import { dayChoices } from "./send-plan.ts";
import type { SendChoice } from "./send-plan.ts";

const styles = stylex.create({
  // One card, a hairline between its parts.
  card: {
    display: "flex",
    flexDirection: "column",
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.base,
    cornerShape: radius.shape,
  },
  part: {
    display: "flex",
    flexDirection: "column",
    gap: space[3],
    minWidth: 0,
    margin: 0,
    paddingBlock: space[3],
    paddingInline: space[4],
    borderWidth: 0,
    borderBlockStartWidth: { default: size.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  teamsPart: { gap: space[2] },
  words: { display: "flex", flexDirection: "column" },
  // On one line by their words: a day's form to type it in, or why it can't be, hangs below it.
  when: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: space[2],
  },
  day: { width: "11rem" },
  hour: { width: "7rem" },
  // The legend's words stand in the fieldset's own flow, as a row.
  legend: { display: "contents" },
  head: { display: "flex", alignItems: "baseline", gap: space[3] },
  grow: { flexGrow: 1 },
  // Only on a phone, where the teams fold away, on the head's line.
  change: {
    // The Button's own display restated, as null would drop it.
    display: { default: "inline-flex", [media.sm]: "none" },
    marginBlock: `calc(-1 * ${space[1]})`,
  },
  // Many teams scroll in the list, so the step still fits on screen.
  teams: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.sm]: "repeat(2, minmax(0, 1fr))",
    },
    columnGap: space[4],
    rowGap: space[2],
    maxHeight: "9rem",
    margin: 0,
    padding: 0,
    overflowY: "auto",
    listStyle: "none",
  },
  folded: { display: { default: "grid", [media.maxSm]: "none" } },
  team: { display: "flex", alignItems: "center", gap: space[2] },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  count: {
    flexShrink: 0,
    whiteSpace: "nowrap",
    color: colors.mutedForeground,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontVariantNumeric: "tabular-nums",
  },
  at: { color: colors.mutedForeground },
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

/** The last day of `year` as it is typed in `locale`, so its order is plain: "31/12/2026", "12/31/2026". */
const exampleDay = (year: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, 11, 31));

/** Where Damsko's DatePicker marks typed text it can't take, a day that is none or comes too early. */
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
  /** The first day that can be planned. */
  min: string;
  value: string;
  today: string;
  onDay: (day: string) => void;
  onWrong: (wrong: boolean) => void;
}) => {
  const { t, i18n } = useLingui();
  const locale = useDateLocale();
  const example = exampleDay(yearOf(today), locale);
  const earliest = formatDay(min, i18n.locale, yearOf(today));
  const box = useRef<HTMLDivElement>(null);
  const [wrong, setWrong] = useState(false);
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
      tell(false);
    };
  }, []);
  return (
    <div ref={box} {...stylex.props(styles.day)}>
      <Field data-invalid={wrong}>
        <DatePicker
          aria-label={label}
          locale={locale}
          min={min}
          onValueChange={(day) => {
            if (typeof day === "string" && day !== "") {
              onDay(day);
            }
          }}
          size="sm"
          value={value}
        />
        <FieldDescription>{t`For example ${example}`}</FieldDescription>
        <FieldError>{t`I can’t plan that day. Type one like ${example}, ${earliest} or later.`}</FieldError>
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
}: {
  today: string;
  teams: SendTeam[];
  choice: SendChoice;
  onChange: (choice: SendChoice) => void;
  /** Hears whether a day field holds typed text that is no day that can be planned: the first one's, or the later one's. */
  onWrong: (field: "first" | "later", wrong: boolean) => void;
}) => {
  const { t } = useLingui();
  const dayField = useId();
  const timeField = useId();
  const laterField = useId();
  const offered = dayChoices(today);
  const names = {
    tomorrow: t`Tomorrow`,
    after: t`The day after`,
    week: t`Next week`,
  };
  const picked = offered.find((each) => each.day === choice.day)?.id ?? "other";
  const held = teams.filter((team) => choice.held.includes(team.id));
  const going = teams.length - held.length;
  const count = teams.length;
  // On a phone the teams fold into how many go, until they are to be changed: most send to every team.
  const teamsList = useId();
  const list = useRef<HTMLUListElement>(null);
  const [choosing, setChoosing] = useState(false);
  // Opened, the keys go on from the first team.
  useEffect(() => {
    if (choosing) {
      list.current
        ?.querySelector<HTMLElement>('[role="checkbox"], input')
        ?.focus();
    }
  }, [choosing]);
  const at = t({
    message: "at",
    context: "at an hour of the day: on Tuesday at 9:00",
  });
  return (
    <div {...stylex.props(styles.card)}>
      <div {...stylex.props(styles.part)}>
        <div {...stylex.props(styles.words)}>
          <span id={dayField}>{t`The first links go out`}</span>
          <Text as="span" size="xs" color="muted">
            {t`To the team leads. Everyone else follows once their lead has talked.`}
          </Text>
        </div>
        <div {...stylex.props(styles.when)}>
          <ToggleGroup
            aria-labelledby={dayField}
            onValueChange={(value: unknown[]) => {
              const day = offered.find((each) => each.id === value[0])?.day;
              if (day !== undefined) {
                onChange({ ...choice, day });
              }
            }}
            size="sm"
            value={[picked]}
          >
            {offered.map((each) => (
              <ToggleGroupItem key={each.id} value={each.id}>
                {names[each.id]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
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
          <label htmlFor={timeField} {...stylex.props(styles.at)}>
            {at}
          </label>
          <Input
            id={timeField}
            style={styles.hour}
            onValueChange={(time) => {
              onChange({ ...choice, time });
            }}
            size="sm"
            type="time"
            value={choice.time}
          />
        </div>
      </div>
      <fieldset {...stylex.props(styles.part, styles.teamsPart)}>
        <legend {...stylex.props(styles.legend)}>
          <span {...stylex.props(styles.head)}>
            <span {...stylex.props(styles.grow)}>{t`To these teams`}</span>
            <span
              {...stylex.props(styles.count)}
            >{t`${going} of ${count}`}</span>
            {choosing ? null : (
              <Button
                aria-controls={teamsList}
                aria-expanded={false}

                style={styles.change}
                onClick={() => {
                  setChoosing(true);
                }}
                size="xs"
                variant="ghost"
              >
                {t({ message: "Change", context: "change which teams" })}
                <Icon icon={ChevronDownIcon} />
              </Button>
            )}
          </span>
        </legend>
        <ul
          id={teamsList}
          ref={list}
          {...stylex.props(styles.teams, !choosing && styles.folded)}
        >
          {teams.map((team) => {
            const inIt = !choice.held.includes(team.id);
            return (
              <li key={team.id}>
                <label {...stylex.props(styles.team)}>
                  <Checkbox
                    checked={inIt}
                    onCheckedChange={(checked) => {
                      onChange({
                        ...choice,
                        held:
                          checked === true
                            ? choice.held.filter((id) => id !== team.id)
                            : [...choice.held, team.id],
                      });
                    }}
                  />
                  <span {...stylex.props(styles.name)}>{team.name}</span>
                  <span {...stylex.props(styles.count)}>
                    <Plural
                      one="# person"
                      other="# people"
                      value={team.people}
                    />
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {held.length > 0 ? (
        <div {...stylex.props(styles.part)}>
          <div {...stylex.props(styles.words)}>
            <span id={laterField}>
              <Plural
                one="The team you left out"
                other="The # teams you left out"
                value={held.length}
              />
            </span>
            <Text as="span" size="xs" color="muted">
              {formatList(held.map((team) => team.name))}
            </Text>
          </div>
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
                    heldDay: choice.heldDay ?? offered[2]?.day ?? choice.day,
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
              <>
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
                <span {...stylex.props(styles.at)}>{at}</span>
                <Input
                  aria-label={t`The hour the other teams get their links`}
                  style={styles.hour}
                  onValueChange={(heldTime) => {
                    onChange({ ...choice, heldTime });
                  }}
                  size="sm"
                  type="time"
                  value={choice.heldTime}
                />
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
