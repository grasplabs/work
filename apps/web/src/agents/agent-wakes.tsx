import type { Agent, AgentWake } from "@grasp-os/shared/agents";
import { agentWakeOpeningMax } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import { useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { useId, useState } from "react";

import type { Session } from "../core.ts";
import { formatZone } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import { Form, FormRow } from "../grasp/form/index.ts";
import { CalendarIcon, Plus, Trash } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Select } from "../grasp/select/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { toast } from "../grasp/toast/index.ts";

// An agent's wake-ups, on its page's Schedule tab (agent-page.tsx): when it takes a
// turn nobody asked for, for whom, and what it is asked. An admin picks
// how often and at what time, in the company's time zone, never a cron
// expression; core keeps the schedule as one (agent-wakes.ts) and refuses
// anything more often than hourly. A woken turn only reads: what the
// agent wants to change waits for the person it works for, in their chat.
// Each wake-up says how its last one went. A card of Grasp UI's Items,
// a new one asked for in a dialog.

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

/**
 * Removes `wake` at once and offers Undo in a toast, as the library's
 * Confirmations pattern has an undoable removal: Undo makes it again, as
 * it was (paused again if it was), through the same call as Add a time.
 */
const removeWithUndo = async (
  wake: AgentWake,
  change: Change,
  words: { done: string; undo: string }
): Promise<void> => {
  let removed = false;
  await change(async (session) => {
    await session.connections.deleteAgentWake(wake.id);
    removed = true;
  });
  if (!removed) {
    return;
  }
  toast.success(words.done, {
    action: {
      label: words.undo,
      onAction: () => {
        void change(async (session) => {
          const made = await session.connections.makeAgentWake(wake.agentId, {
            cron: wake.cron,
            personId: wake.personId,
            opening: wake.opening,
          });
          if (wake.state === "paused") {
            await session.connections.setAgentWakePaused(made.id, true);
          }
        });
      },
    },
  });
};

/** Add a time: its button, and the dialog that asks when, for whom and what. */
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
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [rhythm, setRhythm] = useState<Rhythm>("weekdays");
  const [time, setTime] = useState("09:00");
  // For the admin adding it, when they are among the people; else the first.
  const me = useRouteContext({ strict: false }).identity?.userId;
  const [person, setPerson] = useState(
    people.find(({ userId }) => userId === me)?.userId ??
      people[0]?.userId ??
      ""
  );
  const [opening, setOpening] = useState("");
  const cron = cronOf(rhythm, time);
  const ready = cron !== undefined && person !== "" && opening.trim() !== "";
  return (
    <>
      <Button
        disabled={!can}
        icon={Plus}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        {t`Add a time`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent closeLabel={t`Close`}>
          <DialogTitle>{t`Add a time`}</DialogTitle>
          <DialogDescription>
            {t`It only reads. What it wants to change waits in that person's chat.`}
          </DialogDescription>
          <DialogBody>
            <Form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                if (cron === undefined || !ready) {
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
                  // Only what was added is cleared: one core refused stays
                  // to be corrected.
                  if (added) {
                    setOpening("");
                    setOpen(false);
                  }
                })();
              }}
            >
              <FormRow>
                <Field disabled={!can}>
                  <FieldLabel>{t`How often`}</FieldLabel>
                  <Select
                    items={[
                      { value: "weekdays", label: t`Every weekday` },
                      { value: "daily", label: t`Every day` },
                      { value: "mondays", label: t`Every Monday` },
                    ]}
                    onValueChange={(value) => {
                      const next = rhythms.find((one) => one === value);
                      if (next !== undefined) {
                        setRhythm(next);
                      }
                    }}
                    value={rhythm}
                  />
                </Field>
                <Field disabled={!can}>
                  <FieldLabel>{t`Time`}</FieldLabel>
                  <Input onValueChange={setTime} type="time" value={time} />
                  <FieldDescription>{t`In the company's time zone`}</FieldDescription>
                </Field>
              </FormRow>
              <Field disabled={!can}>
                <FieldLabel>{t`For whom`}</FieldLabel>
                <Select
                  items={people.map(({ userId, name, email }) => ({
                    value: userId,
                    label: name === "" ? email : name,
                  }))}
                  onValueChange={(value) => {
                    setPerson(value ?? "");
                  }}
                  value={person}
                />
              </Field>
              <Field disabled={!can}>
                <FieldLabel>{t`What to ask it each time`}</FieldLabel>
                <Textarea
                  maxLength={agentWakeOpeningMax}
                  onValueChange={setOpening}
                  placeholder={t`Look for overdue invoices and say which.`}
                  rows={3}
                  value={opening}
                />
              </Field>
            </Form>
          </DialogBody>
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button
              disabled={!can || !ready}
              form={formId}
              type="submit"
              variant="ink"
            >
              {t`Add`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

/** An agent's wake-ups, a row each, and Add a time: the Schedule tab's card. */
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
    // No title: the page's is "Schedule" already; Add a time at its foot.
    <SectionCard
      aria-label={t`Schedule`}
      density="compact"
      flush
      {...(editable
        ? {
            footer: (
              <NewWake
                agent={agent}
                can={can}
                change={change}
                people={people}
              />
            ),
          }
        : {})}
    >
      {wakes.length === 0 ? (
        <Empty size="inline">{t`${name} only works when asked.`}</Empty>
      ) : (
        <ItemGroup separated>
          {wakes.map((wake) => {
            const when = whenOf(wake);
            const person = nameOf(wake.personId);
            const last = lastOf(wake);
            const { opening } = wake;
            return (
              <Item key={wake.id} size="sm">
                <ItemMedia icon={CalendarIcon} iconLook="inline" />
                <ItemContent>
                  <ItemTitle>
                    {when}
                    {/* With the zone it was made in: the company's then,
                        which it keeps if the company's changes. */}
                    <ItemDetail>{formatZone(wake.timeZone)}</ItemDetail>
                  </ItemTitle>
                  <ItemDescription>
                    {last === undefined
                      ? t`For ${person}: ${opening}`
                      : t`For ${person}: ${opening} · ${last}`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    checked={wake.state === "on"}
                    disabled={!can}
                    label={t`On`}
                    onCheckedChange={(next) => {
                      void change(async (session) => {
                        await session.connections.setAgentWakePaused(
                          wake.id,
                          !next
                        );
                      });
                    }}
                  />
                  {editable ? (
                    <Button
                      aria-label={t`Remove ${when}, for ${person}`}
                      disabled={!can}
                      icon={Trash}
                      onClick={() => {
                        void removeWithUndo(wake, change, {
                          done: t`Time removed`,
                          undo: t`Undo`,
                        });
                      }}
                      size="sm"
                      variant="ghost"
                    />
                  ) : null}
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      )}
    </SectionCard>
  );
};
