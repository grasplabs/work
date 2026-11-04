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
import { Trans } from "@lingui/react/macro";
import { useState } from "react";

/**
 * A confirmation before `onConfirm`, behind a small button. It closes as
 * soon as it is confirmed, and confirms nothing while a change runs, so a
 * second click can't make the change twice; what goes wrong shows where
 * it is used.
 */
export const Confirmed = ({
  button,
  label,
  title,
  description,
  confirm,
  busy,
  onConfirm,
}: {
  button: string;
  /** The button's name with what it acts on, for screen readers. */
  label: string;
  title: string;
  description: string;
  confirm: string;
  busy: boolean;
  onConfirm: () => void;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        aria-label={label}
        disabled={busy}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        {button}
      </Button>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
              variant="destructive"
            >
              {confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
