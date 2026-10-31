// Layout primitive, not in shadcn: a page's title, what it is for and its
// actions, as the prototype's components/page.tsx lays them out. The title
// keeps a width of its own, so actions beside it go to the next line rather
// than squeezing it.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";

function PageHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="page-header"
      className={cn("flex min-w-0 flex-wrap items-end gap-3", className)}
      {...props}
    />
  );
}

function PageHeaderContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header-content"
      className={cn("flex min-w-0 flex-1 basis-64 flex-col gap-1", className)}
      {...props}
    />
  );
}

/**
 * A page's own title, in the serif: the one place a page's name is set
 * large. `render` makes it another heading, such as the `h2` of a record
 * that stands as a page's subject. A page may focus its title for a
 * screen reader (`tabIndex={-1}`); a title is never a control, so it shows
 * no ring for it.
 */
function PageHeaderTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"h1">) {
  return useRender({
    defaultTagName: "h1",
    props: mergeProps<"h1">(
      {
        className: cn(
          // The prototype's `type-title`: 28px on a 1.15 line, set tight.
          "font-serif text-[1.75rem] leading-[1.15] font-light tracking-[-0.022em] text-balance outline-none",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "page-header-title" },
  });
}

const pageHeaderDescriptionVariants = cva(
  "text-muted-foreground text-sm text-pretty",
  {
    variants: {
      /** `two`: at most two lines, for a description someone wrote, such as a project's. */
      lines: {
        all: "",
        two: "line-clamp-2",
      },
    },
    defaultVariants: {
      lines: "all",
    },
  }
);

function PageHeaderDescription({
  className,
  lines = "all",
  ...props
}: React.ComponentProps<"p"> &
  VariantProps<typeof pageHeaderDescriptionVariants>) {
  return (
    <p
      data-slot="page-header-description"
      data-lines={lines}
      className={cn(pageHeaderDescriptionVariants({ lines }), className)}
      {...props}
    />
  );
}

/** Small marks under the title, such as a status badge. */
function PageHeaderMeta({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header-meta"
      className={cn("mt-1 flex flex-wrap items-center gap-1.5", className)}
      {...props}
    />
  );
}

function PageHeaderActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-header-actions"
      className={cn(
        "ml-auto flex shrink-0 flex-wrap items-center gap-2",
        className
      )}
      {...props}
    />
  );
}

export {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderTitle,
};
