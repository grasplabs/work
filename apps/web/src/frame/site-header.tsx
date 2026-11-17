import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import type { RegionId } from "../brain/brain-atlas.ts";
import { AppShellBar } from "../grasp/app-shell/index.ts";
import { useFrameBanner } from "./frame-banner.ts";

/** A step on the way to the page; the last one is the page itself. */
export type Crumb =
  | { label: string }
  | {
      label: string;
      to:
        | "/"
        | "/brain"
        | "/projects"
        | "/knowledge"
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
      to: "/knowledge/$collection";
      params: { collection: string };
    }
  | {
      label: string;
      to: "/workflows/$workflow";
      params: { workflow: string };
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
  if (crumb.to === "/workflows/$workflow") {
    return <Link params={crumb.params} to="/workflows/$workflow" />;
  }
  if (crumb.to === "/projects/$projectId") {
    return <Link params={crumb.params} to="/projects/$projectId" />;
  }
  if (crumb.to === "/brain/$noteId") {
    return <Link params={crumb.params} to="/brain/$noteId" />;
  }
  if (crumb.to === "/brain/sections/$sectionId") {
    return <Link params={crumb.params} to="/brain/sections/$sectionId" />;
  }
  return crumb.to === "/apps/$app" ? (
    <Link params={crumb.params} to="/apps/$app" />
  ) : (
    <Link params={crumb.params} search={{}} to="/knowledge/$collection" />
  );
};

/**
 * The bar above every signed-in page, Grasp UI's page bar (AppShellBar):
 * where the page is, with where its subject stands after it (`trailing`),
 * and at its end any page action. App shell puts the menu's button before
 * it on a phone, and the sidebar's way back when it is folded.
 * `phoneCrumbs` says which crumbs a phone keeps.
 */
export const SiteHeader = ({
  crumbs,
  actions,
  trailing,
  phoneCrumbs,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  trailing?: ReactNode;
  phoneCrumbs?: "last-two" | "first";
}) => {
  const { t } = useLingui();
  const banner = useFrameBanner();
  return (
    <>
      <AppShellBar
        actions={actions}
        breadcrumbLabel={t`Breadcrumb`}
        crumbs={crumbs.map((crumb) =>
          "to" in crumb
            ? { label: crumb.label, render: crumbLink(crumb) }
            : { label: crumb.label }
        )}
        phoneCrumbs={phoneCrumbs}
        trailing={trailing}
      />
      {banner}
    </>
  );
};
