import { aiProviderIdSchema, aiProviders } from "@grasp-os/shared/ai-providers";
import { runsPageSize } from "@grasp-os/shared/workflows";
import type {
  ListedRun,
  RunAiProviderWait,
  RunStatus,
} from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate } from "@tanstack/react-router";

import { formatDateTime, formatSince } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import { DataTable } from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { personOf } from "./activity-bar.tsx";
import type { Names } from "./activity-bar.tsx";
import { runStatusLabels, runToneOf } from "./run-status.ts";

// Runs as the Workflows page and a workflow's page list them, in the
// prototype's runs log (grasplabs/prototype `components/runs-log.tsx`):
// the workflow, when, who started it, and what happened, as a Badge in the
// words every run is said in (run-status.ts). A run waiting for a decision
// links to where it is answered. The whole row opens the run, on its
// workflow's runs, where what it returned or why it failed is read.

const styles = stylex.create({
  // A result over what it waits for, and the way to the decision.
  outcome: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: grasp.space1,
  },
  log: { display: "grid", rowGap: grasp.space2 },
  // A link in a row that opens: over the row's press area, so it stays its own.
  above: { position: "relative", zIndex: 1 },
});

/** A run's status, in words, in the page's language. */
const runStatusLabel = (status: RunStatus): string =>
  i18n._(runStatusLabels[status]);

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
 * A run's status as a Badge (`toneOf`). A queued run also says since when
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
    <Badge size="sm" tone={runToneOf(status)}>
      {runStatusLabel(status)}
    </Badge>
    {status === "queued" && aiProvider !== undefined ? (
      <Text element="span" size="xs" tone="muted">
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
        <span {...stylex.props(styles.above)}>
          <TextLink
            render={
              <Link
                params={{ decision: run.decision }}
                to="/decisions/$decision"
              />
            }
            variant="standalone"
          >
            {t`Decide`}
          </TextLink>
        </span>
      )}
    </span>
  );
};

/** The runs log's columns, under their headers' words. */
const logColumns = (words: {
  names: Names;
  /** Each workflow by the name people see, by its ID; its own name where missing. */
  workflows: ReadonlyMap<string, string>;
  workflow: string;
  when: string;
  by: string;
  result: string;
}): DataTableColumn<ListedRun>[] => [
  {
    key: "workflow",
    header: words.workflow,
    value: (run) => words.workflows.get(run.workflowId) ?? run.name,
  },
  {
    key: "when",
    header: words.when,
    value: (run) => run.createdAt,
    cell: (run) => formatDateTime(run.createdAt),
  },
  {
    key: "by",
    header: words.by,
    value: ({ startedBy }) =>
      startedBy.userId === words.names.me
        ? i18n._(msg`You`)
        : personOf(words.names, startedBy.userId),
  },
  {
    key: "result",
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
  names,
  workflows,
  empty,
}: {
  runs: ListedRun[];
  more: boolean;
  names: Names;
  workflows: ReadonlyMap<string, string>;
  empty?: string;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const columns = logColumns({
    names,
    workflows,
    workflow: t`Workflow`,
    when: t({ message: "When", context: "column: when a run happened" }),
    by: t`Started by`,
    result: t({ message: "Result", context: "column: what happened in a run" }),
  });
  return (
    <div {...stylex.props(styles.log)}>
      <DataTable
        columns={columns}
        density="compact"
        empty={{ description: empty ?? t`Nothing has run yet.` }}
        label={t`Runs`}
        onRowOpen={(run) => {
          void navigate({
            to: "/workflows/$workflow",
            params: { workflow: run.workflowId },
            search: { view: "runs", run: run.id },
          });
        }}
        pageSize={logPageSize}
        rowKey={(run) => run.id}
        rows={runs}
        unit={{ one: t`run`, other: t`runs` }}
      />
      {more ? (
        <Text size="sm" tone="muted">
          {t`Showing the first ${runsPageSize} runs of more.`}
        </Text>
      ) : null}
    </div>
  );
};
