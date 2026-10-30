// Layout primitive, not in shadcn: a page's title, what it is for and its
// actions, as the prototype's components/page.tsx lays them out. The title
// keeps a width of its own, so actions beside it go to the next line rather
// than squeezing it.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";

function PageHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
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
          "font-serif text-3xl leading-tight font-light tracking-tight text-balance outline-none",
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
      className={cn("ml-auto flex items-center gap-2", className)}
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
