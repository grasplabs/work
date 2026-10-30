// Not in shadcn: something to open, as the brand shows the product
// (grasplabs/prototype `components/apps/apps-overview.tsx`): a white
// sheet on a painted field, running off the field's foot and lifting a
// little when pointed at, then its title, which opens it, and a line or
// two under it. The sheet is a picture of what opens, hidden from screen
// readers: the title and the lines say it. `TileTitle`'s `render` makes
// the title the page's link; it stretches over the whole tile.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { PaintedField } from "@grasp-os/ui/components/painted-field";
import type { Painting, Pattern } from "@grasp-os/ui/components/painted-field";
import { cn } from "@grasp-os/ui/lib/utils";
import type * as React from "react";

function Tile({
  className,
  render,
  ...props
}: useRender.ComponentProps<"article">) {
  return useRender({
    defaultTagName: "article",
    props: mergeProps<"article">(
      {
        className: cn(
          "group/tile relative flex min-w-0 flex-col gap-3.5",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "tile" },
  });
}

/** The painted field the sheet lies on; a badge in it sits top left. */
function TileField({
  painting,
  pattern,
  className,
  ...props
}: React.ComponentProps<"div"> & { painting: Painting; pattern: Pattern }) {
  return (
    <PaintedField
      data-slot="tile-field"
      painting={painting}
      pattern={pattern}
      className={cn(
        "relative aspect-video rounded-xl px-6 pt-6 *:data-[slot=badge]:absolute *:data-[slot=badge]:top-3 *:data-[slot=badge]:left-3",
        className
      )}
      {...props}
    />
  );
}

/** The white sheet on the field: a picture of what opens. */
function TileSheet({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="tile-sheet"
      className={cn(
        "bg-background shadow-lifted flex h-full flex-col overflow-hidden rounded-t-lg transition-transform motion-safe:group-hover/tile:-translate-y-1",
        className
      )}
      {...props}
    />
  );
}

/** The bar along the sheet's top: an icon on a grey tile, then a name. */
function TileSheetBar({
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { icon: React.ReactNode }) {
  return (
    <div
      data-slot="tile-sheet-bar"
      className={cn(
        "flex min-w-0 items-center gap-2 border-b px-3 py-2 text-xs font-medium",
        className
      )}
      {...props}
    >
      <span className="bg-muted text-foreground inline-flex size-5 flex-none items-center justify-center rounded-md [&_svg]:size-3">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </div>
  );
}

/** The words under the field. */
function TileContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="tile-content"
      className={cn("flex min-w-0 flex-col gap-1 px-0.5", className)}
      {...props}
    />
  );
}

/** The title, which opens what the tile is: its press area is the whole tile. */
function TileTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"a">) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(
      {
        className: cn(
          "focus-visible:after:ring-ring/50 truncate font-medium outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "tile-title" },
  });
}

/** What it is for, in at most two lines. */
function TileDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="tile-description"
      className={cn(
        "text-muted-foreground line-clamp-2 text-sm text-pretty",
        className
      )}
      {...props}
    />
  );
}

/** A quiet last line, such as where it belongs. */
function TileMeta({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="tile-meta"
      className={cn(
        "text-muted-foreground mt-1 flex min-w-0 items-center gap-1.5 text-xs [&_svg]:size-3.5 [&_svg]:flex-none",
        className
      )}
      {...props}
    />
  );
}

export {
  Tile,
  TileContent,
  TileDescription,
  TileField,
  TileMeta,
  TileSheet,
  TileSheetBar,
  TileTitle,
};
