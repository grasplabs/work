import { Button } from "@grasp-os/ui/components/button";
import type { ReactNode } from "react";

/**
 * One answer to what waits on the person in the chat (a held write, the
 * packages the agent asked for), named for what it answers ("Confirm Send
 * an email on …"), so a list of them reads apart: a small Damsko Button in
 * a Confirmation's actions, the yes in the success colour (the reference's
 * approve).
 */
export const DecisionButton = ({
  label,
  describedBy,
  disabled,
  variant = "success",
  onPress,
  children,
}: {
  label: string;
  /** The line that says why it waits, while it does. */
  describedBy?: string | undefined;
  disabled: boolean;
  variant?: "success" | "outline";
  onPress: () => Promise<void>;
  children: ReactNode;
}) => (
  <Button asChild disabled={disabled} size="sm" variant={variant}>
    <button
      aria-describedby={describedBy}
      aria-label={label}
      onClick={() => {
        void onPress();
      }}
      type="button"
    >
      {children}
    </button>
  </Button>
);
