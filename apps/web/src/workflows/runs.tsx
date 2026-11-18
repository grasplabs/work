import { aiProviderIdSchema, aiProviders } from "@grasp-os/shared/ai-providers";
import { runsPageSize } from "@grasp-os/shared/workflows";
import type {
  ListedRun,
  RunAiProviderWait,
  RunStatus,
} from "@grasp-os/shared/workflows";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { formatDateTime, formatSince } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import type { BadgeTone } from "../grasp/badge/index.ts";
import { Empty, EmptyDescription, EmptyHeader } from "../grasp/empty/index.ts";
import { Link as TextLink } from "../grasp/link/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Runs as the Workflows page and a workflow's page list them, in the
// prototype's runs log (grasplabs/prototype `components/runs-log.tsx`):
// when, the workflow, who started it, and what happened, as a Badge: green
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
    alignItems: "flex-start",
    gap: grasp.space1,
  },
  log: { display: "grid", rowGap: grasp.space2 },
});

/** A run's status, in words, in the page's language. */
export const runStatusLabel = (status: RunStatus): string =>
  i18n._(statusLabels[status]);

/**
 * How a run's status stands as a Badge: attention only where it waits on
 * someone, success once done, danger where it failed, a plain fact while it
 * goes on (queued included) or after it stopped.
 */
const toneOf = (status: RunStatus): BadgeTone => {
  if (status === "waiting") {
    return "attention";
  }
  if (status === "completed") {
    return "success";
  }
  return status === "failed" ? "danger" : "neutral";
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
 * A run's status as a Badge (`toneOf`). A queued run also says since when
 * it waits for a working AI provider key.
 */
export const RunResult = ({
  status,
  aiProvider,
}: {
  status: RunStatus;
  /** While it is queued for a working AI provider key: since when. */
  aiProvider?: RunAiProviderWait | undefined;
}) => (
  <span {...stylex.props(styles.outcome)}>
    <Badge size="sm" tone={toneOf(status)}>
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
      )}
    </span>
  );
};

/** A run's workflow, opening it. */
const RunWorkflow = ({ run }: { run: ListedRun }) => (
  <TextLink
    render={
      <Link params={{ workflow: run.workflowId }} to="/workflows/$workflow" />
    }
    variant="standalone"
  >
    {run.name}
  </TextLink>
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
      <Empty size="section">
        <EmptyHeader>
          <EmptyDescription>
            {empty ?? t`Nothing has run yet.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div {...stylex.props(styles.log)}>
      <SectionCard aria-label={t`Runs`} density="compact" flush>
        <Table aria-label={t`Runs`}>
          <TableHeader>
            <TableRow>
              <TableHead>
                {t({ message: "When", context: "column: when a run happened" })}
              </TableHead>
              {withWorkflow ? <TableHead>{t`Workflow`}</TableHead> : null}
              <TableHead>{t`Started by`}</TableHead>
              <TableHead>
                {t({
                  message: "Result",
                  context: "column: what happened in a run",
                })}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{formatDateTime(run.createdAt)}</TableCell>
                {withWorkflow ? (
                  <TableCell lead>
                    <RunWorkflow run={run} />
                  </TableCell>
                ) : null}
                <TableCell>{startedByOf(run, me)}</TableCell>
                <TableCell wrap>
                  <RunOutcome run={run} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
      {more ? (
        <Text size="sm" tone="muted">
          {t`Showing the first ${runsPageSize} runs of more.`}
        </Text>
      ) : null}
    </div>
  );
};
