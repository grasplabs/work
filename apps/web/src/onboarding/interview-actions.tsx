import type { StaffInterview } from "@grasp-os/shared/onboarding-staff";
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
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { SettingsRow, SettingsSection } from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// What Grasp's staff do for one person's interview, on its page: send
// their mail again once whatever stopped it is put right
// (`onboardingStaff.sendMailAgain`), and give them a new start when they
// lost the device it was on (`onboardingStaff.newStart`): what they said
// goes, and their link opens on the next device. A new start deletes what
// they said, so staff confirm it, and do it only on the person's request.
// Core takes both from staff alone and records each in the audit log.

/** The failed mail, and sending it again. */
const MailRow = ({ read }: { read: StaffInterview }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const failed = read.failedMail;
  const again = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.onboardingStaff.sendMailAgain(read.person);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  if (failed === null) {
    return (
      <SettingsRow label={t`Mail`}>
        <span className="text-muted-foreground">
          <Trans>No mail to them failed.</Trans>
        </span>
      </SettingsRow>
    );
  }
  const on = formatDateTime(failed.at);
  const reason = failed.reason ?? t`no reason given`;
  return (
    <SettingsRow
      description={
        failed.kind === "reminder"
          ? t`Their reminder failed on ${on}: ${reason}. Put right what stopped it, then send it again.`
          : t`Their link failed on ${on}: ${reason}. Put right what stopped it, then send it again.`
      }
      label={t`Mail`}
    >
      <div className="flex flex-col items-end gap-1">
        <Button
          disabled={busy}
          onClick={() => {
            void again();
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Send again</Trans>
        </Button>
        <ErrorText>{failure}</ErrorText>
      </div>
    </SettingsRow>
  );
};

/** A new start on another device, once confirmed. */
const NewStartRow = ({ read }: { read: StaffInterview }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { name } = read;
  const restart = async (): Promise<void> => {
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.onboardingStaff.newStart(read.person);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return (
    <SettingsRow
      description={t`When they lost the device their interview was on. Only on their request.`}
      label={t`New start`}
    >
      <div className="flex flex-col items-end gap-1">
        <AlertDialog>
          <AlertDialogTrigger
            disabled={busy}
            render={<Button size="sm" variant="outline" />}
          >
            <Trans>Start over on a new device</Trans>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <Trans>Give {name} a new start?</Trans>
              </AlertDialogTitle>
              <AlertDialogDescription>
                <Trans>
                  What they said so far is deleted, and their link opens on the
                  next device that opens it. Do this only when they asked.
                </Trans>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <Trans>Cancel</Trans>
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  void restart();
                }}
                variant="destructive"
              >
                <Trans>Delete and start over</Trans>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ErrorText>{failure}</ErrorText>
      </div>
    </SettingsRow>
  );
};

/** What staff do for this person's interview. */
export const InterviewActions = ({ read }: { read: StaffInterview }) => {
  const { t } = useLingui();
  return (
    <SettingsSection
      description={t`For when their link doesn't reach them, or no longer opens for them.`}
      title={t`Help them in`}
    >
      <MailRow read={read} />
      <NewStartRow read={read} />
    </SettingsSection>
  );
};
