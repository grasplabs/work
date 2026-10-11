import type {
  HeldDecision,
  HeldHow,
  HeldRequest,
  ModelBudget,
  ModelSettings,
  ModelSpender,
} from "@grasp-os/shared/models";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Progress } from "@grasp-os/ui/components/progress";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { dollars, monthEnd, percent, shareOf } from "../settings/money.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// AI spend, for admins, as in the prototype (`routes/settings/spend.tsx`):
// what the models cost this month, as core counts it against the budgets
// Grasp sets, and where it went, by workflow, person and run. Core counts
// spend only against a budget, so without one there is nothing to show;
// the budgets' limits are rules, and stay on the Models page.

/** One number of the top row: what it is, the amount, and a line that puts it in its place. */
const Figure = ({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) => (
  <div className="bg-card flex flex-col gap-0.5 px-5 py-4">
    <span className="text-muted-foreground text-xs">{label}</span>
    <span className="text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
    <span className="text-muted-foreground text-xs">{sub}</span>
  </div>
);

/** This month so far, against the budget of all calls together, and where it ends. */
const Month = ({ budget, month }: { budget: ModelBudget; month: string }) => {
  const { t } = useLingui();
  const spent = budget.spent.reduce((sum, { amount }) => sum + amount, 0);
  const share = percent(shareOf(spent, budget.limit));
  const limit = dollars(budget.limit);
  const end = monthEnd(spent, month, new Date());
  const ending = end === null ? null : dollars(end);
  return (
    <div className="bg-border grid gap-px border-t sm:grid-cols-2">
      <Figure
        label={t`This month so far`}
        sub={t`${share} of the ${limit} budget`}
        value={dollars(spent)}
      />
      {ending === null ? null : (
        <Figure
          label={t`By the end of the month`}
          sub={t`If the rest of the month goes like the days so far`}
          value={t`About ${ending}`}
        />
      )}
    </div>
  );
};

/** Who spent part of a budget, by the name core has for them. */
const spenderName = (of: ModelSpender, i18n: I18n): string => {
  if (of.type === "deployment") {
    return i18n._(msg`All calls`);
  }
  if (of.type === "workflow") {
    const { workflowId } = of;
    const engine = of.appName ?? of.appId;
    return i18n._(msg`${workflowId} in ${engine}`);
  }
  if (of.type === "run") {
    const { runId } = of;
    if (of.workflowId === null) {
      return i18n._(msg`Run ${runId}`);
    }
    const { workflowId } = of;
    const engine = of.appName ?? of.appId ?? "";
    return i18n._(msg`Run of ${workflowId} in ${engine}`);
  }
  return of.name ?? of.userId;
};

const byTitles = {
  workflow: msg`By workflow`,
  user: msg`By person`,
  run: msg`By workflow run`,
} as const;

/** What a budget of each workflow, person or run allows each one. */
const eachLimit = (
  budget: ModelBudget & { scope: "workflow" | "user" | "run" },
  i18n: I18n
): string => {
  const limit = dollars(budget.limit);
  const alertAt = percent(budget.alertAt);
  return budget.scope === "run"
    ? i18n._(
        msg`${limit} for each run, with the runs it starts, over its whole life, admins alerted at ${alertAt}. What each spent so far, this month or before.`
      )
    : i18n._(msg`${limit} a month for each, admins alerted at ${alertAt}.`);
};

/** Where a budget of each workflow, person or run went: one line each, most first. */
const SpentBy = ({
  budget,
}: {
  budget: ModelBudget & { scope: "workflow" | "user" | "run" };
}) => {
  const { t, i18n } = useLingui();
  const top = budget.spent.length;
  return (
    <SettingsSection
      description={eachLimit(budget, i18n)}
      title={i18n._(byTitles[budget.scope])}
    >
      {budget.spent.length === 0 ? (
        <SettingsBody>
          <p className="text-muted-foreground">
            <Trans>Nothing spent yet.</Trans>
          </p>
        </SettingsBody>
      ) : (
        <ul>
          {budget.spent.map(({ of, amount }) => {
            const name = spenderName(of, i18n);
            const share = shareOf(amount, budget.limit);
            const shown = percent(share);
            return (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 border-t px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]"
                key={JSON.stringify(of)}
              >
                <span className="truncate">{name}</span>
                <Progress
                  aria-label={t`${name}: ${shown} of the limit`}
                  className="col-span-2 row-start-2 md:col-span-1 md:row-start-auto"
                  value={Math.min(share, 100)}
                />
                <span className="col-start-2 row-start-1 text-right tabular-nums md:col-start-auto md:row-start-auto">
                  {dollars(amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {budget.more ? (
        <p className="text-muted-foreground border-t px-5 py-3">
          <Trans>The {top} who spent most; more spent less.</Trans>
        </p>
      ) : null}
    </SettingsSection>
  );
};

/**
 * A decision that changed nothing, on a held reservation now gone from the
 * list: someone decided it first, or it was no longer held.
 */
interface Unchanged {
  id: string;
  model: string;
  decision: HeldDecision & { state: "already_decided" | "not_held" };
}

/** What stands for a reservation decided before, in words. */
const UnchangedNotice = ({ unchanged }: { unchanged: Unchanged }) => {
  const { t } = useLingui();
  const { model, decision } = unchanged;
  let what = t`It is no longer held.`;
  if (decision.state === "already_decided") {
    const when = formatDateTime(decision.decidedAt);
    const amount = dollars(decision.amount);
    what =
      decision.how === "charge"
        ? t`It was charged ${amount} on ${when}.`
        : t`It was released on ${when}, charging nothing.`;
  }
  return (
    <Alert>
      <AlertTitle>
        {decision.state === "already_decided"
          ? t`Already decided: ${model}`
          : t`No longer held: ${model}`}
      </AlertTitle>
      <AlertDescription>
        {what} <Trans>Your decision changed nothing.</Trans>
      </AlertDescription>
    </Alert>
  );
};

/**
 * One held reservation, and its two decisions: release what it holds, or
 * charge all of it. Each asks first; core audits it in the admin's name.
 */
const HeldRow = ({
  held,
  onUnchanged,
}: {
  held: HeldRequest;
  onUnchanged: (unchanged: Unchanged) => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [deciding, setDeciding] = useState<HeldHow>();
  // Damaged when listed, or found so when a charge was refused since.
  const [refused, setRefused] = useState(false);
  const { id, model, sentAt } = held;
  const releaseOnly = held.releaseOnly || refused;
  const amount = dollars(held.amount);
  const decide = async (how: HeldHow): Promise<void> => {
    setDeciding(undefined);
    const decision = await run(async (session) => {
      let answered: HeldDecision | undefined;
      await changeThenRefresh(
        async () => {
          answered = await session.models.resolveHeld(id, how);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
      return answered;
    });
    if (decision?.state === "release_only") {
      setRefused(true);
    } else if (
      decision?.state === "already_decided" ||
      decision?.state === "not_held"
    ) {
      onUnchanged({ id, model, decision });
    }
  };
  return (
    <li className="flex flex-col gap-2 border-t px-5 py-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3">
        <span className="truncate">
          {model}{" "}
          <span className="text-muted-foreground">
            {formatDateTime(sentAt)}
          </span>
        </span>
        <span className="text-right tabular-nums">{amount}</span>
        <div className="flex gap-2">
          <Button
            disabled={busy}
            size="sm"
            variant="outline"
            onClick={() => {
              setDeciding("release");
            }}
          >
            <Trans>Release</Trans>
          </Button>
          <Button
            disabled={busy || releaseOnly}
            size="sm"
            variant="outline"
            onClick={() => {
              setDeciding("charge");
            }}
          >
            <Trans>Charge</Trans>
          </Button>
        </div>
      </div>
      <Dialog
        open={deciding !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setDeciding(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {deciding === "charge"
                ? t`Charge ${amount} for this model call?`
                : t`Release the ${amount} held for this model call?`}
            </DialogTitle>
            <DialogDescription>
              {deciding === "charge"
                ? t`It counts against the budgets as spent: the most it could have cost. This can't be undone.`
                : t`It no longer counts against the budgets, as if it cost nothing. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              disabled={busy}
              onClick={() => {
                if (deciding !== undefined) {
                  void decide(deciding);
                }
              }}
            >
              {deciding === "charge" ? (
                <Trans>Charge</Trans>
              ) : (
                <Trans>Release</Trans>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {releaseOnly ? (
        <ErrorText>
          {t`This one can only be released: a budget record it counts against is damaged, so charging it would count against a wrong total. Contact Grasp.`}
        </ErrorText>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/**
 * Model requests whose reservations core couldn't read to settle: they
 * hold part of the budgets until an admin releases or charges each.
 */
const Held = ({ held }: { held: readonly HeldRequest[] }) => {
  const { t } = useLingui();
  // Decisions that changed nothing, newest first: their rows are gone from
  // the list once it is read again, so what stands is shown here instead.
  const [unchanged, setUnchanged] = useState<readonly Unchanged[]>([]);
  if (held.length === 0 && unchanged.length === 0) {
    return null;
  }
  const total = dollars(held.reduce((sum, { amount }) => sum + amount, 0));
  return (
    <SettingsSection
      description={
        held.length === 0
          ? t`Nothing is held for review now.`
          : t`${total} is held for these model calls until you decide: what each could have cost. Release it, or charge it in full.`
      }
      title={t`Held for review`}
    >
      {unchanged.length === 0 ? null : (
        <div className="flex flex-col gap-2 border-t px-5 py-3">
          {unchanged.map((one) => (
            <UnchangedNotice key={one.id} unchanged={one} />
          ))}
        </div>
      )}
      <ul>
        {held.map((one) => (
          <HeldRow
            held={one}
            key={one.id}
            onUnchanged={(added) => {
              setUnchanged((shown) => [
                added,
                ...shown.filter(({ id }) => id !== added.id),
              ]);
            }}
          />
        ))}
      </ul>
    </SettingsSection>
  );
};

const Spend = ({ settings }: { settings: ModelSettings }) => {
  const { t } = useLingui();
  const { month } = settings;
  if (settings.rules.state === "invalid") {
    return (
      <SettingsSection title={t`AI spend`}>
        <SettingsBody>
          <ErrorText>
            {t`The rules in this deployment's configuration can't be read, so every model call is refused. Contact Grasp.`}
          </ErrorText>
        </SettingsBody>
      </SettingsSection>
    );
  }
  const { budgets } = settings.rules;
  if (budgets.length === 0) {
    return (
      <SettingsSection title={t`AI spend`}>
        <SettingsBody>
          <p className="text-muted-foreground">
            <Trans>
              Grasp counts what the models cost against the budgets it sets for
              you. No budget is set, so there is nothing to show.
            </Trans>
          </p>
        </SettingsBody>
      </SettingsSection>
    );
  }
  const all = budgets.find(({ scope }) => scope === "deployment");
  return (
    <>
      <SettingsSection
        description={
          <Trans>
            What the models cost that work for you in Grasp this month ({month},
            UTC), in US dollars, as they are priced.
          </Trans>
        }
        title={t`AI spend`}
      >
        {all === undefined ? null : <Month budget={all} month={month} />}
      </SettingsSection>
      {budgets.map((budget) =>
        budget.scope === "deployment" ? null : (
          <SpentBy
            budget={{ ...budget, scope: budget.scope }}
            key={budget.scope}
          />
        )
      )}
    </>
  );
};

const SpendPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`AI spend`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  // Held reservations show whatever the rules say: they hold money even
  // with no budget set, or rules that don't parse.
  return (
    <>
      <Spend settings={page.data} />
      <Held held={page.data.held} />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/spend")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: SpendPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.models.settings()
    ),
});
