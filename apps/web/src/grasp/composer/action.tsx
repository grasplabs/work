// ComposerAction: a round icon button in a composer's footer (composer.tsx), such as Add or
// Dictate. It is UI SDK's Button drawn as a small quiet Grasp Button, so an agent finds it by name.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import type { MouseEvent } from "react";

import { Button } from "../button";
import type { IconData } from "../icons";
import { useComposerDisabled, useVoiceAlone } from "./context";
import { cornerStyles } from "./corner";

/** Every prop a ComposerAction takes. */
export interface ComposerActionProps {
  /** The icon. Import it from the icons entry (`@/components/grasp/icons`). */
  icon: IconData;
  /** Its name, for a screen reader and an agent ("Add a file"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** What a press does. Return a Promise and an agent waits for it. */
  onClick?: (event: MouseEvent<HTMLElement>) => unknown;
  /**
   * Out of use: no press, half strength. A disabled composer turns off its actions too.
   * @default false
   */
  disabled?: boolean;
  /**
   * On: a choice that stays, such as dictation listening. Said as pressed.
   * @default false
   */
  pressed?: boolean;
}

/** A round icon button for a composer's `start` or `end`. */
export const ComposerAction = ({
  icon,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  onClick,
  disabled: own = false,
  pressed,
}: ComposerActionProps) => {
  const disabled = useComposerDisabled() || own;
  // Voice input standing alone in send's place is filled, as send is; so is an action pressed on.
  const alone = useVoiceAlone();
  // First or last in its side of the footer, it nests in the card's corner (corner.ts).
  return (
    <span {...stylex.props(cornerStyles.nest)}>
      <PressPrimitive
        onClick={onClick}
        disabled={disabled}
        pendingAnnouncement=""
        aria-pressed={pressed}
        render={(props: Record<string, unknown>) => (
          <Button
            {...props}
            variant={alone || pressed === true ? "ink" : "quiet"}
            size="sm"
            icon={icon}
            aria-label={label}
            disabled={disabled}
          />
        )}
      />
    </span>
  );
};
