import type { Agent, AgentWake } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import type { Session } from "../core.ts";
import { Row } from "../settings/stephen-settings.tsx";

// An agent's wake-ups, on its page's Schedule tab (agent-page.tsx): when it takes a
// turn nobody asked for, for whom, and what it is asked. An admin picks
// how often and at what time, in the company's time zone, never a cron
// expression; core keeps the schedule as one (agent-wakes.ts) and refuses
// anything more often than hourly. A woken turn only reads: what the
// agent wants to change waits for the person it works for, in their chat.
// Each wake-up says how its last one went. Its rows are Settings ›
// Stephen's (`Row`), on a card of the agent's page.

/** What a page change asks of core, then the page read again. */
type Change = (action: (session: Session) => Promise<unknown>) => Promise<void>;

/** How often a wake-up made here fires. */
const rhythms = ["weekdays", "daily", "mondays"] as const;
type Rhythm = (typeof rhythms)[number];

/** The cron field for the days each rhythm names. */
const daysOf = { weekdays: "1-5", daily: "*", mondays: "1" } as const;

const timePattern = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u;

/** The schedule for `rhythm` at `time` (`HH:MM`), as core keeps it; undefined for no time. */
export const cronOf = (rhythm: Rhythm, time: string): string | undefined => {
  const { hour, minute } = timePattern.exec(time)?.groups ?? {};
  return hour === undefined || minute === undefined
    ? undefined
    : `${Number(minute)} ${Number(hour)} * * ${daysOf[rhythm]}`;
};

const cronPattern = /^(?<minute>\d{1,2}) (?<hour>\d{1,2}) \* \* (?<days>\S+)$/u;

/**
 * The rhythm and time a schedule made here names; undefined for any other,
 * which is shown as core keeps it.
 */
export const readCron = (
  cron: string
): { rhythm: Rhythm; time: string } | undefined => {
  const { minute, hour, days } = cronPattern.exec(cron)?.groups ?? {};
  const rhythm = rhythms.find((each) => daysOf[each] === days);
  if (minute === undefined || hour === undefined || rhythm === undefined) {
    return undefined;
  }
  return {
    rhythm,
    time: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
  };
};

/** When a wake-up fires, in words. */
export const useWhen = () => {
  const { t } = useLingui();
  return (wake: Pick<AgentWake, "cron">): string => {
    const read = readCron(wake.cron);
    if (read === undefined) {
      return wake.cron;
    }
    const { time } = read;
    if (read.rhythm === "weekdays") {
      return t`Every weekday at ${time}`;
    }
    return read.rhythm === "daily"
      ? t`Every day at ${time}`
      : t`Every Monday at ${time}`;
  };
};

/** How a wake-up's last one went, in words; undefined before its first. */
const useLast = () => {
  const { t, i18n } = useLingui();
  return ({ lastAt, lastOutcome }: AgentWake): string | undefined => {
    if (lastAt === null || lastOutcome === null) {
      return undefined;
    }
    const when = new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(lastAt));
    if (lastOutcome === "started") {
      return t`Last ran ${when}`;
    }
    if (lastOutcome === "agent.paused") {
      return t`Didn't run ${when}: the agent was paused`;
    }
    if (lastOutcome === "agent.not_for_you") {
      return t`Didn't run ${when}: the agent isn't set up to answer this person`;
    }
    if (lastOutcome === "permission.person_inactive") {
      return t`Didn't run ${when}: this person is no longer in the company`;
    }
    return lastOutcome === "model.no_provider"
      ? t`Didn't run ${when}: no AI provider is connected`
      : t`Didn't run ${when}: something went wrong`;
  };
};

/** The form that adds a wake-up to `agent`. */
const NewWake = ({
  agent,
  people,
  can,
  change,
}: {
  agent: Agent;
  people: readonly Member[];
  can: boolean;
  change: Change;
}) => {
  const { t } = useLingui();
  const rhythmId = useId();
  const timeId = useId();
  const personId = useId();
  const openingId = useId();
  const [rhythm, setRhythm] = useState<Rhythm>("weekdays");
  const [time, setTime] = useState("09:00");
  const [person, setPerson] = useState(people[0]?.userId ?? "");
  const [opening, setOpening] = useState("");
  const cron = cronOf(rhythm, time);
  const ready = cron !== undefined && person !== "" && opening.trim() !== "";
  return (
    <form
      className="flex flex-col gap-4 border-t px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (cron === undefined) {
          return;
        }
        void (async () => {
          let added = false;
          await change(async (session) => {
            await session.connections.makeAgentWake(agent.id, {
              cron,
              personId: person,
              opening: opening.trim(),
            });
            added = true;
          });
          // Only what was added is cleared: one core refused stays to be
          // corrected.
          if (added) {
            setOpening("");
          }
        })();
      }}
    >
      <div className="flex flex-col gap-4 sm:flex-row">
        <Field className="flex-1">
          <FieldLabel htmlFor={rhythmId}>
            <Trans>How often</Trans>
          </FieldLabel>
          <NativeSelect
            disabled={!can}
            id={rhythmId}
            onChange={(event) => {
              const next = rhythms.find((one) => one === event.target.value);
              if (next !== undefined) {
                setRhythm(next);
              }
            }}
            value={rhythm}
          >
            <NativeSelectOption value="weekdays">{t`Every weekday`}</NativeSelectOption>
            <NativeSelectOption value="daily">{t`Every day`}</NativeSelectOption>
            <NativeSelectOption value="mondays">{t`Every Monday`}</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field className="flex-1">
          <FieldLabel htmlFor={timeId}>
            {t`At, in the company's time zone`}
          </FieldLabel>
          <Input
            disabled={!can}
            id={timeId}
            onChange={(event) => {
              setTime(event.target.value);
            }}
            type="time"
            value={time}
          />
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={personId}>
          <Trans>For whom</Trans>
        </FieldLabel>
        <NativeSelect
          disabled={!can}
          id={personId}
          onChange={(event) => {
            setPerson(event.target.value);
          }}
          value={person}
        >
          {people.map(({ userId, name, email }) => (
            <NativeSelectOption key={userId} value={userId}>
              {name === "" ? email : name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={openingId}>
          <Trans>What to ask it each time</Trans>
        </FieldLabel>
        <Textarea
          disabled={!can}
          id={openingId}
          maxLength={2000}
          onChange={(event) => {
            setOpening(event.target.value);
          }}
          placeholder={t`Such as: look for invoices that are overdue and say which.`}
          rows={3}
          value={opening}
        />
      </Field>
      <div className="flex justify-end">
        <Button disabled={!can || !ready} type="submit" variant="outline">
          <Trans>Add a time</Trans>
        </Button>
      </div>
    </form>
  );
};

/** An agent's wake-ups, and the way to add one, as rows of its panel. */
export const AgentWakes = ({
  agent,
  wakes,
  people,
  editable,
  can,
  change,
}: {
  agent: Agent;
  wakes: readonly AgentWake[];
  /** The company's people, whom a wake-up can work for. */
  people: readonly Member[];
  /** Whether the person may change wake-ups at all. */
  editable: boolean;
  /** Whether they may now: not while a change is on its way to core. */
  can: boolean;
  change: Change;
}) => {
  const { t } = useLingui();
  const whenOf = useWhen();
  const lastOf = useLast();
  const { name } = agent;
  const nameOf = (userId: string): string => {
    const found = people.find((each) => each.userId === userId);
    if (found === undefined) {
      return t`Someone no longer in the company`;
    }
    return found.name === "" ? found.email : found.name;
  };
  return (
    <>
      <li className="flex flex-col gap-0.5 border-t px-5 py-4">
        <span className="font-medium">
          <Trans>When it works on its own</Trans>
        </span>
        <span className="text-muted-foreground">
          {t`At these times it looks into something without being asked. It only reads. What it wants to change waits in that person's chat until they confirm it.`}
        </span>
      </li>
      {wakes.map((wake) => {
        const when = whenOf(wake);
        const person = nameOf(wake.personId);
        const last = lastOf(wake);
        const { opening } = wake;
        return (
          <Row
            description={
              last === undefined
                ? t`For ${person}: ${opening}`
                : t`For ${person}: ${opening} · ${last}`
            }
            key={wake.id}
            // With the zone it was made in: the company's then, which it
            // keeps if the company's changes.
            name={`${when} · ${wake.timeZone}`}
          >
            <span className="flex items-center gap-3">
              <Switch
                aria-label={t`${when}, for ${person}, is on`}
                checked={wake.state === "on"}
                disabled={!can}
                onCheckedChange={(next) => {
                  void change(async (session) => {
                    await session.connections.setAgentWakePaused(
                      wake.id,
                      !next
                    );
                  });
                }}
              />
              <Button
                aria-label={t`Remove ${when}, for ${person}`}
                disabled={!can}
                onClick={() => {
                  void change(async (session) => {
                    await session.connections.deleteAgentWake(wake.id);
                  });
                }}
                size="sm"
                variant="ghost"
              >
                <Trans>Remove</Trans>
              </Button>
            </span>
          </Row>
        );
      })}
      {editable || wakes.length > 0 ? null : (
        <li className="text-muted-foreground border-t px-5 py-4">
          {t`${name} never works on its own.`}
        </li>
      )}
      {/* Kept while a change is on its way, only disabled: what is typed
          and not yet added stays. */}
      {editable ? (
        <li>
          <NewWake agent={agent} can={can} change={change} people={people} />
        </li>
      ) : null}
    </>
  );
};
