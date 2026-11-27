/**
 * An admin page in its frame, as Grasp Work heads one: Damsko's
 * AppShellHeader (the fold while the sidebar is away, where the page is,
 * its actions), then the page body (AppShellPage) and Damsko's PageHeader.
 */
import {
  AppShellHeader,
  AppShellPage,
} from "@grasp-os/ui/blocks/app-shell-01/app-shell-01";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** A page above this one in the bar: its name, and where it is. */
export interface Crumb {
  label: string;
  to: "/" | "/platform" | "/platform/releases";
}

const noParents: readonly Crumb[] = [];

/**
 * The bar above an admin page: the pages above it (`parents`) and the
 * page. With `page` undefined, the page is still loading; null for Home,
 * whose bar names it alone.
 */
export const AdminHeader = ({
  page,
  parents = noParents,
  actions,
}: {
  page: string | null | undefined;
  parents?: readonly Crumb[];
  actions?: ReactNode;
}) => (
  <AppShellHeader
    actions={actions}
    breadcrumb={
      page === undefined
        ? undefined
        : parents.map((parent) => ({
            label: parent.label,
            render: <Link to={parent.to} />,
          }))
    }
    title={page === null ? "Home" : page}
  />
);

/**
 * An admin page titled `title`, with what it is for under it when there is
 * a `description` and its `action` on the right when it has one.
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
    <AppShellPage>
      <PageHeader
        actions={action}
        description={description === "" ? undefined : description}
        title={title}
      />
      {children}
    </AppShellPage>
  </>
);
