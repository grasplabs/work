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
import { Button } from "@grasp-os/ui/components/button";
import type { ButtonVariant } from "@grasp-os/ui/components/button";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

// A grave step that asks first, as Settings has many: Damsko's Alert
// dialog, its answer a Button whose press runs the step and closes the
// dialog once it went. A step that fails throws: the Button then says so
// in `errorLabel` and the dialog stays, so it can be tried again.

export const ConfirmAction = ({
  trigger,
  open: given,
  onOpenChange,
  title,
  description,
  children,
  label,
  errorLabel,
  loadingLabel,
  variant = "destructive",
  disabled = false,
  action,
}: {
  /** The Button that opens it; none when something else opens it (a menu's item), with `open`. */
  trigger?: ReactElement;
  /** Open now, for a dialog a menu's item opens. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** What stands between the question and its answers: a field to confirm with. */
  children?: ReactNode;
  /** The answer's verb ("Sign out"). */
  label: string;
  /** What the answer says when the step failed ("Not signed out"). */
  errorLabel: string;
  loadingLabel?: string;
  /** `destructive` when it deletes or ends something, `default` otherwise. */
  variant?: ButtonVariant;
  /** The answer can't be given yet (a name to type first). */
  disabled?: boolean;
  /** The step; it throws when it failed. */
  action: () => Promise<void>;
}) => {
  const [own, setOwn] = useState(false);
  const open = given ?? own;
  const setOpen = (next: boolean): void => {
    setOwn(next);
    onOpenChange?.(next);
  };
  return (
    <AlertDialog onOpenChange={setOpen} open={open}>
      {trigger === undefined ? null : (
        <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description === undefined ? null : (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel />
          <Button
            disabled={disabled}
            errorLabel={errorLabel}
            {...(loadingLabel === undefined ? {} : { loadingLabel })}
            onClick={async () => {
              await action();
              setOpen(false);
            }}
            size="sm"
            variant={variant}
          >
            {label}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
