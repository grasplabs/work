import type { App } from "@grasp-os/shared/apps";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Trans } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { RotateCcwIcon } from "lucide-react";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Resetting an App's data, in its settings. Every record goes for good and
// its current version's schema is applied to the empty store, in one
// transaction, so each asks first.
//
// - An admin of the organization resets any App's data (`apps.resetData`),
//   typing its name to confirm, which core checks again.
// - A builder resets only data stored before schemas were applied by
//   stable ID (`apps.resetLegacyData`), which can be read no other way;
//   core refuses it for any other App. TODO(GRA-1550): remove
//   `ResetLegacyData` with the legacy store tables.

/** An admin's reset of every record of `app`, its name typed to confirm. */
export const ResetAppData = ({ app }: { app: App }) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const nameId = useId();
  const { name } = app;
  const reset = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.apps.resetData(app.id, typed);
      return true;
    });
    if (done === true) {
      setOpen(false);
      await router.invalidate({ sync: true });
    }
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        setTyped("");
      }}
      open={open}
    >
      <DialogTrigger disabled={busy} render={<Button variant="outline" />}>
        <RotateCcwIcon data-icon="inline-start" />
        <Trans>Reset data</Trans>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Reset {name}’s data?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Every record it holds and every file in them is gone for good, and
              its current version runs again with no records. Its pages,
              versions, members and history stay.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void reset();
          }}
        >
          <Field data-invalid={failure === undefined ? undefined : true}>
            <FieldLabel htmlFor={nameId}>
              <Trans>Type {name} to confirm</Trans>
            </FieldLabel>
            <Input
              aria-invalid={failure === undefined ? undefined : true}
              autoComplete="off"
              id={nameId}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
              value={typed}
            />
            <FieldDescription>
              <Trans>Exactly as it’s written here.</Trans>
            </FieldDescription>
            {failure === undefined ? null : <FieldError>{failure}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button
              disabled={busy || typed !== name}
              type="submit"
              variant="destructive"
            >
              <Trans>Reset for good</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** A builder's reset of `app`'s data stored before stable IDs. */
export const ResetLegacyData = ({ app }: { app: App }) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const { name } = app;
  const reset = async (): Promise<void> => {
    const done = await run(async (session) => {
      await session.apps.resetLegacyData(app.id);
      return true;
    });
    if (done === true) {
      await router.invalidate({ sync: true });
    }
  };
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <AlertDialog>
        <AlertDialogTrigger
          disabled={busy}
          render={<Button variant="outline" />}
        >
          <RotateCcwIcon data-icon="inline-start" />
          <Trans>Reset old data</Trans>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Reset {name}’s old data?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Only for data stored before this version of Grasp, which can’t
                be read any more. Every record it holds and every file in them
                is gone for good, and its current version runs again with no
                records.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void reset();
              }}
              variant="destructive"
            >
              <Trans>Reset for good</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
