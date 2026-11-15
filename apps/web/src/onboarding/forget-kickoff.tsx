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
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The admin deletes the kickoff, Grasp's first conversation with the
// sponsor, for good (GRA-1897): its transcript and everything drawn from
// it, what the onboarding and the Brain knew of it. Only once confirmed,
// for it can't be undone. Core answers once all of it is gone; asked
// again after a failure, it finishes what was left.

export const ForgetKickoff = ({
  kickoff,
  onForgotten,
}: {
  /** Whether the kickoff is in. */
  kickoff: boolean;
  /** Reads core again, once it is gone. */
  onForgotten: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { run, busy, failure } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const forget = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.onboarding.deleteKickoff();
      return true;
    });
    if (done === true) {
      setForgotten(true);
      await onForgotten();
    }
  };
  if (!(kickoff || forgotten)) {
    return null;
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <output aria-live="polite" className="text-muted-foreground text-sm">
        {forgotten
          ? t`Forgotten. Nothing of our first conversation is kept.`
          : null}
      </output>
      {forgotten ? null : (
        <Button
          disabled={busy}
          onClick={() => {
            setOpen(true);
          }}
          size="sm"
          variant="ghost"
        >
          {t`Forget our first conversation`}
        </Button>
      )}
      <ErrorText>{failure}</ErrorText>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Forget our first conversation?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`I delete what was said and everything I took from it: what I know about your company from it, and what your Brain learned from it. This can’t be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false);
                void forget();
              }}
              variant="destructive"
            >
              {t`Forget it`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
