import { toast } from "@grasp-os/ui/components/toast";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

// Copying to the clipboard, the one way the app does it: browsers refuse
// without focus or permission, so nothing says it copied unless it did.

/** How long a copy control says "Copied". */
const copiedMs = 1500;

/** Copies text, and says whether it worked. */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Copies text still being put together (a whole chat, read first), and
 * says whether it worked: the clipboard is handed the text's promise at
 * once, within the press that asked for it, as a browser needs to let it
 * write once the text is ready.
 */
export const copyTextLater = async (
  text: Promise<string>
): Promise<boolean> => {
  const blob = (async () => new Blob([await text], { type: "text/plain" }))();
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": blob }),
    ]);
    return true;
  } catch {
    // A text that failed as well is answered here, never left unhandled,
    // whether or not the clipboard took it before it failed.
    await Promise.allSettled([blob]);
    return false;
  }
};

/**
 * Copies text, and says so for a moment (`copied`); a refused clipboard
 * says that instead.
 */
export const useCopy = () => {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = copied
      ? setTimeout(() => {
          setCopied(false);
        }, copiedMs)
      : undefined;
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const copy = async (text: string): Promise<void> => {
    if (await copyText(text)) {
      setCopied(true);
    } else {
      toast.error(t`Copying didn't work`);
    }
  };
  return { copied, copy };
};
