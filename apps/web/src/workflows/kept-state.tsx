import { workflowStateMaxBytes } from "@grasp-os/shared/workflow-resources";
import type { WorkflowState } from "@grasp-os/shared/workflow-resources";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { formatTime } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// What a workflow keeps between its runs (core's workflow-state.ts): each
// key with its value, the run that set it last and when, for its builders
// and the organization's admins, as its runs' results are. They may empty
// it; core records who did, and a step that wrote before never writes
// again.

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
    if (emptied !== undefined) {
      setReset({ of: loaded, answer: emptied });
    }
  };

  return (
    <section className="mt-8 flex max-w-3xl flex-col gap-3 border-t pt-6">
      <h2 className="font-medium">
        <Trans>Kept between runs</Trans>
      </h2>
      <p className="text-muted-foreground">
        <Trans>
          What its steps keep for later runs, which each run reads as it starts.
          It uses {used} KB of {cap} KB.
        </Trans>
      </p>
      {state.entries.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>Nothing is kept yet.</Trans>
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Key</Trans>
              </TableHead>
              <TableHead>
                <Trans>Value</Trans>
              </TableHead>
              <TableHead>
                <Trans>Set</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.entries.map(({ key, value, updatedAt }) => (
              <TableRow key={key}>
                <TableCell>
                  <code>{key}</code>
                </TableCell>
                <TableCell className="break-all whitespace-normal">
                  <code>{JSON.stringify(value)}</code>
                </TableCell>
                <TableCell>{formatTime(updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editable && state.entries.length > 0 ? (
        <div>
          <AlertDialog>
            <AlertDialogTrigger
              disabled={busy}
              render={<Button size="sm" variant="outline" />}
            >
              <Trans>Reset what it keeps</Trans>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Reset what it keeps?</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>
                    Runs that start after this read nothing kept. Runs already
                    going keep what they read. This can&apos;t be undone.
                  </Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Cancel</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={() => {
                    void resetAll();
                  }}
                  variant="destructive"
                >
                  {t`Reset`}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </section>
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
