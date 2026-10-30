// Layout primitive, not in shadcn: a part of a page on a card of its own,
// as the prototype's components/settings.tsx (`SettingsSection`) draws
// one. Its header holds its title, a line on what it holds and, beside
// them, what can be done there; where there is no room beside them, that
// goes under the title, so the line under it keeps its width. Under the
// header, its rows or its body, each under a line.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cn } from "@grasp-os/ui/lib/utils";

function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="panel"
      className={cn(
        "bg-card overflow-hidden rounded-xl border text-sm",
        className
      )}
      {...props}
    />
  );
}

function PanelHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-5 py-4",
        className
      )}
      {...props}
    />
  );
}

/** The title and the line under it, keeping a width of their own beside the panel's action. */
function PanelHeading({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-heading"
      className={cn("flex min-w-0 flex-1 basis-56 flex-col gap-0.5", className)}
      {...props}
    />
  );
}

/** The panel's title: an `h2` under the page's own; `render` makes it another heading. */
function PanelTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"h2">) {
  return useRender({
    defaultTagName: "h2",
    props: mergeProps<"h2">({ className: cn("font-medium", className) }, props),
    render,
    state: { slot: "panel-title" },
  });
}

function PanelDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

/** What fills a panel below its header: a form, a list or a few lines, under a line. */
function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-body"
      className={cn("flex flex-col gap-4 border-t px-5 py-4", className)}
      {...props}
    />
  );
}

/** One row: what it is and why on the left, its control or where it stands on the right. */
function PanelRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-row"
      className={cn(
        "flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8",
        className
      )}
      {...props}
    />
  );
}

/** A row's label and the line under it. */
function PanelRowLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-row-label"
      className={cn("flex min-w-0 flex-col gap-0.5", className)}
      {...props}
    />
  );
}

/** A row's control, on the right from `sm` up. */
function PanelRowControl({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-row-control"
      className={cn("flex flex-none sm:w-64 sm:justify-end", className)}
      {...props}
    />
  );
}

export {
  Panel,
  PanelBody,
  PanelDescription,
  PanelHeader,
  PanelHeading,
  PanelRow,
  PanelRowControl,
  PanelRowLabel,
  PanelTitle,
};
