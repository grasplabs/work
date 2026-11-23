import type { DecisionView } from "@grasp-os/shared/decisions";
import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { DecisionCard } from "../decision-card.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatDuration, formatSince } from "../format.ts";
import type { Crumb } from "../frame/site-header.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { ItemGroup } from "../grasp/item/index.ts";
import { PageColumn } from "../grasp/page-column/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Stepper } from "../grasp/stepper/index.ts";
import type { StepperStep } from "../grasp/stepper/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Names } from "./activity-words.ts";
import {
  RunResultView,
  StartedWithout,
  useFollowedRun,
  useStartedBy,
} from "./run-detail.tsx";
import { FileRow, RunFilesReader } from "./run-files.tsx";
import type { RunFilesRead } from "./run-files.tsx";
import { runStatusLabels, runToneOf } from "./run-status.ts";
import { WaitingForAiProvider } from "./runs.tsx";
import { StopRun } from "./stop-run.tsx";
import { RunTraceDetail } from "./traces.tsx";

// One run of an independent workflow on a page of its own, as direction C
// (Track) has it: its title, how it stands and when, why it stopped where
// it failed, the answer it waits for in the one approval shape
// (decision-card.tsx), and its updates down a Stepper. What C draws beyond
// that needs core: the item it handled and its title (GRA-2278), its stage
// on a track (GRA-2283), a fix in plain words (GRA-2282) and run again
// (GRA-2280); none of it is shown until core has it. The updates say only
// what core says of every run (started, waiting, ended): its steps are
// read by its builders alone (core need 83), under Workshop, folded away.

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    paddingBlockEnd: grasp.space8,
  },
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  when: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
  },
  workshopHead: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
  },
});

/** A run's name, as its page and its crumb say it: when it started. */
export const useRunTitle = () => {
  const { t } = useLingui();
  return (run: Pick<WorkflowResourceRun, "createdAt">): string => {
    const date = formatSince(run.createdAt);
    return t({
      message: `Run of ${date}`,
      context: "a workflow run's title: when it started",
    });
  };
};

/**
 * What happened to the run, as core says it of every run, oldest first:
 * it started, then where it is now or how it ended.
 */
const useUpdates = (names: Names) => {
  const { t, i18n } = useLingui();
  const startedBy = useStartedBy(names);
  return (run: WorkflowResourceRun, decided: boolean): StepperStep[] => {
    const who = startedBy(run.principal);
    const started = formatSince(run.createdAt);
    const first: StepperStep = {
      label: t({ message: "Started", context: "a workflow run's update" }),
      description: t({
        message: `${started} · by ${who}`,
        context: "when a workflow run started, and who started it",
      }),
      state: "done",
    };
    if (run.endedAt === null) {
      return [
        first,
        {
          label: decided
            ? t({
                message: "Waits for an answer",
                context: "a workflow run's update",
              })
            : i18n._(runStatusLabels[run.status]),
          ...(run.aiProvider === undefined
            ? {}
            : { description: <WaitingForAiProvider wait={run.aiProvider} /> }),
          state: "current",
        },
      ];
    }
    const ended = formatSince(run.endedAt);
    return [
      first,
      {
        label: i18n._(runStatusLabels[run.status]),
        description:
          run.error === undefined ? ended : `${ended} · ${run.error.message}`,
        state: run.status === "completed" ? "done" : "failed",
      },
    ];
  };
};

/** The files it finished writing, for who may download them. */
const RunFiles = ({
  workflow,
  run,
}: {
  workflow: string;
  run: WorkflowResourceRun;
}) => {
  const { t } = useLingui();
  const [read, setRead] = useState<RunFilesRead>();
  const files = read?.files ?? [];
  const label = t`Files it wrote`;
  return (
    <>
      <RunFilesReader
        // Read again once the run ends, with what it finished last.
        key={run.endedAt === null ? "going" : "ended"}
        onRead={setRead}
        run={run.id}
        workflow={workflow}
      />
      <ErrorText>{read?.failure}</ErrorText>
      {files.length === 0 ? null : (
        <section {...stylex.props(styles.section)}>
          <Heading level={2} size="ui">
            {label}
          </Heading>
          <ItemGroup aria-label={label} separated>
            {files.map((file) => (
              <FileRow
                file={file}
                key={file.id}
                run={run.id}
                workflow={workflow}
              />
            ))}
          </ItemGroup>
        </section>
      )}
    </>
  );
};

/**
 * The page of run `opened` of workflow `workflow` (named `name`), read again
 * until it ends; `decision`, the answer it waits for, where the reader may
 * give it.
 */
export const RunPage = ({
  workflow,
  name,
  opened,
  decision,
  names,
  admin,
}: {
  workflow: string;
  name: string;
  opened: WorkflowResourceRun;
  decision: DecisionView | undefined;
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
}) => {
  const { t, i18n } = useLingui();
  const { run, failure, builder, stop } = useFollowedRun(workflow, opened);
  const title = useRunTitle()(run);
  const updates = useUpdates(names);
  const crumbs: Crumb[] = [
    { label: t`Workflows`, to: "/workflows" },
    { label: name, to: "/workflows/$workflow", params: { workflow } },
    { label: title },
  ];
  const going = run.endedAt === null;
  const { version } = run;
  const waits = decision !== undefined && decision.status === "open";
  const shown = waits ? "waiting" : run.status;
  const steps = updates(run, waits);
  const seesResult = run.principal === names.me || admin;
  const took =
    run.endedAt === null
      ? undefined
      : formatDuration(Date.parse(run.endedAt) - Date.parse(run.createdAt));
  return (
    <>
      <SiteHeader
        actions={builder && going ? <StopRun stop={stop} /> : undefined}
        crumbs={crumbs}
        phoneCrumbs="last-two"
      />
      <PageColumn measure="page">
        <div {...stylex.props(styles.page)}>
          <PageHeader
            description={
              <span {...stylex.props(styles.when)}>
                <Badge tone={runToneOf(shown)} variant="dot">
                  {i18n._(runStatusLabels[shown])}
                </Badge>
                {took === undefined ? null : (
                  <Text element="span" size="sm" tone="muted">
                    {t({
                      message: `Took ${took}`,
                      context: "how long a workflow run took",
                    })}
                  </Text>
                )}
              </span>
            }
            title={title}
          />
          <ErrorText>{failure}</ErrorText>
          {run.error === undefined ? null : (
            <Alert title={t`It stopped here`} tone="danger">
              {run.error.message}
            </Alert>
          )}
          {run.status === "failed" && run.error === undefined && !seesResult ? (
            <Text size="sm" tone="muted">
              {t`Only the person it ran for and the organization's admins see why it failed.`}
            </Text>
          ) : null}
          {decision === undefined ? null : (
            <DecisionCard decision={decision} where="run" />
          )}
          <section {...stylex.props(styles.section)}>
            <Heading level={2} size="ui">
              {t({
                message: "Updates",
                context: "what happened to a workflow run",
              })}
            </Heading>
            <Stepper
              aria-label={t`What happened to this run`}
              loading={going && !waits}
              orientation="vertical"
              steps={steps}
              value={steps.length - 1}
            />
            <StartedWithout run={run} />
          </section>
          {run.result === undefined ? null : (
            <Collapsible title={t`What it returned`}>
              <RunResultView
                builder={builder}
                run={run}
                seesResult={seesResult}
              />
            </Collapsible>
          )}
          <RunFiles run={run} workflow={workflow} />
          {builder ? (
            <section {...stylex.props(styles.section)}>
              <div {...stylex.props(styles.workshopHead)}>
                <Heading level={2} size="ui">
                  {t({
                    message: "Workshop",
                    context: "a workflow's builder tools",
                  })}
                </Heading>
                <Text size="sm" tone="muted">
                  {t`Version ${version} ran this. Only builders see this.`}
                </Text>
              </div>
              <Collapsible title={t`Open its steps`}>
                <RunTraceDetail runId={run.id} workflow={workflow} />
              </Collapsible>
            </section>
          ) : null}
        </div>
      </PageColumn>
    </>
  );
};
