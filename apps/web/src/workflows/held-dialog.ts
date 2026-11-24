import { useState } from "react";

// A dialog whose one action is work that runs before it closes, as
// Damsko's alert dialog asks it to be built: open by the page, the work a
// Button whose press returns a Promise, and Escape or the safe answer
// waiting while it runs. Once the work is done it closes; when it fails,
// the Button says so and the dialog stays open, to try again or cancel.

/** What the shade's or Escape's close request says while the work runs. */
interface CloseRequest {
  cancel: () => void;
}

/** A dialog held open while its work runs. */
export const useHeldDialog = () => {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const handleOpenChange = (next: boolean, details: CloseRequest): void => {
    if (working) {
      details.cancel();
      return;
    }
    setOpen(next);
  };
  /** Runs `work`, holding the dialog open until it is done; then closes it. */
  const hold = async (work: () => Promise<void>): Promise<void> => {
    setWorking(true);
    await work().finally(() => {
      setWorking(false);
    });
    setOpen(false);
  };
  return { open, handleOpenChange, hold };
};
