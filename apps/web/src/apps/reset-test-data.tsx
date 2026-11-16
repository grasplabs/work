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
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
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
  const { busy, failure, run } = useCoreAction();
  const [asking, setAsking] = useState(false);
  const reset = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.apps.preview.resetData(app);
      return true;
    });
    if (done !== undefined) {
      onReset();
    }
  };
  return (
    <>
      <Button
        disabled={busy}
        onClick={() => {
          setAsking(true);
        }}
        size="sm"
        variant="outline"
      >
        <RotateCcwIcon data-icon="inline-start" />
        <Trans>Reset test data</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
      <AlertDialog onOpenChange={setAsking} open={asking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Reset test data?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Every test record goes, for everyone who builds this App. The
                App&apos;s live data isn&apos;t touched.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void reset();
              }}
              variant="destructive"
            >
              <Trans>Reset</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
