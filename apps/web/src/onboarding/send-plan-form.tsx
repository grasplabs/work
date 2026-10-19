import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Input } from "@grasp-os/ui/components/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { Plural, useLingui } from "@lingui/react/macro";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { formatList } from "../format.ts";
import { dayChoices } from "./send-plan.ts";
import type { SendChoice } from "./send-plan.ts";

// When the links go out, and to whom (prototype
// `components/onboarding/send-plan.tsx`): set by the one person who sends
// them. A day, from the three asked for most or any other, and an hour;
// then the teams, all of them unless one is taken out. For the teams taken
// out: a later day and hour, or nothing yet, so a first group can go this
// week and the rest when they are ready. Leads get theirs at that moment;
// everyone else once their lead has talked.

/** A team as the choice lists it. */
export interface SendTeam {
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
export const formatDay = (iso: string, locale: string): string => {
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
    <div className="flex flex-col divide-y rounded-xl border">
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-col">
          <span id={dayField}>{t`The first links go out`}</span>
          <span className="text-muted-foreground text-xs">
            {t`To the team leads. Everyone else follows once their lead has talked.`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            variant="outline"
          >
            {offered.map((each) => (
              <ToggleGroupItem key={each.id} value={each.id}>
                {names[each.id]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Input
            aria-label={t`Another day`}
            className="w-40"
            min={today}
            onChange={(event) => {
              if (event.target.value !== "") {
                onChange({ ...choice, day: event.target.value });
              }
            }}
            type="date"
            value={choice.day}
          />
          <label className="text-muted-foreground" htmlFor={timeField}>
            {at}
          </label>
          <Input
            className="w-28"
            id={timeField}
            onChange={(event) => {
              onChange({ ...choice, time: event.target.value });
            }}
            type="time"
            value={choice.time}
          />
        </div>
      </div>
      <fieldset className="flex flex-col gap-2 px-4 py-3">
        <legend className="contents">
          <span className="flex items-baseline gap-3">
            <span className="flex-1">{t`To these teams`}</span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {t`${going} of ${count}`}
            </span>
            {choosing ? null : (
              <Button
                aria-controls={teamsList}
                aria-expanded={false}
                className="-my-1 sm:hidden"
                onClick={() => {
                  setChoosing(true);
                }}
                size="xs"
                variant="ghost"
              >
                {t({ message: "Change", context: "change which teams" })}
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            )}
          </span>
        </legend>
        <ul
          className={cn(
            "grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2",
            !choosing && "max-sm:hidden"
          )}
          id={teamsList}
          ref={list}
        >
          {teams.map((team) => {
            const inIt = !choice.held.includes(team.id);
            return (
              <li key={team.id}>
                <label className="flex items-center gap-2.5">
                  <Checkbox
                    checked={inIt}
                    onCheckedChange={(checked: boolean) => {
                      onChange({
                        ...choice,
                        held: checked
                          ? choice.held.filter((id) => id !== team.id)
                          : [...choice.held, team.id],
                      });
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate">{team.name}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">
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
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-col">
            <span id={laterField}>
              <Plural
                one="The team you left out"
                other="The # teams you left out"
                value={held.length}
              />
            </span>
            <span className="text-muted-foreground text-xs">
              {formatList(held.map((team) => team.name))}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
              variant="outline"
            >
              <ToggleGroupItem value="open">{t`Not planned yet`}</ToggleGroupItem>
              <ToggleGroupItem value="day">{t`On a later day`}</ToggleGroupItem>
            </ToggleGroup>
            {choice.heldDay === null ? null : (
              <>
                <Input
                  aria-label={t`The day the other teams get their links`}
                  className="w-40"
                  min={choice.day}
                  onChange={(event) => {
                    if (event.target.value !== "") {
                      onChange({ ...choice, heldDay: event.target.value });
                    }
                  }}
                  type="date"
                  value={choice.heldDay}
                />
                <span className="text-muted-foreground">{at}</span>
                <Input
                  aria-label={t`The hour the other teams get their links`}
                  className="w-28"
                  onChange={(event) => {
                    onChange({ ...choice, heldTime: event.target.value });
                  }}
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
