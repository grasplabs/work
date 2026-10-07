// Layout primitive, not in shadcn: children in a row that wraps on a narrow
// screen, with a gap from the spacing scale. For toolbars, actions and tags.
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

const inlineVariants = cva("flex min-w-0 flex-row flex-wrap", {
  variants: {
    gap: {
      none: "gap-0",
      xs: "gap-1",
      sm: "gap-2",
      md: "gap-4",
      lg: "gap-6",
      xl: "gap-8",
    },
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      baseline: "items-baseline",
    },
    justify: {
      start: "justify-start",
      center: "justify-center",
      end: "justify-end",
      between: "justify-between",
    },
  },
  defaultVariants: {
    gap: "sm",
    align: "center",
    justify: "start",
  },
});

function Inline({
  className,
  gap,
  align,
  justify,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inlineVariants>) {
  return (
    <div
      data-slot="inline"
      className={cn(inlineVariants({ gap, align, justify }), className)}
      {...props}
    />
  );
}

export { Inline, inlineVariants };
