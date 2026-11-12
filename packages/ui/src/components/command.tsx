"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { cn } from "@grasp-os/ui/lib/utils";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon, CheckIcon } from "lucide-react";
import * as React from "react";

/**
 * A command menu: a search over a list a keyboard moves through, laid out
 * as the kit's menus are, on whatever holds it (a popover, a dialog),
 * whose corners it takes. Focused itself, as a menu without a search is
 * for its keys, it shows no ring: its selected row says where it is.
 */
function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-popover text-popover-foreground flex size-full flex-col overflow-hidden rounded-[inherit] outline-hidden",
        className
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          "top-1/3 translate-y-0 overflow-hidden rounded-xl! p-0",
          className
        )}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The search on top of a command list: a row as wide as the menu, a line
 * under it, the search's icon on its left, or what takes its place
 * (`start`, such as the way back from a list opened in a menu's place).
 * `lg` is the one of a window of its own: taller, its words larger.
 */
function CommandInput({
  className,
  size = "default",
  start,
  ...props
}: Omit<React.ComponentProps<typeof CommandPrimitive.Input>, "size"> & {
  size?: "default" | "lg";
  start?: React.ReactNode;
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      data-size={size}
      className="flex h-10 shrink-0 items-center gap-2 border-b px-3 data-[size=lg]:h-13 data-[size=lg]:px-4"
    >
      {start ?? (
        <SearchIcon
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
      )}
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "placeholder:text-muted-foreground h-full w-full min-w-0 bg-transparent text-sm outline-hidden disabled:cursor-not-allowed disabled:opacity-50 in-data-[size=lg]:text-base",
          className
        )}
        {...props}
      />
    </div>
  );
}

/**
 * The list of a command menu, with the kit's menus' room round its rows.
 * `fill` takes the height its place has, for a list beside something else
 * in a window of its own.
 */
function CommandList({
  className,
  fill = false,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List> & { fill?: boolean }) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar scroll-py-1 overflow-x-hidden overflow-y-auto p-1 outline-none",
        fill ? "h-full max-h-none" : "max-h-72",
        className
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn(
        "text-muted-foreground py-6 text-center text-sm",
        className
      )}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-foreground **:[[cmdk-group-heading]]:text-muted-foreground overflow-hidden **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium",
        className
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

/**
 * One choice in a command list. `check` marks a chosen one with a tick on
 * the right; a row that lays out its own lines leaves it out.
 */
function CommandItem({
  className,
  children,
  check = true,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & { check?: boolean }) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item data-selected:bg-accent data-selected:text-accent-foreground data-selected:**:[svg]:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      {check ? (
        <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
      ) : null}
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "text-muted-foreground group-data-selected/command-item:text-accent-foreground ml-auto text-xs tracking-widest",
        className
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
