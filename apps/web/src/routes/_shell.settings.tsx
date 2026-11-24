import { isAdmin } from "@grasp-os/shared/roles";
import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";

import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { groupsFor } from "../settings/sections.ts";

// Settings, as in the prototype (`routes/settings.tsx`): the workspace and
// who may do what in it, then one's own account, one section at a time.
// The workspace's sections are for admins (Members and roles, Webhooks and
// calls of unknown outcome, never for Grasp staff); the account's for
// everyone. The sidebar lists them while a Settings page is open, in its
// sheet on a phone (frame/settings-level.tsx), so the page holds the
// section alone.
// Core checks the role on every call whatever is listed. Onboarding is the
// company admin's own view of the interviews, as their onboarding shows
// it; what only Grasp's staff do there is in Grasp's admin.

const SettingsLayout = () => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const { identity } = Route.useRouteContext();
  const current = groupsFor({
    admin: isAdmin(identity.role),
    staff: identity.staff,
  })
    .flatMap((group) => group.items)
    .find((item) => pathname.startsWith(item.to));
  // Stephen is a name and stays as it is.
  const nameOf = (label: MessageDescriptor | string): string =>
    typeof label === "string" ? label : i18n._(label);
  const section = current === undefined ? undefined : nameOf(current.label);
  return (
    <>
      <SiteHeader
        crumbs={
          section === undefined
            ? [{ label: t`Settings` }]
            : [{ label: t`Settings` }, { label: section }]
        }
      />
      <Page>
        <PageHeading
          description={t`Your workspace, who may do what in it, and your own account.`}
          title={t`Settings`}
        />
        <div className="flex max-w-5xl min-w-0 flex-col gap-6 text-sm">
          <Outlet />
        </div>
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings")({
  component: SettingsLayout,
});
