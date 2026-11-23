import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import { SidebarTrigger, useSidebar } from "@grasp-os/ui/components/sidebar";
import { colors, media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import type { ReactNode } from "react";

import type { RegionId } from "../brain/brain-atlas.ts";

/** A step on the way to the page; the last one is the page itself. */
export type Crumb =
  | { label: string }
  | {
      label: string;
      to:
        | "/"
        | "/brain"
        | "/projects"
        | "/apps"
        | "/workflows"
        | "/agents"
        | "/integrations";
    }
  | {
      label: string;
      to: "/brain";
      search: { region?: RegionId; group?: string; note?: string };
    }
  | { label: string; to: "/brain/$noteId"; params: { noteId: string } }
  | {
      label: string;
      to: "/brain/sections/$sectionId";
      params: { sectionId: string };
    }
  | { label: string; to: "/apps/$app"; params: { app: string } }
  | {
      label: string;
      to: "/projects/$projectId";
      params: { projectId: string };
    }
  | {
      label: string;
      to: "/workflows/$workflow";
      params: { workflow: string };
    };

/** Where a crumb leads, as a router link holding its name. */
const CrumbLink = ({ crumb }: { crumb: Extract<Crumb, { to: string }> }) => {
  const { label } = crumb;
  // A place on the brain's atlas: a region, a folder in it, a note there.
  if ("search" in crumb) {
    return (
      <Link search={crumb.search} to="/brain">
        {label}
      </Link>
    );
  }
  if (!("params" in crumb)) {
    return <Link to={crumb.to}>{label}</Link>;
  }
  if (crumb.to === "/workflows/$workflow") {
    return (
      <Link params={crumb.params} to="/workflows/$workflow">
        {label}
      </Link>
    );
  }
  if (crumb.to === "/projects/$projectId") {
    return (
      <Link params={crumb.params} to="/projects/$projectId">
        {label}
      </Link>
    );
  }
  if (crumb.to === "/brain/$noteId") {
    return (
      <Link params={crumb.params} to="/brain/$noteId">
        {label}
      </Link>
    );
  }
  if (crumb.to === "/brain/sections/$sectionId") {
    return (
      <Link params={crumb.params} to="/brain/sections/$sectionId">
        {label}
      </Link>
    );
  }
  return (
    <Link params={crumb.params} to="/apps/$app">
      {label}
    </Link>
  );
};

const styles = stylex.create({
  // One row the shell's bar height, across the page's card from edge to
  // edge, at the top of the page, which scrolls under it: on the card's
  // own ground (Damsko's SidebarInset: the page's ground under the lg
  // breakpoint, the sidebar's card from it), with a hairline at its foot.
  bar: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 20,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    minWidth: 0,
    height: size.appShellBar,
    paddingInline: size.appShellPageInline,
    backgroundColor: {
      default: colors.background,
      [media.lg]: colors.sidebarCard,
    },
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    borderBlockEndColor: colors.border,
  },
  // Where the page is, then where its subject stands: they give way to the
  // actions, never the other way round.
  where: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    gap: space["2"],
    minWidth: 0,
    overflow: "hidden",
  },
  trailing: { display: "flex", flexShrink: 0, alignItems: "center" },
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    marginInlineStart: "auto",
  },
});

/**
 * The bar above every signed-in page, the one way a page heads itself, so
 * the frame changes every page's bar here: Damsko's SidebarTrigger at its
 * start while the sidebar is away (folded, or a sheet on a narrow window;
 * otherwise the sidebar's head holds it), then where the page is (Damsko's
 * Breadcrumb, which under 640px keeps only the step back; its steps parted
 * by a slash, as the product's bar has them), with where its
 * subject stands after it (`trailing`), and at its end the page's actions.
 * It is app-shell-01's header, drawn by the page: the block draws its own
 * and the page's title from props, which a page here can't give it
 * (damsko-registry-gaps, 2026-11-23, frame).
 */
export const SiteHeader = ({
  crumbs,
  actions,
  trailing,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  trailing?: ReactNode;
}) => {
  const { t } = useLingui();
  const { state, isMobile } = useSidebar();
  const away = isMobile || state === "collapsed";
  const last = crumbs.length - 1;
  return (
    <header data-slot="site-header" {...stylex.props(styles.bar)}>
      {away ? (
        <SidebarTrigger aria-label={t`Show or hide the sidebar`} />
      ) : null}
      <div {...stylex.props(styles.where)}>
        <Breadcrumb aria-label={t`Breadcrumb`}>
          <BreadcrumbList>
            {crumbs.map((crumb, index) => (
              // A path's steps don't move: each stands at its own place.
              <Fragment key={index}>
                {index === 0 ? null : (
                  <BreadcrumbSeparator>/</BreadcrumbSeparator>
                )}
                <BreadcrumbItem>
                  {index !== last && "to" in crumb ? (
                    <BreadcrumbLink asChild>
                      <CrumbLink crumb={crumb} />
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
        {trailing === undefined ? null : (
          <div {...stylex.props(styles.trailing)}>{trailing}</div>
        )}
      </div>
      {actions === undefined ? null : (
        <div {...stylex.props(styles.actions)}>{actions}</div>
      )}
    </header>
  );
};
