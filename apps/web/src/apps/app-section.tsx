import type { Identity } from "@grasp-os/shared/rpc";
import {
  ClockIcon,
  CodeIcon,
  DatabaseIcon,
  LinkIcon,
  SettingsIcon,
  ShareIcon,
  SlidersHorizontalIcon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatch, useNavigate } from "@tanstack/react-router";

import {
  AppWindowIcon,
  LaptopIcon,
  SmartphoneIcon,
  TabletIcon,
} from "../frame/sidebar-icons.ts";
import type {
  SidebarRow,
  SidebarSection,
  SidebarSectionViews,
} from "../frame/sidebar.tsx";
import { ProcessTile } from "../workflows/business-process.tsx";
import { buildsApp } from "./app-role.ts";
import type { WorkspaceView } from "./app-workspace.tsx";
import { previewWidthOrder, usePreviewWidth } from "./preview-controls.tsx";
import {
  optionsOf,
  readSurfaces,
  sectionLabels,
  shownSections,
} from "./settings-sections.ts";
import type { AppSettingsSection } from "./settings-sections.ts";
import { useCoreRead } from "./use-core-read.ts";

// An App's workspace as the sidebar's section, while one who builds it has
// it open, as an agent's page and Settings are (frame/app-sidebar.tsx): Back to the Apps and the App's mark and name as one press (the name
// opens the App itself), then its views (Code, Data) and its settings'
// sections as rows. They are the workspace's
// own addresses (`?view=`, `?section=`), so a row is a link the page reads.
// Under its name, while the preview shows, how wide it is drawn (`?width=`).
// It takes the views out of the App's bar, which keeps the preview's own
// controls and Share; and the settings' tabs out of Settings. Whoever only
// uses the App gets the live App, with no section: the main list stays.

/** Each settings section's icon, as its row shows it. */
const sectionIcons: Readonly<Record<AppSettingsSection, IconData>> = {
  general: SettingsIcon,
  sharing: UsersIcon,
  history: ClockIcon,
  connections: LinkIcon,
  webhooks: ShareIcon,
  options: SlidersHorizontalIcon,
};

/** The App's workspace, as the sidebar's section; undefined anywhere else. */
export const useAppSection = (
  identity: Identity
): SidebarSection | undefined => {
  const { t, i18n } = useLingui();
  const match = useMatch({ from: "/_shell/apps/$app", shouldThrow: false });
  const width = usePreviewWidth();
  const navigate = useNavigate({ from: "/apps/$app" });
  const page = match?.loaderData;
  const app = page?.state === "ready" ? page.data.app : undefined;
  const builds = app !== undefined && buildsApp(app, identity);
  // Whether the App declares settings of its own (Options): read only for
  // an App whose workspace is open.
  const surfaces = useCoreRead(
    `app-section/${builds ? (app?.id ?? "") : ""}`,
    async (session) =>
      builds && app !== undefined ? await readSurfaces(session, app.id) : []
  );
  if (match === undefined || app === undefined || !builds) {
    return undefined;
  }
  const { search } = match;
  const { name } = app;
  const view: WorkspaceView = search.view ?? "preview";
  const section = search.section ?? "general";
  const held = { env: search.env, project: search.project };
  const viewRow = (
    each: WorkspaceView,
    label: string,
    icon: IconData
  ): SidebarRow => ({
    id: each,
    label,
    icon,
    render: (look) => (
      <Link
        {...look}
        params={{ app: app.id }}
        replace
        search={{
          ...held,
          view: each === "preview" ? undefined : each,
        }}
        to="/apps/$app"
      />
    ),
    current: view === each,
  });
  const widthViews: SidebarSectionViews = {
    label: t`Preview width`,
    value: width,
    tabs: [
      { value: "desktop", label: t`Desktop`, icon: LaptopIcon },
      { value: "tablet", label: t`Tablet`, icon: TabletIcon },
      { value: "phone", label: t`Phone`, icon: SmartphoneIcon },
    ],
    onChange: (chosen) => {
      const picked = previewWidthOrder.find((each) => each === chosen);
      void navigate({
        replace: true,
        search: (before) => ({
          ...before,
          width: picked === "desktop" ? undefined : picked,
        }),
      });
    },
  };
  const sections = shownSections(app, identity, {
    options: optionsOf(surfaces) !== undefined,
  });
  return {
    id: `app/${app.id}`,
    title: name,
    ...(app.process === null
      ? { icon: AppWindowIcon }
      : { mark: <ProcessTile process={app.process} /> }),
    navLabel: t`${name}'s workspace`,
    // How wide the preview is drawn, under the App's name while the preview
    // shows, as the main list's Home and Inbox: out of the App's bar, which
    // keeps Reload, the page and Open.
    ...(view === "preview" ? { views: widthViews } : {}),
    back: {
      label: t`Apps`,
      render: (look) => <Link {...look} to="/apps" />,
    },
    // Back and its name as one press: the name opens the App itself, its preview.
    home: (look) => (
      <Link
        {...look}
        params={{ app: app.id }}
        replace
        search={held}
        to="/apps/$app"
      />
    ),
    homeCurrent: view === "preview",
    groups: [
      {
        rows: [
          viewRow(
            "code",
            t({ message: "Code", context: "an app's workspace view" }),
            CodeIcon
          ),
          viewRow(
            "data",
            t({ message: "Data", context: "an app's workspace view" }),
            DatabaseIcon
          ),
        ],
      },
      {
        label: t({ message: "Settings", context: "an app's workspace view" }),
        rows: sections.map((each) => ({
          id: each,
          label: i18n._(sectionLabels[each]),
          icon: sectionIcons[each],
          render: (look) => (
            <Link
              {...look}
              params={{ app: app.id }}
              replace
              search={{ ...held, view: "settings", section: each }}
              to="/apps/$app"
            />
          ),
          current: view === "settings" && section === each,
        })),
      },
    ],
  };
};
