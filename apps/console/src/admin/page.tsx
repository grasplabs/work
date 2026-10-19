/**
 * An admin page in its frame, as the prototype lays one out
 * (`components/site-header.tsx` and `components/page.tsx`): the bar above
 * it, with the sidebar's trigger and where the page is, then its title.
 * The pages after the overview have only their title until they are ported.
 */
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
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * The bar above an admin page: the sidebar's trigger, then the admin and,
 * below its overview, the page. It stays in view while the page scrolls.
 */
const AdminHeader = ({ page }: { page: string | null }) => (
  <header className="bg-background sticky top-0 z-30 flex h-(--header-height) shrink-0 items-center border-b">
    {/* A square of its own, so the line beside it continues a column's edge. */}
    <div className="flex h-full w-12 flex-none items-center justify-center">
      <SidebarTrigger label="Show or hide the sidebar" />
    </div>
    <Separator
      className="-ml-px h-4 data-vertical:self-auto"
      orientation="vertical"
    />
    <div className="flex min-w-0 flex-1 items-center gap-1 px-4 lg:gap-2 lg:pr-6">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          {page === null ? (
            <BreadcrumbItem className="min-w-8">
              <BreadcrumbPage>Admin</BreadcrumbPage>
            </BreadcrumbItem>
          ) : (
            <>
              <BreadcrumbItem className="flex-none">
                <BreadcrumbLink render={<Link to="/admin" />}>
                  Admin
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-8">
                <BreadcrumbPage>{page}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  </header>
);

/**
 * An admin page titled `title`: the overview when `overview` (as wide as
 * the prototype's, for its table), otherwise a page under it, with
 * `children` below its title.
 */
export const AdminPage = ({
  title,
  overview = false,
  children,
}: {
  title: string;
  overview?: boolean;
  children?: ReactNode;
}) => (
  <>
    <AdminHeader page={overview ? null : title} />
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 px-6 pt-7 pb-6",
        overview ? "max-w-7xl" : "max-w-5xl"
      )}
    >
      <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
      {children}
    </div>
  </>
);
