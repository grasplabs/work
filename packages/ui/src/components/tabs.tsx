"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { watchRow } from "@grasp-os/ui/lib/row-ends";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

// The room between the tabs and what they show: `none` where the row of
// tabs sits in a bar of its own, ruled off from the panel under it.
const tabsVariants = cva("group/tabs flex data-horizontal:flex-col", {
  variants: {
    spacing: {
      default: "gap-2",
      none: "gap-0",
    },
  },
  defaultVariants: {
    spacing: "default",
  },
});

function Tabs({
  className,
  orientation = "horizontal",
  spacing = "default",
  ...props
}: TabsPrimitive.Root.Props & VariantProps<typeof tabsVariants>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      data-spacing={spacing}
      orientation={orientation}
      className={cn(tabsVariants({ spacing }), className)}
      {...props}
    />
  );
}

// A row of tabs is never wider than what it stands in: with no room for all of them it moves
// sideways inside itself, so a page never scrolls sideways because of its tabs. The row starts
// at its first tab, so none is out of reach, and the line under the open tab has room below.
// An end with more tabs behind it fades (`watchRow` marks it), since nothing else would say so,
// and the open tab stays clear of that fade: both are the same 1.5rem.
const tabsListVariants = cva(
  "group/tabs-list text-muted-foreground relative inline-flex w-fit max-w-full scroll-px-6 items-center justify-start overflow-x-auto overflow-y-hidden rounded-lg p-[3px] group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col group-data-vertical/tabs:overflow-visible data-more-end:mask-r-from-[calc(100%-1.5rem)] data-more-start:mask-l-from-[calc(100%-1.5rem)] data-[variant=line]:rounded-none data-[variant=line]:group-data-horizontal/tabs:h-10.25 data-[variant=line]:group-data-horizontal/tabs:pb-2",
  {
    variants: {
      variant: {
        // The brand book's pill bar: a white bar with a hairline round it.
        default: "bg-card ring-foreground/10 ring-1",
        line: "gap-1 bg-transparent",
      },
      // A row of tabs inside a dashboard block, where every line of height counts.
      size: {
        default: "",
        sm: "group-data-horizontal/tabs:h-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

// In a row of line tabs the line under the open tab is one line for the whole row
// (`TabsPrimitive.Indicator`): it slides to the tab that is opened and takes that tab's width on
// the way, instead of going out under one tab and coming on under another. It stands where each
// tab's own line stood (5px under the tab), and moves with the row when the row moves sideways.
// In the pill bar the open tab is one ink thumb in the same way, gliding under the tab's name on
// the house curve.
function TabsList({
  className,
  variant = "default",
  size = "default",
  children,
  ...props
}: Omit<TabsPrimitive.List.Props, "ref"> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      ref={watchRow}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      {variant === "line" ? (
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          className="bg-foreground ease-sidebar absolute bottom-0.75 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full transition-[translate,width] duration-200 group-data-vertical/tabs:hidden motion-reduce:transition-none"
        />
      ) : (
        <TabsPrimitive.Indicator
          data-slot="tabs-thumb"
          className="bg-primary ease-house absolute top-(--active-tab-top) left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) rounded-md transition-[translate,width] duration-200 group-data-vertical/tabs:hidden motion-reduce:transition-none"
        />
      )}
    </TabsPrimitive.List>
  );
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "text-foreground/60 hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring dark:text-muted-foreground dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-disabled:pointer-events-none aria-disabled:opacity-50 group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        // In the pill bar the open tab is ink. Once the thumb has measured the tab it is the
        // tab's ground and glides between tabs, and the tab itself stays clear, above it; until
        // then (Base UI keeps the thumb `hidden`) the tab is ink itself, so it never reads as
        // light text on white. Each holds in dark too, over the tab's dark look above, and in
        // dark the measured thumb's clear tab outranks the dark ink as it does in light.
        "group-data-horizontal/tabs:group-data-[variant=default]/tabs-list:data-active:bg-primary group-data-horizontal/tabs:group-data-[variant=default]/tabs-list:data-active:text-primary-foreground dark:group-data-horizontal/tabs:group-data-[variant=default]/tabs-list:data-active:bg-primary dark:group-data-horizontal/tabs:group-data-[variant=default]/tabs-list:data-active:text-primary-foreground group-data-horizontal/tabs:group-data-[variant=default]/tabs-list:z-10 group-data-horizontal/tabs:group-has-[[data-slot=tabs-thumb]:not([hidden])]/tabs-list:data-active:bg-transparent group-data-horizontal/tabs:group-data-[variant=default]/tabs-list:data-active:border-transparent group-data-horizontal/tabs:group-data-[variant=default]/tabs-list:data-active:[--muted-foreground:color-mix(in_oklab,var(--primary-foreground)_62%,transparent)] dark:group-data-horizontal/tabs:group-has-[[data-slot=tabs-thumb]:not([hidden])]/tabs-list:data-active:bg-transparent dark:group-data-horizontal/tabs:group-data-[variant=default]/tabs-list:data-active:border-transparent",
        "after:bg-foreground after:absolute after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:-bottom-1.25 group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-vertical/tabs:group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
