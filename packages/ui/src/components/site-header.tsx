// Layout primitive, not in shadcn: the bar above a page in a frame with
// a sidebar, from the prototype's components/site-header.tsx. The
// sidebar's trigger in a square of its own, as wide as a page sidebar's
// rail, so the line beside it continues that sidebar's edge; then where
// the page is; on the right, the page's actions. It stays in view while
// the page scrolls, and keeps to one line whatever the window: on a
// narrow one only the step before the page is kept. With no crumbs yet
// (the page is loading), a skeleton where they will be.
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import { Separator } from "@grasp-os/ui/components/separator";
import { SidebarTrigger } from "@grasp-os/ui/components/sidebar";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { cn } from "@grasp-os/ui/lib/utils";
import { Fragment } from "react";
import type { ReactElement, ReactNode } from "react";

/**
 * A step on the way to the page: its name and, where it leads somewhere,
 * the link it renders as (a router's `<Link>`). The last one is the page
 * itself, usually without a link.
 */
interface SiteCrumb {
  label: string;
  link?: ReactElement;
}

function SiteHeader({
  crumbs,
  triggerLabel,
  breadcrumbLabel,
  actions,
}: {
  crumbs: readonly SiteCrumb[];
  /** What the sidebar's trigger says to a screen reader, translated by the page. */
  triggerLabel: string;
  /** The breadcrumb's name, translated by the page. */
  breadcrumbLabel?: string;
  actions?: ReactNode;
}) {
  const last = crumbs.length - 1;
  return (
    <header
      data-slot="site-header"
      className="bg-background sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b"
    >
      <div className="flex h-full w-12 flex-none items-center justify-center">
        <SidebarTrigger label={triggerLabel} />
      </div>
      <Separator
        className="-ml-px h-4 data-vertical:self-auto"
        orientation="vertical"
      />
      <div className="flex min-w-0 flex-1 items-center gap-1 px-4 lg:gap-2 lg:pr-6">
        {crumbs.length === 0 ? (
          <Skeleton className="h-4 w-32" />
        ) : (
          <Breadcrumb aria-label={breadcrumbLabel} className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {crumbs.map((crumb, index) => (
                <Fragment key={`${index}:${crumb.label}`}>
                  {index > 0 ? (
                    <BreadcrumbSeparator
                      className={cn(index < last && "max-md:hidden")}
                    />
                  ) : null}
                  <BreadcrumbItem
                    className={cn(
                      index === last ? "min-w-8" : "flex-none",
                      index < last - 1 && "max-md:hidden"
                    )}
                  >
                    {crumb.link === undefined ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink render={crumb.link}>
                        {crumb.label}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        )}
        {actions === undefined ? null : (
          <div className="ml-auto flex flex-none items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

export { SiteHeader };
export type { SiteCrumb };
