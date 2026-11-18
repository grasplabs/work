import { workflowStateMaxBytes } from "@grasp-os/shared/workflow-resources";
import type { WorkflowState } from "@grasp-os/shared/workflow-resources";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatTime } from "../directory.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// What a workflow keeps between its runs (core's workflow-state.ts): each
// key with its value, the run that set it last and when, for its builders
// and the organization's admins, as its runs' results are. They may empty
// it; core records who did, and a step that wrote before never writes
// again.

const styles = stylex.create({
  // A value is JSON of any length: it breaks anywhere rather than widen the table.
  value: { overflowWrap: "anywhere", whiteSpace: "normal" },
  failure: { paddingInline: grasp.space4, paddingBlockEnd: grasp.space4 },
});

/** Kilobytes, rounded up, as the page says a size. */
const kilobytes = (bytes: number): number => Math.ceil(bytes / 1024);

const KeptEntries = ({
  workflow,
  loaded,
  editable,
}: {
  workflow: string;
  loaded: WorkflowState;
  /** Whether the reader may reset it: one of its builders, or an admin. */
  editable: boolean;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  // What the last reset here answered, only while the page shows the read
  // it reset: a newer read of the page's replaces it.
  const [reset, setReset] = useState<{
    of: WorkflowState;
    answer: WorkflowState;
  }>();
  const state = reset?.of === loaded ? reset.answer : loaded;
  const used = kilobytes(state.bytes);
  const cap = kilobytes(workflowStateMaxBytes);

  const resetAll = async (): Promise<void> => {
    const emptied = await run(
      async (session) => await session.workflowResources.resetState(workflow)
    );
    if (emptied === undefined) {
      // The dialog stays open; why is said on the card.
      throw new Error("It wasn't reset.");
    }
    setReset({ of: loaded, answer: emptied });
  };

  return (
    <SectionCard
      actions={
        editable && state.entries.length > 0 ? (
          <AlertDialog>
            <AlertDialogTrigger disabled={busy} size="sm" variant="quiet">
              {t`Reset what it keeps`}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>{t`Reset what it keeps?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {t`Runs that start after this read nothing kept. Runs already going keep what they read. This can't be undone.`}
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                <AlertDialogAction
                  action={resetAll}
                  failedLabel={t`Not reset`}
                  variant="danger"
                >
                  {t`Reset`}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null
      }
      density="compact"
      description={t`It uses ${used} KB of ${cap} KB.`}
      flush
      info={t`What its steps keep for later runs, which each run reads as it starts.`}
      title={t`Kept between runs`}
    >
      {state.entries.length === 0 ? (
        <Empty size="inline">{t`Nothing is kept yet.`}</Empty>
      ) : (
        <Table aria-label={t`Kept between runs`}>
          <TableHeader>
            <TableRow>
              <TableHead>{t`Key`}</TableHead>
              <TableHead>{t`Value`}</TableHead>
              <TableHead>{t`Set`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.entries.map(({ key, value, updatedAt }) => (
              <TableRow key={key}>
                <TableCell>
                  <code>{key}</code>
                </TableCell>
                <TableCell>
                  <code {...stylex.props(styles.value)}>
                    {JSON.stringify(value)}
                  </code>
                </TableCell>
                <TableCell>{formatTime(updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {failure === undefined ? null : (
        <div {...stylex.props(styles.failure)}>
          <Alert tone="danger">{failure}</Alert>
        </div>
      )}
    </SectionCard>
  );
};

/**
 * What it keeps, as the page read it: nothing for a reader who may not
 * read it (core's own read of it is for builders and admins).
 */
export const KeptState = ({
  workflow,
  read,
  editable,
}: {
  workflow: string;
  read: Loaded<WorkflowState> | undefined;
  /** Whether the reader may reset it: one of its builders, or an admin. */
  editable: boolean;
}) => {
  if (read === undefined) {
    return null;
  }
  return read.state === "ready" ? (
    <KeptEntries editable={editable} loaded={read.data} workflow={workflow} />
  ) : (
    <NotLoadedState page={read} />
  );
};
