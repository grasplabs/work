// Layout primitive, not in shadcn: a page's title, what it is for and its
// actions. The actions move under the title on a phone.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";

function PageHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
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
      className={cn("flex min-w-0 flex-col gap-1", className)}
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

function PageHeaderDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="page-header-description"
      className={cn("text-muted-foreground text-sm text-pretty", className)}
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
      className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

export {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
};
