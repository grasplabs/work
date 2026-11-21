// The one copy in the library: useCopy writes text to the clipboard through useAction, so every copy
// shows the same tick (or the failed mark) for the same duration-hold and says its own words once;
// CopyButton is the icon button that does it. Code block, Chat message, Key value and Copy field all
// copy through here, so a change to how copying looks or behaves is made once.
//
//   const copy = useCopy(text, { done: "Copied", failed: "Could not copy" });
//   <CopyButton text={code} label="Copy code" copiedLabel="Copied" failedLabel="Could not copy" />
"use client";

import { Copy } from "../icons";
import { Button } from "./button";
import type { ButtonSize } from "./button";
import { useAction } from "./use-action";
import type { ActionWords } from "./use-action";

const write = async (text: string) => {
  await navigator.clipboard.writeText(text);
};

/** Copies `text` when run, with the life of an action: working, then done or failed for duration-hold. */
export const useCopy = (text: string, words: ActionWords) =>
  useAction(async () => {
    await write(text);
  }, words);

/** Every prop a CopyButton takes. */
export interface CopyButtonProps {
  /** What is copied. */
  text: string;
  /** The button's name ("Copy code"). */
  label: string;
  /** What is said once copied. */
  copiedLabel: string;
  /** What is said when it could not copy. */
  failedLabel: string;
  /** @default "sm" */
  size?: ButtonSize;
  /** It cannot copy yet (the text is still being written). */
  disabled?: boolean;
}

/** A ghost icon button that copies `text`: the Copy icon, the tick once copied, said once. */
export const CopyButton = ({
  text,
  label,
  copiedLabel,
  failedLabel,
  size = "sm",
  disabled = false,
}: CopyButtonProps) => {
  const copy = useCopy(text, { done: copiedLabel, failed: failedLabel });
  return (
    <Button
      variant="ghost"
      size={size}
      icon={Copy}
      aria-label={label}
      disabled={disabled}
      {...copy.props}
    />
  );
};
