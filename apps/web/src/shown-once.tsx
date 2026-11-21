import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { CopyField } from "./grasp/copy-field/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./grasp/dialog/index.ts";
import { Text } from "./grasp/text/index.ts";

// A secret core answers once and never again (an App webhook's, a webhook
// trigger's): shown in a dialog with the way to copy it (Grasp UI's Copy
// field), until it is closed on purpose (Done or the close button; a stray
// click outside or Escape doesn't). Whoever holds it keeps it above
// anything read again, so a list read after the change never takes it
// away before it was copied.

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
  description: ReactNode;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Dialog
      // Closed on purpose only: Done or the close button. A stray click
      // outside, or Escape, keeps the secret in view.
      dismissible={false}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={secret !== undefined}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <DialogBody>
          {/* Mounted with each secret, so Copied never carries over. */}
          <CopyField
            aria-label={t`Copy the secret`}
            key={secret}
            value={secret ?? ""}
          />
          <Text weight="medium">
            {t`Copy it now: you won't see it again. Lost, it can only be replaced.`}
          </Text>
        </DialogBody>
        <DialogFooter>
          <DialogAction variant="ink">{t`Done`}</DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
