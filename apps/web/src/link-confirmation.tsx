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
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";

import { confirmGate } from "./confirm-gate.ts";
import type { ConfirmGate } from "./confirm-gate.ts";

// The page's confirmation of a link an App's screen asks to open (spec
// 10.7.7, decision 2 on GRA-259), when the person didn't just click in
// the screen, or its App read restricted data. Grasp's own dialog, outside
// the frame: it names only the origin core checked, in ASCII, never text
// of the screen's, so a look-alike name shows as the punycode it is; for
// an App that read restricted data, the whole URL too, as core parsed it,
// so the person sees what it would carry out. Open counts only as the
// gate says (confirm-gate.ts): never for a click or key on its way.

/** A link waiting for the person: the ASCII origin it opens. */
export interface PendingLink {
  readonly origin: string;
  /** The whole URL, for an App that read restricted data. */
  readonly url?: string;
}

/**
 * How long Open stays disabled once the dialog shows, and after every
 * press or key while it is: a click already on its way, which a screen
 * could time its request for, never confirms.
 */
const confirmDelayMs = 1000;

/** The person's confirmation of `pending`, in Grasp's own dialog. */
export const LinkConfirmDialog = ({
  pending,
  onConfirm,
  onCancel,
}: {
  pending: PendingLink | undefined;
  /** Called with the link confirmed: only that one opens. */
  onConfirm: (pending: PendingLink) => void;
  /** Called with the link turned down. */
  onCancel: (pending: PendingLink) => void;
}) => {
  const { t } = useLingui();
  const [ready, setReady] = useState<PendingLink>();
  const gate = useRef<{ pending: PendingLink; gate: ConfirmGate } | null>(null);
  useEffect(() => {
    if (pending === undefined) {
      gate.current = null;
      // Nothing to listen for: the dialog is closed.
      return () => {
        gate.current = null;
      };
    }
    const current = confirmGate(performance.now(), confirmDelayMs);
    gate.current = { pending, gate: current };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          setReady(pending);
        },
        Math.max(0, current.enabledFrom() - performance.now())
      );
    };
    // Every press or key anywhere while Open is disabled starts its delay
    // again; captured first, before the button hears its own.
    const input = (): void => {
      const before = current.enabledFrom();
      current.input(performance.now());
      if (current.enabledFrom() !== before) {
        schedule();
      }
    };
    schedule();
    window.addEventListener("pointerdown", input, { capture: true });
    window.addEventListener("keydown", input, { capture: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", input, { capture: true });
      window.removeEventListener("keydown", input, { capture: true });
    };
  }, [pending]);
  /** The button's own press began now: only one begun once enabled counts. */
  const press = (): void => {
    gate.current?.gate.press(performance.now());
  };
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open && pending !== undefined) {
          onCancel(pending);
        }
      }}
      open={pending !== undefined}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Open a link outside Grasp?`}</AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              This app wants to open a page on another site in a new tab. Open
              it only if you expected to go there.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="font-mono text-sm break-all">{pending?.origin}</p>
        {pending?.url === undefined ? null : (
          <p className="text-muted-foreground font-mono text-xs break-all">
            {pending.url}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={ready !== pending}
            onClick={(event) => {
              const opened = gate.current;
              // A click with no pointer behind it (`detail` 0: a screen
              // reader's activate, or a key) counts as a press of its own
              // as it lands, when no press of the button came before it.
              const clickedAt =
                event.detail === 0 ? performance.now() : undefined;
              if (
                pending !== undefined &&
                opened?.pending === pending &&
                opened.gate.accepts(clickedAt)
              ) {
                onConfirm(pending);
              }
            }}
            onKeyDown={press}
            onPointerDown={press}
          >
            <Trans context="open a link to another site">Open</Trans>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
