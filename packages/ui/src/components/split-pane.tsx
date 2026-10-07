// Layout primitive, not in shadcn: a main pane and a side pane, such as a
// list and the item it shows, or a form and its preview. Stacked on a phone,
// side by side from `md` up. Not resizable; Resizable is for that.
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

function SplitPane({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="split-pane"
      className={cn("flex min-w-0 flex-col gap-6 md:flex-row", className)}
      {...props}
    />
  );
}

function SplitPaneMain({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="split-pane-main"
      className={cn("flex min-w-0 flex-1 flex-col gap-4", className)}
      {...props}
    />
  );
}

const splitPaneAsideVariants = cva("flex min-w-0 shrink-0 flex-col gap-4", {
  variants: {
    side: {
      // Left of the main pane from `md` up; on a phone the panes follow
      // their order in the markup.
      start: "md:order-first",
      end: "",
    },
    size: {
      sm: "md:w-64",
      md: "md:w-80",
      lg: "md:w-96",
    },
  },
  defaultVariants: {
    side: "end",
    size: "md",
  },
});

function SplitPaneAside({
  className,
  side,
  size,
  ...props
}: React.ComponentProps<"aside"> &
  VariantProps<typeof splitPaneAsideVariants>) {
  return (
    <aside
      data-slot="split-pane-aside"
      className={cn(splitPaneAsideVariants({ side, size }), className)}
      {...props}
    />
  );
}

export { SplitPane, SplitPaneAside, SplitPaneMain, splitPaneAsideVariants };
