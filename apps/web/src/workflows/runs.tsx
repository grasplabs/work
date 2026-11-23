import { aiProviderIdSchema, aiProviders } from "@grasp-os/shared/ai-providers";
import { runsPageSize } from "@grasp-os/shared/workflows";
import type {
  ListedRun,
  RunAiProviderWait,
  RunStatus,
} from "@grasp-os/shared/workflows";
import { Badge } from "@grasp-os/ui/components/badge";
import type { BadgeVariant } from "@grasp-os/ui/components/badge";
import { DataTable } from "@grasp-os/ui/components/data-table";
import type { DataTableColumn } from "@grasp-os/ui/components/data-table";
import { Link as TextLink } from "@grasp-os/ui/components/link";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { formatDateTime, formatSince } from "../format.ts";

// Runs as the Workflows page and a workflow's page list them, in the
// prototype's runs log (grasplabs/prototype `components/runs-log.tsx`):
// the workflow, when, who started it, and what happened, as a Badge: green
// once done, the attention colour where someone is needed (a decision it
// waits for), danger where it failed. A run waiting for a decision links
// to where it is answered. A run says what its workflow's page lists of
// it: what it returned or why it failed stays on the run.

const statusLabels: Readonly<Record<RunStatus, MessageDescriptor>> = {
  queued: msg`Queued`,
  running: msg`Running`,
  waiting: msg`Waiting for a decision`,
  paused: msg`Paused`,
  completed: msg`Completed`,
  failed: msg`Failed`,
  cancelled: msg`Cancelled`,
};

const styles = stylex.create({
  // A result over what it waits for, and the way to the decision.
  outcome: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: space["1"],
  },
  log: { display: "grid", rowGap: space["2"] },
});

/** A run's status, in words, in the page's language. */
const runStatusLabel = (status: RunStatus): string =>
  i18n._(statusLabels[status]);

/**
 * How a run's status stands as a Badge: attention only where it waits on
 * someone, success once done, danger where it failed, a plain fact while it
 * goes on (queued included) or after it stopped.
 */
const variantOf = (status: RunStatus): BadgeVariant => {
  if (status === "waiting") {
    return "warning";
  }
  if (status === "completed") {
    return "success";
  }
  return status === "failed" ? "destructive" : "default";
};

/** Who started a run, in words, for the person `me`. */
const startedByOf = ({ startedBy }: ListedRun, me: string): string =>
  startedBy.userId === me ? i18n._(msg`You`) : i18n._(msg`Someone else`);

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
 * A run's status as a Badge (`variantOf`). A queued run also says since when
 * it waits for a working AI provider key.
 */
const RunResult = ({
  status,
  aiProvider,
}: {
  status: RunStatus;
  /** While it is queued for a working AI provider key: since when. */
  aiProvider?: RunAiProviderWait | undefined;
}) => (
  <span {...stylex.props(styles.outcome)}>
    <Badge size="sm" variant={variantOf(status)}>
      {runStatusLabel(status)}
    </Badge>
    {status === "queued" && aiProvider !== undefined ? (
      <Text as="span" color="muted" size="xs">
        <WaitingForAiProvider wait={aiProvider} />
      </Text>
    ) : null}
  </span>
);

/**
 * What happened: the status, with the link to the decision it waits for
 * when the person may answer it (core sends it only then).
 */
const RunOutcome = ({ run }: { run: ListedRun }) => {
  const { t } = useLingui();
  return (
    <span {...stylex.props(styles.outcome)}>
      <RunResult aiProvider={run.aiProvider} status={run.status} />
      {run.decision === undefined ? null : (
        <TextLink asChild variant="plain">
          <Link params={{ decision: run.decision }} to="/decisions/$decision">
            {t`Decide`}
          </Link>
        </TextLink>
      )}
    </span>
  );
};

/** A run's workflow, opening it. */
const RunWorkflow = ({ run }: { run: ListedRun }) => (
  <TextLink asChild variant="plain">
    <Link params={{ workflow: run.workflowId }} to="/workflows/$workflow">
      {run.name}
    </Link>
  </TextLink>
);

/** The runs log's columns, under their headers' words, for the person `me`. */
const logColumns = (words: {
  me: string;
  workflow: string;
  when: string;
  by: string;
  result: string;
}): DataTableColumn<ListedRun>[] => [
  {
    id: "workflow",
    header: words.workflow,
    value: (run) => run.name,
    cell: (run) => <RunWorkflow run={run} />,
  },
  {
    id: "when",
    header: words.when,
    value: (run) => run.createdAt,
    cell: (run) => formatDateTime(run.createdAt),
  },
  { id: "by", header: words.by, value: (run) => startedByOf(run, words.me) },
  {
    id: "result",
    header: words.result,
    value: (run) => runStatusLabel(run.status),
    cell: (run) => <RunOutcome run={run} />,
    align: "end",
  },
];

/** How many runs a page of the log holds. */
const logPageSize = 20;

/**
 * The runs log, in the order core lists them (waiting runs first), on the
 * library's Data table as the tables pattern has it: the workflow names the
 * row, the result stands at its end, the count and pages under it. `more`
 * says core had more than it sent; `empty` what to say when there are none,
 * such as that none match the filters.
 */
export const RunsLog = ({
  runs,
  more,
  me,
  empty,
}: {
  runs: ListedRun[];
  more: boolean;
  me: string;
  empty?: string;
}) => {
  const { t } = useLingui();
  const columns = logColumns({
    me,
    workflow: t`Workflow`,
    when: t({ message: "When", context: "column: when a run happened" }),
    by: t`Started by`,
    result: t({ message: "Result", context: "column: what happened in a run" }),
  });
  return (
    <div {...stylex.props(styles.log)}>
      <DataTable
        aria-label={t`Runs`}
        columns={columns}
        density="compact"
        emptyState={{ description: empty ?? t`Nothing has run yet.` }}
        getRowId={(run) => run.id}
        pageSize={logPageSize}
        rows={runs}
        unit={{ one: t`run`, other: t`runs` }}
      />
      {more ? (
        <Text color="muted" size="sm">
          {t`Showing the first ${runsPageSize} runs of more.`}
        </Text>
      ) : null}
    </div>
  );
};
