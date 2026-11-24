import type { Agent, AgentWake } from "@grasp-os/shared/agents";
import { agentWakeOpeningMax } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Empty,
  EmptyHeader,
  EmptyDescription,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Form, FormRow } from "@grasp-os/ui/components/form";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
} from "@grasp-os/ui/components/select";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { toast } from "@grasp-os/ui/components/toast";
import {
  Icon,
  CalendarIcon,
  PlusIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { useId, useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatZone } from "../format.ts";
import { SeparatedItems } from "../workflows/separated-items.tsx";
import { SectionCard } from "./section-card.tsx";

// An agent's wake-ups, on its page's Schedule tab (agent-page.tsx): when it takes a
// turn nobody asked for, for whom, and what it is asked. An admin picks
// how often and at what time, in the company's time zone, never a cron
// expression; core keeps the schedule as one (agent-wakes.ts) and refuses
// anything more often than hourly. A woken turn only reads: what the
// agent wants to change waits for the person it works for, in their chat.
// Each wake-up says how its last one went. A card of Grasp UI's Items,
// a new one asked for in a dialog.

/** What a page change asks of core, then the page read again. */
/**
 * A change asked of core, then the page read again; whether it was made.
 * Why it wasn't goes under the page's header, or to `report` (a dialog's
 * own line, where the person is looking).
 */
type Change = (
  action: (session: Session) => Promise<unknown>,
  report?: (why: string) => void
) => Promise<boolean>;

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
const useWhen = () => {
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
export const useLast = () => {
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
            // In the zone it was made in, not the company's as it is now.
            timeZone: wake.timeZone,
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
  // Why the last Add didn't go through, in the dialog the person is in.
  const [why, setWhy] = useState<string>();
  const cron = cronOf(rhythm, time);
  const ready = cron !== undefined && person !== "" && opening.trim() !== "";
  return (
    <>
      <Button
        variant="outline"
        disabled={!can}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        <Icon icon={PlusIcon} />
        {t`Add a time`}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Add a time`}</DialogTitle>
            <DialogDescription>
              {t`It only reads. What it wants to change waits in that person's chat.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                if (cron === undefined || !ready) {
                  return;
                }
                void (async () => {
                  setWhy(undefined);
                  const added = await change(async (session) => {
                    await session.connections.makeAgentWake(agent.id, {
                      cron,
                      personId: person,
                      opening: opening.trim(),
                    });
                  }, setWhy);
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
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
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
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
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
            <ErrorText>{why}</ErrorText>
          </DialogBody>
          <DialogFooter>
            <DialogClose>{t`Cancel`}</DialogClose>
            <Button
              disabled={!can || !ready}
              form={formId}
              size="sm"
              type="submit"
              variant="default"
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
    // No title: the side nav says "Schedule" already; Add a time at its foot.
    <SectionCard
      aria-label={t`Schedule`}
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
        <Empty size="sm">
          <EmptyHeader>
            <EmptyDescription>{t`${name} only works when asked.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <SeparatedItems
          rows={wakes.map((wake) => {
            const when = whenOf(wake);
            const person = nameOf(wake.personId);
            const last = lastOf(wake);
            const { opening } = wake;
            return {
              key: wake.id,
              row: (
                <Item key={wake.id} size="sm">
                  <ItemMedia variant="default">
                    <Icon icon={CalendarIcon} />
                  </ItemMedia>
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
                    <Field orientation="horizontal" disabled={!can}>
                      <FieldLabel>{t`On`}</FieldLabel>
                      <Switch
                        checked={wake.state === "on"}
                        onCheckedChange={(next) => {
                          void change(async (session) => {
                            await session.connections.setAgentWakePaused(
                              wake.id,
                              !next
                            );
                          });
                        }}
                      />
                    </Field>
                    {editable ? (
                      <Button
                        aria-label={t`Remove ${when}, for ${person}`}
                        disabled={!can}
                        onClick={() => {
                          void removeWithUndo(wake, change, {
                            done: t`Time removed`,
                            undo: t`Undo`,
                          });
                        }}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Icon icon={TrashIcon} />
                      </Button>
                    ) : null}
                  </ItemActions>
                </Item>
              ),
            };
          })}
        />
      )}
    </SectionCard>
  );
};
