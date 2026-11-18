// TooltipTrigger: the control a tooltip describes (tooltip.tsx), a Grasp Button that UI SDK's
// trigger behaviour drives, so it looks exactly like a Button and an agent finds it by its name.
// It carries the tooltip's words as its description (`aria-describedby`).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { TooltipTrigger as TriggerPrimitive } from "@ui-sdk/react/tooltip";
import type { ComponentProps, ReactNode } from "react";

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
  render?: never;
  /**
   * The words on the trigger: what it does ("Publish", "Share"). With `render`, what the element
   * holds, if it is not in the element already.
   */
  children: ButtonWords;
  /** An icon before the words, or the whole trigger with `aria-label`. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** @deprecated Use `aria-label`. */
  label?: never;
  "aria-label"?: string;
}

/**
 * A trigger that is only an icon. `aria-label` is its name; the tooltip adds to it.
 */
interface TriggerIconOnly {
  render?: never;
  children?: never;
  icon: IconData;
  /**
   * The name of an icon-only trigger, for a screen reader, a voice command and an agent. With
   * `render`, its name when its own words do not say it (a face, a logo).
   */
  "aria-label": string;
  /** @deprecated Use `aria-label`. */
  label?: never;
}

/**
 * The same, named the old way.
 */
interface TriggerIconOnlyLabel {
  render?: never;
  children?: never;
  icon: IconData;
  /** @deprecated Use `aria-label`. */
  label: string;
  "aria-label"?: string;
}

/**
 * A trigger the host draws itself: a router's link, a face, a logo.
 */
interface TriggerRendered {
  /**
   * The element the trigger is drawn as, for a router's link (`render={<Link to="/brain" />}`) or any
   * element the host draws (a face, a logo): it keeps its own look, props and name, and the tooltip
   * is its description. Without it, a Grasp Button.
   */
  render: RenderProp;
  children?: ReactNode;
  icon?: never;
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: never;
}

/** Every prop a TooltipTrigger takes: these, and the rest of UI SDK's TooltipTrigger. */
export type TooltipTriggerProps = Omit<
  TriggerPrimitiveProps,
  "render" | "children" | "className" | "style" | "disabled"
> &
  (
    | TriggerWithWords
    | TriggerIconOnly
    | TriggerIconOnlyLabel
    | TriggerRendered
  ) & {
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
    /** @deprecated Use `layout`. */
    style?: ButtonLayoutStyle;
    /** Layout only: margins and alignment, as on a Button. */
    layout?: ButtonLayoutStyle;
  };

/** The control the tooltip describes: a Grasp Button that UI SDK's trigger behaviour drives. */
export const TooltipTrigger = ({
  variant = "quiet",
  size = "md",
  icon,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated,
  children,
  render,
  style: styleProp,
  layout,
  ...rest
}: TooltipTriggerProps) => {
  const still = useStill();
  // The host's own element: it keeps its look and its name; the tooltip describes it.
  if (render !== undefined) {
    // The layout lands on the element `render` draws, as Item's row takes it.
    const { className } = stylex.props(layout ?? styleProp);
    return still ? (
      renderElement(
        "span",
        { "aria-label": label, className, children },
        render
      )
    ) : (
      <TriggerPrimitive
        {...rest}
        aria-label={label}
        render={(props: Record<string, unknown>) =>
          renderElement("button", { ...props, className, children }, render)
        }
      />
    );
  }
  // SAFETY: the props above are one of the two shapes, words or icon only, as the Button takes them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const look = {
    variant,
    size,
    icon,
    "aria-label": label,
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
