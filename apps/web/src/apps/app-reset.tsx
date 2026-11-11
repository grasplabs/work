import type { App } from "@grasp-os/shared/apps";
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

import { useCoreAction } from "../use-core-action.ts";

// Resetting an App's data, in its settings: an admin of the organization
// resets any App's data (`apps.resetData`), typing its name to confirm,
// which core checks again. Every record goes for good and its current
// version's schema is applied to the empty store, in one transaction.

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
