import type { Agent, AgentWake } from "@grasp-os/shared/agents";
import { agentWakeOpeningMax } from "@grasp-os/shared/agents";
import type { Member } from "@grasp-os/shared/members";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent, CardFooter } from "@grasp-os/ui/components/card";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
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
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  CalendarIcon,
  Icon,
  PlusIcon,
  TrashIcon,
} from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useRouteContext } from "@tanstack/react-router";
import { Fragment, useId, useState } from "react";

import {
  cronOfSchedule,
  rhythms,
  scheduleOfRhythm,
  useScheduleWords,
} from "./schedule.ts";
import type { Rhythm } from "./schedule.ts";
import type { Change } from "./settings-card.tsx";

// An agent's wake-ups, on its page's Schedule tab (agent-page.tsx): when it takes a
// turn nobody asked for, for whom, and what it is asked. An admin picks
// how often and at what time, in the company's time zone, never a cron
// expression; core keeps the schedule as one (agent-wakes.ts) and refuses
// anything more often than hourly. A woken turn only reads: what the
// agent wants to change waits for the person it works for, in their chat.
// Each wake-up says how its last one went. A card of Damsko's Items, a
// new one asked for in a dialog.

/**
 * A time zone's name as the page's language says it ("Central European
 * Time"), from its IANA name; the IANA name where the browser has none.
 */
const formatZone = (timeZone: string, locale: string): string => {
  try {
    return (
      new Intl.DateTimeFormat(locale, {
        timeZone,
        timeZoneName: "longGeneric",
      })
        .formatToParts(new Date())
        .find((part) => part.type === "timeZoneName")?.value ?? timeZone
    );
  } catch {
    // A zone this browser doesn't know.
    return timeZone;
  }
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
  const rhythmNames: Record<Rhythm, string> = {
    weekdays: t`Every weekday`,
    daily: t`Every day`,
    mondays: t`Every Monday`,
  };
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
  const cron = cronOfSchedule(scheduleOfRhythm(rhythm, time));
  const ready = cron !== undefined && person !== "" && opening.trim() !== "";
  return (
    <>
      <Button
        disabled={!can}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
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
                    items={rhythms.map((each) => ({
                      value: each,
                      label: rhythmNames[each],
                    }))}
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
          </DialogBody>
          <DialogFooter>
            <DialogClose>{t`Cancel`}</DialogClose>
            <Button
              disabled={!can || !ready}
              form={formId}
              size="sm"
              type="submit"
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
  const { t, i18n } = useLingui();
  const schedule = useScheduleWords();
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
    // No title: the tab says "Schedule" already; Add a time at its foot.
    <Card aria-label={t`Schedule`} size="sm">
      <CardContent flush>
        {wakes.length === 0 ? (
          <Empty size="sm">
            <EmptyHeader>
              <EmptyDescription>{t`${name} only works when asked.`}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup>
            {wakes.map((wake, index) => {
              const when = schedule.ofCron(wake.cron);
              const person = nameOf(wake.personId);
              const last = lastOf(wake);
              const { opening } = wake;
              return (
                <Fragment key={wake.id}>
                  {index === 0 ? null : <ItemSeparator />}
                  <Item size="sm">
                    <ItemMedia>
                      <Icon icon={CalendarIcon} />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>
                        {when}
                        {/* With the zone it was made in: the company's then,
                        which it keeps if the company's changes. */}
                        <ItemDetail>
                          {formatZone(wake.timeZone, i18n.locale)}
                        </ItemDetail>
                      </ItemTitle>
                      <ItemDescription>
                        {last === undefined
                          ? t`For ${person}: ${opening}`
                          : t`For ${person}: ${opening} · ${last}`}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Field disabled={!can} orientation="horizontal">
                        <FieldLabel>{t`On`}</FieldLabel>
                        <Switch
                          aria-label={t`${when}, for ${person}, is on`}
                          checked={wake.state === "on"}
                          // A spinner while it saves; failed, it stays and says so.
                          onSave={async (next) => {
                            const done = await change(async (session) => {
                              await session.connections.setAgentWakePaused(
                                wake.id,
                                !next
                              );
                            });
                            if (!done) {
                              throw new Error("The wake-up wasn't changed.");
                            }
                          }}
                        />
                      </Field>
                      {editable ? (
                        <Button
                          aria-label={t`Remove ${when}, for ${person}`}
                          disabled={!can}
                          onClick={() => {
                            void change(async (session) => {
                              await session.connections.deleteAgentWake(
                                wake.id
                              );
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
                </Fragment>
              );
            })}
          </ItemGroup>
        )}
      </CardContent>
      {editable ? (
        <CardFooter>
          <NewWake agent={agent} can={can} change={change} people={people} />
        </CardFooter>
      ) : null}
    </Card>
  );
};
