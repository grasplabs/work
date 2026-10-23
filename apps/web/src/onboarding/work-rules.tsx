import {
  SETTLERS,
  STARTING_ORG_RULES,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgRules,
  Settler,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { RotateCcwIcon } from "lucide-react";
import { useId } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatPercent } from "../format.ts";
import { useInterviewAction } from "./use-interview-action.ts";

// When a piece of work counts as known, for this organization only
// (prototype `org-workflows.tsx`, its rules): every organization starts
// with the same values, and Grasp tunes them as its interviews come in.
// A change is kept in core at once, and shows in the work behind.

/** What each rule can be set to. */
const peopleChoices = [2, 3, 4, 5];
const leastChoices = [3, 4, 5, 6, 8];
const shareChoices = [0.01, 0.03, 0.05, 0.1, 0.15];
const mostChoices = [8, 10, 12, 15];

/** The values on offer for a rule: a value the organization already has stays on the list, whatever it is. */
const offer = (values: number[], now: number): number[] =>
  [...new Set([...values, now])].toSorted((a, b) => a - b);

const changedFromStart = (rules: OrgRules): boolean =>
  rules.people !== STARTING_ORG_RULES.people ||
  rules.minInterviews !== STARTING_ORG_RULES.minInterviews ||
  rules.stopShare !== STARTING_ORG_RULES.stopShare ||
  rules.maxInterviews !== STARTING_ORG_RULES.maxInterviews ||
  rules.run !== STARTING_ORG_RULES.run ||
  rules.settles !== STARTING_ORG_RULES.settles;

/** One rule: what it is and why, with its value under it, wide enough to say it in a sentence. */
const Rule = ({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: (id: string) => ReactNode;
}) => {
  const id = useId();
  return (
    <div className="flex flex-col gap-2 border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id}>{label}</label>
        <p className="text-muted-foreground">{description}</p>
      </div>
      {children(id)}
    </div>
  );
};

/** One rule's value, from what is on offer. */
const Choice = ({
  id,
  value,
  items,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  items: { value: string; label: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) => (
  <NativeSelect
    disabled={disabled}
    id={id}
    onChange={(event) => {
      onChange(event.target.value);
    }}
    value={value}
  >
    {items.map((item) => (
      <NativeSelectOption key={item.value} value={item.value}>
        {item.label}
      </NativeSelectOption>
    ))}
  </NativeSelect>
);

export const WorkRules = ({
  rules,
  open,
  onOpenChange,
}: {
  rules: OrgRules;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, act } = useInterviewAction();
  const set = (change: Partial<OrgRules>) => {
    act(async (staff) => {
      await staff.setRules({ ...rules, ...change });
    });
  };
  const perStep = offer(peopleChoices, rules.people).map((people) => {
    const fewer = people - 1;
    return {
      value: String(people),
      label: t`${people}, or ${fewer} and a document`,
    };
  });
  const least = offer(leastChoices, rules.minInterviews).map((value) => ({
    value: String(value),
    label: plural(value, {
      one: "# agreed interview",
      other: "# agreed interviews",
    }),
  }));
  const shares = offer(shareChoices, rules.stopShare).map((value) => {
    const stop = formatPercent(value);
    return {
      value: String(value),
      label: t`The last interviews added less than ${stop} new facts`,
    };
  });
  const split = offer(mostChoices, rules.maxInterviews).map((most) => ({
    value: String(most),
    label: t`After ${most} interviews, it is better split in two`,
  }));
  const settles: Record<Settler, string> = {
    owner: t`The owner of the workflow settles one nobody can explain`,
    lead: t`The team lead settles one nobody can explain`,
    sponsor: t`The sponsor settles one nobody can explain`,
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl" closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>{t`When a workflow is known`}</DialogTitle>
          <DialogDescription>
            {t`For this organization only. Every organization starts with the same values, and Grasp tunes them as its interviews come in.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col text-sm">
          <Rule
            description={t`People who do the work themselves. The lead's own account is an overview, never one of them.`}
            label={t`People per step`}
          >
            {(id) => (
              <Choice
                disabled={busy}
                id={id}
                items={perStep}
                onChange={(value) => {
                  set({ people: Number(value) });
                }}
                value={String(rules.people)}
              />
            )}
          </Rule>
          <Rule
            description={t`Fewer than this, and the workflow is still being heard.`}
            label={t`Before it is checked`}
          >
            {(id) => (
              <Choice
                disabled={busy}
                id={id}
                items={least}
                onChange={(value) => {
                  set({ minInterviews: Number(value) });
                }}
                value={String(rules.minInterviews)}
              />
            )}
          </Rule>
          <Rule
            description={t`Then more interviews would only repeat what is known.`}
            label={t`When it stops`}
          >
            {(id) => (
              <Choice
                disabled={busy}
                id={id}
                items={shares}
                onChange={(value) => {
                  set({ stopShare: Number(value) });
                }}
                value={String(rules.stopShare)}
              />
            )}
          </Rule>
          <Rule
            description={t`Probably two workflows in one, or teams that work differently.`}
            label={t`When it does not settle`}
          >
            {(id) => (
              <Choice
                disabled={busy}
                id={id}
                items={split}
                onChange={(value) => {
                  set({ maxInterviews: Number(value) });
                }}
                value={String(rules.maxInterviews)}
              />
            )}
          </Rule>
          <Rule
            description={t`Most differences are findings: it depends on the case, the office or the date. Only one nobody can explain needs someone to settle it.`}
            label={t`When people say different things`}
          >
            {(id) => (
              <Choice
                disabled={busy}
                id={id}
                items={SETTLERS.map((value) => ({
                  value,
                  label: settles[value],
                }))}
                onChange={(value) => {
                  set({
                    settles:
                      SETTLERS.find((each) => each === value) ?? rules.settles,
                  });
                }}
                value={rules.settles}
              />
            )}
          </Rule>
        </div>
        <ErrorText>{failure}</ErrorText>
        <div className="flex justify-start">
          <Button
            disabled={busy || !changedFromStart(rules)}
            onClick={() => {
              act(async (staff) => {
                await staff.setRules(null);
              });
            }}
            size="sm"
            variant="ghost"
          >
            <RotateCcwIcon data-icon="inline-start" />
            <Trans>Starting values</Trans>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
