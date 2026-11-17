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

// The admin erases the company's teams from the Brain (GRA-1748): every
// version of what it was given of them, for everyone, as the kickoff's
// delete erases what it gave (forget-kickoff.tsx). The list of teams and
// people stays as it is: the next time the admin confirms it, the Brain
// gets the teams afresh. Only once confirmed, for it can't be undone. Core
// answers once all of it is gone; when it is still being erased, core
// finishes that by itself, and the page says so.

export const ForgetTeams = ({
  teamsInBrain,
  onErased,
}: {
  teamsInBrain: OnboardingView["teamsInBrain"];
  /** Reads core again, once they are gone. */
  onErased: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { run, busy, failure } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [erased, setErased] = useState(false);
  const erase = async (): Promise<void> => {
    const done = await run(async (session) => {
      try {
        await session.onboarding.eraseTeamsFromBrain();
        return "done";
      } catch (error) {
        // Erased from what it reads: the rest is core's to finish, and the page says so.
        if (onboardingErrors.codeOf(error) === "onboarding.teams_unfinished") {
          return "erasing";
        }
        throw error;
      }
    });
    if (done === "done") {
      setErased(true);
    }
    if (done !== undefined) {
      await onErased();
    }
  };
  // Erased, until a confirmed save gives the Brain the teams again: then
  // what core says now holds, and the erase is offered again.
  if (erased && teamsInBrain === null) {
    return (
      <output aria-live="polite" className="text-muted-foreground text-sm">
        {t`Erased. Your Brain keeps nothing of your teams until you confirm them again.`}
      </output>
    );
  }
  if (teamsInBrain === "erasing") {
    return (
      <output aria-live="polite" className="text-muted-foreground text-sm">
        {t`I’m erasing your teams from your Brain. It isn’t finished yet, and I finish it by myself.`}
      </output>
    );
  }
  if (teamsInBrain === null) {
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
        {t`Erase your teams from your Brain`}
      </Button>
      <ErrorText>{failure}</ErrorText>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Erase your teams from your Brain?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`I erase everything your Brain keeps of your teams, every earlier version too, for everyone. Your list of teams and people stays as it is, and the next time you confirm it, your Brain gets it again. This can’t be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false);
                void erase();
              }}
              variant="destructive"
            >
              {t`Erase them`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
