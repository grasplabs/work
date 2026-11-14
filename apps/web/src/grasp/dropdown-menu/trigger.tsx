// DropdownMenuTrigger: the button that opens a dropdown menu (menu.tsx), a Grasp Button that UI
// SDK's trigger behaviour drives, so it looks exactly like a Button and an agent finds the menu by
// its name. Enter, Space and the down arrow open it on the first item, the up arrow on the last.
"use client";

import { MenuTrigger as TriggerPrimitive } from "@ui-sdk/react/menu";
import type { ComponentProps } from "react";

import { Button } from "../button";
import type {
  ButtonLayoutStyle,
  ButtonProps,
  ButtonSize,
  ButtonVariant,
  ButtonWords,
} from "../button";
import { ChevronDown } from "../icons";
import type { IconData } from "../icons";

type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;

// Every prop is documented once, where it is first declared; the props on the docs page are read
// from the type below, so they cannot drift from what the code accepts.

/**
 * A trigger with words, and an icon before them if it helps.
 */
interface TriggerWithWords {
  /** The words on the trigger: what the menu acts on ("Report", "Account"). */
  children: ButtonWords;
  /** An icon before the words, or the whole trigger with `label`. Import it from src/icons. */
  icon?: IconData;
  /**
   * A chevron after the words, to say a menu opens here.
   * @default false
   */
  chevron?: boolean;
  label?: never;
}

/**
 * A trigger that is only an icon. `label` is its name.
 */
interface TriggerIconOnly {
  children?: never;
  icon: IconData;
  chevron?: never;
  /** The name of an icon-only trigger, for a screen reader, a voice command and an agent ("Actions for Q3 report"). */
  label: string;
}

/** Every prop a DropdownMenuTrigger takes: these, and the rest of UI SDK's MenuTrigger. */
export type DropdownMenuTriggerProps = Omit<
  TriggerPrimitiveProps,
  "render" | "children" | "className" | "style" | "payload"
> &
  (TriggerWithWords | TriggerIconOnly) & {
    /**
     * The trigger is a Button, in any of its variants: `quiet` beside other buttons, `ghost` in a
     * toolbar or a row.
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

/** The button that opens the menu: a Grasp Button that UI SDK's trigger behaviour drives. */
export const DropdownMenuTrigger = ({
  variant = "quiet",
  size = "md",
  icon,
  label,
  chevron = false,
  children,
  style,
  ...rest
}: DropdownMenuTriggerProps) => {
  // SAFETY: the props above are one of the two shapes, words or icon only, as the Button takes them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const look = {
    variant,
    size,
    icon,
    label,
    style,
    children,
    iconEnd: chevron ? ChevronDown : undefined,
  } as ButtonProps;
  return (
    <TriggerPrimitive
      {...rest}
      render={(props: Record<string, unknown>) => (
        <Button {...props} {...look} />
      )}
    />
  );
};
