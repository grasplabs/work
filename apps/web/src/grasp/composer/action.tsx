// ComposerAction: a round icon button in a composer's footer (composer.tsx), such as Add or
// Dictate. It is UI SDK's Button drawn as a small quiet Grasp Button, so an agent finds it by name.
"use client";

import { Button as PressPrimitive } from "@ui-sdk/react/button";
import type { MouseEvent } from "react";

import { Button } from "../button";
import type { IconData } from "../icons";
import { useComposerDisabled, useVoiceAlone } from "./context";

/** Every prop a ComposerAction takes. */
export interface ComposerActionProps {
  /** The icon. Import it from src/icons. */
  icon: IconData;
  /** Its name, for a screen reader and an agent ("Add a file"). */
  label: string;
  /** What a press does. Return a Promise and an agent waits for it. */
  onClick?: (event: MouseEvent<HTMLElement>) => unknown;
  /**
   * Out of use: no press, half strength. A disabled composer turns off its actions too.
   * @default false
   */
  disabled?: boolean;
}

/** A round icon button for a composer's `start` or `end`. */
export const ComposerAction = ({
  icon,
  label,
  onClick,
  disabled: own = false,
}: ComposerActionProps) => {
  const disabled = useComposerDisabled() || own;
  // Voice input standing alone in send's place is filled, as send is.
  const alone = useVoiceAlone();
  return (
    <PressPrimitive
      onClick={onClick}
      disabled={disabled}
      pendingAnnouncement=""
      render={(props: Record<string, unknown>) => (
        <Button
          {...props}
          variant={alone ? "ink" : "quiet"}
          size="sm"
          icon={icon}
          label={label}
          disabled={disabled}
        />
      )}
    />
  );
};
