// Not in shadcn: a key figure, one number that says the result, in the
// serif. It stands on its own, over or under the words that say what it
// counts, or inside a sentence. Figures line up. `render` makes it a `dd`
// in a definition list, or a `tspan` in a chart (it fills as it colours).
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

const statVariants = cva(
  // The line height goes with each size (`/none`): a `leading-none` here
  // was dropped by `cn` the moment a size's `text-…` followed it, which
  // left every figure at the text's line height, 40px instead of 28px.
  "fill-current font-serif font-light tracking-[-0.03em] lining-nums tabular-nums",
  {
    variants: {
      variant: {
        default: "",
        // A figure of what is done: in the agreed green.
        done: "text-status-agreed",
        // A figure that needs someone: in the attention amber.
        attention: "text-status-attention",
      },
      size: {
        default: "text-[1.75rem]/none",
        // In a narrow container, such as a small ring of a dashboard
        // block: the product's size, and the figure's own from the
        // container's `@sm` on.
        compact: "text-sm/none @sm:text-[1.75rem]/none",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

function Stat({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof statVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      { className: cn(statVariants({ variant, size }), className) },
      props
    ),
    render,
    state: { slot: "stat", variant, size },
  });
}

export { Stat, statVariants };
