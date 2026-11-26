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

// What a setup step shows when a sign-in didn't connect: it came back
// refused, or couldn't start. Damsko's Dialog over the step, so it can't be
// missed under the page: what happened in a title, what it means and
// what to do below, and the way on as its buttons, trying again first.
// Escape, the shade and the other way close it, and the step is as it was.

export interface ConnectionProblemProps {
  /** What happened, as the title: "Microsoft didn't connect". */
  title: string;
  /** What it means and what to do; null while nothing went wrong, and it is closed. */
  message: string | null;
  /** Trying again: its words and what it does; the dialog closes once it ran. */
  retry: { label: string; run: () => Promise<void> | void };
  /** The other way on, closing it: "Use a staff list". */
  other: string;
  onClose: () => void;
}

export const ConnectionProblem = ({
  title,
  message,
  retry,
  other,
  onClose,
}: ConnectionProblemProps) => (
  <Dialog
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
    open={message !== null}
  >
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{message}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose>{other}</DialogClose>
        <Button
          onClick={async () => {
            onClose();
            await retry.run();
          }}
          size="sm"
        >
          {retry.label}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
