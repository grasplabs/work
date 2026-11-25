import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import { breadcrumbVars } from "@grasp-os/ui/components/breadcrumb.stylex";
import { SidebarTrigger, useSidebar } from "@grasp-os/ui/components/sidebar";
import { focusRingText } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { Fragment, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import type { RegionId } from "../brain/brain-atlas.ts";
import { useShownPresence } from "../chat/global-chat.tsx";
import { RenamableName } from "./panels/rename.tsx";

/** A step on the way to the page; the last one is the page itself. */
export type Crumb =
  | {
      label: string;
      /** The page's own name only: renamed in place (panels/rename.tsx). */
      onRename?: (name: string) => void;
      /** Whether its rename is open, when a menu's Rename opens it. */
      renaming?: boolean;
      onRenamingChange?: (renaming: boolean) => void;
    }
  | {
      label: string;
      to:
        | "/"
        | "/brain"
        | "/projects"
        | "/apps"
        | "/workflows"
        | "/agents"
        | "/integrations";
    }
  | {
      label: string;
      to: "/brain";
      search: { region?: RegionId; group?: string; note?: string };
    }
  | { label: string; to: "/brain/$noteId"; params: { noteId: string } }
  | {
      label: string;
      to: "/brain/sections/$sectionId";
      params: { sectionId: string };
    }
  | { label: string; to: "/apps/$app"; params: { app: string } }
  | {
      label: string;
      to: "/projects/$projectId";
      params: { projectId: string };
    }
  | {
      label: string;
      to: "/workflows/$workflow";
      params: { workflow: string };
    };

/** The page's own name, renamed in place where it may be. */
const CrumbName = ({ crumb }: { crumb: Crumb }) => {
  if (!("onRename" in crumb) || crumb.onRename === undefined) {
    return crumb.label;
  }
  const {
    label,
    onRename: handleRename,
    renaming,
    onRenamingChange: handleRenamingChange,
  } = crumb;
  return (
    <RenamableName
      name={label}
      onRename={handleRename}
      {...(renaming === undefined ? {} : { open: renaming })}
      {...(handleRenamingChange === undefined
        ? {}
        : { onOpenChange: handleRenamingChange })}
    />
  );
};

/** A router link's look: none (Damsko's BreadcrumbLink gives it), or the phone trail's. */
type LinkLook = Partial<ReturnType<typeof stylex.props>>;

/** Where a crumb leads, as a router link holding its name. */
const CrumbLink = ({
  crumb,
  look,
}: {
  crumb: Extract<Crumb, { to: string }>;
  look?: LinkLook;
}) => {
  const { label } = crumb;
  // A place on the brain's atlas: a region, a folder in it, a note there.
  if ("search" in crumb) {
    return (
      <Link search={crumb.search} to="/brain" {...look}>
        {label}
      </Link>
    );
  }
  if (!("params" in crumb)) {
    return (
      <Link to={crumb.to} {...look}>
        {label}
      </Link>
    );
  }
  if (crumb.to === "/workflows/$workflow") {
    return (
      <Link params={crumb.params} to="/workflows/$workflow" {...look}>
        {label}
      </Link>
    );
  }
  if (crumb.to === "/projects/$projectId") {
    return (
      <Link params={crumb.params} to="/projects/$projectId" {...look}>
        {label}
      </Link>
    );
  }
  if (crumb.to === "/brain/$noteId") {
    return (
      <Link params={crumb.params} to="/brain/$noteId" {...look}>
        {label}
      </Link>
    );
  }
  if (crumb.to === "/brain/sections/$sectionId") {
    return (
      <Link params={crumb.params} to="/brain/sections/$sectionId" {...look}>
        {label}
      </Link>
    );
  }
  return (
    <Link params={crumb.params} to="/apps/$app" {...look}>
      {label}
    </Link>
  );
};

/**
 * A phone's window, under 40rem, as #2503's shell reads it (its card is
 * the whole window there): where its bar keeps only the page and the step
 * before it.
 */
const phoneQuery = "(width < 40rem)";

const onPhoneChange = (changed: () => void): (() => void) => {
  const list = matchMedia(phoneQuery);
  list.addEventListener("change", changed);
  return () => {
    list.removeEventListener("change", changed);
  };
};

/** Whether the window is a phone's now, followed as it changes; never on the server. */
const usePhone = (): boolean =>
  useSyncExternalStore(
    onPhoneChange,
    () => matchMedia(phoneQuery).matches,
    () => false
  );

// The room a crumb's link keeps round its words for its focus ring, given
// back by a negative margin, and the reach of that ring past the words,
// which the trail's clip keeps clear of, as #2503's bar has them.
const CRUMB_ROOM = `calc(${space["1"]} - ${size.hairline})`;
const RING_REACH = `calc(${size.ringWidth} + ${size.ringOffsetText} + ${CRUMB_ROOM})`;

const styles = stylex.create({
  // One row the shell's bar height, across the page's card from edge to
  // edge, at the top of the page, which scrolls under it: on the card's
  // own ground at every width (app-frame.tsx), as #2503's bar on its
  // card's (shell-card), with a hairline at its foot.
  bar: {
    position: "sticky",
    insetBlockStart: 0,
    zIndex: 20,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    boxSizing: "border-box",
    minWidth: 0,
    height: size.appShellBar,
    paddingInline: size.appShellPageInline,
    backgroundColor: colors.sidebarCard,
    borderBlockEndWidth: size.hairline,
    borderBlockEndStyle: "solid",
    // On a phone #2503's bar line is the frame's own neutral rule (the
    // card's edge, shell-rule's step), not the page's tinted one.
    borderBlockEndColor: {
      default: colors.border,
      [media.maxSm]: colors.sidebarCardBorder,
    },
  },
  // Where the page is, then where its subject stands: they give way to the
  // actions, never the other way round.
  where: {
    display: "flex",
    flexGrow: 1,
    alignItems: "center",
    // What trails the crumbs (where the subject stands) a space-3 after
    // them, as the reference's bar sets them apart.
    gap: space["3"],
    minWidth: 0,
    overflow: "hidden",
    // The crumbs in the sidebar's greys, as the reference's bar: the steps
    // back in its rows' words, the slashes quieter, the page in its ink,
    // through the path's own inks, which a frame on another ground sets.
    // What stands beside the crumbs (where the subject stands, its link)
    // keeps the page's inks, as on the reference.
    [breadcrumbVars.mutedForeground]: colors.sidebarSecondaryForeground,
    [breadcrumbVars.subtleForeground]: colors.sidebarTertiaryForeground,
    [breadcrumbVars.foreground]: colors.sidebarForeground,
  },
  // The button's empty rim hangs out past the bar's room, so its glyph
  // stands where the page's words begin, the crumbs 6px after its box, as
  // the reference's.
  trigger: {
    marginInlineStart: `calc((${size.sidebarIcon} - ${size.sidebarIconButton}) / 2)`,
    marginInlineEnd: "-2px",
  },
  // On a phone the button is #2503's Menu button, a ghost Button: in its
  // ink, the chat button's at the bar's other end, not the sidebar's
  // greys.
  triggerInk: {
    display: "contents",
    "--damsko-sidebar-secondary-foreground": {
      default: null,
      [media.maxSm]: colors.foreground,
    },
  },
  // The slashes stand a step apart from the steps, as the reference's.
  separator: { marginInline: space["1"] },
  // A phone's trail, as #2503's bar draws it (grasp/app-shell/bar.tsx,
  // `phoneCrumbs="last-two"`): the page and the step before it, a slash
  // between, on one line. Laid end to start, the page first to take its
  // room and the step after it, whole or not at all: a step that does not
  // fit beside the page at its least wraps onto a second line, which the
  // trail's clip hides, so the page stands alone.
  phoneTrail: {
    display: "flex",
    minWidth: `calc(${space["8"]} + 2 * ${RING_REACH})`,
    overflow: "clip",
    padding: RING_REACH,
    margin: `calc(-1 * ${RING_REACH})`,
    // #2503's bar keeps two of its gaps (space3) between the crumbs and
    // the actions, where this bar has one of its own (space2).
    marginInlineEnd: `calc(2 * ${space["3"]} - ${space["2"]} - ${RING_REACH})`,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  phoneCrumbs: {
    display: "flex",
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    alignContent: "flex-start",
    columnGap: space["2"],
    rowGap: RING_REACH,
    blockSize: {
      default: font.textSmLine,
      [media.pointerCoarse]: size.tapTarget,
    },
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // The step: its link, then the slash before the page, whole.
  phoneStep: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    minBlockSize: { default: null, [media.pointerCoarse]: size.tapTarget },
    color: colors.sidebarSecondaryForeground,
  },
  phoneSlash: {
    display: "flex",
    flexShrink: 0,
    color: colors.sidebarTertiaryForeground,
  },
  // The step's link: the sidebar's secondary words, its own ink under the
  // pointer, a finger's height on a touch screen.
  phoneLink: {
    display: "inline-flex",
    minWidth: 0,
    alignItems: "center",
    minHeight: { default: null, [media.pointerCoarse]: size.tapTarget },
    borderRadius: radius.sm,
    color: {
      default: colors.sidebarSecondaryForeground,
      ":hover": { default: null, [media.hover]: colors.sidebarForeground },
    },
    textDecoration: "none",
    whiteSpace: "nowrap",
    paddingInline: CRUMB_ROOM,
    marginInline: `calc(-1 * ${CRUMB_ROOM})`,
  },
  // The page: first on the line, whole beside its step, cut to fit alone,
  // never under a stub of its first letters.
  phonePage: {
    order: -100,
    display: "flex",
    flexShrink: 1,
    minWidth: space["8"],
  },
  phonePageWords: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: colors.sidebarForeground,
    fontWeight: font.weightMedium,
  },
  trailing: { display: "flex", flexShrink: 0, alignItems: "center" },
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    marginInlineStart: "auto",
  },
  // Room at its end for the chat's button, which the frame lays over the
  // card's end at the bar's height (app-frame.tsx), as the reference's.
  roomForChat: {
    paddingInlineEnd: `calc(${size.appShellPageInline} + ${size.sidebarIconButton})`,
  },
});

/**
 * Puts a phone trail's step away while it wrapped out of sight: out of the
 * tab order and the accessibility tree too (`inert`), as #2503's bar puts
 * it away (`thinSteps`). It stays laid out, so the next resize finds
 * whether it fits again.
 */
const watchStep = (item: HTMLLIElement | null): (() => void) | undefined => {
  const list = item?.parentElement;
  if (item === null || list === null || list === undefined) {
    return undefined;
  }
  const place = () => {
    item.inert =
      item.getBoundingClientRect().top >= list.getBoundingClientRect().bottom;
  };
  place();
  const observer = new ResizeObserver(place);
  observer.observe(list);
  return () => {
    observer.disconnect();
  };
};

/**
 * Where the page is on a phone, as #2503's bar says it: the page and the
 * step before it (`phoneCrumbs="last-two"`), the step dropped where both
 * don't fit (`phoneCrumbs` in phoneTrail's styles). Composed here, not
 * with Damsko's Breadcrumb, which under 640px keeps only the step back
 * and leaves the page out (registry gap of 24 Nov 2026).
 */
const PhoneTrail = ({
  crumbs,
  label,
}: {
  crumbs: readonly Crumb[];
  label: string;
}) => {
  const page = crumbs.at(-1);
  const step = crumbs.at(-2);
  if (page === undefined) {
    return null;
  }
  return (
    <nav
      aria-label={label}
      data-slot="breadcrumb"
      {...stylex.props(styles.phoneTrail)}
    >
      <ol {...stylex.props(styles.phoneCrumbs)}>
        {step === undefined ? null : (
          <li ref={watchStep} {...stylex.props(styles.phoneStep)}>
            {"to" in step ? (
              <CrumbLink
                crumb={step}
                look={stylex.props(styles.phoneLink, focusRingText)}
              />
            ) : (
              step.label
            )}
            <span aria-hidden="true" {...stylex.props(styles.phoneSlash)}>
              /
            </span>
          </li>
        )}
        <li {...stylex.props(styles.phonePage)}>
          <span
            aria-current="page"
            title={page.label}
            {...stylex.props(styles.phonePageWords)}
          >
            <CrumbName crumb={page} />
          </span>
        </li>
      </ol>
    </nav>
  );
};

/**
 * The bar above every signed-in page, the one way a page heads itself, so
 * the frame changes every page's bar here: Damsko's SidebarTrigger at its
 * start while the sidebar is away (folded, or a sheet on a narrow window;
 * otherwise the sidebar's head holds it), then where the page is (Damsko's
 * Breadcrumb, its steps parted by a slash, as the product's bar has them;
 * on a phone the page and the step before it, `PhoneTrail`), with where its
 * subject stands after it (`trailing`), and at its end the page's actions.
 * It is app-shell-01's header, drawn by the page: the block draws its own
 * from props (the crumbs, the title, the actions), which the pages here
 * draw themselves.
 */
export const SiteHeader = ({
  crumbs,
  actions,
  trailing,
}: {
  crumbs: readonly Crumb[];
  actions?: ReactNode;
  trailing?: ReactNode;
}) => {
  const { t } = useLingui();
  const { state, isMobile } = useSidebar();
  // Room for the chat's button wherever the chat stands beside the page,
  // docked about its subject too, as #2503's bar keeps it (app-shell's
  // `data-shell-panels`).
  const { placements } = useShownPresence();
  const chatFloats =
    placements.includes("floating") || placements.includes("docked");
  const away = isMobile || state === "collapsed";
  const phone = usePhone();
  const last = crumbs.length - 1;
  const bar = useRef<HTMLElement>(null);
  // This bar's trigger opened the sidebar (pressed, or held focus as the
  // shortcut opened it) and went as it did: focus goes on to the fold in
  // the sidebar's head, and never stays on the page. Until Damsko's
  // SidebarProvider does this itself (the registry gap "the sidebar gives
  // no focus back when it opens from a trigger that then goes"); then this
  // goes.
  const handing = useRef(false);
  useLayoutEffect(() => {
    if (away || !handing.current) {
      return () => {
        // Nothing to hand on.
      };
    }
    handing.current = false;
    const sidebar = bar.current
      ?.closest('[data-slot="sidebar-wrapper"]')
      ?.querySelector<HTMLElement>('[data-slot="sidebar-container"]');
    const fold = sidebar?.querySelector<HTMLElement>(
      '[data-slot="sidebar-trigger"]'
    );
    let left = false;
    // Hidden until it has slid in (none of it with reduced motion): the
    // fold takes focus once the sidebar's own transitions are over, done
    // or cut off, unless it is folded again first.
    const slid = Promise.allSettled(
      (sidebar?.getAnimations() ?? []).map(
        async ({ finished }) => await finished
      )
    );
    const handOn = async () => {
      await slid;
      if (!left) {
        fold?.focus();
      }
    };
    void handOn();
    return () => {
      left = true;
    };
  }, [away]);
  return (
    <header
      data-slot="site-header"
      // The trigger holding focus, as the shortcut may open the sidebar.
      onBlur={() => {
        handing.current = false;
      }}
      onFocus={({ target }) => {
        handing.current =
          !isMobile && target.dataset.slot === "sidebar-trigger";
      }}
      ref={bar}
      {...stylex.props(styles.bar, chatFloats && styles.roomForChat)}
    >
      {away ? (
        <span {...stylex.props(styles.triggerInk)}>
          <SidebarTrigger
            aria-label={t`Show or hide the sidebar`}
            style={styles.trigger}
            onClick={() => {
              // The sheet takes focus itself, and gives it back on closing.
              handing.current = !isMobile;
            }}
          />
        </span>
      ) : null}
      <div {...stylex.props(styles.where)}>
        {phone ? (
          <PhoneTrail crumbs={crumbs} label={t`Breadcrumb`} />
        ) : (
          <Breadcrumb aria-label={t`Breadcrumb`}>
            <BreadcrumbList>
              {crumbs.map((crumb, index) => (
                // A path's steps don't move: each stands at its own place.
                <Fragment key={index}>
                  {index === 0 ? null : (
                    <BreadcrumbSeparator style={styles.separator}>
                      /
                    </BreadcrumbSeparator>
                  )}
                  <BreadcrumbItem>
                    {index !== last && "to" in crumb ? (
                      <BreadcrumbLink asChild>
                        <CrumbLink crumb={crumb} />
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage>
                        <CrumbName crumb={crumb} />
                      </BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        )}
        {trailing === undefined ? null : (
          <div {...stylex.props(styles.trailing)}>{trailing}</div>
        )}
      </div>
      {actions === undefined ? null : (
        <div {...stylex.props(styles.actions)}>{actions}</div>
      )}
    </header>
  );
};
