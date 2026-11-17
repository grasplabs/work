// ChatMessageAction: a quiet icon button in a chat message's row of actions (message.tsx), such as
// a thumbs up. It is UI SDK's Button drawn as a small ghost Grasp Button, so an agent finds it by name.
"use client";

import { Button as PressPrimitive } from "@ui-sdk/react/button";
import type { MouseEvent } from "react";

import { Button } from "../button";
import type { IconData } from "../icons";

/** Every prop a ChatMessageAction takes. */
export interface ChatMessageActionProps {
  /** The icon. Import it from the icons entry (`@/components/grasp/icons`). */
  icon: IconData;
  /** Its name, for a screen reader and an agent ("Good answer"). */
  label: string;
  /** What a press does. Return a Promise and an agent waits for it. */
  onClick?: (event: MouseEvent<HTMLElement>) => unknown;
  /**
   * On: a choice that stays, such as a thumbs up given. Said as pressed.
   * @default false
   */
  pressed?: boolean;
}

/** A quiet icon button for a message's actions. */
export const ChatMessageAction = ({
  icon,
  label,
  onClick,
  pressed,
}: ChatMessageActionProps) => (
  <PressPrimitive
    onClick={onClick}
    pendingAnnouncement=""
    aria-pressed={pressed}
    render={(props: Record<string, unknown>) => (
      <Button
        {...props}
        variant={pressed === true ? "quiet" : "ghost"}
        size="sm"
        icon={icon}
        label={label}
      />
    )}
  />
);
