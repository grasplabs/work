// CopyButton: a Button that copies a value to the clipboard (hooks/use-copy): the copy icon, and
// Button's own marks over it, the check once copied and the alert when it could not copy, each shown
// for duration-hold and said once through the page's one live region. Icon only by default, named Copy with a Tooltip
// that says so; with words as its children it shows them beside the icon.
//
//   <CopyButton value={code} aria-label="Copy code" />
//   <CopyButton value={() => link.href} variant="outline" size="sm">Copy link</CopyButton>
"use client";

import type { ReactNode } from "react";

import { useCopy } from "../hooks/use-copy";
import { useI18n } from "../lib/i18n";
import { CopyIcon, Icon } from "../lib/icons";
import { isIconSize } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { Button } from "./button";
import type { ButtonSize, ButtonVariant } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** Every prop a CopyButton takes. */
export interface CopyButtonProps {
  /** What is copied, or what gives it at the moment it is pressed. */
  value: string | (() => string);
  /** Runs with what was copied, once it is on the clipboard: never for a copy that failed or did not run. */
  onCopy?: (value: string) => void;
  /**
   * Button's variant.
   * @default "ghost"
   */
  variant?: ButtonVariant;
  /**
   * Button's size: an `icon` size while it is only an icon, a size with words otherwise.
   * @default "icon-sm", or "sm" with words
   */
  size?: ButtonSize;
  /** Words beside the icon ("Copy link"). Left out, it is only the icon, named by `aria-label`. */
  children?: ReactNode;
  /**
   * Its name when it is only the icon ("Copy code"), shown in its tooltip too.
   * @default the catalogue's copyButton.copy, "Copy"
   */
  "aria-label"?: string;
  /**
   * It cannot copy yet (the value is still being written).
   * @default false
   */
  disabled?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

export const CopyButton = ({
  value,
  onCopy,
  variant = "ghost",
  size,
  children,
  "aria-label": label,
  disabled = false,
  style,
}: CopyButtonProps) => {
  const words = useI18n().copyButton;
  const copy = useCopy(value);
  const props = {
    // Button shows where the copy is; a copy is over within a frame, so it shows no spinner.
    status: copy.status === "loading" ? ("idle" as const) : copy.status,
    disabled,
    // The copy, then the caller's handler with what was copied, only when it is on the clipboard;
    // a failed copy rejects, so UI SDK's Button (and an agent's press) hears that it failed. A press
    // while "Copied" still shows copies nothing; after a failed copy a press copies again.
    onClick: async () => {
      const result = await copy.run();
      if (result.ok) {
        onCopy?.(result.value);
      } else if (!("busy" in result)) {
        throw new Error(words.copyError);
      }
    },
    variant,
    style,
    asChild: true,
  };
  const mark = <Icon icon={CopyIcon} />;
  // The slot is set on the element Button draws, as UI SDK would overwrite one passed as a prop.
  if (children !== undefined) {
    return (
      <Button
        {...props}
        size={size === undefined || isIconSize(size) ? "sm" : size}
      >
        <button type="button" data-slot="copy-button">
          {mark}
          {children}
        </button>
      </Button>
    );
  }
  const name = label ?? words.copy;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...props}
          size={isIconSize(size) ? size : "icon-sm"}
          aria-label={name}
        >
          <button type="button" data-slot="copy-button">
            {mark}
          </button>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
};
