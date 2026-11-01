import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import * as React from "react";

// `panel`: a part of a page on a card of its own, as the prototype's
// components/settings.tsx (`SettingsSection`) draws one: a hairline round
// it rather than the resting shadow, its header, then rows or a body each
// under a line, edge to edge.
const cardVariants = cva(
  "group/card bg-card text-card-foreground flex flex-col overflow-hidden rounded-xl text-sm has-[>img:first-child]:pt-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
  {
    variants: {
      variant: {
        default:
          "ring-foreground/10 shadow-block gap-(--card-spacing) py-(--card-spacing) ring-1 [--card-spacing:--spacing(6)] data-[size=sm]:[--card-spacing:--spacing(4)]",
        panel: "border [--card-spacing:--spacing(5)]",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

/** `render` makes it another element, such as the `section` a panel is. */
function Card({
  className,
  size = "default",
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & {
  size?: "default" | "sm";
} & VariantProps<typeof cardVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn(cardVariants({ variant }), className) },
      props
    ),
    render,
    state: { slot: "card", size, variant },
  });
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) group-data-[variant=panel]/card:gap-0.5 group-data-[variant=panel]/card:py-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-normal font-medium group-data-[size=sm]/card:text-sm group-data-[variant=panel]/card:col-start-1 group-data-[variant=panel]/card:text-sm",
        className
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn(
        "text-muted-foreground text-sm group-data-[variant=panel]/card:col-start-1",
        className
      )}
      {...props}
    />
  );
}

/**
 * What can be done with the card, beside its title; on a panel too narrow
 * for both, under its title and description, so they keep their width.
 */
function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end group-data-[variant=panel]/card:@max-md/card-header:col-start-1 group-data-[variant=panel]/card:@max-md/card-header:row-span-1 group-data-[variant=panel]/card:@max-md/card-header:row-start-3 group-data-[variant=panel]/card:@max-md/card-header:mt-2 group-data-[variant=panel]/card:@max-md/card-header:justify-self-start",
        className
      )}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn(
        "flex flex-col gap-3 px-(--card-spacing) group-data-[variant=panel]/card:gap-4 group-data-[variant=panel]/card:border-t group-data-[variant=panel]/card:py-4",
        className
      )}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl px-(--card-spacing) [.border-t]:pt-(--card-spacing)",
        className
      )}
      {...props}
    />
  );
}

/** One row of a panel, under a line: what it is on the left, its control or where it stands on the right. */
function CardRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-row"
      className={cn(
        "flex flex-col gap-3 border-t px-(--card-spacing) py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8",
        className
      )}
      {...props}
    />
  );
}

/** A row's label and the line under it. */
function CardRowLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-row-label"
      className={cn("flex min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  );
}

/** A row's control, on the right from `sm` up. */
function CardRowControl({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-row-control"
      className={cn("flex flex-none sm:w-64 sm:justify-end", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
  CardRow,
  CardRowControl,
  CardRowLabel,
  cardVariants,
};
