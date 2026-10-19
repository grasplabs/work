import { isAdmin } from "@grasp-os/shared/roles";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import {
  ActivityIcon,
  BellIcon,
  BuildingIcon,
  CircleHelpIcon,
  CoinsIcon,
  CreditCardIcon,
  HistoryIcon,
  KeyRoundIcon,
  PackageIcon,
  SparklesIcon,
  UserRoundIcon,
  UsersIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { SiteHeader } from "../frame/site-header.tsx";

// Settings, as in the prototype (`routes/settings.tsx`): the workspace and
// who may do what in it, then one's own account, one section at a time.
// The workspace's sections are for admins (Members and roles, and calls of
// unknown outcome, never for Grasp staff); Packages for all but Grasp staff
// (its list is for who may approve packages); the account's for everyone.
// Core checks the role on every call whatever is listed. The prototype's
// Onboarding section is not here: in Grasp OS the onboarding is Grasp
// staff's own area (`/onboarding`).

type SettingsPath =
  | "/settings/workspace"
  | "/settings/members"
  | "/settings/models"
  | "/settings/spend"
  | "/settings/pulse"
  | "/settings/audit"
  | "/settings/outcomes"
  | "/settings/billing"
  | "/settings/packages"
  | "/settings/profile"
  | "/settings/notifications"
  | "/settings/security";

interface SettingsItem {
  /** Pulse is a name and stays as it is; the other labels are translated. */
  label: MessageDescriptor | string;
  to: SettingsPath;
  icon: LucideIcon;
}

interface SettingsGroup {
  id: string;
  title: MessageDescriptor;
  items: SettingsItem[];
}

/** The sections this person may open, in their groups. */
const groupsFor = ({
  admin,
  staff,
}: {
  admin: boolean;
  staff: boolean;
}): SettingsGroup[] => {
  // Packages for everyone but Grasp staff: what it lists is for whoever
  // may approve packages, a permission no role implies, so core says.
  const packages: SettingsItem[] = staff
    ? []
    : [{ label: msg`Packages`, to: "/settings/packages", icon: PackageIcon }];
  const workspace: SettingsItem[] = admin
    ? [
        {
          label: msg`Workspace`,
          to: "/settings/workspace",
          icon: BuildingIcon,
        },
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
        { label: msg`AI spend`, to: "/settings/spend", icon: CoinsIcon },
        { label: "Pulse", to: "/settings/pulse", icon: ActivityIcon },
        { label: msg`Audit trail`, to: "/settings/audit", icon: HistoryIcon },
        ...(staff
          ? []
          : [
              {
                label: msg`Unknown outcomes`,
                to: "/settings/outcomes" as const,
                icon: CircleHelpIcon,
              },
            ]),
        { label: msg`Billing`, to: "/settings/billing", icon: CreditCardIcon },
        ...packages,
      ]
    : packages;
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
        {
          label: msg`Notifications`,
          to: "/settings/notifications",
          icon: BellIcon,
        },
        { label: msg`Security`, to: "/settings/security", icon: KeyRoundIcon },
      ],
    },
  ];
};

/**
 * Settings: the workspace and who may do what in it, then one's own account. One section at a time.
 * The list of sections stands beside the section only where the page has the room for both, which
 * is about the page and not the window: Grasp's own sidebar takes its share. With less room the
 * sections are one control above the section, so a section is never squeezed into a sliver.
 */
const SettingsLayout = () => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { identity } = Route.useRouteContext();
  const groups = groupsFor({
    admin: isAdmin(identity.role),
    staff: identity.staff,
  });
  const labelOf = (label: MessageDescriptor | string): string =>
    typeof label === "string" ? label : i18n._(label);
  const items = groups.flatMap((group) => group.items);
  const current = items.find((item) => pathname.startsWith(item.to));
  return (
    <>
      <SiteHeader
        crumbs={
          current === undefined
            ? [{ label: t`Settings` }]
            : [{ label: t`Settings` }, { label: labelOf(current.label) }]
        }
      />
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 pt-7 pb-24">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
            <h1 className="text-2xl font-medium tracking-tight">
              <Trans>Settings</Trans>
            </h1>
            <p className="text-muted-foreground text-sm">
              <Trans>
                Your workspace, who may do what in it, and your own account.
              </Trans>
            </p>
          </div>
        </div>
        <div className="@container">
          <div className="flex flex-col gap-6 text-sm @3xl:flex-row @3xl:items-start @3xl:gap-8">
            <div className="@3xl:hidden">
              <Select
                items={items.map((item) => ({
                  value: item.to,
                  label: labelOf(item.label),
                }))}
                value={current?.to ?? null}
                onValueChange={(value) => {
                  const to = items.find((item) => item.to === value)?.to;
                  if (to !== undefined) {
                    void navigate({ to });
                  }
                }}
              >
                <SelectTrigger aria-label={t`Settings`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectGroup key={group.id}>
                      <SelectLabel>{i18n._(group.title)}</SelectLabel>
                      {group.items.map((item) => (
                        <SelectItem key={item.to} value={item.to}>
                          {labelOf(item.label)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <nav
              aria-label={t`Settings`}
              className="hidden w-52 flex-none flex-col gap-5 @3xl:sticky @3xl:top-16 @3xl:flex"
            >
              {groups.map((group) => (
                <div className="flex flex-col gap-0.5" key={group.id}>
                  <span className="text-muted-foreground px-2 pb-1 text-xs">
                    {i18n._(group.title)}
                  </span>
                  {group.items.map(({ label, to, icon: Icon }) => (
                    <Link
                      className="text-muted-foreground hover:bg-accent data-[status=active]:bg-muted data-[status=active]:text-foreground hover:text-foreground focus-visible:ring-ring/50 flex items-center gap-2 rounded-md px-2 py-1.5 outline-none focus-visible:ring-3"
                      key={to}
                      to={to}
                    >
                      <Icon aria-hidden="true" className="size-4" />
                      {labelOf(label)}
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
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings")({
  component: SettingsLayout,
});
