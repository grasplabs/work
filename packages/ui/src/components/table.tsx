import { cn } from "@grasp-os/ui/lib/utils";
import * as React from "react";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/50 border-t font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors",
        className
      )}
      {...props}
    />
  );
}

/*
 * `card`: a table in a card of its own, as the Grasp design lists
 * workflows and runs: wider cells, and quiet column names.
 */
function TableHead({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"th"> & { variant?: "default" | "card" }) {
  return (
    <th
      data-slot="table-head"
      data-variant={variant}
      className={cn(
        "h-10 text-left align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        variant === "card"
          ? "text-muted-foreground px-4 font-normal"
          : "text-foreground px-2 font-medium",
        className
      )}
      {...props}
    />
  );
}

/** `card` as for `TableHead`; `roomy` also gives each row more height. */
function TableCell({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"td"> & { variant?: "default" | "card" | "roomy" }) {
  return (
    <td
      data-slot="table-cell"
      data-variant={variant}
      className={cn(
        "align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        variant === "default" && "p-2",
        variant === "card" && "px-4 py-2",
        variant === "roomy" && "px-4 py-3",
        className
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
