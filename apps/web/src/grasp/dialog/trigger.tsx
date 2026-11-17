// DialogTrigger: the button that opens a dialog (dialog.tsx), a Grasp Button that UI SDK's trigger
// behaviour drives, so it looks exactly like a Button and an agent finds it by its name.
"use client";

import { DialogTrigger as TriggerPrimitive } from "@ui-sdk/react/dialog";
import { mergeProps } from "@ui-sdk/react/primitive";
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
import { WithTip } from "../tooltip/lazy-tip";
import { useStill } from "./still-context";

type TriggerPrimitiveProps = ComponentProps<typeof TriggerPrimitive>;

/**
 * A trigger with words, and an icon before them if it helps.
 */
interface TriggerWithWords {
  /** The words on the trigger: what the dialog is for, a verb first ("Rename project"). */
  children: ButtonWords;
  /** An icon before the words, or the whole trigger with `label`. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  label?: never;
}

/**
 * A trigger that is only an icon. `label` is its name, and the dialog's.
 */
interface TriggerIconOnly {
  children?: never;
  icon: IconData;
  /** The name of an icon-only trigger, for a screen reader, a voice command and an agent. */
  label: string;
}

/** Every prop a DialogTrigger takes: these, and the rest of UI SDK's DialogTrigger. */
export type DialogTriggerProps = Omit<
  TriggerPrimitiveProps,
  "render" | "children" | "className" | "style"
> &
  (TriggerWithWords | TriggerIconOnly) & {
    /**
     * The trigger is a Button, in any of its variants: `quiet` beside other buttons, `ink` when
     * opening the dialog is the step you want taken.
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
    /**
     * Words for a tooltip on the trigger: what the dialog is for, when the trigger alone does not
     * say it (an icon only). It never shows while the dialog is open.
     */
    tooltip?: string;
  };

/** The button that opens the dialog: a Grasp Button that UI SDK's trigger behaviour drives. */
export const DialogTrigger = ({
  variant = "quiet",
  size = "md",
  icon,
  label,
  children,
  style: styleProp,
  layout,
  tooltip,
  ...rest
}: DialogTriggerProps) => {
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
    // Drawn where the page shows it: shut, and closing as focus comes back to it. While the panel
    // stands over it, the panel covers it.
    if (still.phase === "opening" || still.phase === "open") {
      return null;
    }
    return <Button {...look} type="button" />;
  }
  return (
    <WithTip
      tooltip={tooltip}
      render={(tip) => (
        <TriggerPrimitive
          {...rest}
          render={(props: Record<string, unknown>) => (
            <Button {...mergeProps(tip, props)} {...look} />
          )}
        />
      )}
    />
  );
};
