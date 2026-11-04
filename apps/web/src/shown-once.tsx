import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Input } from "@grasp-os/ui/components/input";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";

import { useCopy } from "./copy.ts";

// A secret core answers once and never again (an App webhook's, a webhook
// trigger's): shown in a dialog with the way to copy it, until it is
// closed on purpose (Done, the close button or Escape; a stray click
// outside doesn't). Whoever holds it keeps it above anything read again,
// so a list read after the change never takes it away before it was
// copied.

/** Copies `text`, and says so for a moment, to screen readers too. */
export const CopyButton = ({
  text,
  label,
}: {
  text: string;
  /** What is copied, for screen readers: "Copy the URL". */
  label: string;
}) => {
  const { t } = useLingui();
  const { copied, copy } = useCopy();
  // The button keeps naming what it copies; that it did is announced
  // apart, as a changed name on a focused button often isn't.
  return (
    <>
      <Button
        aria-label={label}
        onClick={() => {
          void copy(text);
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
      </Button>
      <output aria-live="polite" className="sr-only">
        {copied ? t`Copied` : ""}
      </output>
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
  description: ReactNode;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <Dialog
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={secret !== undefined}
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input aria-label={t`Secret`} readOnly value={secret ?? ""} />
        <p className="text-sm font-medium">
          <Trans>
            Copy it now: you won&apos;t see it again. Lost, it can only be
            replaced.
          </Trans>
        </p>
        <DialogFooter>
          {/* Mounted with each secret, so Copied never carries over. */}
          <CopyButton
            key={secret}
            label={t`Copy the secret`}
            text={secret ?? ""}
          />
          <Button onClick={onClose}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
