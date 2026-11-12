// Layout primitive, not in shadcn: the column beside a page's content, the
// same on every page that has one (the workspace's Knowledge and Brain, an
// organization in the admin), from the prototype's
// components/page-sidebar.tsx. 288px open, with the page's first choice in
// its top row and the button that folds it beside that; folded, a 48px rail
// of icons as wide as the site header's square for the sidebar trigger, so
// its edge continues the line beside that trigger and nothing moves when it
// folds. On a phone neither shows: the page offers its list another way.
// Whether it is folded is the page's to keep. Built on the kit's Panel, as
// every collapsible region is.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { Panel } from "@grasp-os/ui/components/panel";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

const motionReduced = (): boolean =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

const pageSidebarInnerVariants = cva("flex flex-none flex-col", {
  variants: {
    folded: {
      true: "w-12 items-center gap-1 overflow-y-auto py-3",
      false: "w-72",
    },
  },
  defaultVariants: { folded: false },
});

/**
 * The sidebar itself, named `label`: open, or folded to its rail. It stays
 * one element either way, so its width eases between the two on the app
 * sidebar's curve; what it holds keeps its own width, so it is uncovered or
 * cut off rather than squeezed. Folding, it keeps what it held open until
 * its width has shrunk, so it closes the way it opens rather than turning
 * into the rail at once and shrinking an empty column. `landmark` says
 * what it is to assistive technology: beside the page (`aside`), or the
 * way between a record's own pages (`nav`).
 */
function PageSidebar({
  folded = false,
  label,
  landmark = "complementary",
  className,
  children,
}: {
  label: string;
  landmark?: "complementary" | "navigation";
  className?: string;
  children: ReactNode;
  /** Folded to its rail. */
  folded?: boolean;
}) {
  const shut = folded;
  const Landmark = landmark === "navigation" ? "nav" : "aside";
  const [was, setWas] = useState({
    folded: shut,
    open: shut ? null : children,
  });
  // While it folds, what it held open; none once the width has shrunk, or
  // where motion is reduced.
  const [leaving, setLeaving] = useState<ReactNode>(null);
  if (shut !== was.folded || (!shut && children !== was.open)) {
    setWas({ folded: shut, open: shut ? was.open : children });
    if (shut !== was.folded) {
      setLeaving(shut && !motionReduced() ? was.open : null);
    }
  }
  return (
    // The kit's Panel on the content's left edge, as every collapsible
    // region is: 288 pixels open, a 48-pixel rail folded.
    <Panel
      side="left"
      open={!shut}
      size="18rem"
      collapsedSize="3rem"
      render={<Landmark aria-label={label} />}
      data-slot="page-sidebar"
      data-folded={shut}
      bordered
      // The rail takes over once the width has shrunk.
      onOpenChangeComplete={() => {
        setLeaving(null);
      }}
      className={cn("hidden md:flex", className)}
    >
      {leaving === null ? (
        <div
          data-slot="page-sidebar-inner"
          className={pageSidebarInnerVariants({ folded: shut })}
        >
          {children}
        </div>
      ) : (
        <div
          data-slot="page-sidebar-inner"
          className={pageSidebarInnerVariants({ folded: false })}
          inert
        >
          {leaving}
        </div>
      )}
    </Panel>
  );
}

/** A rail entry that is a link: `render` with the rail button's look. */
function PageSidebarRailLink({
  active,
  label,
  render,
  className,
  ...props
}: useRender.ComponentProps<"a"> & { active: boolean; label: string }) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        "aria-current": active ? "page" : undefined,
        "aria-label": label,
        className: cn(
          buttonVariants({
            size: "icon",
            variant: active ? "secondary" : "ghost",
          }),
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "page-sidebar-rail-link", active },
  });
}

/**
 * A button named by its tooltip: the fold, and the rail's entries. With
 * `render` it is a link (a link, not a button, to assistive technology).
 */
function PageSidebarRailButton({
  label,
  active = false,
  onClick,
  render,
  className,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  render?: ReactElement;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      {render === undefined ? (
        <TooltipTrigger
          render={
            <Button
              aria-current={active ? "page" : undefined}
              aria-label={label}
              className={className}
              data-slot="page-sidebar-rail-button"
              onClick={onClick}
              size="icon"
              variant={active ? "secondary" : "ghost"}
            />
          }
        >
          {children}
        </TooltipTrigger>
      ) : (
        <TooltipTrigger
          render={
            <PageSidebarRailLink
              active={active}
              className={className}
              label={label}
              render={render}
            />
          }
        >
          {children}
        </TooltipTrigger>
      )}
      <TooltipContent className="max-w-64" side="right">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

const pageSidebarTopVariants = cva("flex flex-none items-center gap-1.5", {
  variants: {
    // `joined`: the rest continues it as one list, with no line between.
    joined: { true: "px-3 pt-3", false: "border-b p-3" },
  },
  defaultVariants: { joined: false },
});

/**
 * The top row: the page's first choice or a heading, and the fold beside
 * it, where the rail's first button sits. A line sets it apart from the
 * rest, unless the rest continues it as one list (`joined`).
 */
function PageSidebarTop({
  fold,
  joined = false,
  className,
  children,
}: {
  fold?: { label: string; onFold: () => void };
  className?: string;
  children: ReactNode;
} & VariantProps<typeof pageSidebarTopVariants>) {
  return (
    <div
      data-slot="page-sidebar-top"
      className={cn(pageSidebarTopVariants({ joined }), className)}
    >
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      {fold === undefined ? null : (
        <PageSidebarRailButton
          label={fold.label}
          onClick={() => {
            fold.onFold();
          }}
        >
          <PanelLeftCloseIcon />
        </PageSidebarRailButton>
      )}
    </div>
  );
}

const pageSidebarBodyVariants = cva(
  "flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto",
  {
    variants: {
      joined: { true: "px-3 pt-0.5 pb-3", false: "p-3" },
    },
    defaultVariants: { joined: false },
  }
);

/** What the open sidebar holds under its top row; it scrolls on its own. */
function PageSidebarBody({
  joined = false,
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
} & VariantProps<typeof pageSidebarBodyVariants>) {
  return (
    <div
      data-slot="page-sidebar-body"
      className={cn(pageSidebarBodyVariants({ joined }), className)}
    >
      {children}
    </div>
  );
}

/** The rail's first button: open the sidebar again. */
function PageSidebarRailExpand({
  label,
  onExpand,
  className,
}: {
  label: string;
  onExpand: () => void;
  className?: string;
}) {
  return (
    <PageSidebarRailButton
      className={className}
      label={label}
      onClick={onExpand}
    >
      <PanelLeftOpenIcon />
    </PageSidebarRailButton>
  );
}

/** A short line between groups in the rail. */
function PageSidebarRailDivider({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-slot="page-sidebar-rail-divider"
      className={cn("bg-border my-1.5 h-px w-6", className)}
    />
  );
}

export {
  PageSidebar,
  PageSidebarBody,
  PageSidebarRailButton,
  PageSidebarRailDivider,
  PageSidebarRailExpand,
  PageSidebarTop,
};
