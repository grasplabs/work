// AlertDialogTrigger: the button that opens an alert dialog (alert-dialog.tsx), a Grasp Button that
// UI SDK's trigger behaviour drives, so it looks exactly like a Button and an agent opens the alert
// dialog by its name. Opening it is harmless, so it never asks an agent for a yes; the action does.
"use client";

import { AlertDialogTrigger as TriggerPrimitive } from "@ui-sdk/react/alert-dialog";
import type { ComponentProps } from "react";

import { Button } from "../button";
import type {
  ButtonLayoutStyle,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  ButtonWords,
} from "../button";
import { useStill } from "../dialog/still-context";
import type { IconData } from "../icons";

type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/**
 * A trigger with words, and an icon before them if it helps.
 */
interface TriggerWithWords {
  /** The words on the trigger: the step it asks about, a verb first ("Delete workspace"). */
  children: ButtonWords;
  /** An icon before the words, or the whole trigger with `label`. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  label?: never;
}

/**
 * A trigger that is only an icon. `label` is its name.
 */
interface TriggerIconOnly {
  children?: never;
  icon: IconData;
  /** The name of an icon-only trigger, for a screen reader, a voice command and an agent. */
  label: string;
}

/** Every prop an AlertDialogTrigger takes: these, and the rest of UI SDK's AlertDialogTrigger. */
export type AlertDialogTriggerProps = Omit<
  TriggerPrimitiveProps,
  "render" | "children" | "className" | "style"
> &
  (TriggerWithWords | TriggerIconOnly) & {
    /**
     * The trigger is a Button, in any of its variants: `danger` when the step deletes, `quiet`
     * beside other buttons.
     * @default "quiet"
     */
    variant?: ButtonVariant;
    /**
     * The Button's height: `xs` 28px, `sm` 32px, `md` 36px, `lg` 44px.
     * @default "md"
     */
    size?: ButtonSize;
    /** Layout only: margins and alignment, as on a Button. */
    style?: ButtonLayoutStyle;
  };

/** The button that opens the alert dialog: a Grasp Button that UI SDK's trigger behaviour drives. */
export const AlertDialogTrigger = ({
  variant = "quiet",
  size = "md",
  icon,
  label,
  children,
  style,
  ...rest
}: AlertDialogTriggerProps) => {
  const still = useStill();
  // One of the two shapes above, as the Button takes it.
  // SAFETY: the props above are one of the two shapes, words or icon only, as the Button takes them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const look = { variant, size, icon, label, style, children } as ButtonProps;
  if (still) {
    // While the panel stands over it, the panel covers it.
    if (still.phase === "opening" || still.phase === "open") {
      return null;
    }
    return <Button {...look} type="button" />;
  }
  return (
    <TriggerPrimitive
      {...rest}
      render={(props: Record<string, unknown>) => (
        <Button {...props} {...look} />
      )}
    />
  );
};
