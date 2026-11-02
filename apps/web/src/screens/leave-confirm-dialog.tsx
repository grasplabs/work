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
import { Trans } from "@lingui/react/macro";

// Apart from screen-frame.tsx: the shell's panel asks it before its screen
// has loaded (app-panel-context.tsx), and the frame comes with the panel.

/**
 * Asks whether to leave a screen whose forms hold unsaved edits, or a
 * change whose outcome isn't known yet: once per leave, in Grasp's own
 * dialog, which the screen can't draw over or answer.
 */
export const LeaveConfirmDialog = ({
  open,
  onLeave,
  onStay,
}: {
  open: boolean;
  onLeave: () => void;
  onStay: () => void;
}) => (
  <AlertDialog
    onOpenChange={(next) => {
      if (!next) {
        onStay();
      }
    }}
    open={open}
  >
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          <Trans>Leave this app?</Trans>
        </AlertDialogTitle>
        <AlertDialogDescription>
          <Trans>
            It has changes that aren&apos;t saved, or a change it hasn&apos;t
            heard back about. Leaving loses unsaved changes; anything already
            saved or running stays.
          </Trans>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Stay</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onLeave}>
          <Trans>Leave</Trans>
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
