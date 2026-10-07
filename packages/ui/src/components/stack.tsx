// Layout primitive, not in shadcn: children in a column with a gap from the
// spacing scale. For composing a screen; it adds no page chrome.
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

const stackVariants = cva("flex min-w-0 flex-col", {
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
      stretch: "items-stretch",
      start: "items-start",
      center: "items-center",
      end: "items-end",
    },
  },
  defaultVariants: {
    gap: "md",
    align: "stretch",
  },
});

function Stack({
  className,
  gap,
  align,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof stackVariants>) {
  return (
    <div
      data-slot="stack"
      className={cn(stackVariants({ gap, align }), className)}
      {...props}
    />
  );
}

export { Stack, stackVariants };
