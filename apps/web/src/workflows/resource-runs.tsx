import type { WorkflowResourceRun } from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatDateTime } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty, EmptyDescription, EmptyHeader } from "../grasp/empty/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
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
import type { Names } from "./activity-bar.tsx";
import { RunBeside, RunStatusBadge, useStartedBy } from "./run-detail.tsx";
import { WaitingForAiProvider } from "./runs.tsx";

// An independent workflow's runs (GRA-674), newest first, the latest page,
// as core lists them for the reader: every run for its builders, their own
// for its users (`workflowResources.runs`). Each opens beside the list
// (run-detail.tsx) with what it returned or why it failed, read on the
// run itself under its own rule for who sees it; its steps stay for the
// workflow's builders, who read its definitions (Traces).

/** The width of the runs' card under which each run is a row of its own, its facts under its time. */
const narrowRuns = "@container runs (width < 40rem)";

const styles = stylex.create({
  // The runs measure their own width, whatever the page beside them.
  runs: { containerName: "runs", containerType: "inline-size" },
  // Wide: the table; narrow: the rows. One of them shows.
  wideRuns: { display: { default: "block", [narrowRuns]: "none" } },
  narrowRuns: { display: { default: "none", [narrowRuns]: "block" } },
  // Its status over what it waits for.
  status: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: grasp.space1,
  },
});

/** When a run ended, in words. */
const EndedAt = ({ at }: { at: string }) => {
  const { t } = useLingui();
  const ended = formatDateTime(at);
  return t`Ended ${ended}`;
};

/** The button on a run's row that opens it beside the list. */
export const OpenRun = ({
  started,
  onOpen,
}: {
  started: string;
  onOpen: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Button
      aria-label={t`Open the run started ${started}`}
      onClick={onOpen}
      size="xs"
      variant="ghost"
    >
      {t({ message: "Open", context: "open one run of a workflow" })}
    </Button>
  );
};

/** No runs yet, where a list of them would stand. */
export const NoRuns = () => {
  const { t } = useLingui();
  return (
    <Empty size="section">
      <EmptyHeader>
        <EmptyDescription>{t`No runs yet.`}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
};

export const ResourceRuns = ({
  workflow,
  runs,
  names,
  admin,
  openRun,
  onCloseRun,
}: {
  workflow: string;
  /** The run the address asks to open, by its ID. */
  openRun?: string | undefined;
  /** Clears the run from the address once it is closed. */
  onCloseRun?: () => void;
  runs: WorkflowResourceRun[];
  names: Names;
  /** Whether the reader is one of the organization's admins. */
  admin: boolean;
}) => {
  const { t } = useLingui();
  const startedBy = useStartedBy(names);
  const [chosen, setChosen] = useState<WorkflowResourceRun | null>(null);
  // The run the address names (Run's "Open the run"), until one is chosen here.
  const opened = chosen ?? runs.find((run) => run.id === openRun) ?? null;
  if (runs.length === 0) {
    return <NoRuns />;
  }
  return (
    <RunBeside
      admin={admin}
      names={names}
      onClose={() => {
        setChosen(null);
        onCloseRun?.();
      }}
      opened={opened}
      workflow={workflow}
    >
      <SectionCard aria-label={t`Runs`} density="compact" flush>
        <div {...stylex.props(styles.runs)}>
          <div {...stylex.props(styles.wideRuns)}>
            <Table aria-label={t`Runs`}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t`Started`}</TableHead>
                  <TableHead>{t`Status`}</TableHead>
                  <TableHead>{t`Version`}</TableHead>
                  <TableHead>{t`Started by`}</TableHead>
                  <TableHead>{t`Ended`}</TableHead>
                  <TableHead
                    aria-label={t({
                      message: "Open",
                      context: "column: a button that opens a run",
                    })}
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const started = formatDateTime(run.createdAt);
                  return (
                    <TableRow
                      chosen={opened !== null && opened.id === run.id}
                      key={run.id}
                    >
                      <TableCell lead>{started}</TableCell>
                      <TableCell wrap>
                        <span {...stylex.props(styles.status)}>
                          <RunStatusBadge status={run.status} />
                          {run.aiProvider === undefined ? null : (
                            <Text element="span" size="xs" tone="muted">
                              <WaitingForAiProvider wait={run.aiProvider} />
                            </Text>
                          )}
                        </span>
                      </TableCell>
                      <TableCell>{run.version}</TableCell>
                      <TableCell>{startedBy(run.principal)}</TableCell>
                      <TableCell>
                        {run.endedAt === null
                          ? ""
                          : formatDateTime(run.endedAt)}
                      </TableCell>
                      <TableCell align="end">
                        <OpenRun
                          onOpen={() => {
                            setChosen(run);
                          }}
                          started={started}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div {...stylex.props(styles.narrowRuns)}>
            <ItemGroup aria-label={t`Runs`} separated>
              {runs.map((run) => {
                const started = formatDateTime(run.createdAt);
                const by = startedBy(run.principal);
                const { version } = run;
                return (
                  <Item key={run.id} size="sm">
                    <ItemContent>
                      <ItemTitle>{started}</ItemTitle>
                      <ItemDescription>
                        {t`Version ${version} · ${by}`}
                      </ItemDescription>
                      {run.endedAt === null ? null : (
                        <ItemDescription>
                          <EndedAt at={run.endedAt} />
                        </ItemDescription>
                      )}
                      <span {...stylex.props(styles.status)}>
                        <RunStatusBadge status={run.status} />
                        {run.aiProvider === undefined ? null : (
                          <Text element="span" size="xs" tone="muted">
                            <WaitingForAiProvider wait={run.aiProvider} />
                          </Text>
                        )}
                      </span>
                    </ItemContent>
                    <ItemActions>
                      <OpenRun
                        onOpen={() => {
                          setChosen(run);
                        }}
                        started={started}
                      />
                    </ItemActions>
                  </Item>
                );
              })}
            </ItemGroup>
          </div>
        </div>
      </SectionCard>
    </RunBeside>
  );
};
