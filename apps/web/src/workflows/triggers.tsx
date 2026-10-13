import type { WorkflowTrigger } from "@grasp-os/shared/workflows";
import { Badge } from "@grasp-os/ui/components/badge";
import { Trans, useLingui } from "@lingui/react/macro";
import { CalendarClockIcon, MailIcon, ZapIcon } from "lucide-react";

import { formatDateTime } from "../format.ts";

// What starts a workflow on its own, as its App's current version
// registered it (core's `WorkflowDetail.triggers`): a schedule with its
// next run and whether it stopped, an email address, or an event.

const ScheduleTrigger = ({
  trigger,
}: {
  trigger: Extract<WorkflowTrigger, { type: "schedule" }>;
}) => {
  const { t } = useLingui();
  const { param, timeZone, nextRunAt } = trigger;
  const next = nextRunAt === null ? undefined : formatDateTime(nextRunAt);
  return (
    <>
      <CalendarClockIcon aria-hidden="true" className="mt-0.5 size-4" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">
          {t`On the schedule set by ${param} (${timeZone})`}
        </span>
        <span className="text-muted-foreground text-xs">
          {next === undefined ? t`No next run` : t`Next run: ${next}`}
        </span>
      </span>
      {trigger.stopped ? (
        <Badge variant="destructive">
          <Trans context="a schedule that stopped">Stopped</Trans>
        </Badge>
      ) : null}
    </>
  );
};

/** One trigger: what starts the workflow, in words. */
const Trigger = ({ trigger }: { trigger: WorkflowTrigger }) => {
  const { t } = useLingui();
  if (trigger.type === "schedule") {
    return <ScheduleTrigger trigger={trigger} />;
  }
  if (trigger.type === "email") {
    const { address } = trigger;
    return (
      <>
        <MailIcon aria-hidden="true" className="mt-0.5 size-4" />
        <span className="min-w-0 flex-1 font-medium">
          {t`When an email arrives at ${address}`}
        </span>
      </>
    );
  }
  const { event } = trigger;
  return (
    <>
      <ZapIcon aria-hidden="true" className="mt-0.5 size-4" />
      <span className="min-w-0 flex-1 font-medium">
        {t`When the event ${event} happens`}
      </span>
    </>
  );
};

/** A workflow's triggers, or that only a person starts it. */
export const WorkflowTriggers = ({
  triggers,
}: {
  triggers: readonly WorkflowTrigger[];
}) => {
  const { t } = useLingui();
  if (triggers.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        <Trans>
          Nothing starts it on its own: it runs when someone starts it.
        </Trans>
      </p>
    );
  }
  return (
    <ul aria-label={t`Triggers`} className="flex flex-col gap-2">
      {triggers.map((trigger) => (
        <li
          className="bg-card flex items-start gap-2 rounded-xl border px-4 py-3 shadow-xs"
          // Its place among the workflow's triggers, its own alone: two
          // alike in all shown (one event, two filters) are two rows.
          key={trigger.position}
        >
          <Trigger trigger={trigger} />
        </li>
      ))}
    </ul>
  );
};
