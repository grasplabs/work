import type { App } from "@grasp-os/shared/apps";
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
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { RotateCcwIcon } from "lucide-react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Resetting an App's data (`apps.resetData`), in its settings: for its
// builders, never Grasp staff, as core checks. Every record goes, for
// good, and its current version runs again on an empty store, so it asks
// first. What a store from before stable IDs holds can only be reset.

export const ResetAppData = ({ app }: { app: App }) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { name } = app;
  const reset = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.apps.resetData(app.id);
      return true;
    });
    if (done === true) {
      await router.invalidate({ sync: true });
    }
  };
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          render={<Button variant="outline" />}
        >
          <RotateCcwIcon data-icon="inline-start" />
          <Trans>Reset data</Trans>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Reset {name}’s data?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Every record it holds is gone for good, and its current version
                runs again with no records. Its pages, versions, members and
                files stay.
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
              <Trans>Reset for good</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
