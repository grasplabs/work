import { isAdmin } from "@grasp-os/shared/roles";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
} from "@tanstack/react-router";
import {
  CheckCheckIcon,
  HistoryIcon,
  SparklesIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { SiteHeader } from "../frame/site-header.tsx";

// Settings, as in the prototype (`routes/settings.tsx`): the workspace and
// who may do what in it, then one's own account, one section at a time.
// Only the sections core has something behind are here, and only those
// the person may open are listed: Profile for everyone; Members and roles,
// Models, the audit trail and pending approvals for admins (Members and
// roles never for Grasp staff). Core checks the role on every call
// whatever is listed.

type SettingsPath =
  | "/settings/profile"
  | "/settings/members"
  | "/settings/models"
  | "/settings/audit"
  | "/settings/approvals";

interface SettingsItem {
  label: MessageDescriptor;
  to: SettingsPath;
  icon: LucideIcon;
}

/** The sections this person may open, in their groups. */
const groupsFor = ({
  admin,
  staff,
}: {
  admin: boolean;
  staff: boolean;
}): { id: string; title: MessageDescriptor; items: SettingsItem[] }[] => {
  const workspace: SettingsItem[] = admin
    ? [
        ...(staff
          ? []
          : [
              {
                label: msg`Members and roles`,
                to: "/settings/members" as const,
                icon: UsersIcon,
              },
            ]),
        { label: msg`Models`, to: "/settings/models", icon: SparklesIcon },
        { label: msg`Audit trail`, to: "/settings/audit", icon: HistoryIcon },
        {
          label: msg`Pending approvals`,
          to: "/settings/approvals",
          icon: CheckCheckIcon,
        },
      ]
    : [];
  return [
    ...(workspace.length === 0
      ? []
      : [
          {
            id: "workspace",
            title: msg({ message: "Workspace", context: "settings group" }),
            items: workspace,
          },
        ]),
    {
      id: "account",
      title: msg`Your account`,
      items: [
        { label: msg`Profile`, to: "/settings/profile", icon: UserRoundIcon },
      ],
    },
  ];
};

const SettingsLayout = () => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const { identity } = Route.useRouteContext();
  const groups = groupsFor({
    admin: isAdmin(identity.role),
    staff: identity.staff,
  });
  const current = groups
    .flatMap((group) => group.items)
    .find((item) => pathname.startsWith(item.to));
  return (
    <>
      <SiteHeader
        crumbs={
          current === undefined
            ? [{ label: t`Settings` }]
            : [{ label: t`Settings` }, { label: i18n._(current.label) }]
        }
      />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-7">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium tracking-tight">
            <Trans>Settings</Trans>
          </h1>
          <p className="text-muted-foreground text-sm">
            <Trans>
              Your workspace, who may do what in it, and your own account.
            </Trans>
          </p>
        </div>
        <div className="flex flex-col gap-8 text-sm md:flex-row md:items-start">
          <nav
            aria-label={t`Settings`}
            className="flex w-full flex-none flex-col gap-5 md:sticky md:top-16 md:w-52"
          >
            {groups.map((group) => (
              <div className="flex flex-col gap-0.5" key={group.id}>
                <span className="text-muted-foreground px-2 pb-1 text-xs">
                  {i18n._(group.title)}
                </span>
                {group.items.map(({ label, to, icon: Icon }) => (
                  <Link
                    activeProps={{
                      className: "bg-muted text-foreground",
                    }}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 flex items-center gap-2 rounded-md px-2 py-1.5 outline-none focus-visible:ring-3"
                    key={to}
                    to={to}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    {i18n._(label)}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="flex max-w-5xl min-w-0 flex-1 flex-col gap-6">
            <Outlet />
          </div>
        </div>
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings")({
  component: SettingsLayout,
});
