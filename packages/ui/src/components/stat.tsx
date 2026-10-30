// Not in shadcn: a key figure, one number that says the result, in the
// serif. It stands on its own, over or under the words that say what it
// counts, or inside a sentence. Figures line up. `render` makes it a `dd`
// in a definition list.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

const statVariants = cva(
  "font-serif text-[1.75rem] leading-none font-light tracking-[-0.03em] lining-nums tabular-nums",
  {
    variants: {
      variant: {
        default: "",
        // A figure that needs someone: in the attention amber.
        attention: "text-status-attention",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Stat({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof statVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      { className: cn(statVariants({ variant }), className) },
      props
    ),
    render,
    state: { slot: "stat", variant },
  });
}

export { Stat, statVariants };
