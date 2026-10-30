import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-4 py-3 text-left text-sm has-[[data-slot=alert-action][data-placement=corner]]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        attention: "bg-card text-card-foreground *:[svg]:text-status-attention",
        agreed: "bg-card text-card-foreground *:[svg]:text-status-agreed",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Alert({
  className,
  variant,
  live = "assertive",
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    /**
     * How a screen reader hears it: `assertive` interrupts (role `alert`),
     * for what went wrong; `polite` waits its turn (role `status`), for
     * where something stands.
     */
    live?: "assertive" | "polite";
  }) {
  return (
    <div
      data-slot="alert"
      role={live === "polite" ? "status" : "alert"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "[&_a]:hover:text-foreground font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3",
        className
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-muted-foreground [&_a]:hover:text-foreground text-sm text-balance md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  );
}

/*
 * `placement`: one small action in the corner (`corner`), or the choices a
 * confirmation asks for, in a row under what it says (`below`).
 */
function AlertAction({
  className,
  placement = "corner",
  ...props
}: React.ComponentProps<"div"> & { placement?: "corner" | "below" }) {
  return (
    <div
      data-slot="alert-action"
      data-placement={placement}
      className={cn(
        placement === "corner"
          ? "absolute top-2.5 right-3"
          : "mt-2.5 flex flex-wrap gap-2 group-has-[>svg]/alert:col-start-2",
        className
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
