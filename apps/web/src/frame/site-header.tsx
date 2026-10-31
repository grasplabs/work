import { SiteHeader as SiteHeaderBar } from "@grasp-os/ui/components/site-header";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
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
        | "/knowledge"
        | "/domains"
        | "/apps"
        | "/workflows"
        | "/integrations"
        | "/landscape"
        | "/policies";
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
  | { label: string; to: "/domains/$engine"; params: { engine: string } }
  | {
      label: string;
      to: "/projects/$projectId";
      params: { projectId: string };
    }
  | {
      label: string;
      to: "/landscape/$appId/overview";
      params: { appId: string };
    }
  | {
      label: string;
      to: "/landscape/$appId/usage";
      params: { appId: string };
    }
  | {
      label: string;
      to: "/knowledge/$collection";
      params: { collection: string };
    }
  | {
      label: string;
      to: "/workflows/$app/$workflow";
      params: { app: string; workflow: string };
    };

/** Where a crumb leads, as a link. */
const crumbLink = (crumb: Extract<Crumb, { to: string }>) => {
  // A place on the brain's atlas: a region, a folder in it, a note there.
  if ("search" in crumb) {
    return <Link search={crumb.search} to="/brain" />;
  }
  if (!("params" in crumb)) {
    return <Link to={crumb.to} />;
  }
  if (crumb.to === "/workflows/$app/$workflow") {
    return <Link params={crumb.params} to="/workflows/$app/$workflow" />;
  }
  if (crumb.to === "/brain/$noteId") {
    return <Link params={crumb.params} to="/brain/$noteId" />;
  }
  if (crumb.to === "/brain/sections/$sectionId") {
    return <Link params={crumb.params} to="/brain/sections/$sectionId" />;
  }
  if (crumb.to === "/projects/$projectId") {
    return <Link params={crumb.params} to="/projects/$projectId" />;
  }
  if (crumb.to === "/landscape/$appId/overview") {
    return <Link params={crumb.params} to="/landscape/$appId/overview" />;
  }
  if (crumb.to === "/landscape/$appId/usage") {
    return <Link params={crumb.params} to="/landscape/$appId/usage" />;
  }
  return crumb.to === "/domains/$engine" ? (
    <Link params={crumb.params} to="/domains/$engine" />
  ) : (
    <Link params={crumb.params} search={{}} to="/knowledge/$collection" />
  );
};

/**
 * The bar above every signed-in page (`SiteHeader` in the kit, the same
 * as the admin's): the sidebar's trigger, then where the page is, and on
 * the right any page action. `phoneCrumbs` says which crumbs a phone
 * keeps (the kit's `phoneCrumbs`).
 */
export const SiteHeader = ({
  crumbs,
  actions,
  phoneCrumbs,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  phoneCrumbs?: "last-two" | "first";
}) => {
  const { t } = useLingui();
  return (
    <SiteHeaderBar
      actions={actions}
      phoneCrumbs={phoneCrumbs}
      breadcrumbLabel={t`Breadcrumb`}
      crumbs={crumbs.map((crumb) =>
        "to" in crumb
          ? { label: crumb.label, link: crumbLink(crumb) }
          : { label: crumb.label }
      )}
      triggerLabel={t`Show or hide the sidebar`}
    />
  );
};
