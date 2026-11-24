// Copying text to the clipboard, with the life of an action: every copy in the library shows the
// same result for the same time and says its words once (useAction).
//
//   const copy = useCopy(code);
//   const copy = useCopy(() => link.href);      read at the press
//   <Button variant="ghost" size="icon-sm" aria-label={copyLabel} {...copy.props}>…</Button>
"use client";

import { useI18n } from "../lib/i18n";
import { useAction } from "./use-action";
import type { ActionText } from "./use-action";

/**
 * Copies `text` when run, or what `text()` gives at that moment: loading, then success or error for
 * duration-hold. A run resolves with what was copied.
 */
export const useCopy = (
  text: string | (() => string),
  given: ActionText = {}
) => {
  const words = useI18n().copyButton;
  return useAction(
    async () => {
      const copied = typeof text === "function" ? text() : text;
      await navigator.clipboard.writeText(copied);
      return copied;
    },
    {
      ...given,
      successText: given.successText ?? words.copied,
      errorText: given.errorText ?? words.copyError,
    }
  );
};
