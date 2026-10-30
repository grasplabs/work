/**
 * An admin page in its frame, as the workspace lays one out
 * (apps/web/src/frame/page.tsx, from the prototype's
 * `components/site-header.tsx` and `components/page.tsx`): the kit's
 * site header above it, with the sidebar's trigger and where the page
 * is, then its heading from the kit's page header.
 */
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { SiteHeader } from "@grasp-os/ui/components/site-header";
import type { SiteCrumb } from "@grasp-os/ui/components/site-header";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";

/** A page above this one in the bar: its name, and a link to it to render as. */
export interface Crumb {
  label: string;
  link: ReactElement;
}

const noParents: readonly Crumb[] = [];

/** The admin's own overview, first in every page's bar. */
const adminCrumb: SiteCrumb = { label: "Admin", link: <Link to="/" /> };

/**
 * The bar above an admin page: the sidebar's trigger, then the admin and,
 * below its overview, the pages above it (`parents`) and the page. With
 * `page` undefined, the page is still loading. It stays in view while the
 * page scrolls.
 */
export const AdminHeader = ({
  page,
  parents = noParents,
  actions,
}: {
  page: string | null | undefined;
  parents?: readonly Crumb[];
  /** The page's actions, on the right of the bar. */
  actions?: ReactNode;
}) => {
  let crumbs: readonly SiteCrumb[] = [];
  if (page === null) {
    crumbs = [{ label: "Admin" }];
  } else if (page !== undefined) {
    crumbs = [adminCrumb, ...parents, { label: page }];
  }
  return (
    <SiteHeader
      actions={actions}
      breadcrumbLabel="Breadcrumb"
      crumbs={crumbs}
      triggerLabel="Show or hide the sidebar"
    />
  );
};

/** A page's title, with what it is for under it when there is a `description`, and `children` under that. */
export const PageHeading = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) => (
  <PageHeaderContent>
    <PageHeaderTitle>{title}</PageHeaderTitle>
    {description === undefined || description === "" ? null : (
      <PageHeaderDescription>{description}</PageHeaderDescription>
    )}
    {children}
  </PageHeaderContent>
);

/**
 * The page body: centred, with the workspace's room around it, as wide as
 * the prototype's overview when `wide`, for its table.
 */
export const PageBody = ({
  wide = false,
  children,
}: {
  wide?: boolean;
  children: ReactNode;
}) => (
  <div
    className={cn(
      "mx-auto flex w-full flex-col gap-6 px-6 pt-7 pb-6 text-sm",
      wide ? "max-w-7xl" : "max-w-5xl"
    )}
  >
    {children}
  </div>
);

/**
 * An admin page titled `title`, with what it is for under it when there is
 * a `description` and its `action` on the right when it has one: the
 * overview when `overview`, otherwise a page under it, below the pages in
 * `parents`, with `children` below its title.
 */
export const AdminPage = ({
  title,
  description,
  action,
  overview = false,
  parents,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  overview?: boolean;
  parents?: readonly Crumb[];
  children?: ReactNode;
}) => (
  <>
    <AdminHeader page={overview ? null : title} parents={parents} />
    <PageBody wide={overview}>
      <PageHeader>
        <PageHeading description={description} title={title} />
        {action === undefined ? null : (
          <PageHeaderActions>{action}</PageHeaderActions>
        )}
      </PageHeader>
      {children}
    </PageBody>
  </>
);
