import { Plural, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";

import { formatList } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox } from "../grasp/checkbox/index.ts";
import { DatePicker } from "../grasp/date-picker/index.ts";
import { ChevronDown } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { dayChoices } from "./send-plan.ts";
import type { SendChoice } from "./send-plan.ts";

const styles = stylex.create({
  // One card, a hairline between its parts.
  card: {
    display: "flex",
    flexDirection: "column",
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.line,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
  part: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    minWidth: 0,
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
    borderWidth: 0,
    borderBlockStartWidth: { default: grasp.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  teamsPart: { gap: grasp.space2 },
  words: { display: "flex", flexDirection: "column" },
  when: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  day: { width: "10rem" },
  hour: { width: "7rem" },
  // The legend's words stand in the fieldset's own flow, as a row.
  legend: { display: "contents" },
  head: { display: "flex", alignItems: "baseline", gap: grasp.space3 },
  grow: { flexGrow: 1 },
  // Only on a phone, where the teams fold away, on the head's line.
  change: {
    display: { default: null, [media.fromPhone]: "none" },
    marginBlock: `calc(-1 * ${grasp.space1})`,
  },
  // Many teams scroll in the list, so the step still fits on screen.
  teams: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromPhone]: "repeat(2, minmax(0, 1fr))",
    },
    columnGap: grasp.space4,
    rowGap: grasp.space2,
    maxHeight: "9rem",
    margin: 0,
    padding: 0,
    overflowY: "auto",
    listStyle: "none",
  },
  folded: { display: { default: "grid", [media.belowPhone]: "none" } },
  team: { display: "flex", alignItems: "center", gap: grasp.space2 },
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
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontVariantNumeric: "tabular-nums",
  },
  at: { color: grasp.muted },
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

/** "6 Oct": an ISO day, without its year, in the page's language. */
const formatDay = (iso: string, locale: string): string => {
  const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);
  if (locale === "en") {
    return `${day} ${isoMonths[month - 1] ?? ""}`;
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, day));
};

const leadingZero = /^0/u;

/** A choice in a sentence, as the screen says it: "on 6 Oct at 9:00". */
export const useSendWords = (): ((day: string, time: string) => string) => {
  const { t, i18n } = useLingui();
  return (day, time) => {
    const date = formatDay(day, i18n.locale);
    const hour = time.replace(leadingZero, "");
    return t`on ${date} at ${hour}`;
  };
};

export const SendPlanForm = ({
  today,
  teams,
  choice,
  onChange,
}: {
  today: string;
  teams: SendTeam[];
  choice: SendChoice;
  onChange: (choice: SendChoice) => void;
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
          <Text element="span" size="xs" tone="muted">
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
              <Toggle key={each.id} value={each.id}>
                {names[each.id]}
              </Toggle>
            ))}
          </ToggleGroup>
          <div {...stylex.props(styles.day)}>
            <DatePicker
              aria-label={t`Another day`}
              min={today}
              onValueChange={(value) => {
                if (typeof value === "string" && value !== "") {
                  onChange({ ...choice, day: value });
                }
              }}
              size="sm"
              value={choice.day}
            />
          </div>
          <label htmlFor={timeField} {...stylex.props(styles.at)}>
            {at}
          </label>
          <Input
            id={timeField}
            layout={styles.hour}
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
                iconEnd={ChevronDown}
                layout={styles.change}
                onClick={() => {
                  setChoosing(true);
                }}
                size="xs"
                variant="ghost"
              >
                {t({ message: "Change", context: "change which teams" })}
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
            <Text element="span" size="xs" tone="muted">
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
              <Toggle value="open">{t`Not planned yet`}</Toggle>
              <Toggle value="day">{t`On a later day`}</Toggle>
            </ToggleGroup>
            {choice.heldDay === null ? null : (
              <>
                <div {...stylex.props(styles.day)}>
                  <DatePicker
                    aria-label={t`The day the other teams get their links`}
                    min={choice.day}
                    onValueChange={(value) => {
                      if (typeof value === "string" && value !== "") {
                        onChange({ ...choice, heldDay: value });
                      }
                    }}
                    size="sm"
                    value={choice.heldDay}
                  />
                </div>
                <span {...stylex.props(styles.at)}>{at}</span>
                <Input
                  aria-label={t`The hour the other teams get their links`}
                  layout={styles.hour}
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
