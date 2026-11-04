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
      toast.add({ type: "error", title: t`Copying didn't work` });
    }
  };
  return { copied, copy };
};
