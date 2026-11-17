import { failureText } from "@grasp-os/shared/errors";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatDateTime } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { FactRow, RowAlert, SettingsRows } from "../grasp/setting-row/index.ts";
import { Text } from "../grasp/text/index.ts";
import { useCore } from "../use-core.ts";

// Settings › Workspace › Grasp staff access, for the company's admins:
// whether Grasp's staff may sign in now, what they reach and until when,
// as core's onboarding gate tells it (`onboardingGate.view().staff`), and
// a way to end it now, in the card's header. Ending it signs every staff member out at once,
// and the window the admin opened lets nobody in again; only a new window
// does. Core takes it only from the company's own admins, never from staff
// (who see the section but no button), and records it in the audit log.

/**
 * Ends staff access now, once the admin confirms: when it fails, the
 * dialog stays open and says so, and `onFailure` hears core's reason.
 */
const EndStaffAccess = ({
  onFailure,
}: {
  onFailure: (reason?: string) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const end = async (): Promise<void> => {
    onFailure();
    try {
      await changeThenRefresh(
        async () =>
          await core.withSession(
            async (session) => await session.onboardingGate.endStaffAccess()
          ),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    } catch (error) {
      // Core's reason, with its reference to quote.
      onFailure(failureText(error));
      throw error;
    }
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger size="sm">
        {t`End staff access now`}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`End Grasp staff access now?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`Everyone from Grasp is signed out at once, and nobody from Grasp can sign in again until a new window is opened.`}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
          <AlertDialogAction
            action={end}
            agentConfirm={t`Signs everyone from Grasp out of this workspace`}
            failedLabel={t`Could not end access`}
            value="confirm"
            variant="danger"
            workingLabel={t`Ending access`}
          >
            {t`End access`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

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
  const [failure, setFailure] = useState<string>();
  const open = staff?.open === true;
  return (
    <SectionCard
      {...(open && editable
        ? { actions: <EndStaffAccess onFailure={setFailure} /> }
        : {})}
      density="compact"
      description={t`Only while a window your organization opened lasts.`}
      flush
      title={t`Grasp staff access`}
    >
      <SettingsRows>
        {failure === undefined ? null : (
          <RowAlert variant="danger">{failure}</RowAlert>
        )}
        {open ? (
          <>
            <FactRow
              help={
                staff.scope === "onboarding"
                  ? t`They reach the onboarding alone.`
                  : t`They reach everything their role allows.`
              }
              label={t`Grasp staff can sign in`}
            >
              <Badge tone="attention">
                {staff.scope === "onboarding"
                  ? t`Onboarding only`
                  : t`Full access`}
              </Badge>
            </FactRow>
            <FactRow
              help={t`Their access ends on its own then.`}
              label={t`Until`}
            >
              <Text element="span" size="sm">
                <time dateTime={staff.until}>
                  {formatDateTime(staff.until)}
                </time>
              </Text>
            </FactRow>
          </>
        ) : (
          <FactRow
            help={t`Nobody from Grasp can sign in to this workspace now.`}
            label={t`Grasp staff can sign in`}
          >
            <Badge>{t`No`}</Badge>
          </FactRow>
        )}
      </SettingsRows>
    </SectionCard>
  );
};
