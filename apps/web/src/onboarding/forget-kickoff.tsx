import { onboardingErrors } from "@grasp-os/shared/onboarding";
import type { OnboardingView } from "@grasp-os/shared/onboarding";
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
// for it can't be undone. Core answers once all of it is gone; when what
// the Brain had of it is still being erased, core finishes that by itself,
// and the page says so.

export const ForgetKickoff = ({
  kickoff,
  onForgotten,
}: {
  kickoff: OnboardingView["kickoff"];
  /** Reads core again, once it is gone. */
  onForgotten: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { run, busy, failure } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const forget = async (): Promise<void> => {
    const done = await run(async (session) => {
      try {
        await session.onboarding.deleteKickoff();
        return "done";
      } catch (error) {
        // Deleted: the rest is core's to finish, and the page says so.
        if (
          onboardingErrors.codeOf(error) === "onboarding.kickoff_unfinished"
        ) {
          return "erasing";
        }
        throw error;
      }
    });
    if (done === "done") {
      setForgotten(true);
    }
    if (done !== undefined) {
      await onForgotten();
    }
  };
  if (forgotten) {
    return (
      <output aria-live="polite" className="text-muted-foreground text-sm">
        {t`Forgotten. Nothing of our first conversation is kept.`}
      </output>
    );
  }
  if (kickoff === "erasing") {
    return (
      <output aria-live="polite" className="text-muted-foreground text-sm">
        {t`Our first conversation is deleted. I’m still erasing what I took from it, and I finish that by myself.`}
      </output>
    );
  }
  if (kickoff === null) {
    return null;
  }
  return (
    <div className="flex flex-col items-center gap-2">
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
      <ErrorText>{failure}</ErrorText>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Forget our first conversation?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`I delete what was said and everything I took from it: what I know about your company from it, and what your Brain learned from it. I then know less about your company, which can put off the day your Grasp opens. This can’t be undone.`}
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
