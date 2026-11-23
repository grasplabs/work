import type { App } from "@grasp-os/shared/apps";
import { failureText } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { Input } from "@grasp-os/ui/components/input";
import { useAction } from "@grasp-os/ui/hooks/use-action";
import { Icon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { useCore } from "../use-core.ts";

// Resetting an App's data, in its settings: an admin of the organization
// resets any App's data (`apps.resetData`), typing its name to confirm,
// which core checks again. Every record goes for good and its current
// version's schema is applied to the empty store, in one transaction.

/** An admin's reset of every record of `app`, its name typed to confirm. */
export const ResetAppData = ({ app }: { app: App }) => {
  const { t } = useLingui();
  const core = useCore();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const formId = useId();
  const { name } = app;
  const reset = useAction(
    async () => {
      await core.withSession(async (session) => {
        await session.apps.resetData(app.id, typed);
      });
      setOpen(false);
      await router.invalidate({ sync: true });
    },
    {
      loadingLabel: t`Resetting`,
      successLabel: t`Reset`,
      errorLabel: t`Could not reset`,
    }
  );
  const failure =
    reset.error === undefined ? undefined : failureText(reset.error);
  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        setTyped("");
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Icon icon={RefreshCwIcon} />
          {t`Reset data`}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>{t`Reset ${name}’s data?`}</DialogTitle>
        <DialogDescription>
          {t`Every record it holds and every file in them is gone for good, and its current version runs again with no records. Its pages, versions, members and history stay.`}{" "}
          {t`What its code remembered in the Brain until now goes too; a call already running may still remember what it read before.`}
        </DialogDescription>
        <DialogBody>
          <Form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              if (typed === name) {
                void reset.run();
              }
            }}
          >
            <Field data-invalid={failure !== undefined}>
              <FieldLabel>{t`Type ${name} to confirm`}</FieldLabel>
              <Input
                autoComplete="off"
                onValueChange={setTyped}
                value={typed}
              />
              <FieldDescription>{t`Exactly as it’s written here.`}</FieldDescription>
              {failure === undefined ? null : (
                <FieldError match>{failure}</FieldError>
              )}
            </Field>
          </Form>
        </DialogBody>
        <DialogFooter>
          <DialogClose>{t`Cancel`}</DialogClose>
          <Button
            disabled={typed !== name}
            form={formId}
            type="submit"
            variant="destructive"
            errorLabel={reset.labels.error}
            loadingLabel={reset.labels.loading}
            status={reset.status}
            successLabel={reset.labels.success}
          >
            {t`Reset for good`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
