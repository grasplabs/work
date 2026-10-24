import { maxMessagesAnHour } from "@grasp-os/shared/models";
import type {
  PersonLimit,
  PersonLimitFrom,
  PersonLimits,
  PersonLimitSet,
  PersonLimitSubject,
} from "@grasp-os/shared/models";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress } from "@grasp-os/ui/components/progress";
import type { I18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { dollars, percent, shareOf } from "./money.ts";
import { SettingsBody, SettingsSection } from "./settings-parts.tsx";

// The limits a company's admins set per person (D8), on Settings › AI
// spend: a default for everyone, exceptions for a person or a team, and
// each person's spend this month against the limit that applies to them.
// Core keeps them and holds every call to them (person-limits.ts), never
// above Grasp's budgets: the page says the ceiling, refuses a monthly
// limit above it before asking, and says why when core refuses one all
// the same (Grasp lowered a budget meanwhile). Only admins change them.

/** A limit in words: its monthly amount and its messages an hour, either or both none. */
export const limitText = (limit: PersonLimit, i18n: I18n): string => {
  const { monthly, messagesAnHour } = limit;
  if (monthly === null && messagesAnHour === null) {
    return i18n._(msg`No limit`);
  }
  if (messagesAnHour === null) {
    const amount = dollars(monthly ?? 0);
    return i18n._(msg`${amount} a month, no limit on messages`);
  }
  if (monthly === null) {
    return i18n._(
      msg`No monthly limit, ${plural(messagesAnHour, { one: "# message an hour", other: "# messages an hour" })}`
    );
  }
  const amount = dollars(monthly);
  return i18n._(
    msg`${amount} a month, ${plural(messagesAnHour, { one: "# message an hour", other: "# messages an hour" })}`
  );
};

const fromTexts = {
  person: msg`Their own limit`,
  team: msg`Their team's limit`,
  default: msg`The default`,
  none: msg`No limit set`,
} as const satisfies Record<PersonLimitFrom, unknown>;

/** Whom a limit is for, as the page shows them. */
interface Named {
  subject: PersonLimitSubject;
  name: string;
}

/** The input of one of the form's amounts: empty for none. */
const inputOf = (value: number | null): string =>
  value === null ? "" : String(value);

/** Why a monthly limit above Grasp's budget can't be saved. */
const aboveBudget = (ceiling: number, i18n: I18n): string => {
  const most = dollars(ceiling);
  return i18n._(
    msg`Grasp's budget allows at most ${most} a month for one person, so no limit can be above it. Ask Grasp to raise the budget first.`
  );
};

/** Why a limit the form holds can't be saved, or its limit. */
type Checked = { limit: PersonLimit } | { refused: string };

/** The form's values as a limit, or why they can't be one. */
const checked = (
  monthly: string,
  hourly: string,
  ceiling: number | null,
  i18n: I18n
): Checked => {
  const month = monthly.trim() === "" ? null : Number(monthly);
  const hour = hourly.trim() === "" ? null : Number(hourly);
  if (month !== null && !(Number.isFinite(month) && month >= 0)) {
    return {
      refused: i18n._(msg`Enter an amount of at least 0, or leave it empty.`),
    };
  }
  if (
    hour !== null &&
    !(Number.isInteger(hour) && hour >= 1 && hour <= maxMessagesAnHour)
  ) {
    const most = maxMessagesAnHour;
    return {
      refused: i18n._(
        msg`Enter a whole number from 1 to ${most}, or leave it empty.`
      ),
    };
  }
  if (month !== null && ceiling !== null && month > ceiling) {
    return { refused: aboveBudget(ceiling, i18n) };
  }
  return { limit: { monthly: month, messagesAnHour: hour } };
};

/** Why core didn't set a limit, in words; nothing when it did. */
const refusalOf = (set: PersonLimitSet, i18n: I18n): string | undefined => {
  if (set.state === "above_budget") {
    return aboveBudget(set.ceiling, i18n);
  }
  if (set.state === "rules_invalid") {
    return i18n._(
      msg`Grasp's budgets can't be read just now, so no limit can be checked against them. Contact Grasp.`
    );
  }
  if (set.state === "not_found") {
    return i18n._(msg`They are no longer in your organization.`);
  }
  return undefined;
};

/** Who a new exception may be for: the organization's people and teams, by key. */
const choicesOf = (limits: PersonLimits): Map<string, Named> => {
  const choices = new Map<string, Named>();
  for (const { userId, name } of limits.people) {
    choices.set(`person:${userId}`, {
      subject: { type: "person", userId },
      name,
    });
  }
  for (const { teamId, name } of limits.teams) {
    choices.set(`team:${teamId}`, { subject: { type: "team", teamId }, name });
  }
  return choices;
};

/**
 * The form for one limit: for `editing`'s subject, or for a person or team
 * picked from `limits` when there is none. Saves through core, then reads
 * the page again.
 */
const LimitDialog = ({
  limits,
  editing,
  initial,
  title,
  open,
  onOpenChange,
}: {
  limits: PersonLimits;
  editing: Named | undefined;
  initial: PersonLimit;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const whoId = useId();
  const monthlyId = useId();
  const hourlyId = useId();
  const [who, setWho] = useState("");
  const [monthly, setMonthly] = useState(inputOf(initial.monthly));
  const [hourly, setHourly] = useState(inputOf(initial.messagesAnHour));
  const [refused, setRefused] = useState<string>();
  const choices = choicesOf(limits);
  const save = async (): Promise<void> => {
    const subject = editing?.subject ?? choices.get(who)?.subject;
    if (subject === undefined) {
      setRefused(t`Choose a person or a team.`);
      return;
    }
    const values = checked(monthly, hourly, limits.ceiling, i18n);
    if ("refused" in values) {
      setRefused(values.refused);
      return;
    }
    setRefused(undefined);
    const set = await run(async (session) => {
      let answered: PersonLimitSet | undefined;
      await changeThenRefresh(
        async () => {
          answered = await session.models.setLimit(subject, values.limit);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      return answered;
    });
    if (set === undefined) {
      return;
    }
    const reason = refusalOf(set, i18n);
    if (reason === undefined) {
      onOpenChange(false);
    } else {
      setRefused(reason);
    }
  };
  const ceiling = limits.ceiling === null ? null : dollars(limits.ceiling);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {ceiling === null
              ? t`Leave a field empty for no limit.`
              : t`Leave a field empty for no limit. A monthly limit can be at most ${ceiling}, Grasp's budget for one person.`}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <FieldGroup>
            {editing === undefined ? (
              <Field>
                <FieldLabel htmlFor={whoId}>
                  <Trans>Who</Trans>
                </FieldLabel>
                <NativeSelect
                  className="w-full"
                  id={whoId}
                  value={who}
                  onChange={(event) => {
                    setWho(event.target.value);
                  }}
                >
                  <NativeSelectOption value="">
                    {t`Choose a person or a team`}
                  </NativeSelectOption>
                  <NativeSelectOptGroup label={t`People`}>
                    {limits.people.map(({ userId, name }) => (
                      <NativeSelectOption
                        key={userId}
                        value={`person:${userId}`}
                      >
                        {name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                  <NativeSelectOptGroup label={t`Teams`}>
                    {limits.teams.map(({ teamId, name }) => (
                      <NativeSelectOption key={teamId} value={`team:${teamId}`}>
                        {name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelectOptGroup>
                </NativeSelect>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor={monthlyId}>
                <Trans>Most a month, in US dollars</Trans>
              </FieldLabel>
              <Input
                id={monthlyId}
                inputMode="decimal"
                min={0}
                step="any"
                type="number"
                value={monthly}
                onChange={(event) => {
                  setMonthly(event.target.value);
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={hourlyId}>
                <Trans>Most messages an hour</Trans>
              </FieldLabel>
              <Input
                id={hourlyId}
                inputMode="numeric"
                max={maxMessagesAnHour}
                min={1}
                step={1}
                type="number"
                value={hourly}
                onChange={(event) => {
                  setHourly(event.target.value);
                }}
              />
              <FieldDescription>
                <Trans>Messages they send Grasp in a chat app.</Trans>
              </FieldDescription>
            </Field>
            <ErrorText>{refused ?? failure}</ErrorText>
          </FieldGroup>
          <DialogFooter className="mt-4" showCloseButton>
            <Button disabled={busy} type="submit">
              <Trans>Save</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** What the form is open for: the default, an exception, or a new one. */
type Editing =
  | { kind: "default" }
  | { kind: "exception"; named: Named; limit: PersonLimit }
  | { kind: "new" };

/** An exception's name, or what it was for once its person or team is gone. */
const exceptionName = (
  exception: PersonLimits["exceptions"][number],
  i18n: I18n
): string => {
  const { subject, name } = exception;
  if (subject.type === "team") {
    return name === null
      ? i18n._(msg`A team no longer in your organization`)
      : i18n._(msg`Team ${name}`);
  }
  return name ?? i18n._(msg`Someone no longer in your organization`);
};

/** A removal of an exception, then the page read again. */
const RemoveButton = ({
  named,
  onFailure,
}: {
  named: Named;
  onFailure: (reason: string) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, run } = useCoreAction();
  const { name } = named;
  return (
    <Button
      aria-label={t`Remove the exception for ${name}`}
      disabled={busy}
      size="sm"
      variant="outline"
      onClick={() => {
        void run(async (session) => {
          await changeThenRefresh(
            async () => {
              await session.models.removeLimit(named.subject);
            },
            async () => {
              await router.invalidate({ sync: true });
            }
          );
        }, onFailure);
      }}
    >
      <Trans>Remove</Trans>
    </Button>
  );
};

/** One person's spend this month against the limit that applies to them. */
const PersonSpend = ({
  person,
}: {
  person: PersonLimits["people"][number];
}) => {
  const { t, i18n } = useLingui();
  const { name, spent, limit, from } = person;
  const amount = dollars(spent);
  const { monthly } = limit;
  const share = monthly === null ? null : shareOf(spent, monthly);
  const limitShown = monthly === null ? null : dollars(monthly);
  const shown = share === null ? "" : percent(share);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 border-t px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]">
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        <span className="text-muted-foreground text-xs">
          {i18n._(fromTexts[from])}: {limitText(limit, i18n)}
        </span>
      </span>
      {share === null ? (
        <span className="hidden md:block" />
      ) : (
        <Progress
          aria-label={t`${name}: ${shown} of their limit`}
          className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto"
          value={Math.min(share, 100)}
        />
      )}
      <span className="col-start-2 row-start-1 text-right tabular-nums md:col-start-auto md:row-start-auto">
        {limitShown === null ? amount : t`${amount} of ${limitShown}`}
      </span>
    </li>
  );
};

/**
 * The limits per person, and each person's spend against theirs this
 * month; `editable` for admins, who may change them.
 */
export const PersonLimitsSection = ({
  limits,
  editable,
}: {
  limits: PersonLimits;
  editable: boolean;
}) => {
  const { t, i18n } = useLingui();
  const [editing, setEditing] = useState<Editing>();
  const [removeFailure, setRemoveFailure] = useState<string>();
  const ceiling = limits.ceiling === null ? null : dollars(limits.ceiling);
  const listed = limits.people.length;
  const close = (open: boolean): void => {
    if (!open) {
      setEditing(undefined);
    }
  };
  let dialog: { title: string; named?: Named; initial: PersonLimit } | null =
    null;
  if (editing?.kind === "default") {
    dialog = { title: t`Default limit`, initial: limits.default };
  } else if (editing?.kind === "exception") {
    const { name } = editing.named;
    dialog = {
      title: t`Limit for ${name}`,
      named: editing.named,
      initial: editing.limit,
    };
  } else if (editing?.kind === "new") {
    dialog = {
      title: t`Add an exception`,
      initial: { monthly: null, messagesAnHour: null },
    };
  }
  return (
    <SettingsSection
      action={
        editable ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing({ kind: "new" });
            }}
          >
            <Trans>Add an exception</Trans>
          </Button>
        ) : undefined
      }
      description={
        ceiling === null
          ? t`What each person's model calls may cost a month, and how many messages they may send an hour. A person's own exception goes first, then their team's, then the default.`
          : t`What each person's model calls may cost a month, and how many messages they may send an hour. A person's own exception goes first, then their team's, then the default. Grasp's budget of ${ceiling} a person is the ceiling.`
      }
      title={t`Limits per person`}
    >
      <ul>
        <li className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          <span className="flex min-w-0 flex-col">
            <span>
              <Trans>Everyone without an exception</Trans>
            </span>
            <span className="text-muted-foreground">
              {limitText(limits.default, i18n)}
            </span>
          </span>
          {editable ? (
            <Button
              aria-label={t`Change the default limit`}
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing({ kind: "default" });
              }}
            >
              <Trans>Change</Trans>
            </Button>
          ) : null}
        </li>
        {limits.exceptions.map((exception) => {
          const name = exceptionName(exception, i18n);
          const named = { subject: exception.subject, name };
          return (
            <li
              className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3"
              key={JSON.stringify(exception.subject)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{name}</span>
                <span className="text-muted-foreground">
                  {limitText(exception.limit, i18n)}
                </span>
              </span>
              {editable ? (
                <span className="flex gap-2">
                  <Button
                    aria-label={t`Change the limit for ${name}`}
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing({
                        kind: "exception",
                        named,
                        limit: exception.limit,
                      });
                    }}
                  >
                    <Trans>Change</Trans>
                  </Button>
                  <RemoveButton named={named} onFailure={setRemoveFailure} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {removeFailure === undefined ? null : (
        <SettingsBody>
          <ErrorText>{removeFailure}</ErrorText>
        </SettingsBody>
      )}
      <h3 className="border-t px-5 pt-4 pb-1 font-medium">
        <Trans>This month by person</Trans>
      </h3>
      {limits.people.length === 0 ? (
        <SettingsBody>
          <p className="text-muted-foreground">
            <Trans>No one is in your organization yet.</Trans>
          </p>
        </SettingsBody>
      ) : (
        <ul aria-label={t`This month by person`}>
          {limits.people.map((person) => (
            <PersonSpend key={person.userId} person={person} />
          ))}
        </ul>
      )}
      {limits.more ? (
        <p className="text-muted-foreground border-t px-5 py-3">
          <Trans>The first {listed} people, by name.</Trans>
        </p>
      ) : null}
      {dialog === null ? null : (
        <LimitDialog
          editing={dialog.named}
          initial={dialog.initial}
          key={dialog.title}
          limits={limits}
          open
          title={dialog.title}
          onOpenChange={close}
        />
      )}
    </SettingsSection>
  );
};
