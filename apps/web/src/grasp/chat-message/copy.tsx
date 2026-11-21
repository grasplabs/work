// ChatMessageCopy: the Copy action of a message given `copyText` (message.tsx). The library's one
// copy (CopyButton, ../button/copy.tsx): it shows the tick, or the failed mark, for duration-hold and
// says "Copied" or "Could not copy" once, and a failed copy fails for an agent too, with the same
// words.
"use client";

import { CopyButton } from "../button/copy";

interface CopyProps {
  text: string;
  label: string;
  doneLabel: string;
  failedLabel: string;
}

/** Copies the message's words. */
export const ChatMessageCopy = ({
  text,
  label,
  doneLabel,
  failedLabel,
}: CopyProps) => (
  <CopyButton
    text={text}
    label={label}
    copiedLabel={doneLabel}
    failedLabel={failedLabel}
  />
);
