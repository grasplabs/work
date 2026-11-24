import { failureText } from "@grasp-os/shared/errors";
import type { GateView } from "@grasp-os/shared/onboarding-gate";
import {
  AlertDialog,
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
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";
import { useHeldDialog } from "../workflows/held-dialog.ts";
import { RowAlert, SettingRow, SettingsGroup } from "./section.tsx";
import { controlStyles } from "./styles.ts";

// Settings › Workspace › Grasp staff access, for the company's admins,
// only while Grasp's staff may sign in: what they reach and until when, as
// core's onboarding gate tells it (`onboardingGate.view().staff`), and a
// way to end it now, in the card's header. Closed, there is no card. Ending it signs every staff member out at once,
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
  const dialog = useHeldDialog();
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
    <AlertDialog onOpenChange={dialog.handleOpenChange} open={dialog.open}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          {t`End now`}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`End Grasp staff access now?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Everyone from Grasp is signed out at once, and nobody from Grasp can sign in again until a new window is opened.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            agentConfirm={t`Signs everyone from Grasp out of this workspace`}
            errorText={t`Not ended`}
            loadingText={t`Ending access`}
            onClick={async () => {
              await dialog.hold(end);
            }}
            size="sm"
            variant="destructive"
          >
            {t`End access`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/**
 * Grasp's staff access, as core answered the admin: a card only while a
 * window is open, saying until when and what staff reach, with the way to
 * end it now. While none is open, nothing: nobody from Grasp can sign in.
 */
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
  if (staff?.open !== true) {
    return null;
  }
  const until = formatDateTime(staff.until);
  return (
    <SettingsGroup
      {...(editable
        ? { actions: <EndStaffAccess onFailure={setFailure} /> }
        : {})}
      flush
      title={t`Grasp staff access`}
    >
      <FieldGroup>
        {failure === undefined ? null : (
          <RowAlert variant="destructive">{failure}</RowAlert>
        )}
        {/* Until when, in a field that only reads, with what staff reach at its end. */}
        <SettingRow
          help={t`Grasp's team can help here until then`}
          label={t`Open until`}
        >
          <InputGroup size="sm" style={controlStyles.fill}>
            <InputGroupInput readOnly value={until} />
            <InputGroupAddon align="inline-end">
              {staff.scope === "onboarding" ? (
                <Badge
                  tooltip={t`They reach the onboarding alone, and lose access 7 days after Grasp's go.`}
                  size="sm"
                  variant="warning"
                >
                  {t`Onboarding only`}
                </Badge>
              ) : (
                <Badge
                  tooltip={t`They can do everything their role allows in the whole workspace, not only the onboarding.`}
                  size="sm"
                  variant="warning"
                >
                  {t`Full access`}
                </Badge>
              )}
            </InputGroupAddon>
          </InputGroup>
        </SettingRow>
      </FieldGroup>
    </SettingsGroup>
  );
};
