import { runsPageSize } from "@grasp-os/shared/workflows";
import type { ListedRun, RunStatus } from "@grasp-os/shared/workflows";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { formatDateTime } from "../format.ts";
import { AskToFix } from "./fix-in-chat.tsx";

// Runs as the Workflows page and a workflow's page list them, in the
// prototype's runs log (grasplabs/prototype `components/runs-log.tsx`):
// when, the workflow, who started it, and what happened, with a dot in
// the status colours. A run waiting for a decision links to where it is
// answered; a failed one says why and offers a fix in chat.

const statusLabels: Readonly<Record<RunStatus, MessageDescriptor>> = {
  running: msg`Running`,
  waiting: msg`Waiting for a decision`,
  paused: msg`Paused`,
  completed: msg`Completed`,
  failed: msg`Failed`,
  cancelled: msg`Cancelled`,
};

/** A run's status, in words, in the page's language. */
export const runStatusLabel = (status: RunStatus): string =>
  i18n._(statusLabels[status]);

/** Who started a run, in words, for the person `me`. */
const startedByOf = ({ startedBy }: ListedRun, me: string): string => {
  if (startedBy.type === "trigger") {
    return i18n._(msg`Automatically`);
  }
  return startedBy.userId === me ? i18n._(msg`You`) : i18n._(msg`Someone else`);
};

/**
 * A run's status with its dot, as the prototype's `RunResult`: green once
 * done, the attention colour where someone is needed (waiting, failed),
 * ink while it goes on or after it stopped.
 */
export const RunResult = ({ status }: { status: RunStatus }) => (
  <span className="inline-flex items-center gap-2">
    {status === "completed" ? (
      <span
        aria-hidden="true"
        className="bg-status-agreed size-1.75 flex-none rounded-full"
      />
    ) : null}
    {status === "waiting" || status === "failed" ? (
      <span
        aria-hidden="true"
        className="bg-status-attention size-1.75 flex-none rounded-full"
      />
    ) : null}
    {status === "running" || status === "paused" || status === "cancelled" ? (
      <span
        aria-hidden="true"
        className="bg-foreground size-1.75 flex-none rounded-full"
      />
    ) : null}
    {runStatusLabel(status)}
  </span>
);

/**
 * What happened: the status, with the link to the decision it waits for
 * when the person may answer it (core sends it only then), or, for those
 * who see it, why it failed and a fix in chat. That reason is the
 * workflow's own text, shown as text. A run whose details were removed,
 * its retention over, says so in place of the reason, which went with them.
 */
const RunOutcome = ({
  run,
  model,
}: {
  run: ListedRun;
  model: string | undefined;
}) => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col items-start gap-1">
      <RunResult status={run.status} />
      {run.decision === undefined ? null : (
        <Link
          className="underline-offset-4 hover:underline"
          params={{ decision: run.decision }}
          to="/decisions/$decision"
        >
          <Trans>Decide</Trans>
        </Link>
      )}
      {run.failure === undefined || run.detailsRemoved ? null : (
        <span className="text-muted-foreground text-xs">
          {run.failure.step === null
            ? run.failure.error.message
            : t`At ${ph({ step: run.failure.step })}: ${ph({ error: run.failure.error.message })}`}
        </span>
      )}
      {run.detailsRemoved ? (
        <span className="text-muted-foreground text-xs">
          <Trans>Details removed</Trans>
        </span>
      ) : null}
      {/* Only where the person sees why it failed: core fixes nothing
          else, nor a run whose details are gone. */}
      {run.status === "failed" &&
      run.failure !== undefined &&
      !run.detailsRemoved &&
      model !== undefined ? (
        <AskToFix inLog model={model} run={run.id} />
      ) : null}
    </div>
  );
};

/**
 * The runs log, in the order core lists them (waiting runs first); with
 * each one's workflow unless `withWorkflow` is false, as on a workflow's
 * own page. `more` says core had more than it sent; `empty` what to say
 * when there are none, such as that none match the filters. `model` is
 * the one a fix in chat asks with, if there is one.
 */
export const RunsLog = ({
  runs,
  more,
  me,
  model,
  empty,
  withWorkflow = true,
}: {
  runs: ListedRun[];
  more: boolean;
  me: string;
  model: string | undefined;
  empty?: string;
  withWorkflow?: boolean;
}) => {
  const { t } = useLingui();
  if (runs.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-4 py-6 text-center">
        {empty ?? t`Nothing has run yet.`}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-card overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44" variant="card">
                <Trans context="column: when a run happened">When</Trans>
              </TableHead>
              {withWorkflow ? (
                <TableHead variant="card">
                  <Trans>Workflow</Trans>
                </TableHead>
              ) : null}
              <TableHead variant="card">
                <Trans>Started by</Trans>
              </TableHead>
              <TableHead variant="card">
                <Trans context="column: what happened in a run">Result</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="align-top" variant="card">
                  <span className="text-muted-foreground tabular-nums">
                    {formatDateTime(run.createdAt)}
                  </span>
                </TableCell>
                {withWorkflow ? (
                  <TableCell className="align-top" variant="card">
                    <div className="flex flex-col">
                      <Link
                        className="underline-offset-4 hover:underline"
                        params={{ app: run.app, workflow: run.workflow }}
                        to="/workflows/$app/$workflow"
                      >
                        {run.workflow}
                      </Link>
                      <span className="text-muted-foreground">
                        {run.appName}
                      </span>
                    </div>
                  </TableCell>
                ) : null}
                <TableCell className="align-top" variant="card">
                  {startedByOf(run, me)}
                </TableCell>
                <TableCell
                  className="align-top whitespace-normal"
                  variant="card"
                >
                  <RunOutcome model={model} run={run} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {more ? (
        <p className="text-muted-foreground">
          <Trans>Showing the first {runsPageSize} runs of more.</Trans>
        </p>
      ) : null}
    </div>
  );
};
