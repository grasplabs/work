import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import { Link, useMatch, useNavigate } from "@tanstack/react-router";

import {
  AppWindow,
  Cable,
  Clock,
  Code,
  Database,
  Desktop,
  Link as LinkIcon,
  People,
  Phone,
  Settings,
  Sliders,
  Tablet,
} from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import type {
  SidebarSection,
  SidebarSectionViews,
} from "../grasp/sidebar/index.ts";
import { ProcessTile } from "../workflows/business-process.tsx";
import { buildsApp } from "./app-role.ts";
import {
  optionsOf,
  readSurfaces,
  sectionLabels,
  shownSections,
} from "./app-settings.tsx";
import type { AppSettingsSection } from "./app-settings.tsx";
import type { WorkspaceView } from "./app-workspace.tsx";
import { previewWidthOrder, usePreviewWidth } from "./preview-controls.tsx";
import { useCoreRead } from "./use-core-read.ts";

// An App's workspace as the sidebar's section, while one who builds it has
// it open, as an agent's page and Settings are (grasp/frame/grasp-sidebar
// .tsx): Back to the Apps, the App's mark and name, then its views (App,
// Code, Data) and its settings' sections as rows. They are the workspace's
// own addresses (`?view=`, `?section=`), so a row is a link the page reads.
// Under its name, while the preview shows, how wide it is drawn (`?width=`).
// It takes the views out of the App's bar, which keeps the preview's own
// controls and Share; and the settings' tabs out of Settings. Whoever only
// uses the App gets the live App, with no section: the main list stays.

/** Each settings section's icon, as its row shows it. */
const sectionIcons: Readonly<Record<AppSettingsSection, IconData>> = {
  general: Settings,
  sharing: People,
  history: Clock,
  connections: Cable,
  webhooks: LinkIcon,
  options: Sliders,
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
  const viewRow = (each: WorkspaceView, label: string, icon: IconData) => ({
    label,
    icon,
    render: (
      <Link
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
      { value: "desktop", label: t`Desktop`, icon: Desktop },
      { value: "tablet", label: t`Tablet`, icon: Tablet },
      { value: "phone", label: t`Phone`, icon: Phone },
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
      ? { icon: AppWindow }
      : { mark: <ProcessTile process={app.process} /> }),
    navLabel: t`${name}'s workspace`,
    // How wide the preview is drawn, under the App's name while the preview
    // shows, as the main list's Home and Inbox: out of the App's bar, which
    // keeps Reload, the page and Open.
    ...(view === "preview" ? { views: widthViews } : {}),
    back: {
      label: t`Apps`,
      render: <Link to="/apps" />,
    },
    groups: [
      {
        rows: [
          viewRow(
            "preview",
            t({ message: "App", context: "an app's workspace view" }),
            AppWindow
          ),
          viewRow(
            "code",
            t({ message: "Code", context: "an app's workspace view" }),
            Code
          ),
          viewRow(
            "data",
            t({ message: "Data", context: "an app's workspace view" }),
            Database
          ),
        ],
      },
      {
        label: t({ message: "Settings", context: "an app's workspace view" }),
        rows: sections.map((each) => ({
          label: i18n._(sectionLabels[each]),
          icon: sectionIcons[each],
          render: (
            <Link
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
