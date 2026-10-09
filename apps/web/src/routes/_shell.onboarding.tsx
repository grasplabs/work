import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import {
  FileSignatureIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  MessagesSquareIcon,
  NotebookPenIcon,
  RocketIcon,
  UserRoundIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  PageSidebar,
  PageSidebarBody,
  PageSidebarTop,
  RailButton,
  RailDivider,
  RailExpand,
  usePageSidebarFold,
} from "../frame/page-sidebar.tsx";
import { SiteHeader } from "../frame/site-header.tsx";

// Grasp's onboarding area (GRA-319), as in the prototype's admin
// (`components/admin/org-home.tsx`, `org-sidebar.tsx`): for Grasp's staff
// in this deployment alone. One deployment is one organization, so there
// is no list of them: its sections sit in a page sidebar that folds to a
// rail, the section in the address. Core checks it is staff on every call.

type AreaPath =
  | "/onboarding"
  | "/onboarding/kickoff"
  | "/onboarding/agreements"
  | "/onboarding/stephen"
  | "/onboarding/open"
  | "/onboarding/notes"
  | "/onboarding/log";

interface AreaSection {
  to: AreaPath;
  label: MessageDescriptor;
  icon: LucideIcon;
}

const overview: AreaSection = {
  to: "/onboarding",
  label: msg({ message: "Overview", context: "onboarding area section" }),
  icon: LayoutDashboardIcon,
};

const sections: readonly AreaSection[] = [
  overview,
  {
    to: "/onboarding/kickoff",
    label: msg({ message: "Kickoff", context: "onboarding area section" }),
    icon: MessagesSquareIcon,
  },
  {
    to: "/onboarding/agreements",
    label: msg({ message: "Agreements", context: "onboarding area section" }),
    icon: FileSignatureIcon,
  },
  {
    to: "/onboarding/stephen",
    label: msg({ message: "Stephen", context: "onboarding area section" }),
    icon: UserRoundIcon,
  },
  {
    to: "/onboarding/open",
    label: msg({ message: "The go", context: "onboarding area section" }),
    icon: RocketIcon,
  },
  {
    to: "/onboarding/notes",
    label: msg({ message: "Notes", context: "onboarding area section" }),
    icon: NotebookPenIcon,
  },
  {
    to: "/onboarding/log",
    label: msg({ message: "Log", context: "onboarding area section" }),
    icon: HistoryIcon,
  },
];

/** The section `pathname` is in: the overview unless it is a deeper one. */
const sectionOf = (pathname: string): AreaSection =>
  sections.find(({ to }) => to !== "/onboarding" && pathname.startsWith(to)) ??
  overview;

const linkClass =
  "text-muted-foreground hover:bg-muted/60 hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground flex h-8 flex-none items-center gap-2 rounded-md px-2 text-left transition-colors";

const AreaSidebar = ({ current }: { current: AreaSection }) => {
  const { t, i18n } = useLingui();
  const [folded, setFolded] = usePageSidebarFold("onboarding");
  const label = t`Onboarding sections`;
  if (folded) {
    return (
      <PageSidebar folded label={label}>
        <RailExpand
          label={t`Expand the sections`}
          onExpand={() => {
            setFolded(false);
          }}
        />
        <RailDivider />
        {sections.map(({ to, label: name, icon: Icon }) => (
          <RailButton
            active={to === current.to}
            key={to}
            label={i18n._(name)}
            render={<Link to={to} />}
          >
            <Icon />
          </RailButton>
        ))}
      </PageSidebar>
    );
  }
  return (
    <PageSidebar folded={false} label={label}>
      <PageSidebarTop
        fold={{
          label: t`Fold the sections`,
          onFold: () => {
            setFolded(true);
          },
        }}
        joined
      >
        <h2 className="truncate px-2 font-medium">{t`Onboarding`}</h2>
      </PageSidebarTop>
      <PageSidebarBody joined>
        {sections.map(({ to, label: name, icon: Icon }) => (
          <Link
            aria-current={to === current.to ? "page" : undefined}
            className={linkClass}
            key={to}
            to={to}
          >
            <Icon aria-hidden="true" className="size-4 flex-none" />
            <span className="min-w-0 flex-1 truncate">{i18n._(name)}</span>
          </Link>
        ))}
      </PageSidebarBody>
    </PageSidebar>
  );
};

/** Without room for the sidebar, the sections are a row of links on top. */
const AreaTabs = ({ current }: { current: AreaSection }) => {
  const { t, i18n } = useLingui();
  return (
    <nav aria-label={t`Onboarding sections`} className="flex gap-1 md:hidden">
      {sections.map(({ to, label: name }) => (
        <Link
          aria-current={to === current.to ? "page" : undefined}
          className={linkClass}
          key={to}
          to={to}
        >
          {i18n._(name)}
        </Link>
      ))}
    </nav>
  );
};

const OnboardingArea = () => {
  const { t, i18n } = useLingui();
  const { pathname } = useLocation();
  const current = sectionOf(pathname);
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Onboarding` }, { label: i18n._(current.label) }]}
      />
      <div className="flex min-h-0 flex-1">
        <AreaSidebar current={current} />
        <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-6 py-7 text-sm">
          <AreaTabs current={current} />
          <Outlet />
        </div>
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/onboarding")({
  // Staff's alone: anyone else is taken home rather than shown a refusal.
  beforeLoad: ({ context: { identity } }) => {
    if (!identity.staff) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/", replace: true });
    }
  },
  component: OnboardingArea,
});
