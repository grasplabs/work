import { AppShellPage } from "@grasp-os/ui/blocks/app-shell-01/app-shell-01";
import { Container } from "@grasp-os/ui/components/container";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";

import { SiteHeader } from "../frame/site-header.tsx";
import { sectionsFor } from "../settings/sections.ts";

// Settings: the workspace and who may do what in it, then one's own
// account, one section at a time, each under its own name as the page's
// one header. The sections, their groups and who sees each are data
// (settings/sections.ts); the sidebar lists them while the person is in
// Settings (frame/app-sidebar.tsx), on a phone in its sheet.
//
// A section stands in one column in the page's middle, Damsko's
// settings column (Container `sm`, 40rem): a settings page needs no more, and its rows
// read as one group. Its loading state stands in the same column. Only a
// section that needs the room (the Audit trail's log beside its details)
// says `wide` and keeps the page's whole width.

/** Settings: the section the address names, under its name. */
const SettingsLayout = () => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const { identity } = Route.useRouteContext();
  const current = sectionsFor(identity).find((section) =>
    pathname.startsWith(section.href)
  );
  // One header: the section's own name; the crumbs above already say Settings.
  const header = (
    <PageHeader
      size="sm"
      title={current === undefined ? t`Settings` : i18n._(current.label)}
    />
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
      <AppShellPage>
        {current?.wide === true ? (
          <>
            {header}
            <Outlet />
          </>
        ) : (
          <Container size="sm">
            {header}
            <Outlet />
          </Container>
        )}
      </AppShellPage>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings")({
  component: SettingsLayout,
});
