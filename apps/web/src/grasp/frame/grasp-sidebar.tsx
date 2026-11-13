import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { GraspMark } from "@grasp-os/ui/components/grasp-mark";
import { Sheet, SheetContent, SheetTitle } from "@grasp-os/ui/components/sheet";
import { useSidebar } from "@grasp-os/ui/components/sidebar";
import { Plural, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useMatchRoute, useRouter } from "@tanstack/react-router";
import {
  AppWindowIcon,
  CableIcon,
  FolderKanbanIcon,
  HandHelpingIcon,
  InboxIcon,
  IterationCwIcon,
  PanelLeftIcon,
  PanelsTopLeftIcon,
  SearchIcon,
  SparkleIcon,
  WaypointsIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { chatsKey, useChatsWindow } from "../../chat/chat-switcher.tsx";
import type { CoreConnection } from "../../core-connection.ts";
import { useWaitingCount } from "../../dashboard/nav-item.tsx";
import { useSidebarApps } from "../../frame/surface-nav.tsx";
import { appSplat } from "../../pages/app-address.ts";
import { shortcutLabel } from "../../shortcuts.ts";
import { useWorkflowsWaiting } from "../../workflows/nav-item.tsx";
import { focus } from "../focus/focus.ts";
import { grasp, media } from "../tokens/tokens.stylex.ts";
import { frame } from "./frame.stylex.ts";
import {
  NavEntry,
  NavGroup,
  NavList,
  NavSub,
  NavSubEntry,
  Unseen,
} from "./nav.tsx";
import { ProfileMenu } from "./profile-menu.tsx";

// Grasp UI's sidebar, as Profound's platform has it: on the window's
// ground at its left edge, beside the page's card, which lies on the same
// ground a hair off the window's edges (app-frame.tsx). Top down: Grasp's
// mark, with search and the sidebar's fold beside it; the product's
// sections and the Apps' own rows; at the foot the person and their
// organization, with their menu (profile-menu.tsx). As Capy's.
//
// Closed, it is gone and the page's card takes the whole window. It is
// still a pointer's reach away: resting on the window's left edge slides it
// in over the page as a floating card (a peek), which slides away when the
// pointer leaves it, and its fold there keeps it open again. The page's bar
// has a button to open it too, for the keyboard (page-bar.tsx), and ⌘B
// opens and closes it. On a phone it is a sheet over the page. What it holds is
// today's sidebar's (frame/app-sidebar.tsx), drawn in StyleX from the
// frame's values (frame.stylex.ts) and Grasp UI's tokens.

/** How long the pointer rests on the edge before the sidebar peeks in. */
const peekAfterMs = 120;

/** How long the pointer may be off the peeking sidebar before it goes. */
const leaveAfterMs = 240;

const styles = stylex.create({
  // Sticky, it is a layer of its own: above the page's card, so the
  // sidebar peeking from it lies over the card.
  aside: {
    position: "sticky",
    zIndex: 40,
    top: 0,
    display: { default: "none", [media.fromTablet]: "flex" },
    flexShrink: 0,
    alignSelf: "flex-start",
    width: frame.sidebar,
    height: "100svh",
    transitionProperty: "width",
    transitionDuration: { default: grasp.durationUi, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  asideClosed: {
    width: 0,
  },
  // What the sidebar holds, standing in its place while it is open.
  panel: {
    display: "flex",
    width: frame.sidebar,
    height: "100%",
    overflow: "hidden",
    backgroundColor: frame.ground,
  },
  // Closed, it waits off the window's left edge as a floating card, and
  // slides in over the page while it peeks.
  panelClosed: {
    position: "fixed",
    top: frame.inset,
    bottom: frame.inset,
    left: frame.inset,
    height: "auto",
    borderRadius: frame.cardCorner,
    // The card's own edge and lift, so the two read as one surface.
    boxShadow: frame.cardShadow,
    transform: `translateX(calc(-100% - 2 * ${frame.inset}))`,
    transitionProperty: "transform",
    transitionDuration: { default: grasp.durationUi, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  panelPeeking: {
    transform: "translateX(0)",
  },
  // The window's left edge, where resting the pointer brings it back.
  edge: {
    position: "fixed",
    top: 0,
    bottom: 0,
    left: 0,
    width: frame.inset,
  },
  sheet: {
    height: "100%",
    backgroundColor: frame.ground,
  },
  inner: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minHeight: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: frame.textPrimary,
  },
  // The head, as Capy's: Grasp's mark on the left, search and the
  // sidebar's fold on the right.
  head: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    gap: frame.rowGap,
    paddingTop: frame.head,
    paddingInline: frame.gutter,
    paddingBottom: "4px",
  },
  tools: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: frame.rowGap,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: frame.gutter,
    minHeight: 0,
    padding: frame.gutter,
    overflowX: "hidden",
    overflowY: "auto",
  },
  // The foot: a rule across the sidebar, then the person and their
  // organization.
  foot: {
    display: "flex",
    flexShrink: 0,
    justifyContent: "center",
    padding: frame.gutter,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: frame.rule,
  },
  // Grasp's mark, as it is: not a control.
  logo: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    height: frame.iconButton,
    paddingInlineStart: "8px",
  },
  mark: {
    width: "20px",
    height: "20px",
    color: frame.textPrimary,
  },
  iconButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: { default: frame.iconButton, [media.coarse]: grasp.tap },
    height: { default: frame.iconButton, [media.coarse]: grasp.tap },
    padding: 0,
    borderWidth: 0,
    borderRadius: frame.corner,
    color: {
      default: frame.textSecondary,
      [media.hover]: {
        default: frame.textSecondary,
        ":hover": frame.textPrimary,
      },
    },
    backgroundColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": frame.hover },
    },
    cursor: "pointer",
    transitionProperty: "color, background-color",
    transitionDuration: { default: frame.answer, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  icon: {
    width: frame.icon,
    height: frame.icon,
  },
});

/**
 * Search and the sidebar's fold, at the head's right: search opens the
 * person's chats, ⌘K away anywhere; on a phone the sheet closes as any
 * sheet does, so no fold.
 */
const Tools = ({ search, onFold }: { search: boolean; onFold: () => void }) => {
  const { t } = useLingui();
  const openChats = useChatsWindow();
  const { isMobile } = useSidebar();
  const searchLabel = t`Search chats`;
  const fold = t`Show or hide the sidebar`;
  return (
    <div {...stylex.props(styles.tools)}>
      {search ? (
        <button
          aria-label={searchLabel}
          onClick={() => {
            openChats(true);
          }}
          title={`${searchLabel} (${shortcutLabel(chatsKey)})`}
          type="button"
          {...stylex.props(styles.iconButton, focus.ring)}
        >
          <SearchIcon aria-hidden="true" {...stylex.props(styles.icon)} />
        </button>
      ) : null}
      {isMobile ? null : (
        <button
          aria-label={fold}
          onClick={onFold}
          title={fold}
          type="button"
          {...stylex.props(styles.iconButton, focus.ring)}
        >
          <PanelLeftIcon aria-hidden="true" {...stylex.props(styles.icon)} />
        </button>
      )}
    </div>
  );
};

/** What a screen reader hears of the Dashboard's count: the message today's sidebar has. */
const ThingsWaiting = ({ waiting }: { waiting: number }) => (
  <Plural one="# thing waiting" other="# things waiting" value={waiting} />
);

/** What a screen reader hears of the Workflows' count: the message today's sidebar has. */
const WorkflowsWaiting = ({ waiting }: { waiting: number }) => (
  <Plural
    one="# workflow needs you"
    other="# workflows need you"
    value={waiting}
  />
);

/** The product's sections, with how much waits on the person in each. */
const Sections = ({ identity }: { identity: Identity }) => {
  const { t } = useLingui();
  const matchRoute = useMatchRoute();
  const waiting = useWaitingCount();
  const workflowsWaiting = useWorkflowsWaiting();
  const at = (to: string, fuzzy = true) => matchRoute({ to, fuzzy }) !== false;
  const inWorkflows = at("/workflows");
  const onRequests = at("/workflows/requests");
  return (
    <nav aria-label={t`Main`}>
      <NavList>
        <NavEntry
          current={at("/", false)}
          icon={SparkleIcon}
          label={t`Chat`}
          render={<Link to="/" />}
        />
        <NavEntry
          count={waiting}
          countLabel={<ThingsWaiting waiting={waiting ?? 0} />}
          current={at("/dashboard", false)}
          icon={InboxIcon}
          label={t`Dashboard`}
          render={<Link to="/dashboard" />}
        />
        <NavEntry
          current={at("/brain")}
          icon={WaypointsIcon}
          label={t`Brain`}
          render={<Link to="/brain" />}
        />
        <NavEntry
          current={at("/projects")}
          icon={FolderKanbanIcon}
          label={t`Projects`}
          render={<Link to="/projects" />}
        />
        <NavEntry
          current={at("/apps")}
          icon={PanelsTopLeftIcon}
          label={t`Apps`}
          render={<Link to="/apps" />}
        />
        <NavEntry
          count={workflowsWaiting}
          countLabel={<WorkflowsWaiting waiting={workflowsWaiting ?? 0} />}
          current={inWorkflows && !onRequests}
          icon={IterationCwIcon}
          label={t`Workflows`}
          render={<Link to="/workflows" />}
        >
          {/* Stephen's requests, under Workflows while the person is in them. */}
          {isAdmin(identity.role) && inWorkflows ? (
            <NavSub>
              <NavSubEntry
                current={onRequests}
                label={t({
                  message: "Requests",
                  context: "Stephen's requests: the page",
                })}
                render={<Link to="/workflows/requests" />}
              />
            </NavSub>
          ) : null}
        </NavEntry>
        <NavEntry
          current={at("/agents")}
          icon={HandHelpingIcon}
          label={t`Agents`}
          render={<Link to="/agents" />}
        />
        <NavEntry
          current={at("/integrations")}
          icon={CableIcon}
          label={t`Integrations`}
          render={<Link to="/integrations" />}
        />
      </NavList>
    </nav>
  );
};

/** The Apps' own entries (spec 34.1), a group of their own; none when there are none. */
const AppsEntries = ({ core }: { core: CoreConnection }) => {
  const { t } = useLingui();
  const matchRoute = useMatchRoute();
  const apps = useSidebarApps(core);
  const labelId = useId();
  if (apps.length === 0) {
    return null;
  }
  return (
    <NavGroup label={t`From your Apps`} labelId={labelId}>
      <NavList aria-labelledby={labelId}>
        {apps.map((app) => (
          <NavEntry
            current={
              matchRoute({
                to: "/apps/$app",
                params: { app: app.app },
                fuzzy: true,
              }) !== false
            }
            icon={AppWindowIcon}
            key={app.app}
            label={app.name}
            render={<Link params={{ app: app.app }} to="/apps/$app" />}
          >
            <NavSub>
              {app.entries.map((entry) => {
                const splat = appSplat(entry.path);
                return (
                  <NavSubEntry
                    key={entry.path}
                    label={entry.title}
                    render={
                      splat === "" ? (
                        <Link params={{ app: app.app }} to="/apps/$app" />
                      ) : (
                        <Link
                          params={{ app: app.app, _splat: splat }}
                          to="/apps/$app/pages/$"
                        />
                      )
                    }
                  />
                );
              })}
            </NavSub>
          </NavEntry>
        ))}
      </NavList>
    </NavGroup>
  );
};

/** The person and their organization, at the foot, with their menu. */
const Foot = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => (
  <div {...stylex.props(styles.foot)}>
    <ProfileMenu core={core} identity={identity} />
  </div>
);

/** What the sidebar holds, open, peeking or in the phone's sheet. */
const Contents = ({
  core,
  identity,
  onFold,
}: {
  core: CoreConnection;
  identity: Identity;
  onFold: () => void;
}) => {
  const sections = identity.onboardingOnly !== true;
  return (
    <div {...stylex.props(styles.inner)}>
      <div {...stylex.props(styles.head)}>
        <div {...stylex.props(styles.logo)}>
          <GraspMark aria-hidden {...stylex.props(styles.mark)} />
        </div>
        <Tools onFold={onFold} search={sections} />
      </div>
      <div {...stylex.props(styles.body)}>
        {sections ? <Sections identity={identity} /> : null}
        {sections ? <AppsEntries core={core} /> : null}
      </div>
      <Foot core={core} identity={identity} />
    </div>
  );
};

/** Grasp UI's sidebar. */
export const GraspSidebar = ({
  core,
  identity,
}: {
  core: CoreConnection;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { isMobile, openMobile, setOpenMobile, open, toggleSidebar } =
    useSidebar();
  const [peeking, setPeeking] = useState(false);
  const timer = useRef(0);
  const panel = useRef<HTMLDivElement>(null);
  // On a phone the sidebar is a sheet over the page: going anywhere from it
  // closes it, so the page it went to is in view.
  useEffect(
    () =>
      router.subscribe("onResolved", () => {
        setOpenMobile(false);
      }),
    [router, setOpenMobile]
  );
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    []
  );
  /** Peeks in, or goes, after `ms`, unless the pointer changes its mind. */
  const peekAfter = (next: boolean, ms: number): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      // A menu open from the sidebar (the person's) stands outside it:
      // the sidebar stays while it is open.
      const menuOpen =
        panel.current?.querySelector('[aria-expanded="true"]') !== null;
      if (next || !menuOpen) {
        setPeeking(next);
      }
    }, ms);
  };
  // While it is closed, the peeking sidebar stays while the pointer or the
  // keys are on it, and goes when they leave it or on Escape. On the panel
  // itself, not its children: it is no control, only where they are.
  useEffect(() => {
    const element = panel.current;
    if (open || element === null) {
      return () => {
        // Open: it stays where it is.
      };
    }
    const stay = (): void => {
      window.clearTimeout(timer.current);
    };
    const leave = (): void => {
      peekAfter(false, leaveAfterMs);
    };
    const blur = (event: FocusEvent): void => {
      const to = event.relatedTarget;
      if (!(to instanceof Node && element.contains(to))) {
        setPeeking(false);
      }
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPeeking(false);
      }
    };
    element.addEventListener("pointerenter", stay);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("focusin", stay);
    element.addEventListener("focusout", blur);
    element.addEventListener("keydown", escape);
    return () => {
      element.removeEventListener("pointerenter", stay);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("focusin", stay);
      element.removeEventListener("focusout", blur);
      element.removeEventListener("keydown", escape);
    };
  });
  /** The fold: closes the open sidebar, and keeps a peeking one open. */
  const fold = (): void => {
    window.clearTimeout(timer.current);
    setPeeking(false);
    toggleSidebar();
  };
  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpenMobile} open={openMobile}>
        <SheetContent showCloseButton={false} side="left">
          <Unseen>
            <SheetTitle>{t`Sidebar`}</SheetTitle>
          </Unseen>
          <div data-icons="still" {...stylex.props(styles.sheet)}>
            <Contents core={core} identity={identity} onFold={fold} />
          </div>
        </SheetContent>
      </Sheet>
    );
  }
  const shown = open || peeking;
  return (
    <aside
      aria-label={t`Sidebar`}
      data-icons="still"
      data-slot="sidebar"
      {...stylex.props(styles.aside, !open && styles.asideClosed)}
    >
      {open ? null : (
        <div
          aria-hidden="true"
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") {
              peekAfter(true, peekAfterMs);
            }
          }}
          onPointerLeave={() => {
            if (!peeking) {
              window.clearTimeout(timer.current);
            }
          }}
          {...stylex.props(styles.edge)}
        />
      )}
      <div
        // Off the window and out of reach while it is closed and not
        // peeking: no tab stop lands on what can't be seen.
        inert={!shown}
        ref={panel}
        {...stylex.props(
          styles.panel,
          !open && styles.panelClosed,
          !open && peeking && styles.panelPeeking
        )}
      >
        <Contents core={core} identity={identity} onFold={fold} />
      </div>
    </aside>
  );
};
