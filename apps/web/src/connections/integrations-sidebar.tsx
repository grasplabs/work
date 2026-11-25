import { catalogGroups } from "@grasp-os/shared/connect-names";
import type { CatalogGroup } from "@grasp-os/shared/connect-names";
import {
  AppWindowIcon,
  CableIcon,
  CircleHelpIcon,
  ClipboardListIcon,
  CodeIcon,
  CoinsIcon,
  DatabaseIcon,
  FileIcon,
  ImageIcon,
  ListChecksIcon,
  MailIcon,
  MessageCircleIcon,
  PencilIcon,
  SparklesIcon,
  TagIcon,
  TrendingUpIcon,
  UserSparklesIcon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation, useMatch } from "@tanstack/react-router";

import { formatNumber } from "../format.ts";
import type { SidebarSection } from "../frame/sidebar.tsx";
import { WayOut } from "../frame/way-out.tsx";
import type { Outside } from "../frame/way-out.tsx";
import { groupLabel } from "./groups.ts";
import { integrationsOf } from "./integrations.ts";

// Integrations as the sidebar's section while the person is in it, as
// Settings and the Brain are (frame/app-sidebar.tsx): its name
// opens the overview, Back returns to the page they came from, and each
// kind of app is a row that opens that kind whole on the overview
// (`?group=`), with how many apps it holds once the catalog is read.

/** Each kind of app's icon, as its row shows it. */
const kindIcons: Readonly<Record<CatalogGroup, IconData>> = {
  "Email and calendar": MailIcon,
  "Files and documents": FileIcon,
  Chat: MessageCircleIcon,
  CRM: UsersIcon,
  "Finance and accounting": CoinsIcon,
  HR: UserSparklesIcon,
  Signing: PencilIcon,
  Marketing: TrendingUpIcon,
  Support: CircleHelpIcon,
  "Projects and tasks": ClipboardListIcon,
  "Forms and surveys": ListChecksIcon,
  "Data and analytics": DatabaseIcon,
  AI: SparklesIcon,
  Commerce: TagIcon,
  "Design and media": ImageIcon,
  "Developer tools": CodeIcon,
  Other: AppWindowIcon,
};

/**
 * How many apps each kind holds, by the same rule as the kind's own page:
 * the apps of that kind nobody connected yet (what is connected stands
 * under Connected).
 */
const kindCounts = (
  entries: Parameters<typeof integrationsOf>[0],
  connections: Parameters<typeof integrationsOf>[1]
): Map<CatalogGroup, number> => {
  const counts = new Map<CatalogGroup, number>();
  for (const integration of integrationsOf(entries, connections)) {
    if (integration.listed && integration.connections.length === 0) {
      counts.set(integration.group, (counts.get(integration.group) ?? 0) + 1);
    }
  }
  return counts;
};

/** Integrations' kinds of app, as the sidebar's section; undefined outside Integrations. */
export const useIntegrationsSection = (
  outside: Outside | undefined
): SidebarSection | undefined => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const overview = useMatch({
    from: "/_shell/integrations/",
    shouldThrow: false,
  });
  // An app's page reads the same catalog and connections, so its kinds match the overview's.
  const app = useMatch({
    from: "/_shell/integrations/$integration",
    shouldThrow: false,
  });
  const inIntegrations =
    pathname === "/integrations" || pathname.startsWith("/integrations/");
  if (!inIntegrations) {
    return undefined;
  }
  const read = overview?.loaderData ?? app?.loaderData;
  const catalog = read?.catalog;
  const connections = read?.connections;
  const entries = catalog?.state === "ready" ? catalog.data.entries : [];
  const chosen = overview?.search.group;
  const counts = kindCounts(
    entries,
    connections?.state === "ready" ? connections.data : []
  );
  const kinds = catalogGroups.filter(
    (group) => entries.length === 0 || (counts.get(group) ?? 0) > 0
  );
  return {
    id: "integrations",
    title: t`Integrations`,
    icon: CableIcon,
    // Its name opens the overview: no Overview row of its own.
    home: (look) => <Link {...look} to="/integrations" />,
    homeCurrent: overview !== undefined && chosen === undefined,
    back: {
      label: t`Back`,
      render: (look) => <WayOut {...look} outside={outside} />,
    },
    groups: [
      {
        label: t`Kinds of app`,
        rows: kinds.map((group) => {
          const count = counts.get(group);
          return {
            id: group,
            label: i18n._(groupLabel[group]),
            icon: kindIcons[group],
            render: (look) => (
              <Link {...look} search={{ group }} to="/integrations" />
            ),
            current: chosen === group,
            ...(count === undefined ? {} : { end: formatNumber(count) }),
          };
        }),
      },
    ],
    navLabel: t`Kinds of app`,
  };
};
