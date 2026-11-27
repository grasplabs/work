import { AppShellHeader } from "@grasp-os/ui/blocks/app-shell-01/app-shell-01";
import { Link } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";

import type { RegionId } from "../brain/brain-atlas.ts";

/** A step on the way to the page; the last one is the page itself. */
export type Crumb =
  | {
      label: string;
      /**
       * The page's own name only: renamed in a small popup under it
       * (AppShellHeader's rename). A promise holds the
       * popup open while it works, and open with the words typed if it
       * rejects, saying `renameErrorText`.
       */
      onRename?: (name: string) => unknown;
      /** The most a new name may hold. */
      renameMaxLength?: number;
      /** Said under the field when the rename fails. */
      renameErrorText?: string;
      /** Whether its rename is open, when a menu's Rename opens it. */
      renaming?: boolean;
      onRenamingChange?: (renaming: boolean) => void;
    }
  | {
      label: string;
      to:
        | "/"
        | "/brain"
        | "/projects"
        | "/apps"
        | "/workflows"
        | "/agents"
        | "/connectors";
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

/** Where a crumb leads, as a router link: the bar gives it its look and words. */
const crumbLink = (
  crumb: Extract<Crumb, { to: string }>
): ReactElement<Record<string, unknown>> => {
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
  return <Link params={crumb.params} to="/apps/$app" />;
};

/**
 * The bar above every signed-in page, the one way a page heads itself:
 * Damsko's AppShellHeader, with the page's crumbs (the last is the page
 * itself, renamed in a small popup where it may be), where its subject
 * stands after them (`trailing`), and at its end the page's actions.
 */
export const SiteHeader = ({
  crumbs,
  actions,
  trailing,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  /**
   * Where its subject stands, an item of the row after the crumbs: one
   * that gives way where the bar is narrow takes no room, nor the gap
   * before it, once it has (`display: none`), so the crumbs keep it.
   */
  trailing?: ReactNode;
}) => {
  const page = crumbs.at(-1);
  const rename =
    page !== undefined && "onRename" in page && page.onRename !== undefined
      ? {
          onRename: page.onRename,
          ...(page.renameMaxLength === undefined
            ? {}
            : { renameMaxLength: page.renameMaxLength }),
          ...(page.renameErrorText === undefined
            ? {}
            : { renameErrorText: page.renameErrorText }),
          ...(page.renaming === undefined ? {} : { renaming: page.renaming }),
          ...(page.onRenamingChange === undefined
            ? {}
            : { onRenamingChange: page.onRenamingChange }),
        }
      : {};
  return (
    <AppShellHeader
      actions={actions}
      breadcrumb={crumbs
        .slice(0, -1)
        .map((crumb) =>
          "to" in crumb
            ? { label: crumb.label, render: crumbLink(crumb) }
            : { label: crumb.label }
        )}
      title={page?.label}
      trailing={trailing}
      {...rename}
    />
  );
};
