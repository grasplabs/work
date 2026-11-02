import { failureText } from "@grasp-os/shared/errors";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Trans } from "@lingui/react/macro";
import { SquareIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";

// Stopping a run that hasn't ended, independent or in an App, asked again
// before it happens: a stopped run never goes on. Offered only to whoever
// core lets stop it (a workflow's or an App's builders), and core decides
// again (`workflowResources.terminateRun`, `workflows.cancel`); what it
// refuses is said under the button.

/** A Stop button that asks before it stops the run with `stop`. */
export const StopRun = ({
  stop,
}: {
  /** Stops the run; what it throws is shown. */
  stop: () => Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string>();

  const confirm = async (): Promise<void> => {
    setStopping(true);
    setFailure(undefined);
    try {
      await stop();
    } catch (error) {
      setFailure(failureText(error));
    }
    setStopping(false);
    setOpen(false);
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <SquareIcon aria-hidden="true" />
        <Trans context="stop a workflow's run">Stop</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Stop this run?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                It stops where it is and never goes on. What it already did
                stays done. This can&apos;t be undone.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Keep it running</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={stopping}
              onClick={() => {
                void confirm();
              }}
              variant="destructive"
            >
              <Trans>Stop the run</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
