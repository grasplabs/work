import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Retry } from "../grasp/icons/index.ts";
import { useCoreAction } from "../use-core-action.ts";

// The test data of an App's draft preview, in the Data view's toolbar
// while it shows the draft (app-data-model.tsx): one store per App,
// shared by everyone who builds it (core's app-preview.ts). Resetting it
// clears it for all of them, so the person confirms first.

/**
 * Resets the test data of the preview of `app`, once the person
 * confirms; `onReset` is told once it went, so the preview starts afresh.
 */
export const ResetTestData = ({
  app,
  onReset,
}: {
  app: string;
  onReset: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [asking, setAsking] = useState(false);
  // Refused, it says so in the dialog, which stays open to try again.
  const reset = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.apps.drafts.resetTestData(app);
      return true;
    });
    if (done === undefined) {
      throw new Error(failure ?? t`The test data wasn't reset. Try again.`);
    }
    onReset();
  };
  return (
    <>
      <Button
        disabled={busy}
        icon={Retry}
        onClick={() => {
          setAsking(true);
        }}
        size="sm"
        variant="quiet"
      >
        {t`Reset test data`}
      </Button>
      <AlertDialog onOpenChange={setAsking} open={asking}>
        <AlertDialogContent>
          <AlertDialogTitle>{t`Reset test data?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Every test record goes, for everyone who builds this App. The App's live data isn't touched.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
            <AlertDialogAction
              action={reset}
              failedLabel={t`Could not reset`}
              variant="danger"
              workingLabel={t`Resetting`}
            >
              {t`Reset`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
