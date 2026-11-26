import { PageHeader } from "@grasp-os/ui/components/page-header";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { PageBar } from "../frame/page-bar.tsx";
import type { Crumb as BarCrumb, CrumbLook } from "../frame/page-bar.tsx";
/**
 * An admin page in its frame, as Grasp Work heads one: the frame's bar
 * (PageBar: the fold while the sidebar is away, where the page is, its
 * actions), then the page body (Page) and Damsko's PageHeader.
 */
import { Page } from "../frame/page.tsx";

/** A page above this one in the bar: its name, and where it is. */
export interface Crumb {
  label: string;
  to: "/" | "/platform" | "/platform/releases";
}

const noParents: readonly Crumb[] = [];

export const barLabels = {
  breadcrumb: "Breadcrumb",
  sidebar: "Show or hide the sidebar",
};

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
}) => {
  let crumbs: BarCrumb[] = [];
  if (page === null) {
    crumbs = [{ label: "Home" }];
  } else if (page !== undefined) {
    crumbs = [
      ...parents.map((parent) => ({
        label: parent.label,
        render: (look: CrumbLook) => <Link {...look} to={parent.to} />,
      })),
      { label: page },
    ];
  }
  return <PageBar actions={actions} crumbs={crumbs} labels={barLabels} />;
};

/** The page body: as wide as the card, 24px in, as every Grasp Work page. */
export const PageBody = ({ children }: { children: ReactNode }) => (
  <Page>{children}</Page>
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
    <PageBody>
      <PageHeader
        actions={action}
        description={description === "" ? undefined : description}
        title={title}
      />
      {children}
    </PageBody>
  </>
);
