import { workflowStateMaxBytes } from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowState,
  WorkflowStateEntry,
} from "@grasp-os/shared/workflow-resources";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import {
  AlertDialog,
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
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@grasp-os/ui/components/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatTime } from "../directory.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useHeldDialog } from "./held-dialog.ts";
import { SectionCard } from "./section-card.tsx";

// What a workflow keeps between its runs (core's workflow-state.ts): each
// key with its value, the run that set it last and when, for its builders
// and the organization's admins, as its runs' results are. A key whose run
// read what may no longer be read is withheld, its value never served.
// They may empty it; core records who did, and a step that wrote before
// never writes again.

const styles = stylex.create({
  // A value is JSON of any length: it breaks anywhere rather than widen the table.
  value: { overflowWrap: "anywhere", whiteSpace: "normal" },
  failure: { paddingInline: space["4"], paddingBlockEnd: space["4"] },
});

/** Kilobytes, rounded up, as the page says a size. */
const kilobytes = (bytes: number): number => Math.ceil(bytes / 1024);

/**
 * A key's value, or why it isn't shown: the run that set it read what may
 * no longer be read (core leaves it out of what later runs read), or that
 * can't be checked now.
 */
const KeptValue = ({
  value,
  withheld,
}: Pick<WorkflowStateEntry, "value" | "withheld">) => {
  const { t } = useLingui();
  if (withheld === "revoked") {
    return (
      <Text as="span" color="muted" size="sm">
        {t`Withheld: the run that kept it read something that is no longer there to read, so later runs start without it.`}
      </Text>
    );
  }
  if (withheld === "unchecked") {
    return (
      <Text as="span" color="muted" size="sm">
        {t`Can't be shown right now.`}
      </Text>
    );
  }
  return <code {...stylex.props(styles.value)}>{JSON.stringify(value)}</code>;
};

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

  const dialog = useHeldDialog();
  const emptyAll = async (): Promise<void> => {
    const emptied = await run(
      async (session) => await session.workflowResources.resetState(workflow)
    );
    if (emptied === undefined) {
      // The dialog stays open; why is said on the card.
      throw new Error("It wasn't reset.");
    }
    setReset({ of: loaded, answer: emptied });
  };
  const resetAll = async (): Promise<void> => {
    await dialog.hold(emptyAll);
  };

  return (
    <SectionCard
      actions={
        editable && state.entries.length > 0 ? (
          <AlertDialog
            onOpenChange={dialog.handleOpenChange}
            open={dialog.open}
          >
            <AlertDialogTrigger asChild>
              <Button disabled={busy} size="sm" variant="outline">
                {t`Reset what it keeps`}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t`Reset what it keeps?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t`Runs that start after this read nothing kept. Runs already going keep what they read. This can't be undone.`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel />
                <Button
                  errorLabel={t`Not reset`}
                  onClick={resetAll}
                  size="sm"
                  variant="destructive"
                >
                  {t`Reset`}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null
      }
      description={t`It uses ${used} KB of ${cap} KB.`}
      flush
      info={t`What its steps keep for later runs, which each run reads as it starts.`}
      title={t`Kept between runs`}
    >
      {state.entries.length === 0 ? (
        <Empty size="sm">
          <EmptyHeader>
            <EmptyDescription>{t`Nothing is kept yet.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
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
            {state.entries.map(({ key, value, withheld, updatedAt }) => (
              <TableRow key={key}>
                <TableCell>
                  <code>{key}</code>
                </TableCell>
                <TableCell>
                  <KeptValue value={value} withheld={withheld} />
                </TableCell>
                <TableCell>{formatTime(updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {failure === undefined ? null : (
        <div {...stylex.props(styles.failure)}>
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
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
