import type { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import { ChevronRightIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type * as React from "react";

/*
 * A project's files as a code editor's side bar shows them: folders that
 * open and fold, a line down each open one, every file with the icon of
 * its type (the page's to pick) and the open file standing out. Lists of
 * buttons, a folder's a disclosure that says whether it is open, so it
 * reads as nested lists by any reader, without a tree's own keys to learn.
 */

const fileTreeRowVariants = cva(
  "focus-visible:ring-ring/50 flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[0.8125rem] leading-5 transition-colors duration-100 outline-none focus-visible:ring-[3px] [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      active: {
        true: "bg-tinted text-tinted-foreground font-medium",
        false: "text-muted-foreground hover:bg-muted hover:text-foreground",
      },
    },
    defaultVariants: { active: false },
  }
);

function FileTree({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="file-tree"
      className={cn("flex min-w-0 flex-col gap-px", className)}
      {...props}
    />
  );
}

/** A folder: its name, and what it holds while it is open. */
function FileTreeFolder({
  name,
  children,
  className,
  ...props
}: CollapsiblePrimitive.Root.Props & {
  name: React.ReactNode;
}) {
  return (
    <li data-slot="file-tree-folder" className={cn("min-w-0", className)}>
      <Collapsible {...props}>
        <CollapsibleTrigger
          className={cn(fileTreeRowVariants(), "group/file-tree-folder")}
        >
          <ChevronRightIcon className="transition-transform duration-100 group-data-[panel-open]/file-tree-folder:rotate-90 motion-reduce:transition-none" />
          <FolderIcon className="group-data-[panel-open]/file-tree-folder:hidden" />
          <FolderOpenIcon className="hidden group-data-[panel-open]/file-tree-folder:block" />
          <span className="truncate">{name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="border-border ms-4 flex min-w-0 flex-col gap-px border-s ps-1.5 pt-px">
            {children}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * A file: its icon and name, a button that opens it. The open one is
 * `active` (`aria-current`).
 */
function FileTreeFile({
  active = false,
  icon,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "type"> & {
  active?: boolean;
  /** Its type's icon, as the page tells types apart. */
  icon?: React.ReactNode;
}) {
  return (
    <li data-slot="file-tree-file" className="min-w-0">
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        data-active={active ? "" : undefined}
        // In line with a folder's name: past where its chevron stands.
        className={cn(fileTreeRowVariants({ active }), "ps-7", className)}
        {...props}
      >
        {icon}
        <span className="truncate">{children}</span>
      </button>
    </li>
  );
}

export { FileTree, FileTreeFolder, FileTreeFile };
