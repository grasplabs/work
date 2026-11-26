import { Alert } from "@grasp-os/ui/components/alert";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Snippet } from "@grasp-os/ui/components/snippet";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { SettingsStack } from "./settings/section.tsx";

// A secret core answers once and never again (an App webhook's, an event
// source's): shown with the way to copy it, until it is closed on purpose
// (Done, the close button or Escape; a stray press beside it doesn't).
// Whoever holds it keeps it above anything read again, so a list read
// after the change never takes it away before it was copied.

/** A secret core answered once, with the warning that it is shown this once. */
export const SecretOnce = ({ secret }: { secret: string }) => {
  const { t } = useLingui();
  return (
    <>
      {/* Mounted with each secret, so Copied never carries over. */}
      <Snippet key={secret} aria-label={t`Copy the secret`} value={secret} />
      <Alert variant="warning">
        {t`Copy it now: you won't see it again. Lost, it can only be replaced.`}
      </Alert>
    </>
  );
};

/** Shows `secret` once, with the way to copy it; closed, it is gone. */
export const ShownOnceDialog = ({
  secret,
  title,
  description,
  onClose,
}: {
  /** Undefined while there is none to show. */
  secret: string | undefined;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Dialog
      onOpenChange={(open, details) => {
        // A stray press beside it never takes the secret away: Done or the close button does.
        if (!open && details.reason === "outside-press") {
          details.cancel();
          return;
        }
        if (!open) {
          onClose();
        }
      }}
      open={secret !== undefined}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : (
            <DialogDescription>{description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          <SettingsStack>
            {secret === undefined ? null : <SecretOnce secret={secret} />}
          </SettingsStack>
        </DialogBody>
        <DialogFooter>
          <DialogClose variant="default">{t`Done`}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
