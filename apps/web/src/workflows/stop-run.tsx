import { failureText } from "@grasp-os/shared/errors";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Stop } from "../grasp/icons/index.ts";

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

  const confirm = async (): Promise<void> => {
    setFailure(undefined);
    try {
      await stop();
    } catch (error) {
      setFailure(failureText(error));
      // The question stays open, saying why.
      throw error;
    }
  };

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (open) {
          setFailure(undefined);
        }
      }}
    >
      <AlertDialogTrigger icon={Stop} size="xs">
        {t({ message: "Stop", context: "stop a workflow's run" })}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Stop this run?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`It stops where it is and never goes on. What it already did stays done. This can't be undone.`}
        </AlertDialogDescription>
        <ErrorText>{failure}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Keep it running`}</AlertDialogAction>
          <AlertDialogAction
            action={confirm}
            failedLabel={t`Not stopped`}
            variant="danger"
          >
            {t`Stop the run`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
