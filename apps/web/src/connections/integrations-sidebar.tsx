import { catalogGroups } from "@grasp-os/shared/connect-names";
import type { CatalogGroup } from "@grasp-os/shared/connect-names";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation, useMatch } from "@tanstack/react-router";
import { useState } from "react";

import { formatNumber } from "../format.ts";
import {
  AgentPerson,
  AppWindow,
  Cable,
  Chat,
  Checklist,
  Code,
  Database,
  Edit,
  File,
  Image,
  Mail,
  Money,
  People,
  Question,
  Sparkles,
  Tag,
  Tasks,
  TrendUp,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import type { SidebarSection } from "../grasp/sidebar/index.ts";
import { groupLabel } from "./groups.ts";

// Integrations as the sidebar's section while the person is in it, as
// Settings and the Brain are (grasp/frame/grasp-sidebar.tsx): its name
// opens the overview, Back returns to the page they came from, and each
// kind of app is a row that opens that kind whole on the overview
// (`?group=`), with how many apps it holds once the catalog is read.

/** Each kind of app's icon, as its row shows it. */
const kindIcons: Readonly<Record<CatalogGroup, IconData>> = {
  "Email and calendar": Mail,
  "Files and documents": File,
  Chat,
  CRM: People,
  "Finance and accounting": Money,
  HR: AgentPerson,
  Signing: Edit,
  Marketing: TrendUp,
  Support: Question,
  "Projects and tasks": Tasks,
  "Forms and surveys": Checklist,
  "Data and analytics": Database,
  AI: Sparkles,
  Commerce: Tag,
  "Design and media": Image,
  "Developer tools": Code,
  Other: AppWindow,
};

/** The last page outside Integrations, to go back to. */
interface Outside {
  pathname: string;
  search: Record<string, unknown>;
}

/** Integrations' kinds of app, as the sidebar's section; undefined outside Integrations. */
export const useIntegrationsSection = (): SidebarSection | undefined => {
  const { t, i18n } = useLingui();
  const { pathname, search } = useLocation();
  const overview = useMatch({
    from: "/_shell/integrations/",
    shouldThrow: false,
  });
  const [outside, setOutside] = useState<Outside>();
  const inIntegrations =
    pathname === "/integrations" || pathname.startsWith("/integrations/");
  if (!inIntegrations && outside?.pathname !== pathname) {
    setOutside({ pathname, search });
  }
  if (!inIntegrations) {
    return undefined;
  }
  const catalog = overview?.loaderData?.catalog;
  const entries = catalog?.state === "ready" ? catalog.data.entries : [];
  const chosen = overview?.search.group;
  const counts = new Map<CatalogGroup, number>();
  for (const entry of entries) {
    counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
  }
  const kinds = catalogGroups.filter(
    (group) => entries.length === 0 || (counts.get(group) ?? 0) > 0
  );
  return {
    id: "integrations",
    title: t`Integrations`,
    icon: Cable,
    // Its name opens the overview: no Overview row of its own.
    home: <Link to="/integrations" />,
    homeCurrent: overview !== undefined && chosen === undefined,
    back: {
      label: t`Back`,
      render:
        outside === undefined ? (
          <Link to="/" />
        ) : (
          <Link search={outside.search} to={outside.pathname} />
        ),
    },
    groups: [
      {
        label: t`Kinds of app`,
        rows: kinds.map((group) => {
          const count = counts.get(group);
          return {
            label: i18n._(groupLabel[group]),
            icon: kindIcons[group],
            render: <Link search={{ group }} to="/integrations" />,
            current: chosen === group,
            ...(count === undefined ? {} : { end: formatNumber(count) }),
          };
        }),
      },
    ],
    storageKey: "grasp.sidebar.integrations",
    navLabel: t`Kinds of app`,
  };
};
