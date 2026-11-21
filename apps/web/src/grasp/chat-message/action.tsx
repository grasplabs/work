// ChatMessageAction: a quiet icon button in a chat message's row of actions (message.tsx), such as
// a thumbs up. It is UI SDK's Button drawn as a small ghost Grasp Button, so an agent finds it by name.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import type { MouseEvent } from "react";

import { Button } from "../button";
import type { IconData } from "../icons";
import { grasp, media } from "../tokens/tokens.stylex";

/** Every prop a ChatMessageAction takes. */
export interface ChatMessageActionProps {
  /** The icon. Import it from the icons entry (`@/components/grasp/icons`). */
  icon: IconData;
  /**
   * The icon while it is on (`pressed`): the filled form of the same mark, such as `ThumbsUpFilled`
   * for `ThumbsUp`. With it a pressed action stays the bare ghost button and only its icon fills.
   * Without it a pressed action keeps the ghost button's soft pressed fill.
   */
  iconPressed?: IconData;
  /** Its name, for a screen reader and an agent ("Good answer"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** What a press does. Return a Promise and an agent waits for it. */
  onClick?: (event: MouseEvent<HTMLElement>) => unknown;
  /**
   * On: a choice that stays, such as a thumbs up given. Said as pressed.
   * @default false
   */
  pressed?: boolean;
}

const styles = stylex.create({
  // Adds no box: the button stands in the row of actions as before.
  holder: { display: "contents" },
  bare: {
    "--grasp-ghost-fill-press": {
      default: "transparent",
      ":hover": { default: "transparent", [media.hover]: grasp.ghostFillHover },
    },
  },
});

/** A quiet icon button for a message's actions. */
export const ChatMessageAction = ({
  icon,
  iconPressed,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  onClick,
  pressed,
}: ChatMessageActionProps) => {
  const filled = pressed === true && iconPressed !== undefined;
  return (
    <span {...stylex.props(styles.holder, filled && styles.bare)}>
      <PressPrimitive
        onClick={onClick}
        pendingAnnouncement=""
        aria-pressed={pressed}
        render={(props: Record<string, unknown>) => (
          <Button
            {...props}
            variant="ghost"
            size="sm"
            icon={filled ? iconPressed : icon}
            aria-label={label}
          />
        )}
      />
    </span>
  );
};
