// TooltipTrigger: the control a tooltip describes (tooltip.tsx), a Grasp Button that UI SDK's
// trigger behaviour drives, so it looks exactly like a Button and an agent finds it by its name.
// It carries the tooltip's words as its description (`aria-describedby`).
"use client";

import { TooltipTrigger as TriggerPrimitive } from "@ui-sdk/react/tooltip";
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
  /** The words on the trigger: what it does ("Publish", "Share"). */
  children: ButtonWords;
  /** An icon before the words, or the whole trigger with `label`. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  label?: never;
}

/**
 * A trigger that is only an icon. `label` is its name; the tooltip adds to it.
 */
interface TriggerIconOnly {
  children?: never;
  icon: IconData;
  /** The name of an icon-only trigger, for a screen reader, a voice command and an agent. */
  label: string;
}

/** Every prop a TooltipTrigger takes: these, and the rest of UI SDK's TooltipTrigger. */
export type TooltipTriggerProps = Omit<
  TriggerPrimitiveProps,
  "render" | "children" | "className" | "style" | "disabled"
> &
  (TriggerWithWords | TriggerIconOnly) & {
    /**
     * The trigger is a Button, in any of its variants: `ghost` in a toolbar, `quiet` beside other
     * buttons.
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
    /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
    layout?: ButtonLayoutStyle;
  };

/** The control the tooltip describes: a Grasp Button that UI SDK's trigger behaviour drives. */
export const TooltipTrigger = ({
  variant = "quiet",
  size = "md",
  icon,
  label,
  children,
  style: styleProp,
  layout,
  ...rest
}: TooltipTriggerProps) => {
  const still = useStill();
  // SAFETY: the props above are one of the two shapes, words or icon only, as the Button takes them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const look = {
    variant,
    size,
    icon,
    label,
    layout: layout ?? styleProp,
    children,
  } as ButtonProps;
  if (still) {
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
