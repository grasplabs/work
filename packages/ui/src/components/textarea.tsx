import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

const textareaVariants = cva(
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 flex field-sizing-content min-h-16 w-full rounded-md border px-2.5 py-2 shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3",
  {
    variants: {
      variant: {
        default: "text-base md:text-sm",
        // Source text, such as JSON: fixed-width, so columns line up.
        code: "font-mono text-xs",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Textarea({
  className,
  variant,
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant ?? "default"}
      className={cn(textareaVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Textarea, textareaVariants };
