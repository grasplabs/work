// DrawerTrigger: the button that opens a drawer (drawer.tsx), a Grasp Button that UI SDK's
// trigger behaviour drives, so it looks exactly like a Button and an agent finds it by its name.
"use client";

import { DrawerTrigger as TriggerPrimitive } from "@ui-sdk/react/drawer";
import type { ComponentProps } from "react";

import { Button } from "../button";
import type {
  ButtonLayoutStyle,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  ButtonWords,
} from "../button";
import type { IconData } from "../icons";
import { useStill } from "./still-context";

type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;

/**
 * A trigger with words, and an icon before them if it helps.
 */
interface TriggerWithWords {
  /** The words on the trigger: what the panel is for, a verb first ("Set a reminder"). */
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

/** Every prop a DrawerTrigger takes: these, and the rest of UI SDK's DrawerTrigger. */
export type DrawerTriggerProps = Omit<
  TriggerPrimitiveProps,
  "render" | "children" | "className" | "style"
> &
  (TriggerWithWords | TriggerIconOnly) & {
    /**
     * The trigger is a Button, in any of its variants: `quiet` beside other buttons, `ink` when
     * opening the panel is the step you want taken.
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

/** The button that opens the drawer: a Grasp Button that UI SDK's trigger behaviour drives. */
export const DrawerTrigger = ({
  variant = "quiet",
  size = "md",
  icon,
  label,
  children,
  style,
  ...rest
}: DrawerTriggerProps) => {
  // SAFETY: the props above are one of the two shapes, words or icon only, as the Button takes them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const look = { variant, size, icon, label, style, children } as ButtonProps;
  // Drawn standing still for the docs: the open panel covers the page, so the trigger is not drawn.
  if (useStill()) {
    return null;
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
