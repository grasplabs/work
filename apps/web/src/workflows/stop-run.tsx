import { failureText } from "@grasp-os/shared/errors";
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
import { Icon, SquareIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useHeldDialog } from "./held-dialog.ts";

// Stopping a run that hasn't ended, independent or in an App, asked again
// before it happens: a stopped run never goes on. Offered only to whoever
// core lets stop it (a workflow's or an App's builders), and core decides
// again (`workflowResources.terminateRun`, `workflows.cancel`); what it
// refuses is said in the question, which stays open.

/** A Stop button that asks before it stops the run with `stop`. */
export const StopRun = ({
  stop,
}: {
  /** Stops the run; what it throws is shown. */
  stop: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const [failure, setFailure] = useState<string>();
  const dialog = useHeldDialog();

  const confirm = async (): Promise<void> => {
    setFailure(undefined);
    await dialog.hold(async () => {
      await stop().catch((error: unknown) => {
        // The question stays open, saying why.
        setFailure(failureText(error));
        throw error;
      });
    });
  };

  return (
    <AlertDialog
      onOpenChange={(open, details) => {
        if (open) {
          setFailure(undefined);
        }
        dialog.handleOpenChange(open, details);
      }}
      open={dialog.open}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon icon={SquareIcon} />
          {t({ message: "Stop", context: "stop a workflow's run" })}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Stop this run?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`It stops where it is and never goes on. What it already did stays done. This can't be undone.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorText>{failure}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Keep it running`}</AlertDialogCancel>
          <Button
            errorText={t`Not stopped`}
            onClick={confirm}
            size="sm"
            variant="destructive"
          >
            {t`Stop the run`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
