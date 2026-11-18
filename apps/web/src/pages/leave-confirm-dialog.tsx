import { useLingui } from "@lingui/react/macro";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../grasp/alert-dialog/index.ts";

/**
 * Asks whether to leave a page whose forms hold unsaved edits, or a
 * change whose outcome isn't known yet: once per leave, in Grasp's own
 * dialog, which the page can't draw over or answer. Leaving loses what
 * isn't saved, so it is the danger answer; Stay is the safe one.
 */
export const LeaveConfirmDialog = ({
  open,
  onLeave,
  onStay,
}: {
  open: boolean;
  onLeave: () => void;
  onStay: () => void;
}) => {
  const { t } = useLingui();
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onStay();
        }
      }}
      open={open}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{t`Leave this page?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`It has changes that aren't saved, or a change it hasn't heard back about. Leaving loses unsaved changes; anything already saved or running stays.`}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Stay`}</AlertDialogAction>
          <AlertDialogAction
            action={onLeave}
            failedLabel={t`Not done`}
            variant="danger"
          >
            {t`Leave`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
