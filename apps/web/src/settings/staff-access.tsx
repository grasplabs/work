import type { GateView } from "@grasp-os/shared/onboarding-gate";
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
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { SettingsRow, SettingsSection } from "./settings-parts.tsx";

// Settings › Workspace › Grasp staff access, for the company's admins:
// whether Grasp's staff may sign in now, what they reach and until when,
// as core's onboarding gate tells it (`onboardingGate.view().staff`), and
// a way to end it now. Ending it signs every staff member out at once,
// and the window the admin opened lets nobody in again; only a new window
// does. Core takes it only from the company's own admins, never from staff
// (who see the section but no button), and records it in the audit log.

/** Grasp's staff access, as core answered the admin. */
export const StaffAccessSection = ({
  staff,
  editable,
}: {
  staff: GateView["staff"];
  /** The company's own admin, not Grasp staff: they may end it. */
  editable: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const end = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => await session.onboardingGate.endStaffAccess(),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <SettingsSection
      description={
        <Trans>
          Whether people from Grasp can sign in to help with this workspace.
          They come in only while a window your organization opened lasts.
        </Trans>
      }
      title={t`Grasp staff access`}
    >
      {staff?.open === true ? (
        <>
          <SettingsRow
            description={
              staff.scope === "onboarding"
                ? t`They reach the onboarding alone.`
                : t`They reach everything their role allows.`
            }
            label={t`Grasp staff can sign in`}
          >
            <Badge variant="secondary">
              {staff.scope === "onboarding"
                ? t`Onboarding only`
                : t`Full access`}
            </Badge>
          </SettingsRow>
          <SettingsRow
            description={t`Their access ends on its own then.`}
            label={t`Until`}
          >
            <time dateTime={staff.until}>{formatDateTime(staff.until)}</time>
          </SettingsRow>
          {editable ? (
            <div className="flex flex-col items-start gap-1 border-t px-5 py-4">
              <AlertDialog>
                <AlertDialogTrigger
                  disabled={busy}
                  render={<Button size="sm" variant="destructive" />}
                >
                  <Trans>End staff access now</Trans>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      <Trans>End Grasp staff access now?</Trans>
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      <Trans>
                        Everyone from Grasp is signed out at once, and nobody
                        from Grasp can sign in again until a new window is
                        opened.
                      </Trans>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>
                      <Trans>Cancel</Trans>
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        void end();
                      }}
                      variant="destructive"
                    >
                      <Trans>End access</Trans>
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <ErrorText>{failure}</ErrorText>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-muted-foreground border-t px-5 py-4">
          <Trans>Nobody from Grasp can sign in to this workspace now.</Trans>
        </p>
      )}
    </SettingsSection>
  );
};
