import { Button } from "@grasp-os/ui/components/button";
import type { ReactNode } from "react";

/**
 * One answer to what waits on the person in the chat (a held write, the
 * packages the agent asked for), named for what it answers ("Confirm Send
 * an email on …"), so a list of them reads apart: a small Damsko Button in
 * a Confirmation's actions, the yes in the success colour (the reference's
 * approve). Held for the pause after an answer (`pausedBy`), it stays a
 * Tab stop that says why, as the Inbox's answers do, and a press does
 * nothing.
 */
export const DecisionButton = ({
  label,
  describedBy,
  pausedBy,
  disabled,
  variant = "success",
  onPress,
  children,
}: {
  label: string;
  /** The line that says why it waits, while it does. */
  describedBy?: string | undefined;
  /** The line that says the answers wait a moment, while they do (answer-pause.tsx). */
  pausedBy?: string | undefined;
  disabled: boolean;
  variant?: "success" | "outline";
  onPress: () => Promise<void>;
  children: ReactNode;
}) => {
  const paused = pausedBy !== undefined;
  const off = disabled || paused;
  const why = [describedBy, pausedBy].filter((id) => id !== undefined);
  return (
    <Button
      asChild
      disabled={off}
      focusableWhenDisabled={paused}
      size="sm"
      variant={variant}
    >
      <button
        aria-describedby={why.length === 0 ? undefined : why.join(" ")}
        aria-label={label}
        onClick={() => {
          if (!off) {
            void onPress();
          }
        }}
        type="button"
      >
        {children}
      </button>
    </Button>
  );
};
