import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";

import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { PageHeader } from "../grasp/page-header/index.ts";
import { sectionsFor } from "../settings/sections.ts";

// Settings: the workspace and who may do what in it, then one's own
// account, one section at a time, each under its own name as the page's
// one header. The sections, their groups and who sees each are data
// (settings/sections.ts); the sidebar lists them while the person is in
// Settings (grasp/frame/grasp-sidebar.tsx), on a phone in its sheet.

/** Settings: the section the address names, under its name. */
const SettingsLayout = () => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const { identity } = Route.useRouteContext();
  const current = sectionsFor(identity).find((section) =>
    pathname.startsWith(section.href)
  );
  return (
    <>
      <SiteHeader
        crumbs={
          current === undefined
            ? [{ label: t`Settings` }]
            : [{ label: t`Settings` }, { label: i18n._(current.label) }]
        }
      />
      <Page>
        {/* One header: the section's own name; the crumbs above already say Settings. */}
        <PageHeader
          size="md"
          title={current === undefined ? t`Settings` : i18n._(current.label)}
        />
        <Outlet />
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings")({
  component: SettingsLayout,
});
