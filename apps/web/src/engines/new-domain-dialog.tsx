import { appLimits } from "@grasp-os/shared/app-limits";
import { newAppSchema } from "@grasp-os/shared/apps";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Making a domain from the Domains page (grasplabs/prototype
// `components/engines/new-engine-dialog.tsx`): its name and, in a
// sentence, what part of the business it runs. Core makes it as a draft
// App (`apps.create`), empty: what Grasp builds in it brings its
// workflows, apps and integrations.

/** The form, a fresh one for each opening. `onMade` gets the new domain's ID. */
const DomainForm = ({ onMade }: { onMade: (domain: string) => void }) => {
  const { t } = useLingui();
  const ids = useId();
  const { busy, failure, run } = useCoreAction();
  const [name, setName] = useState("");
  const [covers, setCovers] = useState("");
  const named = newAppSchema.shape.name.safeParse(name).success;
  const make = async (): Promise<void> => {
    const made = await run(
      async (session) =>
        await session.apps.create({
          name: name.trim(),
          description: covers.trim(),
        })
    );
    if (made !== undefined) {
      onMade(made.id);
    }
  };
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (named && !busy) {
          void make();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>
          <Trans>New domain</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            For a part of the business, such as a product line or an office. It
            starts empty: what Grasp builds in it brings its workflows, apps and
            integrations.
          </Trans>
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor={`${ids}-name`}>
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          // Not a login: password managers keep out of it.
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          disabled={busy}
          id={`${ids}-name`}
          maxLength={appLimits.nameLength}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder={t`For example Leasing`}
          value={name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${ids}-covers`}>
          <Trans>What does it run?</Trans>
        </FieldLabel>
        <Textarea
          disabled={busy}
          id={`${ids}-covers`}
          maxLength={appLimits.descriptionLength}
          onChange={(event) => {
            setCovers(event.target.value);
          }}
          placeholder={t`For example: everything around lease contracts, from request to renewal`}
          rows={3}
          value={covers}
        />
      </Field>
      <ErrorText>{failure}</ErrorText>
      <DialogFooter>
        <DialogClose
          disabled={busy}
          render={<Button type="button" variant="outline" />}
        >
          <Trans>Cancel</Trans>
        </DialogClose>
        <Button disabled={!named || busy} type="submit">
          <Trans>Make domain</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
};

/** Makes a domain; `onMade` gets its ID, the dialog closing after it. */
export const NewDomainDialog = ({
  open,
  onOpenChange,
  onMade,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMade: (domain: string) => void;
}) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogContent>
      {open ? (
        <DomainForm
          onMade={(domain) => {
            onOpenChange(false);
            onMade(domain);
          }}
        />
      ) : null}
    </DialogContent>
  </Dialog>
);
