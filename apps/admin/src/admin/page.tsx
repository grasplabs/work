/**
 * An admin page in its frame, as the workspace lays one out
 * (apps/web/src/frame/page.tsx, from the prototype's
 * `components/site-header.tsx` and `components/page.tsx`): a bar above
 * it with the sidebar's trigger and where the page is, then its heading,
 * Damsko's PageHeader. The bar is app-shell-01's header, drawn by the
 * page, as each page says where it is itself.
 */
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import { breadcrumbVars } from "@grasp-os/ui/components/breadcrumb.stylex";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SidebarTrigger } from "@grasp-os/ui/components/sidebar";
import { colors, media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import type { ReactNode } from "react";

/** A page above this one in the bar: its name, and where it is. */
export interface Crumb {
  label: string;
  to: "/" | "/platform" | "/platform/releases";
}

const noParents: readonly Crumb[] = [];

/** The admin's own overview, first in every page's bar. */
const adminCrumb: Crumb = { label: "Admin", to: "/" };

const styles = stylex.create({
  // One row the shell's bar height across the page's card, at the top of
  // the page, which scrolls under it, as app-shell-01's header: its path
  // in the sidebar's inks, a hairline at its foot.
  bar: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 20,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    height: size.appShellBar,
    paddingInline: space["3"],
    backgroundColor: colors.sidebarCard,
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: {
      default: colors.sidebarCardBorder,
      [media.forcedColors]: "CanvasText",
    },
    [breadcrumbVars.foreground]: colors.sidebarForeground,
    [breadcrumbVars.mutedForeground]: colors.sidebarSecondaryForeground,
    [breadcrumbVars.subtleForeground]: colors.sidebarTertiaryForeground,
  },
  where: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    minWidth: 0,
    overflowX: "clip",
  },
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    marginInlineStart: "auto",
  },
  // The page body: centred, with the workspace's room around it, one width
  // for every page of the admin.
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space["6"],
    boxSizing: "border-box",
    width: "100%",
    maxWidth: "72rem",
    marginInline: "auto",
    paddingInline: space["6"],
    paddingBlockStart: space["7"],
    paddingBlockEnd: space["6"],
  },
});

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
  let steps: readonly Crumb[] = [];
  let current: string | undefined;
  if (page === null) {
    current = adminCrumb.label;
  } else if (page !== undefined) {
    steps = [adminCrumb, ...parents];
    current = page;
  }
  return (
    <header {...stylex.props(styles.bar)}>
      <SidebarTrigger />
      <div {...stylex.props(styles.where)}>
        {current === undefined ? null : (
          <Breadcrumb>
            <BreadcrumbList>
              {steps.map((step) => (
                <Fragment key={step.to}>
                  <BreadcrumbItem>
                    <BreadcrumbLink asChild>
                      {/* Only the page is current, never the steps above it. */}
                      <Link activeOptions={{ exact: true }} to={step.to}>
                        {step.label}
                      </Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                </Fragment>
              ))}
              <BreadcrumbItem>
                <BreadcrumbPage>{current}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        )}
      </div>
      {actions === undefined ? null : (
        <div {...stylex.props(styles.actions)}>{actions}</div>
      )}
    </header>
  );
};

/**
 * The page body: centred, with the workspace's room around it, and one
 * width for every page of the admin, so going from one to the next never
 * moves where the page starts. What should stay narrower than the page (a
 * form, a line of text) holds its own measure inside it.
 */
export const PageBody = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.body)}>{children}</div>
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
