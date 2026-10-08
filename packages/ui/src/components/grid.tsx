// Layout primitive, not in shadcn: a responsive grid of equal columns. One
// column on a phone, growing to `columns` as the screen widens.
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

const gridVariants = cva("grid min-w-0 grid-cols-1", {
  variants: {
    columns: {
      1: "",
      2: "sm:grid-cols-2",
      3: "sm:grid-cols-2 lg:grid-cols-3",
      4: "sm:grid-cols-2 lg:grid-cols-4",
    },
    gap: {
      none: "gap-0",
      xs: "gap-1",
      sm: "gap-2",
      md: "gap-4",
      lg: "gap-6",
      xl: "gap-8",
    },
  },
  defaultVariants: {
    columns: 3,
    gap: "md",
  },
});

function Grid({
  className,
  columns,
  gap,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof gridVariants>) {
  return (
    <div
      data-slot="grid"
      className={cn(gridVariants({ columns, gap }), className)}
      {...props}
    />
  );
}

export { Grid, gridVariants };
