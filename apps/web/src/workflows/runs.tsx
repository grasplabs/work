import { aiProviderIdSchema, aiProviders } from "@grasp-os/shared/ai-providers";
import { runsPageSize } from "@grasp-os/shared/workflows";
import type {
  ListedRun,
  RunAiProviderWait,
  RunStatus,
} from "@grasp-os/shared/workflows";
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

import { formatDateTime, formatSince } from "../format.ts";

// Runs as the Workflows page and a workflow's page list them, in the
// prototype's runs log (grasplabs/prototype `components/runs-log.tsx`):
// when, the workflow, who started it, and what happened, with a dot in
// the status colours. A run waiting for a decision links to where it is
// answered. A run says what its workflow's page lists of it: what it
// returned or why it failed stays on the run.

const statusLabels: Readonly<Record<RunStatus, MessageDescriptor>> = {
  queued: msg`Queued`,
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
const startedByOf = ({ startedBy }: ListedRun, me: string): string =>
  startedBy.userId === me ? i18n._(msg`You`) : i18n._(msg`Someone else`);

/** The status in words, after its dot. */
const RunStatusDot = ({ status }: { status: RunStatus }) => (
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
    {status === "queued" ||
    status === "running" ||
    status === "paused" ||
    status === "cancelled" ? (
      <span
        aria-hidden="true"
        className="bg-foreground size-1.75 flex-none rounded-full"
      />
    ) : null}
    {runStatusLabel(status)}
  </span>
);

/**
 * What a run waits for when its AI provider failed a model call, in words:
 * what the provider showed, by what was seen, and since when. It goes on
 * by itself once calls work.
 */
export const WaitingForAiProvider = ({ wait }: { wait: RunAiProviderWait }) => {
  const { t } = useLingui();
  const since = formatSince(wait.since);
  const provider = aiProviderIdSchema.safeParse(wait.provider);
  const label = provider.success
    ? aiProviders[provider.data].label
    : wait.provider;
  switch (wait.trouble) {
    case "refused": {
      return t`Waiting for ${ph({ label })}, which is refusing the key, since ${ph({ since })}. It goes on by itself once calls work.`;
    }
    case "not_answering": {
      return t`Waiting for ${ph({ label })}, which isn't answering, since ${ph({ since })}. It goes on by itself once calls work.`;
    }
    case "limiting": {
      return t`Waiting for ${ph({ label })}, which is limiting requests, since ${ph({ since })}. It goes on by itself once calls work.`;
    }
    default: {
      return wait.trouble satisfies never;
    }
  }
};

/**
 * A run's status with its dot, as the prototype's `RunResult`: green once
 * done, the attention colour where someone is needed (waiting, failed),
 * ink while it goes on (queued included) or after it stopped. A queued
 * run also says since when it waits for a working AI provider key.
 */
export const RunResult = ({
  status,
  aiProvider,
}: {
  status: RunStatus;
  /** While it is queued for a working AI provider key: since when. */
  aiProvider?: RunAiProviderWait | undefined;
}) => (
  <span className="inline-flex flex-col items-start gap-0.5">
    <RunStatusDot status={status} />
    {status === "queued" && aiProvider !== undefined ? (
      <span className="text-muted-foreground text-xs">
        <WaitingForAiProvider wait={aiProvider} />
      </span>
    ) : null}
  </span>
);

/**
 * What happened: the status, with the link to the decision it waits for
 * when the person may answer it (core sends it only then).
 */
const RunOutcome = ({ run }: { run: ListedRun }) => (
  <div className="flex flex-col items-start gap-1">
    <RunResult aiProvider={run.aiProvider} status={run.status} />
    {run.decision === undefined ? null : (
      <Link
        className="underline-offset-4 hover:underline"
        params={{ decision: run.decision }}
        to="/decisions/$decision"
      >
        <Trans>Decide</Trans>
      </Link>
    )}
  </div>
);

/** When a run started. */
const RunTime = ({ run }: { run: ListedRun }) => (
  <span className="text-muted-foreground tabular-nums">
    {formatDateTime(run.createdAt)}
  </span>
);

/** A run's workflow, opening it. */
const RunWorkflow = ({ run }: { run: ListedRun }) => (
  <Link
    className="underline-offset-4 hover:underline"
    params={{ workflow: run.workflowId }}
    to="/workflows/$workflow"
  >
    {run.name}
  </Link>
);

/**
 * The runs log, in the order core lists them (waiting runs first); with
 * each one's workflow unless `withWorkflow` is false, as on a workflow's
 * own page. `more` says core had more than it sent; `empty` what to say
 * when there are none, such as that none match the filters.
 */
export const RunsLog = ({
  runs,
  more,
  me,
  empty,
  withWorkflow = true,
}: {
  runs: ListedRun[];
  more: boolean;
  me: string;
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
                  <RunTime run={run} />
                </TableCell>
                {withWorkflow ? (
                  <TableCell className="align-top" variant="card">
                    <RunWorkflow run={run} />
                  </TableCell>
                ) : null}
                <TableCell className="align-top" variant="card">
                  {startedByOf(run, me)}
                </TableCell>
                <TableCell
                  className="align-top whitespace-normal"
                  variant="card"
                >
                  <RunOutcome run={run} />
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
